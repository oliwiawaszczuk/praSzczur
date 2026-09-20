"""Średnie widma per tkanka — wizualizacja i zapis do praOutputs/."""

from pathlib import Path
import sys

import numpy as np
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

DATA = ROOT / "data" / "processed"
OUT = ROOT / "praOutputs"
OUT.mkdir(exist_ok=True)

TISSUES = ["T1_ref", "T2", "T3", "T4"]
LABELS  = ["T1 (ref)", "T2", "T3", "T4"]
COLORS  = ["#2c7bb6", "#d7191c", "#fdae61", "#1a9641"]

# ── Wczytanie ──────────────────────────────────────────────────────────────
data = {}
for t in TISSUES:
    d = np.load(DATA / f"{t}.npz")
    data[t] = {"spectra": d["spectra"], "mz_bins": d["mz_bins"]}

mz = data["T1_ref"]["mz_bins"]
means = {t: data[t]["spectra"].mean(axis=0) for t in TISSUES}
stds  = {t: data[t]["spectra"].std(axis=0)  for t in TISSUES}

# ── Wykres 1: nałożone średnie widma (pełny zakres) ───────────────────────
fig, ax = plt.subplots(figsize=(18, 5))
for t, label, color in zip(TISSUES, LABELS, COLORS):
    ax.plot(mz, means[t], color=color, linewidth=0.6, label=label, alpha=0.85)

ax.set_xlabel("m/z [Da]", fontsize=11)
ax.set_ylabel("Średnia intensywność [counts]", fontsize=11)
ax.set_title("Średnie widma MALDI-TOF — FMP10 Rat Brain (bregma 0.84)", fontsize=13)
ax.legend(fontsize=10)
ax.xaxis.set_major_locator(ticker.MultipleLocator(100))
ax.xaxis.set_minor_locator(ticker.MultipleLocator(50))
ax.set_xlim(mz[0], mz[-1])
ax.grid(axis="x", which="major", linewidth=0.3, alpha=0.5)
plt.tight_layout()
fig.savefig(OUT / "02a_mean_spectra_overlay.png", dpi=150)
plt.close()
print("Saved: 02a_mean_spectra_overlay.png")

# ── Wykres 2: osobne panele z odchyleniem standardowym ────────────────────
fig, axes = plt.subplots(4, 1, figsize=(18, 14), sharex=True)
for ax, t, label, color in zip(axes, TISSUES, LABELS, COLORS):
    m, s = means[t], stds[t]
    ax.fill_between(mz, m - s, m + s, color=color, alpha=0.18)
    ax.plot(mz, m, color=color, linewidth=0.7, label=label)
    ax.set_ylabel("Intensywność", fontsize=9)
    ax.set_title(label, fontsize=10, loc="left", pad=2)
    ax.set_xlim(mz[0], mz[-1])
    ax.xaxis.set_major_locator(ticker.MultipleLocator(100))
    ax.grid(axis="x", which="major", linewidth=0.3, alpha=0.5)

axes[-1].set_xlabel("m/z [Da]", fontsize=11)
fig.suptitle("Średnie widma ± SD per tkanka", fontsize=13, y=1.01)
plt.tight_layout()
fig.savefig(OUT / "02b_mean_spectra_panels.png", dpi=150, bbox_inches="tight")
plt.close()
print("Saved: 02b_mean_spectra_panels.png")

# ── Wykres 3: zoom na kluczowe zakresy neuroprzekaźników ──────────────────
# Typowe lipidy/neuroprzekaźniki w MALDI: 400-1000 Da
REGIONS = [
    (300, 500,  "Małe cząsteczki / neuroprzekaźniki"),
    (500, 800,  "Lipidy / fosfolipidy"),
    (800, 1200, "Sfingolipidy / gangliozydy"),
]

fig, axes = plt.subplots(len(REGIONS), 1, figsize=(18, 11))
for ax, (lo, hi, title) in zip(axes, REGIONS):
    mask = (mz >= lo) & (mz <= hi)
    for t, label, color in zip(TISSUES, LABELS, COLORS):
        ax.plot(mz[mask], means[t][mask], color=color, linewidth=0.8, label=label, alpha=0.9)
    ax.set_title(f"{title}  ({lo}–{hi} Da)", fontsize=10, loc="left")
    ax.set_ylabel("Intensywność", fontsize=9)
    ax.xaxis.set_major_locator(ticker.MultipleLocator(50))
    ax.xaxis.set_minor_locator(ticker.MultipleLocator(10))
    ax.grid(axis="x", which="major", linewidth=0.3, alpha=0.5)
    ax.legend(fontsize=9, loc="upper right")

axes[-1].set_xlabel("m/z [Da]", fontsize=11)
fig.suptitle("Zoom na zakresy biologicznie istotne", fontsize=13)
plt.tight_layout()
fig.savefig(OUT / "02c_mean_spectra_zoom.png", dpi=150)
plt.close()
print("Saved: 02c_mean_spectra_zoom.png")

# ── Statystyki do raportu ─────────────────────────────────────────────────
print("\n── Statystyki peak intensywności (max średniego widma) ──")
for t, label in zip(TISSUES, LABELS):
    m = means[t]
    top5_idx = np.argsort(m)[::-1][:5]
    print(f"\n{label}:")
    for i in top5_idx:
        print(f"  m/z = {mz[i]:.2f} Da   mean intensity = {m[i]:.1f}")
