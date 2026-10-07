"""
Kontrola artefaktu: czy "roznicujace" m/z wynikaja z przesuniecia kalibracji masy miedzy tkankami?

1. Przesuniecie apeksu per tkanka dla wszystkich m/z z cache (lista + kalibranty FMP-10) oraz per piksel
   dla jonu matrycy FMP-10 (lock mass 555.2231) w funkcji pozycji na szkielku (x).
2. Ponowne liczenie roznicowania na intensywnosci ODPORNEJ na przesuniecie: pole calego piku
   wokol apeksu wyznaczonego osobno dla kazdej tkanki (±0.2 Da), zamiast stalego okna m/z ±tol.
3. Jon matrycy: czy najmocniej "roznicujace" piki calego widma koreluja z matryca FMP-10.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy import stats

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import importlib  # noqa: E402

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

m8 = importlib.import_module("08_mz_marker_profile")
OUT = m8.OUT
d = m8.load()
tis, on = d["tissue"], d["on"]
T = list(m8.TISSUES)
NAMES = [m8.TISSUES[t][0] for t in T]


def apex_parabolic(wm, ms, center, half=0.3):
    core = np.flatnonzero(np.abs(wm - center) <= half)
    k = core[np.argmax(ms[core])]
    if 0 < k < len(ms) - 1:
        y0, y1, y2 = ms[k - 1], ms[k], ms[k + 1]
        den = y0 - 2 * y1 + y2
        off = 0.5 * (y0 - y2) / den if den != 0 else 0.0
        return float(wm[k] + off * (wm[1] - wm[0])), k
    return float(wm[k]), k


# ---------------------------------------------------------------- 1. przesuniecia
print("Apeks per tkanka (interpolacja paraboliczna) i przesunięcie względem REF [Da]:")
shifts = []
for j, t0 in enumerate(d["targets"]):
    wm = d["wmz"][j]
    ap = []
    for t in T:
        ms = d["Wr"][on & (tis == t), j].mean(axis=0)
        ap.append(apex_parabolic(wm, ms, t0)[0])
    ap = np.array(ap)
    shifts.append(ap - ap[0])
    print(f"  {t0:9.3f}  apeksy {np.round(ap, 3)}  Δ vs REF {np.round(ap - ap[0], 3)}")
shifts = np.array(shifts)
print("Mediana przesunięcia vs REF [Da]:", dict(zip(NAMES, np.round(np.median(shifts, axis=0), 3))))
print("Mediana przesunięcia vs REF [ppm]:",
      dict(zip(NAMES, np.round(np.median(shifts / d["targets"][:, None] * 1e6, axis=0), 0))))

# per piksel: apeks jonu matrycy 555.22 vs x
jl = int(np.argmin(np.abs(d["targets"] - 555.2231)))
wm = d["wmz"][jl]
W = d["Wr"][:, jl]
core = np.abs(wm - 555.2231) <= 0.3
sub = np.clip(W[:, core], 0, None)
px_apex = (sub * wm[core]).sum(axis=1) / np.maximum(sub.sum(axis=1), 1e-9)  # centroid
ok = sub.sum(axis=1) > np.percentile(sub.sum(axis=1), 10)
rho, _ = stats.spearmanr(d["xy"][ok, 0], px_apex[ok])
print(f"\nCentroid jonu 555.22 per piksel vs pozycja x na szkiełku: Spearman ρ = {rho:.2f}")
for t, n in zip(T, NAMES):
    k = ok & (tis == t)
    r_in = stats.spearmanr(d["xy"][k, 0], px_apex[k])[0]
    r_y = stats.spearmanr(d["xy"][k, 1], px_apex[k])[0]
    print(f"  {n:8s} mediana centroidu {np.median(px_apex[k]):.4f}  ρ(x w tkance)={r_in:+.2f}  ρ(y)={r_y:+.2f}")

# ---------------------------------------------------------------- 2. intensywnosc odporna na przesuniecie
def cliff_set(v):
    g = [v[on & (tis == t)] for t in T]
    pairs = {f"{NAMES[a]}|{NAMES[b]}": 2 * m8.auc(g[a], g[b]) - 1 for a in range(4) for b in range(a + 1, 4)}
    H, _ = stats.kruskal(*g)
    eps = (H - 3) / (sum(map(len, g)) - 4)
    med = [np.median(x) for x in g]
    return pairs, eps, med


print("\nPorównanie: stałe okno m/z ±0.1 (jak w appce) vs pole piku wokół apeksu własnej tkanki (±0.2 Da):")
print(f"{'m/z':>8s} {'apeksy':>30s} | {'ε² okno':>8s} {'max|δ| okno':>11s} | {'ε² pik':>7s} {'max|δ| pik':>10s} | mediany (pik) REF/KET/MDMA/PSYL")
rows = []
for m0 in m8.USER_LIST:
    j = int(np.argmin(np.abs(d["targets"] - m0)))
    wm = d["wmz"][j]
    v_win = m8.intensity(d, m0, 0.1)
    v_pk = np.zeros(len(tis))
    aps = []
    for t in T:
        k = on & (tis == t)
        ap, _ = apex_parabolic(wm, d["Wr"][k, j].mean(axis=0), m0, 0.35)
        aps.append(ap)
        sel = np.abs(wm - ap) <= 0.2
        v_pk[k] = np.clip(d["Wr"][k, j][:, sel], 0, None).sum(axis=1)
    v_pk = v_pk / d["tic_bg"] * np.median(d["tic_bg"])
    p1, e1, _ = cliff_set(v_win)
    p2, e2, med2 = cliff_set(v_pk)
    mx1 = max(abs(x) for x in p1.values())
    mx2 = max(abs(x) for x in p2.values())
    rows.append((m0, aps, e1, mx1, e2, mx2, med2, p2))
    print(f"{m0:8.2f} {str(np.round(aps, 2)):>30s} | {e1:8.3f} {mx1:11.2f} | {e2:7.3f} {mx2:10.2f} | "
          + "/".join(f"{x:.2f}" for x in med2))

print("\nCliff δ par (pole piku) — najsilniejsze pary:")
for m0, *_, p2 in rows:
    best = sorted(p2.items(), key=lambda kv: -abs(kv[1]))[:3]
    print(f"  {m0:8.2f}: " + ", ".join(f"{k} {v:+.2f}" for k, v in best))

# ---------------------------------------------------------------- 3. matryca
lock = m8.intensity(d, 555.2231, 0.15, "none")
print("\nJon matrycy FMP-10 (555.22, bez normalizacji) — mediana per tkanka:",
      dict(zip(NAMES, [round(float(np.median(lock[on & (tis == t)])), 2) for t in T])))
print("TIC po korekcji tła — mediana per tkanka:",
      dict(zip(NAMES, [round(float(np.median(d["tic_bg"][on & (tis == t)])), 0) for t in T])))
R = np.loadtxt(OUT / "ranking_pikow.csv", delimiter=";")
top = R[np.argsort(R[:, 2])[::-1][:40], 0]
Bn = d["B"] / d["tic_bg"][:, None]
lock_n = lock / d["tic_bg"]
cors = []
for mzb in top:
    b = int(np.argmin(np.abs(d["centers"] - mzb)))
    cors.append(stats.spearmanr(Bn[on, b], lock_n[on])[0])
print(f"40 najmocniej różnicujących binów: mediana ρ z jonem matrycy 555.22 = {np.median(cors):.2f}; "
      f"w zakresie 530–610 Da leży {(np.abs(top - 570) <= 40).sum()}/40")

# wykres
fig, axs = plt.subplots(1, 3, figsize=(17, 4.6))
for i, n in enumerate(NAMES[1:], start=1):
    axs[0].scatter(d["targets"], shifts[:, i] * 1e3, label=n, color=m8.TCOL[T[i]])
axs[0].axhline(0, color="k", lw=0.6)
axs[0].set_xlabel("m/z")
axs[0].set_ylabel("przesunięcie apeksu vs REF [mDa]")
axs[0].legend()
axs[0].set_title("Przesunięcie kalibracji masy między tkankami")
img = np.full((d["xy"][:, 1].max() + 1, d["xy"][:, 0].max() + 1), np.nan)
img[d["xy"][ok, 1], d["xy"][ok, 0]] = px_apex[ok]
im = axs[1].imshow(img[30:, 30:], cmap="coolwarm", vmin=np.percentile(px_apex[ok], 5),
                   vmax=np.percentile(px_apex[ok], 95), aspect="auto", interpolation="nearest")
plt.colorbar(im, ax=axs[1])
axs[1].set_title("Centroid jonu matrycy 555.22 per piksel (m/z)")
x = np.arange(len(rows))
axs[2].bar(x - 0.2, [r[3] for r in rows], 0.4, label="okno m/z ±0.1 (stałe)")
axs[2].bar(x + 0.2, [r[5] for r in rows], 0.4, label="pole piku wokół apeksu tkanki")
axs[2].set_xticks(x, [f"{r[0]:g}" for r in rows], rotation=45)
axs[2].set_ylabel("max |Cliff δ| między tkankami")
axs[2].legend(fontsize=8)
axs[2].set_title("Różnicowanie: okno stałe vs odporne na przesunięcie")
fig.tight_layout()
fig.savefig(OUT / "09_przesuniecie_masy.png", dpi=120)
