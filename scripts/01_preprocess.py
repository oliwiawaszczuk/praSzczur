"""
Preprocessing pipeline — uruchamiać jako punkt startowy każdej sesji analitycznej.

Kroki:
  1. Wczytanie imzML.
  2. Binning osi m/z (suma intensywności w oknie BIN_SIZE Da).
  3. Podział spektrów na 4 tkanki wg TISSUE_BOUNDS.
  4. Zapis danych per tkanka do data/processed/<tissue>.npz.

Wyjście (data/processed/):
  <tissue>.npz zawiera:
    - spectra  : float32 array (n_spectra, n_bins)
    - coords   : int16 array  (n_spectra, 2)  — (x, y) w układzie oryginalnym
    - mz_bins  : float64 array (n_bins,)      — centra binów
"""

from pathlib import Path

import numpy as np
from pyimzml.ImzMLParser import ImzMLParser
from tqdm import tqdm

ROOT = Path(__file__).parents[1]
import sys
sys.path.insert(0, str(ROOT))

from src.msi.constants import BIN_SIZE, MZ_MIN, MZ_MAX, TISSUE_BOUNDS

OUT_DIR = ROOT / "data" / "processed"
OUT_DIR.mkdir(parents=True, exist_ok=True)

IMZML = ROOT / "source" / "FMP10_Rat_brain_breg_084.imzML"


def build_bin_edges(mz_min: float, mz_max: float, bin_size: float) -> np.ndarray:
    """Centra binów rozmieszczone co bin_size w przedziale [mz_min, mz_max]."""
    return np.arange(mz_min + bin_size / 2, mz_max, bin_size)


def bin_spectrum(mz: np.ndarray, intensities: np.ndarray, bin_centers: np.ndarray,
                 bin_size: float) -> np.ndarray:
    """Suma intensywności w każdym binie (wektorowo, bez pętli po binach)."""
    half = bin_size / 2.0
    binned = np.zeros(len(bin_centers), dtype=np.float32)
    # Indeks binu dla każdego punktu m/z
    idx = np.searchsorted(bin_centers, mz - half, side="right")
    # Odrzuć punkty poza zakresem
    in_range = (idx < len(bin_centers)) & (np.abs(mz - bin_centers[np.clip(idx, 0, len(bin_centers)-1)]) <= half)
    np.add.at(binned, idx[in_range], intensities[in_range])
    return binned


def main() -> None:
    print(f"BIN_SIZE = {BIN_SIZE} Da")
    bin_centers = build_bin_edges(MZ_MIN, MZ_MAX, BIN_SIZE)
    print(f"Liczba binów: {len(bin_centers)}  ({MZ_MIN}–{MZ_MAX} Da)")

    print("Wczytywanie imzML...")
    p = ImzMLParser(str(IMZML))
    coords = np.array(p.coordinates)  # (N, 3): x, y, z

    # Przygotuj słowniki buforów per tkanka
    buffers: dict[str, dict] = {
        name: {"spectra": [], "coords": []}
        for name in TISSUE_BOUNDS
    }

    # Mapa x -> nazwa tkanki (szybkie przypisanie)
    x_to_tissue: dict[int, str] = {}
    for name, (x_lo, x_hi) in TISSUE_BOUNDS.items():
        for x in range(x_lo, x_hi + 1):
            x_to_tissue[x] = name

    print("Binning i segmentacja spektrów...")
    for i in tqdm(range(len(p.coordinates)), unit="spec"):
        x, y = coords[i, 0], coords[i, 1]
        tissue = x_to_tissue.get(int(x))
        if tissue is None:
            continue  # piksel w przerwie — pomijamy
        mz, intensities = p.getspectrum(i)
        binned = bin_spectrum(mz, intensities.astype(np.float32), bin_centers, BIN_SIZE)
        buffers[tissue]["spectra"].append(binned)
        buffers[tissue]["coords"].append([x, y])

    print("Zapis plików .npz...")
    for name, buf in buffers.items():
        spectra = np.stack(buf["spectra"])          # (n, n_bins)
        coords_arr = np.array(buf["coords"], dtype=np.int16)
        path = OUT_DIR / f"{name}.npz"
        np.savez_compressed(path, spectra=spectra, coords=coords_arr, mz_bins=bin_centers)
        print(f"  {name}: {spectra.shape[0]} spektrów → {path.name}")

    print("Gotowe.")


if __name__ == "__main__":
    main()
