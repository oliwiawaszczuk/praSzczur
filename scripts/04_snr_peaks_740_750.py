"""
S/N per pik w zakresie 740-750 Da, dla tkanki T1 (referencyjnej).

Metoda (per piksel, nie na widmie usrednionym — zeby nie zanizac szumu):
  1. Piki identyfikowane na SUROWYM widmie srednim T1 (do wyznaczenia pozycji m/z pikow).
  2. Dla kazdego piku i kazdego surowego widma pojedynczego piksela T1:
       - signal = intensywnosc w oknie apeksu piku (+/- 0.15 Da)
       - noise  = robust std (MAD*1.4826) z lokalnego flankera (+/- 3 Da wokol piku,
                  z wykluczeniem +/- 0.5 Da wokol samego piku)
       - S/N = signal / noise
  3. Raportowane: mediana/srednia S/N po wszystkich pikselach T1, oraz % pikseli
     z S/N > 3 (LOD) i > 10 (LOQ).
"""

from pathlib import Path

import numpy as np
from scipy.signal import find_peaks

ROOT = Path(__file__).parents[1]
import sys
sys.path.insert(0, str(ROOT))

from src.msi.loader import open_parser

WINDOW = (740.0, 750.0)
FLANK = 3.0       # Da, szerokosc okna szumu po kazdej stronie piku
EXCLUDE = 0.5      # Da, wykluczenie wokol apeksu piku z okna szumu
APEX = 0.15        # Da, polowa szerokosci okna sygnalu (apeks)


def robust_std(x: np.ndarray) -> float:
    med = np.median(x)
    mad = np.median(np.abs(x - med))
    return 1.4826 * mad


def main() -> None:
    p = open_parser()
    coords_all = np.array(p.coordinates)[:, :2]

    d = np.load(ROOT / "data" / "processed" / "T1.npz")
    t1_coords = d["coords"]

    coord_to_idx = {(int(x), int(y)): i for i, (x, y) in enumerate(coords_all)}
    t1_indices = [coord_to_idx[(int(x), int(y))] for x, y in t1_coords]

    print(f"T1: {len(t1_indices)} pikseli")

    # ── Widmo srednie T1 (surowe, do peak-pickingu) ──────────────────────
    mz0, _ = p.getspectrum(t1_indices[0])
    lo_mask = (mz0 >= WINDOW[0] - FLANK - 1) & (mz0 <= WINDOW[1] + FLANK + 1)
    mz_sub = mz0[lo_mask]

    acc = np.zeros(mz_sub.shape, dtype=np.float64)
    for i in t1_indices:
        _, inten = p.getspectrum(i)
        acc += inten[lo_mask]
    mean_sp = acc / len(t1_indices)

    win_mask = (mz_sub >= WINDOW[0]) & (mz_sub <= WINDOW[1])
    peaks_local, props = find_peaks(mean_sp[win_mask], prominence=mean_sp[win_mask].max() * 0.02)
    peak_mz = mz_sub[win_mask][peaks_local]
    print(f"\nWykryte piki (na widmie srednim T1) w {WINDOW[0]}-{WINDOW[1]} Da: {len(peak_mz)}")
    print(f"  m/z: {np.round(peak_mz, 3)}")

    if len(peak_mz) == 0:
        print("Brak wyraznych pikow w tym zakresie.")
        return

    # ── S/N per piksel dla kazdego piku ──────────────────────────────────
    results = {mzp: [] for mzp in peak_mz}
    for i in t1_indices:
        mz, inten = p.getspectrum(i)
        sub_mask = (mz >= WINDOW[0] - FLANK - 1) & (mz <= WINDOW[1] + FLANK + 1)
        mzs, ints = mz[sub_mask], inten[sub_mask]
        for mzp in peak_mz:
            sig_mask = np.abs(mzs - mzp) <= APEX
            signal = ints[sig_mask].max() if sig_mask.any() else np.nan

            flank_mask = (np.abs(mzs - mzp) <= FLANK) & (np.abs(mzs - mzp) > EXCLUDE)
            noise = robust_std(ints[flank_mask]) if flank_mask.sum() > 5 else np.nan

            snr = signal / noise if noise and noise > 0 else np.nan
            results[mzp].append(snr)

    print(f"\n{'m/z':>8}  {'S/N mediana':>12}  {'S/N srednia':>12}  {'%>3 (LOD)':>10}  {'%>10 (LOQ)':>11}")
    for mzp in peak_mz:
        arr = np.array(results[mzp])
        arr = arr[~np.isnan(arr)]
        med, mean = np.median(arr), np.mean(arr)
        pct_lod = np.mean(arr > 3) * 100
        pct_loq = np.mean(arr > 10) * 100
        print(f"{mzp:8.3f}  {med:12.1f}  {mean:12.1f}  {pct_lod:9.1f}%  {pct_loq:10.1f}%")


if __name__ == "__main__":
    main()
