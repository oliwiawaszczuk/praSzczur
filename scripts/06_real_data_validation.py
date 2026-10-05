"""
Walidacja metod na PRAWDZIWYCH widmach (bez wstrzykiwania): FMP10, probka 300 surowych pikseli.

Idea "od duzych pikow do malych" (sugestia prowadzacego): piki referencyjne wyznaczamy ze SREDNIEGO
widma 300 pikseli (tam sa pewne), dzielimy na warstwy wg sily wzgledem szumu pojedynczego piksela,
a potem pytamy: jaka czesc pikow z kazdej warstwy wykrywa metoda na POJEDYNCZYM pikselu przy progu
SNR=3 (lokalny MAD jak w MALDIquant) i ile detekcji nie ma pokrycia w piku referencyjnym (proxy FP).

Dodatkowo: CV per kanal m/z, kalibracja FWHM(m/z), porownanie normalizacji (TIC/mediana/RMS/szum).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d, median_filter, uniform_filter1d
from scipy.signal import find_peaks, peak_widths, savgol_filter

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

OUT = ROOT / "praOutputs"
d = np.load(ROOT / "data" / "interim" / "raw_sample.npz")
S, mz = d["spectra"].astype(float), d["mz"]
step = float(np.median(np.diff(mz)))
N_PIX = 100


def local_sigma(x: np.ndarray, size: int = 301) -> np.ndarray:
    return 1.4826 * median_filter(np.abs(x), size=size, mode="nearest") + 1e-9


def prep(x):
    return x - median_filter(x, size=301, mode="nearest")


# ------------------------------------------------ 1. FWHM vs m/z (z sredniego widma)
mean = S.mean(axis=0)
mean_d = prep(mean)
sig_mean = local_sigma(mean_d)
pk, _ = find_peaks(mean_d, prominence=6 * sig_mean[0] * 0 + 4 * np.median(sig_mean))
fw = peak_widths(mean_d, pk, 0.5)[0] * step
ok = (fw > 0.03) & (fw < 0.5)
print(f"piki w średnim widmie: {len(pk)}, mediana FWHM = {np.median(fw[ok]):.3f} Da")
for lo, hi in [(300, 450), (450, 600), (600, 800), (800, 1100), (1100, 1500)]:
    m = ok & (mz[pk] >= lo) & (mz[pk] < hi)
    if m.sum():
        print(f"  {lo}-{hi}: n={m.sum():4d}  FWHM mediana={np.median(fw[m]):.3f}  (pikseli: {np.median(fw[m])/step:.1f})")

# ------------------------------------------------ 2. warstwy pikow referencyjnych
noise_px = np.median(np.array([local_sigma(prep(x))[::50] for x in S[:50]]), axis=0)  # coarse
sig_px_full = np.interp(np.arange(len(mz)), np.arange(len(mz))[::50], noise_px)
ref_pk, props = find_peaks(mean_d, prominence=5 * np.median(sig_mean))
strength = mean_d[ref_pk] / sig_px_full[ref_pk]  # wysokosc sredniego piku / szum pojedynczego piksela
tiers = {"silne (>5σ_px)": strength > 5, "średnie (1–5σ_px)": (strength > 1) & (strength <= 5),
         "słabe (<1σ_px)": strength <= 1}
print("\nPiki referencyjne (ze średniego widma):", len(ref_pk))
for k, m in tiers.items():
    print(f"  {k}: {m.sum()}")

methods = {
    "surowe": lambda x: x,
    "MA w=3": lambda x: uniform_filter1d(x, 3, mode="nearest"),
    "SG 7/2": lambda x: savgol_filter(x, 7, 2),
    "SG 15/3 (appka)": lambda x: savgol_filter(x, 15, 3),
    "Gauss σ=1": lambda x: gaussian_filter1d(x, 1.0, mode="nearest"),
}
TOL = 0.07
FP_TARGET = 2.0  # detekcji bez pokrycia w pikach ref. na 100 Da
mask_ref = np.zeros(len(mz), bool)
for p in ref_pk:
    mask_ref[max(p - 5, 0): p + 6] = True
da_total = (mz[-1] - mz[0]) * N_PIX
THRS = np.linspace(1.5, 20, 75)
tier_masks = list(tiers.values())
curves = {}
res = {}
print(f"\nRecall pikow referencyjnych na POJEDYNCZYM pikselu, progi dobrane tak, by FP = {FP_TARGET}/100 Da (uczciwe porownanie)")
print(f"{'metoda':18s} " + " ".join(f"{t:>20s}" for t in tiers) + "    prog SNR")
for name, f in methods.items():
    dets = []  # (z_values, near_ref_dist_by_tier)
    for x in S[:N_PIX]:
        y = f(prep(x))
        z = y / local_sigma(y)
        det, _ = find_peaks(z)
        dets.append((det, z[det]))
    fp_c, rec_c = [], []
    for thr in THRS:
        fp_n = 0
        hits = np.zeros(len(tiers))
        for det, zz in dets:
            dt = det[zz >= thr]
            fp_n += int((~mask_ref[dt]).sum())
            if len(dt) == 0:
                continue
            for ti, m in enumerate(tier_masks):
                rp = ref_pk[m]
                pos = np.searchsorted(dt, rp)
                l = np.abs(dt[np.clip(pos - 1, 0, len(dt) - 1)] - rp)
                r = np.abs(dt[np.clip(pos, 0, len(dt) - 1)] - rp)
                hits[ti] += int((np.minimum(l, r) * step <= TOL).sum())
        fp_c.append(fp_n / da_total * 100)
        rec_c.append(hits / np.array([m.sum() * N_PIX for m in tier_masks]))
    fp_c, rec_c = np.array(fp_c), np.array(rec_c)
    curves[name] = (fp_c, rec_c)
    i = int(np.argmax(fp_c <= FP_TARGET))
    res[name] = {t: rec_c[i][j] for j, t in enumerate(tiers)}
    print(f"{name:18s} " + " ".join(f"{res[name][t]:20.3f}" for t in tiers) + f"    {THRS[i]:.1f}")

# ------------------------------------------------ 3. CV per kanal
base = np.median(S, axis=1, keepdims=True)
A = np.clip(S - base, 0, None)  # bez offsetu detektora
mu = A.mean(axis=0)
cv = A.std(axis=0) / np.maximum(mu, 1e-9)
sig_mean_full = np.interp(np.arange(len(mz)), np.arange(len(mz)), local_sigma(prep(mean)))
is_peak = np.zeros(len(mz), bool)
for p in ref_pk:
    is_peak[max(p - 2, 0): p + 3] = True
print("\nCV kanału (po odjęciu offsetu): mediana — piki ref: %.2f | tło: %.2f" % (np.median(cv[is_peak]), np.median(cv[~is_peak & (mu > 0)])))
for lo, hi in [(300, 600), (600, 900), (900, 1500)]:
    k = (mz >= lo) & (mz < hi) & ~is_peak
    print(f"  tło {lo}-{hi}: CV mediana={np.median(cv[k]):.2f}")
# separacja piki-vs-tlo wg CV (AUC) i wg sredniej intensywnosci
from sklearn.metrics import roc_auc_score  # noqa: E402

auc_cv = roc_auc_score(is_peak, cv)
auc_mu = roc_auc_score(is_peak, mu)
auc_z = roc_auc_score(is_peak, mu / np.maximum(A.std(axis=0), 1e-9))
print(f"AUC piki-vs-tło: CV={auc_cv:.3f}  średnia={auc_mu:.3f}  średnia/SD (odw. CV)={auc_z:.3f}")

# ------------------------------------------------ 4. normalizacje
pk_top = ref_pk[np.argsort(mean_d[ref_pk])[::-1][:12]]
offset_share = np.median(S, axis=1) * S.shape[1] / S.sum(axis=1)
print(f"\nUdzial offsetu detektora (mediana*N) w surowym TIC: {100*np.median(offset_share):.0f}%  (TIC liczony na surowych widmach normalizuje glownie offset!)")
B = np.array([x - median_filter(x, size=301, mode="nearest") for x in S])  # po korekcji linii bazowej
Bc = np.clip(B, 0, None)
non_peak = ~is_peak
norms = {
    "brak": np.ones(len(S)),
    "TIC surowy": S.sum(axis=1),
    "TIC po korekcji tła": Bc.sum(axis=1),
    "szum (MAD tła)": np.array([1.4826 * np.median(np.abs(b[non_peak])) for b in B]),
    "RMS po korekcji": np.sqrt((Bc**2).mean(axis=1)),
    "mediana niezerowych": np.array([np.median(b[b > 0]) for b in Bc]),
}
print("CV miedzypikselowe 12 najsilniejszych pikow po normalizacji (PROXY: tkanka nie jest jednorodna, nizsze != lepsze bez zastrzezen):")
for k, f in norms.items():
    Z = Bc[:, pk_top] / f[:, None]
    print(f"  {k:24s} mediana CV = {np.median(Z.std(axis=0) / Z.mean(axis=0)):.3f}")
print("  zmiennosc wspolczynnika (CV) per piksel: " + ", ".join(f"{k}={np.std(f)/np.mean(f):.2f}" for k, f in norms.items() if k != "brak"))

# ------------------------------------------------ wykresy
fig, ax = plt.subplots(1, 3, figsize=(16, 4.2))
ax[0].scatter(mz[pk][ok], fw[ok], s=8)
ax[0].set_xlabel("m/z"); ax[0].set_ylabel("FWHM [Da]"); ax[0].set_title("Szerokość pików vs m/z (średnie widmo)")
ax[1].plot(mz, cv, lw=0.4); ax[1].set_title("CV kanału m/z (po odjęciu offsetu)"); ax[1].set_xlabel("m/z"); ax[1].set_ylim(0, 8)
ax[2].hist([cv[is_peak], cv[~is_peak & (mu > 0)]], bins=60, label=["piki ref.", "tło"], density=True, range=(0, 8))
ax[2].legend(); ax[2].set_title(f"CV: piki vs tło  (AUC={auc_cv:.2f})")
fig.tight_layout(); fig.savefig(OUT / "06a_fwhm_cv.png", dpi=140); plt.close(fig)

fig, ax = plt.subplots(figsize=(9, 4.5))
w = 0.16
for i, name in enumerate(methods):
    ax.bar(np.arange(3) + i * w, [res[name][t] for t in tiers], w, label=name)
ax.set_xticks(np.arange(3) + 2 * w); ax.set_xticklabels(list(tiers)); ax.set_ylabel("recall pikow ref. (1 piksel, SNR≥3)")
ax.legend(fontsize=8); ax.set_title("Wykrywanie pikow ref. na pojedynczych pikselach, wg siły piku")
fig.tight_layout(); fig.savefig(OUT / "06b_real_recall_by_tier.png", dpi=140); plt.close(fig)
