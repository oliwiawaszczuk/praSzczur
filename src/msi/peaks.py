"""Wykrywanie i opis pików w (średnim) widmie — domena "Markery" w Node Graph.

Przeniesione i dostosowane z repo IsotopeakeR (M. Dulewicz, MaldiGeoMxSpatialTranscriptomicsIsotopeaker):
  - próg SNR względem MAD (my_detect_peaks) → `detect_peaks(noise="mad")`; domyślnie jednak szum LOKALNY
    (`preprocessing.local_noise`), bo w tych danych szum spada ~2x między 300 a 1000 Da,
  - granice piku po dolinach (find_bounds_valley) → `valley_bounds`,
  - centroid / FWHM / AUC (calc_peak_params, calc_auc) → `peak_params`,
  - dopasowanie asymetrycznego Gaussa i R² (nlsLM w .analyze_spectra_simple) → `fit_asym_gauss`,
  - ALS baseline → `als_baseline`, ale na macierzy RZADKIEJ (oryginał rozwiązuje gęsty układ n×n,
    co przy ~35 700 punktach widma surowego jest niewykonalne).
Świadomie NIE przeniesione: normalizacja do 100% maksimum (zaciera różnice całkowitej intensywności
między widmami) i okno SG = 49 pkt (dobrane do pików tryb liniowego ~kilka Da; tu FWHM ~0.1 Da).
"""

from __future__ import annotations

import numpy as np
from scipy import sparse
from scipy.optimize import curve_fit
from scipy.sparse.linalg import spsolve

from src.msi.preprocessing import local_noise

ISOTOPE_SPACING = 1.003355  # 13C − 12C [Da]


# ── Linia bazowa ALS (Eilers & Boelens 2005), wersja rzadka ─────────────────
def als_baseline(y: np.ndarray, lam: float = 1e5, p: float = 0.01, n_iter: int = 10) -> np.ndarray:
    """Asymetryczne najmniejsze kwadraty: gładka linia bazowa, której reszty dodatnie (piki) mają wagę p,
    ujemne 1−p. `lam` — gładkość (10^2…10^9), `p` — asymetria (0.001…0.1)."""
    y = np.asarray(y, dtype=float)
    n = len(y)
    if n < 3:
        return np.zeros_like(y)
    D = sparse.diags([1.0, -2.0, 1.0], [0, -1, -2], shape=(n, n - 2))
    P = lam * D.dot(D.T)
    w = np.ones(n)
    z = y
    for _ in range(max(int(n_iter), 1)):
        W = sparse.spdiags(w, 0, n, n)
        z = spsolve((W + P).tocsc(), w * y)
        w_new = np.where(y > z, p, 1 - p)
        if np.array_equal(w_new, w):
            break
        w = w_new
    return np.asarray(z)


# ── Detekcja ────────────────────────────────────────────────────────────────
def _noise(
    mz: np.ndarray, y: np.ndarray, method: str, window_da: float
) -> tuple[np.ndarray, np.ndarray]:
    if method == "mad":
        med = float(np.median(y))
        base = np.full_like(y, med)
        sigma = np.full_like(y, 1.4826 * float(np.median(np.abs(y - med))))
    else:
        base, sigma = local_noise(mz, y, window_da)
    # Widmo po korekcji tła z obcięciem do 0 ma większość punktów = 0 → MAD = 0 i SNR rzędu 1e10.
    # Tam, gdzie σ jest zdegenerowane, bierzemy σ z MAD pierwszych różnic punktów dodatnich.
    yp = y[y > 0]
    if len(yp) > 10:
        d = np.diff(yp)
        sd = 1.4826 * float(np.median(np.abs(d - np.median(d)))) / np.sqrt(2)
        if sd > 0:
            sigma = np.where(sigma < 0.1 * sd, sd, sigma)
    return base, np.maximum(sigma, 1e-12)


def detect_peaks(
    mz: np.ndarray,
    y: np.ndarray,
    snr: float = 3.0,
    half_window_da: float = 0.1,
    min_distance_da: float = 0.0,
    max_peaks: int = 500,
    noise: str = "local",
    noise_window_da: float = 10.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Indeksy pików: lokalne maksimum w ±half_window_da, wysokość nad linią szumu >= snr·σ.
    Zwraca (indeksy posortowane po m/z, SNR, lokalna linia bazowa)."""
    from scipy.ndimage import maximum_filter1d

    mz = np.asarray(mz, dtype=float)
    y = np.asarray(y, dtype=float)
    step = float(np.median(np.diff(mz))) if len(mz) > 1 else 1.0
    base, sigma = _noise(mz, y, noise, noise_window_da)
    z = (y - base) / sigma
    hw = max(int(round(half_window_da / step)), 1)
    is_max = (y == maximum_filter1d(y, size=2 * hw + 1, mode="nearest")) & (z >= snr)
    is_max[1:] &= ~(is_max[:-1] & (y[1:] == y[:-1]))  # plateau → pierwszy punkt
    idx = np.flatnonzero(is_max)
    # najsilniejsze najpierw; min_distance i max_peaks egzekwowane zachłannie
    order = idx[np.argsort(-z[idx])]
    kept: list[int] = []
    for i in order:
        if len(kept) >= max_peaks:
            break
        if min_distance_da > 0 and any(abs(mz[i] - mz[k]) < min_distance_da for k in kept):
            continue
        kept.append(int(i))
    kept_arr = np.array(sorted(kept), dtype=int)
    return kept_arr, z[kept_arr] if len(kept_arr) else np.array([]), base


def valley_bounds(
    y: np.ndarray, k: int, floor: np.ndarray | float = 0.0, max_pts: int = 200
) -> tuple[int, int]:
    """Granice piku: idzie od apeksu w obie strony, dopóki sygnał maleje i jest nad `floor`
    (dolina albo zejście do linii bazowej). Ograniczone do max_pts punktów w każdą stronę."""
    n = len(y)
    fl = np.broadcast_to(np.asarray(floor, dtype=float), y.shape)
    # punkt doliny / pierwszy punkt na poziomie tła NALEŻY do piku (inaczej piki szerokie na
    # 2–4 punkty surowej siatki dostawałyby granice = apeks i FWHM = 0)
    lo = k
    while lo > 0 and k - lo < max_pts and y[lo - 1] <= y[lo]:
        lo -= 1
        if y[lo] <= fl[lo]:
            break
    hi = k
    while hi < n - 1 and hi - k < max_pts and y[hi + 1] <= y[hi]:
        hi += 1
        if y[hi] <= fl[hi]:
            break
    return lo, hi


def _asym_gauss(x, a, mu, sl, sr):
    s = np.where(x < mu, sl, sr)
    return a * np.exp(-0.5 * ((x - mu) / s) ** 2)


def fit_asym_gauss(x: np.ndarray, y: np.ndarray) -> tuple[float, float, float]:
    """Dopasowanie asymetrycznego Gaussa (jak w IsotopeakeR). Zwraca (R², mu, FWHM z dopasowania);
    NaN gdy za mało punktów albo dopasowanie się nie zbiega."""
    if len(x) < 5 or np.max(y) <= 0:
        return float("nan"), float("nan"), float("nan")
    k = int(np.argmax(y))
    w0 = max((x[-1] - x[0]) / 4, 1e-4)
    try:
        popt, _ = curve_fit(
            _asym_gauss,
            x,
            y,
            p0=[y[k], x[k], w0, w0],
            bounds=(
                [0, x[0], 1e-5, 1e-5],
                [np.inf, x[-1], x[-1] - x[0] + 1e-3, x[-1] - x[0] + 1e-3],
            ),
            maxfev=2000,
        )
    except Exception:
        return float("nan"), float("nan"), float("nan")
    pred = _asym_gauss(x, *popt)
    ss_res = float(((y - pred) ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    fwhm = 1.1774 * (popt[2] + popt[3])  # √(2 ln 2) · (σL + σR)
    return r2, float(popt[1]), float(fwhm)


def peak_params(mz: np.ndarray, y: np.ndarray, k: int, lo: int, hi: int, base: float = 0.0) -> dict:
    """Apeks (interpolacja paraboliczna), centroid i FWHM (interpolacja liniowa na połowie wysokości),
    AUC (trapezy) — wszystko po odjęciu `base`."""
    yy = np.clip(y[lo : hi + 1] - base, 0, None)
    xx = mz[lo : hi + 1]
    kk = k - lo
    apex = float(mz[k])
    if 0 < k < len(y) - 1:
        a, b, c = y[k - 1], y[k], y[k + 1]
        den = a - 2 * b + c
        if den < 0:
            apex = float(mz[k] + 0.5 * (a - c) / den * (mz[k + 1] - mz[k - 1]) / 2)
    h = float(yy[kk])
    hm = h / 2
    li = kk
    while li > 0 and yy[li] > hm:
        li -= 1
    ri = kk
    while ri < len(yy) - 1 and yy[ri] > hm:
        ri += 1

    def cross(i0, i1):
        y0, y1 = yy[i0], yy[i1]
        return (
            float(xx[i0] + (hm - y0) * (xx[i1] - xx[i0]) / (y1 - y0)) if y1 != y0 else float(xx[i0])
        )

    left = cross(li, li + 1) if yy[li] <= hm and li < kk else float(xx[li])
    right = cross(ri - 1, ri) if yy[ri] <= hm and ri > kk else float(xx[ri])
    above = yy >= hm
    centroid = (
        float((xx[above] * yy[above]).sum() / yy[above].sum()) if yy[above].sum() > 0 else apex
    )
    auc = float(np.trapezoid(yy, xx)) if len(xx) > 1 else 0.0
    return {
        "apex": apex,
        "centroid": centroid,
        "fwhm": max(right - left, 0.0),
        "height": h,
        "auc": auc,
    }


def describe_peaks(
    mz: np.ndarray,
    y: np.ndarray,
    snr: float = 3.0,
    half_window_da: float = 0.1,
    min_distance_da: float = 0.0,
    max_peaks: int = 500,
    noise: str = "local",
    noise_window_da: float = 10.0,
    fit: bool = True,
    max_bound_da: float = 1.0,
) -> list[dict]:
    """Pełna lista pików: m/z apeksu, centroid, granice [lo, hi], FWHM, wysokość, AUC, SNR, R² (opcjonalnie)."""
    mz = np.asarray(mz, dtype=float)
    y = np.asarray(y, dtype=float)
    idx, z, base = detect_peaks(
        mz, y, snr, half_window_da, min_distance_da, max_peaks, noise, noise_window_da
    )
    step = float(np.median(np.diff(mz))) if len(mz) > 1 else 1.0
    max_pts = max(int(max_bound_da / step), 2)
    out = []
    for k, s in zip(idx, z):
        lo, hi = valley_bounds(y, int(k), floor=base, max_pts=max_pts)
        pp = peak_params(mz, y, int(k), lo, hi, float(base[k]))
        r2 = float("nan")
        if fit:
            # okno dopasowania co najmniej ±4 punkty — sam pik ma na surowej siatce 2–4 punkty
            w = min(max(4, k - lo, hi - k), max_pts)
            a, b = max(int(k) - w, 0), min(int(k) + w + 1, len(y))
            r2, _, _ = fit_asym_gauss(mz[a:b], np.clip(y[a:b] - base[k], 0, None))
        out.append(
            {
                "mz": round(pp["apex"], 5),
                "centroid": round(pp["centroid"], 5),
                "lo": round(float(mz[lo]), 5),
                "hi": round(float(mz[hi]), 5),
                "fwhm": round(pp["fwhm"], 5),
                "height": float(pp["height"]),
                "auc": float(pp["auc"]),
                "snr": round(float(s), 2),
                "r2": None if np.isnan(r2) else round(r2, 4),
            }
        )
    return out


def flag_isotopes(peaks: list[dict], tol_da: float = 0.02, max_ratio: float = 1.0) -> list[dict]:
    """Oznacza piki M+1 (Δm/z = 1.00336 ± tol) o wysokości <= max_ratio · M jako izotopy (`isotope_of` = m/z M).
    Kolejne M+2 łapane łańcuchowo (M+1 też ma swojego "M+1")."""
    res = [dict(p) for p in peaks]
    mzs = np.array([p["mz"] for p in res])
    for i, p in enumerate(res):
        target = p["mz"] + ISOTOPE_SPACING
        j = int(np.argmin(np.abs(mzs - target))) if len(mzs) else -1
        if (
            j >= 0
            and j != i
            and abs(mzs[j] - target) <= tol_da
            and res[j]["height"] <= max_ratio * p["height"]
        ):
            res[j].setdefault("isotope_of", p.get("isotope_of", p["mz"]))
    return res
