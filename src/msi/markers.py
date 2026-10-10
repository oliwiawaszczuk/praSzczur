"""Markery przestrzenne: macierz piksel × pik i rankingi m/z — domena "Markery" w Node Graph.

Metryki przeniesione ze `scripts/08_mz_marker_profile.py` (Moran I, Gini, AUC/Cliff δ, ε² Kruskala-Wallisa)
i `scripts/10_recalibrated_ranking.py` (rekalibracja per piksel do lock mass). Piksele NIE są niezależnymi
replikami — zwracamy wyłącznie wielkości efektu, żadnych p-wartości.
"""

from __future__ import annotations

from collections import deque

import numpy as np
from scipy.ndimage import distance_transform_edt
from scipy.stats import rankdata

FMP10_LOCK_MZ = 555.2231  # jon matrycy FMP-10 używany jako lock mass (patrz 09/10)


# ── Pojedynczy piksel ───────────────────────────────────────────────────────
def baseline_block(x: np.ndarray, block: int = 300) -> np.ndarray:
    """Tło jako interpolowana mediana bloków (~10 Da na surowej siatce) — jak w 08."""
    n = len(x)
    nb = n // block
    if nb < 2:
        return np.full(n, float(np.median(x)))
    med = np.median(x[: nb * block].reshape(nb, block), axis=1)
    centers = np.arange(nb) * block + block / 2
    return np.interp(np.arange(n), centers, med)


def integrate_windows(
    mz: np.ndarray, y: np.ndarray, lo: np.ndarray, hi: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Suma intensywności w każdym oknie [lo, hi] (jak /ion_image: suma punktów) + liczba punktów okna."""
    cs = np.concatenate([[0.0], np.cumsum(y, dtype=float)])
    a = np.searchsorted(mz, lo, side="left")
    b = np.searchsorted(mz, hi, side="right")
    return cs[b] - cs[a], np.maximum(b - a, 1)


def lock_mass_ppm(
    mz: np.ndarray, y: np.ndarray, lock_mz: float = FMP10_LOCK_MZ, search_da: float = 0.3
) -> tuple[float, float]:
    """Przesunięcie [ppm] centroidu jonu lock mass względem wartości teoretycznej + wysokość apeksu."""
    a = np.searchsorted(mz, lock_mz - search_da)
    b = np.searchsorted(mz, lock_mz + search_da)
    if b - a < 3:
        return float("nan"), 0.0
    seg = y[a:b]
    k = int(np.argmax(seg))
    h = float(seg[k])
    if h <= 0:
        return float("nan"), 0.0
    sel = seg >= h / 2
    # tylko spójny fragment wokół apeksu
    lo = k
    while lo > 0 and sel[lo - 1]:
        lo -= 1
    hi = k
    while hi < len(seg) - 1 and sel[hi + 1]:
        hi += 1
    w = seg[lo : hi + 1]
    c = float((mz[a + lo : a + hi + 1] * w).sum() / w.sum())
    return (c - lock_mz) / lock_mz * 1e6, h


def pixel_noise(mz: np.ndarray, y: np.ndarray) -> float:
    """σ szumu piksela z MAD pierwszej różnicy (m/z > 1000, gdzie prawie nie ma pików) — jak w 08."""
    sel = mz > 1000 if (mz > 1000).sum() > 50 else slice(None)
    d = np.diff(y[sel])
    return float(1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2)) if len(d) else 0.0


class PpmFallback:
    """Gdy jon lock mass jest w pikselu za słaby, bierze medianę ostatnich wiarygodnych ppm tej samej
    tkanki (akwizycja rastrowa → sąsiedzi przestrzenni). Zastępuje medianę tkanki z 10 (wymagałaby
    drugiego przejścia po całym pliku)."""

    def __init__(self, n: int = 101):
        self.buf: dict[str, deque] = {}
        self.n = n

    def get(self, tissue: str, ppm: float, ok: bool) -> float:
        q = self.buf.setdefault(tissue, deque(maxlen=self.n))
        if ok and np.isfinite(ppm):
            q.append(ppm)
            return ppm
        return float(np.median(q)) if q else 0.0


# ── Metryki ─────────────────────────────────────────────────────────────────
def to_grid(xy: np.ndarray, values: np.ndarray) -> np.ndarray:
    x0, y0 = xy.min(axis=0)
    h, w = xy[:, 1].max() - y0 + 1, xy[:, 0].max() - x0 + 1
    img = np.full((int(h), int(w)), np.nan)
    img[xy[:, 1] - y0, xy[:, 0] - x0] = values
    return img


def morans_i(img: np.ndarray) -> float:
    """Moran I z sąsiedztwem 4-spójnym; NaN = brak piksela."""
    m = ~np.isnan(img)
    if m.sum() < 3:
        return float("nan")
    z = np.where(m, img - np.nanmean(img), 0.0)
    ph = m[:, 1:] & m[:, :-1]
    pv = m[1:] & m[:-1]
    num = (z[:, 1:] * z[:, :-1])[ph].sum() + (z[1:] * z[:-1])[pv].sum()
    w = ph.sum() + pv.sum()
    den = (z[m] ** 2).sum()
    return float(m.sum() / w * num / den) if den > 0 and w > 0 else float("nan")


def gini(v: np.ndarray) -> float:
    v = np.sort(np.clip(v, 0, None))
    if v.sum() == 0:
        return float("nan")
    n = len(v)
    return float((2 * np.arange(1, n + 1) - n - 1).dot(v) / (n * v.sum()))


def spearman_cols(X: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Spearman każdej kolumny X z wektorem v."""
    if len(v) < 3:
        return np.full(X.shape[1], np.nan)
    R = rankdata(X, axis=0)
    r = rankdata(v)
    R = R - R.mean(axis=0)
    r = r - r.mean()
    den = np.sqrt((R**2).sum(axis=0) * (r**2).sum())
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(den > 0, (R * r[:, None]).sum(axis=0) / den, np.nan)


def _nanr(x: float, nd: int = 4):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def spatial_ranking(
    X: np.ndarray,
    det: np.ndarray,
    xy: np.ndarray,
    tissue: np.ndarray,
    tissue_ids: list[str],
    lock_h: np.ndarray,
    peak_mz: np.ndarray,
    min_coverage: float = 0.1,
) -> list[dict]:
    """Ranking bez etykiet — "czy m/z tworzy strukturę przestrzenną", osobno w każdej tkance.

    Na tkankę: Moran I (spójność przestrzenna), Gini (koncentracja w hotspotach — pik "nie wszędzie"),
    pokrycie (% pikseli z sygnałem > 3σ), kary za artefakty: |Spearman| z odległością od krawędzi
    tkanki i z intensywnością jonu matrycy (lock mass).
    wynik_tkanki = max(Moran,0) · (0.5 + 0.5·Gini) · (1 − max(|ρ_krawędź|, |ρ_matryca|)),
    zero, gdy pokrycie < min_coverage. Wynik = średnia po tkankach.
    """
    p = X.shape[1]
    per = {tid: {} for tid in tissue_ids}
    scores = np.zeros((len(tissue_ids), p))
    for ti, tid in enumerate(tissue_ids):
        m = tissue == ti
        if m.sum() < 10:
            scores[ti] = np.nan
            continue
        Xt, xyt = X[m], xy[m]
        present = to_grid(xyt, np.ones(m.sum()))
        dist = distance_transform_edt(np.nan_to_num(present) > 0)
        x0, y0 = xyt.min(axis=0)
        edge = dist[xyt[:, 1] - y0, xyt[:, 0] - x0]
        rho_edge = spearman_cols(Xt, edge)
        rho_lock = spearman_cols(Xt, lock_h[m]) if np.ptp(lock_h[m]) > 0 else np.zeros(p)
        cov = det[m].mean(axis=0)
        for j in range(p):
            mi = morans_i(to_grid(xyt, Xt[:, j]))
            g = gini(Xt[:, j])
            art = np.nanmax([abs(rho_edge[j]), abs(rho_lock[j]), 0.0])
            s = (
                max(mi, 0.0) * (0.5 + 0.5 * (g if np.isfinite(g) else 0.0)) * (1 - art)
                if np.isfinite(mi)
                else 0.0
            )
            if cov[j] < min_coverage:
                s = 0.0
            scores[ti, j] = s
            per[tid][j] = {
                "score": _nanr(s),
                "moran": _nanr(mi),
                "gini": _nanr(g),
                "coverage": _nanr(cov[j], 3),
                "rho_edge": _nanr(rho_edge[j], 3),
                "rho_lock": _nanr(rho_lock[j], 3),
            }
    rows = []
    for j in range(p):
        pt = {tid: per[tid][j] for tid in tissue_ids if j in per[tid]}
        vals = [v for v in pt.values()]

        def mean_of(key):
            xs = [v[key] for v in vals if v[key] is not None]
            return _nanr(float(np.mean(xs))) if xs else None

        rows.append(
            {
                "peak": j,
                "mz": round(float(peak_mz[j]), 5),
                "score": _nanr(float(np.nanmean(scores[:, j])) if vals else 0.0),
                "metrics": {
                    k: mean_of(k) for k in ("moran", "gini", "coverage", "rho_edge", "rho_lock")
                },
                "per_tissue": {tid: v["score"] for tid, v in pt.items()},
            }
        )
    rows.sort(key=lambda r: -(r["score"] or 0))
    return rows


def region_contrast(
    X: np.ndarray, labels: np.ndarray, peak_mz: np.ndarray, min_region: int = 20
) -> dict:
    """Kontrast regionów jednej tkanki. `labels` per piksel (−1 = pomiń). Zwraca per pik:
    ε² Kruskala-Wallisa, AUC jeden-vs-reszta dla każdego regionu, najlepszy region (max |Cliff δ|), log2FC."""
    keep = labels >= 0
    regions = [r for r in np.unique(labels[keep]) if (labels == r).sum() >= min_region]
    if len(regions) < 2:
        raise ValueError("segmentacja ma mniej niż 2 regiony z ≥ %d pikselami" % min_region)
    sel = np.isin(labels, regions)
    Xs, ls = X[sel], labels[sel]
    N, p = Xs.shape
    R = rankdata(Xs, axis=0)
    k = len(regions)
    H = np.zeros(p)
    auc = np.zeros((k, p))
    log2fc = np.zeros((k, p))
    for i, r in enumerate(regions):
        m = ls == r
        n = m.sum()
        rs = R[m].sum(axis=0)
        H += n * (rs / n - (N + 1) / 2) ** 2
        auc[i] = (rs - n * (n + 1) / 2) / (n * (N - n))
        med_in = np.median(Xs[m], axis=0)
        med_out = np.median(Xs[~m], axis=0)
        log2fc[i] = np.log2((med_in + 1e-9) / (med_out + 1e-9))
    H *= 12 / (N * (N + 1))
    eps2 = (H - k + 1) / (N - k)
    cliff = 2 * auc - 1
    best = np.argmax(np.abs(cliff), axis=0)
    out = []
    for j in range(p):
        b = best[j]
        out.append(
            {
                "peak": j,
                "mz": round(float(peak_mz[j]), 5),
                "eps2": _nanr(eps2[j]),
                "max_cliff": _nanr(abs(cliff[b, j])),
                "best_region": int(regions[b]),
                "auc_best": _nanr(auc[b, j]),
                "log2fc_best": _nanr(log2fc[b, j], 3),
                "per_region": {str(int(r)): _nanr(cliff[i, j], 3) for i, r in enumerate(regions)},
            }
        )
    return {"regions": [int(r) for r in regions], "rows": out}


def colocalization_groups(
    X: np.ndarray, order: list[int], r_threshold: float = 0.8, max_peaks: int = 300
) -> dict[int, dict]:
    """Grupy wspólnie zlokalizowanych jonów: zachłannie w kolejności rankingu — pik dołącza do grupy
    pierwszego reprezentanta, z którym ma Spearman ≥ r_threshold, inaczej zakłada nową grupę."""
    order = [int(j) for j in order[:max_peaks]]
    if not order:
        return {}
    R = rankdata(X[:, order], axis=0)
    R = R - R.mean(axis=0)
    norm = np.sqrt((R**2).sum(axis=0))
    norm[norm == 0] = 1
    Z = R / norm
    C = Z.T @ Z
    reps: list[int] = []  # pozycje w `order`
    res: dict[int, dict] = {}
    for pos, j in enumerate(order):
        hit = next((rp for rp in reps if C[pos, rp] >= r_threshold), None)
        if hit is None:
            reps.append(pos)
            res[j] = {"group": len(reps) - 1, "rep": j, "r": 1.0}
        else:
            res[j] = {
                "group": reps.index(hit),
                "rep": order[hit],
                "r": round(float(C[pos, hit]), 3),
            }
    return res
