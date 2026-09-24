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
