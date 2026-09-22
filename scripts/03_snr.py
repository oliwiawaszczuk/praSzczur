"""
Estymacja stosunku sygnał/szum (S/N) dla widm MALDI-TOF FMP10.

Metoda:
  - noise  = odchylenie standardowe intensywności w zakresie 900-1500 Da
             (region praktycznie płaski, bez pików — patrz praOutputs/02_mean_spectra_report.md)
  - signal = maksymalna intensywność w zakresie 300-800 Da (region z dominującymi pikami)
  - S/N per spektrum = signal / noise; raportowane też per tkanka i globalnie (na widmach średnich)
"""

from pathlib import Path

import numpy as np

ROOT = Path(__file__).parents[1]
DATA_DIR = ROOT / "data" / "processed"

SIGNAL_RANGE = (300.0, 800.0)
NOISE_RANGE = (900.0, 1500.0)


def snr_stats(spectra: np.ndarray, mz_bins: np.ndarray) -> dict:
    sig_mask = (mz_bins >= SIGNAL_RANGE[0]) & (mz_bins <= SIGNAL_RANGE[1])
    noise_mask = (mz_bins >= NOISE_RANGE[0]) & (mz_bins <= NOISE_RANGE[1])

    noise = spectra[:, noise_mask].std(axis=1)
    noise = np.where(noise == 0, np.nan, noise)
    signal = spectra[:, sig_mask].max(axis=1)
    snr = signal / noise

    return {
        "n_spectra": spectra.shape[0],
        "snr_mean": float(np.nanmean(snr)),
        "snr_median": float(np.nanmedian(snr)),
        "snr_std": float(np.nanstd(snr)),
    }


def main() -> None:
    for f in sorted(DATA_DIR.glob("*.npz")):
        d = np.load(f)
        spectra, mz_bins = d["spectra"], d["mz_bins"]
        stats = snr_stats(spectra, mz_bins)
        print(f"{f.stem:8s}  n={stats['n_spectra']:5d}  "
              f"S/N mean={stats['snr_mean']:7.2f}  median={stats['snr_median']:7.2f}  "
              f"std={stats['snr_std']:7.2f}")


if __name__ == "__main__":
    main()
