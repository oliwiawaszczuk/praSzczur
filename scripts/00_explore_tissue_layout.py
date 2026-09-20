"""Quick TIC image to visualise tissue layout before segmentation."""

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from pyimzml.ImzMLParser import ImzMLParser

ROOT = Path(__file__).parents[1]
OUT = ROOT / "praOutputs"
OUT.mkdir(exist_ok=True)

imzml = ROOT / "source" / "FMP10_Rat_brain_breg_084.imzML"
p = ImzMLParser(str(imzml))

coords = np.array(p.coordinates)
x_max, y_max = coords[:, 0].max(), coords[:, 1].max()

# TIC image
tic = np.zeros((y_max, x_max), dtype=np.float64)
for i, (x, y, *_) in enumerate(p.coordinates):
    _, intensities = p.getspectrum(i)
    tic[y - 1, x - 1] = intensities.sum()

# Column-wise mean TIC (to find gaps)
col_tic = tic.mean(axis=0)  # shape: (x_max,)

fig, axes = plt.subplots(2, 1, figsize=(18, 8))

axes[0].imshow(tic, aspect="auto", cmap="inferno", interpolation="nearest")
axes[0].set_title("TIC image — widok przestrzenny (y × x piksele)")
axes[0].set_xlabel("x [piksel]")
axes[0].set_ylabel("y [piksel]")

axes[1].plot(np.arange(1, x_max + 1), col_tic, linewidth=0.7)
axes[1].set_title("Średnia TIC per kolumna X — do identyfikacji przerw między tkankami")
axes[1].set_xlabel("x [piksel]")
axes[1].set_ylabel("mean TIC")
axes[1].axhline(col_tic[col_tic > 0].mean() * 0.05, color="red", linestyle="--",
                label="próg 5% mean TIC")
axes[1].legend()

plt.tight_layout()
fig.savefig(OUT / "00_tic_layout.png", dpi=150)
print(f"Saved: {OUT / '00_tic_layout.png'}")

# Print candidate gap columns
threshold = col_tic[col_tic > 0].mean() * 0.05
gap_cols = np.where(col_tic < threshold)[0] + 1  # 1-indexed
print(f"\nKolumny poniżej progu ({threshold:.1f}): {gap_cols}")
