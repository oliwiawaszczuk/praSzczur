"""Metody preprocessingu widm MALDI-MSI (na widmie pojedynczego piksela).

Standardowy zestaw kroków znany m.in. z pipeline'u Cardinal (R/Bioconductor)
dla danych MSI: smooth (wygladzanie), baselineCorrection (usuwanie linii
bazowej), normalize (normalizacja TIC), peakPick (redukcja do pikow).
Kazda funkcja operuje na widmie jednego piksela i zwraca widmo po
przetworzeniu (ta sama os m/z, przeksztalcona intensywnosc).
"""

from __future__ import annotations

import numpy as np
from scipy.signal import find_peaks, savgol_filter


def smooth_savgol(intensity: np.ndarray, window: int = 15, polyorder: int = 3) -> np.ndarray:
    """Wygladzanie Savitzky-Golay — redukuje szum przyrzadu, zachowujac ksztalt pikow."""
    n = len(intensity)
    w = max(int(window) | 1, polyorder + 1 + ((polyorder + 1) % 2 == 0))  # nieparzyste, > polyorder
    w = min(w, n - 1 if n % 2 == 0 else n)
    if w < polyorder + 2:
        return intensity.copy()
    return savgol_filter(intensity, window_length=w, polyorder=polyorder)


def baseline_correction_snip(intensity: np.ndarray, iterations: int = 40) -> tuple[np.ndarray, np.ndarray]:
    """Usuwanie linii bazowej algorytmem SNIP (LLS + iteracyjne peak-clipping).

    Standardowa metoda w spektrometrii mas / XRF do usuwania powolnie
    zmieniajacego sie tla chemicznego spod pikow.
    Zwraca (widmo po korekcji, wyznaczona linia bazowa).
    """
    v = np.clip(intensity, 0, None).astype(float)
    y = np.log(np.log(np.sqrt(v + 1) + 1) + 1)  # LLS transform — tlumi wplyw pikow
    n = len(y)
    idx = np.arange(n)
    for p in range(1, int(iterations) + 1):
        shifted_left = np.roll(y, p)
        shifted_right = np.roll(y, -p)
        avg = (shifted_left + shifted_right) / 2.0
        valid = (idx >= p) & (idx < n - p)
        y = np.where(valid, np.minimum(y, avg), y)
    baseline = (np.exp(np.exp(y) - 1) - 1) ** 2 - 1
    baseline = np.clip(baseline, 0, None)
    corrected = np.clip(intensity - baseline, 0, None)
    return corrected, baseline


def normalize_tic(intensity: np.ndarray, target_tic: float | None = None) -> tuple[np.ndarray, float]:
    """Normalizacja do calkowitego pradu jonowego (TIC).

    Skaluje widmo tak, aby jego suma (TIC) odpowiadala `target_tic`
    (np. medianie TIC calej tkanki) — koryguje roznice czulosci
    piksel-do-piksela, zeby intensywnosci byly porownywalne.
    """
    tic = float(intensity.sum())
    if tic <= 0 or target_tic is None or target_tic <= 0:
        return intensity.copy(), 1.0
    factor = target_tic / tic
    return intensity * factor, factor


def peak_pick(mz: np.ndarray, intensity: np.ndarray, prominence_frac: float = 0.02) -> tuple[np.ndarray, int]:
    """Redukcja profilu do listy pikow (centroidy) — reszta widma wyzerowana.

    Ulatwia odczyt widma "po" jako czysty zestaw sygnalow bez szumu tla.
    """
    out = np.zeros_like(intensity)
    if intensity.max() <= 0:
        return out, 0
    thresh = float(intensity.max()) * prominence_frac
    peaks_idx, _ = find_peaks(intensity, prominence=thresh)
    out[peaks_idx] = intensity[peaks_idx]
    return out, len(peaks_idx)


# ---------------------------------------------------------------------------
# Metody dodane po analizie scripts/05_preproc_benchmark.py i 06_real_data_validation.py
# (raport: praOutputs/05_preprocessing_research.md).
# ---------------------------------------------------------------------------
from scipy.ndimage import gaussian_filter1d, maximum_filter1d, median_filter  # noqa: E402


def _step_da(mz: np.ndarray) -> float:
    return float(np.median(np.diff(mz))) if len(mz) > 1 else 1.0


def local_noise(mz: np.ndarray, intensity: np.ndarray, window_da: float = 10.0) -> tuple[np.ndarray, np.ndarray]:
    """Lokalna linia bazowa (mediana krocząca) i szum (MAD*1.4826 reszt) w oknie `window_da` [Da].

    Odpowiednik estimateNoise(method="MAD") z MALDIquant, ale z lokalnym oknem — szum w tych
    danych spada z ~0.053 (300-600 Da) do ~0.027 (>1000 Da), więc jedna globalna wartość nie wystarcza.
    """
    w = max(int(window_da / _step_da(mz)) | 1, 5)
    w = min(w, len(intensity) if len(intensity) % 2 else len(intensity) - 1)
    base = median_filter(intensity, size=w, mode="nearest")
    sigma = 1.4826 * median_filter(np.abs(intensity - base), size=w, mode="nearest")
    return base, np.maximum(sigma, 1e-9)


def smooth_matched(mz: np.ndarray, intensity: np.ndarray, resolving_power: float = 5000.0) -> np.ndarray:
    """Gauss o szerokości dopasowanej do piku: FWHM(m/z) = m/z / R, σ = FWHM / 2.355 (filtr dopasowany).

    W przeciwieństwie do Savitzky-Golay o stałym oknie (15 pkt = 0.5 Da na surowych danych, ~4x
    szersze niż pik ~0.09-0.16 Da) nie spłaszcza pików: zachowuje ~70% wysokości piku vs ~37% dla SG 15/3.
    Szerokość rośnie z m/z (zmierzone: 0.09 Da @ 375, 0.16 Da @ 950). Gdy σ < ~0.4 punktu
    (np. dane zbinowane 0.3 Da) filtr nie ma sensu i widmo wraca bez zmian.
    """
    out = intensity.astype(float).copy()
    step = _step_da(mz)
    n_seg = max(int((mz[-1] - mz[0]) / 25.0), 1)
    edges = np.linspace(0, len(mz), n_seg + 1).astype(int)
    pad = 40
    for a, b in zip(edges[:-1], edges[1:]):
        if b - a < 2:
            continue
        sigma_pts = (mz[(a + b) // 2] / resolving_power) / 2.3548 / step
        if sigma_pts < 0.4:
            continue
        lo, hi = max(a - pad, 0), min(b + pad, len(mz))
        seg = gaussian_filter1d(intensity[lo:hi].astype(float), sigma_pts, mode="nearest")
        out[a:b] = seg[a - lo: b - lo]
    return out


def peak_pick_snr(
    mz: np.ndarray, intensity: np.ndarray, snr: float = 4.0, window_da: float = 10.0,
    max_window_da: float = 0.1, mode: str = "centroidy",
) -> tuple[np.ndarray, int]:
    """Detekcja pików z progiem SNR względem LOKALNEGO szumu (jak MALDIquant::detectPeaks, SNR=3 = LOD).

    Pik = punkt będący MAKSIMUM w oknie ±max_window_da [Da] (jak halfWindowSize w MALDIquant),
    którego wysokość nad lokalną linią bazową wynosi >= snr * lokalny szum. mode="centroidy": zostają tylko wierzchołki; "profil": zostaje cały
    profil piku (od podstawy do podstawy), reszta jest zerowana. Próg nie zależy od najwyższego piku
    w widmie (w odróżnieniu od progu prominence = ułamek maksimum).
    """
    base, sigma = local_noise(mz, intensity, window_da)
    z = (intensity - base) / sigma
    hw = max(int(round(max_window_da / _step_da(mz))), 1)
    is_max = (z == maximum_filter1d(z, size=2 * hw + 1, mode="nearest")) & (z >= snr)
    is_max[1:] &= ~(is_max[:-1] & (z[1:] == z[:-1]))  # plateau: tylko pierwszy punkt
    peaks = np.flatnonzero(is_max)
    out = np.zeros_like(intensity, dtype=float)
    if len(peaks) == 0:
        return out, 0
    if mode == "profil":
        from scipy.signal import peak_widths

        _, _, left, right = peak_widths(z, peaks, rel_height=0.9)
        for lo, hi in zip(left, right):
            a, b = int(np.floor(lo)), int(np.ceil(hi)) + 1
            out[a:b] = intensity[a:b]
    else:
        out[peaks] = intensity[peaks]
    return out, int(len(peaks))


def apply_extra_step(method: str, mz: np.ndarray, intensity: np.ndarray, params: dict):
    """Wspólny dyspozytor dla metod dodanych po analizie MALDI (używany przez sidecar).

    Zwraca (nowe_intensywności, info) albo None, gdy `method` nie jest jedną z nich.
    """
    if method == "smooth_matched":
        return smooth_matched(mz, intensity, float(params.get("resolving_power", 5000))), {}
    if method == "peakpick_snr":
        out, n = peak_pick_snr(
            mz, intensity, snr=float(params.get("snr", 4.0)),
            window_da=float(params.get("noise_window_da", 10.0)),
            max_window_da=float(params.get("max_window_da", 0.1)),
            mode=str(params.get("mode", "centroidy")),
        )
        return out, {"n_peaks": n}
    return None
