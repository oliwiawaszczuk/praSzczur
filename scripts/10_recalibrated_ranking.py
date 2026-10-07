"""
Ranking roznicujacych m/z PO rekalibracji masy per piksel (lock mass FMP-10 555.2231) i na cechach
odpornych na przesuniecie (pole piku ±0.2 Da wokol apeksu ze sredniego, zrekalibrowanego widma).

Model korekcji: przesuniecie stale w ppm (z 09_mass_shift_check: ~20/50/62 ppm KET/MDMA/PSYL vs REF,
w przyblizeniu stale w ppm w 300-960 Da). ppm per piksel = centroid(555.22) vs teoria; gdy jon matrycy
jest slaby (<10. percentyl) -> mediana ppm tkanki.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy import stats
from scipy.signal import find_peaks

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import importlib  # noqa: E402

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

m8 = importlib.import_module("08_mz_marker_profile")
OUT = m8.OUT
LOCK = 555.2231
FINE = 0.02
MZ_LO, MZ_HI = 300.0, 1000.0
CACHE = m8.CACHE.parent / "recal_fine.npz"


def build():
    from src.msi.loader import open_parser

    p = open_parser()
    xy = np.array(p.coordinates)[:, :2]
    mz = np.asarray(p.getspectrum(0)[0])
    sel = (mz >= MZ_LO - 1) & (mz <= MZ_HI + 1)
    mzs = mz[sel]
    edges = np.arange(MZ_LO, MZ_HI + FINE, FINE)
    lockw = np.abs(mz - LOCK) <= 0.3
    n = len(xy)
    ppm = np.zeros(n)
    lock_int = np.zeros(n)
    for i in range(n):  # pass 1: centroid jonu matrycy
        x = np.asarray(p.getspectrum(i)[1], dtype=np.float64)
        w = np.clip(x[lockw] - np.median(x[lockw]), 0, None)
        lock_int[i] = w.sum()
        ppm[i] = ((w * mz[lockw]).sum() / max(w.sum(), 1e-9) - LOCK) / LOCK * 1e6
    tis = m8.tissue_of(xy)
    weak = lock_int < np.percentile(lock_int, 10)
    for t in m8.TISSUES:
        k = tis == t
        ppm[k & weak] = np.median(ppm[k & ~weak])
    ppm = np.clip(ppm, -200, 200)
    F = np.zeros((n, len(edges) - 1), np.float16)
    tic = np.zeros(n)
    for i in range(n):  # pass 2: korekcja osi + korekcja tla + biny 0.02 Da
        x = np.asarray(p.getspectrum(i)[1], dtype=np.float64)
        y = np.clip(x - m8.baseline_block(x), 0, None)
        tic[i] = y.sum()
        mz_c = mzs * (1 - ppm[i] * 1e-6)
        F[i] = np.histogram(mz_c, bins=edges, weights=y[sel])[0].astype(np.float16)
        if i % 4000 == 0:
            print(f"  {i}/{n}", flush=True)
    np.savez(CACHE, F=F, ppm=ppm, lock_int=lock_int, tic=tic, xy=xy, edges=edges)


if not CACHE.exists():
    print("Rekalibracja i binowanie 0.02 Da (2 przejścia po imzML)...")
    build()
d = dict(np.load(CACHE))
tis = m8.tissue_of(d["xy"])
T = list(m8.TISSUES)
NAMES = [m8.TISSUES[t][0] for t in T]
centers = d["edges"][:-1] + FINE / 2
print("ppm per piksel (mediana per tkanka):", {n: round(float(np.median(d["ppm"][tis == t])), 1) for t, n in zip(T, NAMES)})

F = d["F"].astype(np.float32)
mean = F.mean(axis=0)
# piki w zrekalibrowanym srednim widmie
noise = 1.4826 * np.median(np.abs(np.diff(mean))) / np.sqrt(2)
pk, _ = find_peaks(mean, prominence=8 * noise, distance=int(0.15 / FINE))
print(f"piki w zrekalibrowanym średnim widmie: {len(pk)}")
half = int(round(0.2 / FINE))
cs = np.concatenate([np.zeros((len(F), 1), np.float32), np.cumsum(F, axis=1)], axis=1)
lo = np.clip(pk - half, 0, F.shape[1])
hi = np.clip(pk + half + 1, 0, F.shape[1])
A = (cs[:, hi] - cs[:, lo]) / d["tic"][:, None] * np.median(d["tic"])  # pole piku, TIC po korekcji tla
apex = centers[pk]

rows = []
for i in range(len(pk)):
    v = A[:, i]
    g = [v[tis == t] for t in T]
    H, _ = stats.kruskal(*g)
    eps = (H - 3) / (len(v) - 4)
    pairs = [2 * m8.auc(g[a], g[b]) - 1 for a in range(4) for b in range(a + 1, 4)]
    mi = np.mean([m8.morans_i(m8.grid(d["xy"][tis == t], v[tis == t])) for t in T])
    med = [float(np.median(x)) for x in g]
    rows.append((apex[i], eps, max(abs(x) for x in pairs), mi, mean[pk[i]], *med, *pairs))
R = np.array(rows)
pair_names = [f"{NAMES[a]}|{NAMES[b]}" for a in range(4) for b in range(a + 1, 4)]
np.savetxt(OUT / "ranking_po_rekalibracji.csv", R, delimiter=";", fmt="%.4f",
           header="apex_mz;epsilon2_KW;max_abs_cliff;moran_I;mean_height;"
           + ";".join(f"median_{n}" for n in NAMES) + ";" + ";".join(f"cliff_{p}" for p in pair_names))

# monotonicznosc wzdluz szkielka (REF<KET<MDMA<PSYL lub odwrotnie) — sygnal ostrzegawczy resztkowego artefaktu
mono = np.array([abs(stats.spearmanr([0, 1, 2, 3], r[5:9])[0]) == 1.0 for r in R])
print(f"odsetek pików z idealnie monotonicznym porządkiem median wzdłuż szkiełka: {100 * mono.mean():.0f}% "
      f"(oczekiwane losowo: {100 * 2 / 24:.0f}%)")

ok = (R[:, 3] > 0.3)  # struktura przestrzenna
order = np.argsort(R[:, 2])[::-1]
print("\nTOP 30 po rekalibracji (pole piku), tylko piki z Moran I > 0.3:")
print(f"{'apeks':>8s} {'max|δ|':>6s} {'ε²':>5s} {'I':>5s}  mediany REF/KET/MDMA/PSYL   najsilniejsza para        mono  kandydat FMP-10")
shown = 0
for o in order:
    if not ok[o]:
        continue
    pr = R[o, 9:]
    b = int(np.argmax(np.abs(pr)))
    cand = "; ".join(m8.fmp_candidates(R[o, 0], 0.05)) or "-"
    print(f"{R[o, 0]:8.3f} {R[o, 2]:6.2f} {R[o, 1]:5.2f} {R[o, 3]:5.2f}  "
          + "/".join(f"{x:.2f}" for x in R[o, 5:9])
          + f"   {pair_names[b]:14s} {pr[b]:+.2f}   {'TAK' if mono[o] else '   '}  {cand}")
    shown += 1
    if shown == 30:
        break

print("\nTwoja lista po rekalibracji (najbliższy pik ±0.3 Da):")
for m0 in m8.USER_LIST:
    i = int(np.argmin(np.abs(R[:, 0] - m0)))
    if abs(R[i, 0] - m0) > 0.3:
        print(f"  {m0:8.2f}: brak piku")
        continue
    pct = stats.percentileofscore(R[:, 2], R[i, 2])
    print(f"  {m0:8.2f} → pik {R[i, 0]:.3f}: max|δ|={R[i, 2]:.2f} (percentyl {pct:.0f}), ε²={R[i, 1]:.3f}, I={R[i, 3]:.2f}, "
          f"mediany " + "/".join(f"{x:.2f}" for x in R[i, 5:9]) + f"  {'; '.join(m8.fmp_candidates(R[i, 0], 0.05)) or ''}")

print("\nZnane neuroprzekaźniki (FMP-10), po rekalibracji:")
for name, m in m8.NEURO.items():
    for tag, val in (("1A", m + m8.FMP1), ("2A", m + 2 * m8.FMP1 - 15.0235), ("2B", m + 2 * m8.FMP1 - 1.0078)):
        if not (MZ_LO < val < MZ_HI):
            continue
        i = int(np.argmin(np.abs(R[:, 0] - val)))
        if abs(R[i, 0] - val) <= 0.04:
            print(f"  {name:20s} {tag} {val:9.3f} → pik {R[i, 0]:.3f} (Δ {1e6 * (R[i, 0] - val) / val:+.0f} ppm) "
                  f"max|δ|={R[i, 2]:.2f} ε²={R[i, 1]:.3f} I={R[i, 3]:.2f} mediany " + "/".join(f"{x:.2f}" for x in R[i, 5:9]))

fig, ax = plt.subplots(figsize=(9, 5))
ax.scatter(R[:, 3], R[:, 2], s=8, c=np.where(mono, "#d62728", "#999"), alpha=0.7)
ax.set_xlabel("Moran I (struktura przestrzenna)")
ax.set_ylabel("max |Cliff δ| między tkankami")
ax.set_title("Piki po rekalibracji — czerwone: monotoniczny porządek wzdłuż szkiełka (podejrzane)")
fig.tight_layout()
fig.savefig(OUT / "10_ranking_po_rekalibracji.png", dpi=120)
