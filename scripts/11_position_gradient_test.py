"""
Test: efekt "tkanki" czy gradient polozenia na szkielku?

Tkanki leza na szkielku w kolejnosci REF -> KETAMIN -> MDMA -> PSYL (x rosnace), wiec gradient fizyczny
(nachylenie plytki, grubosc matrycy, wysokosc probki) jest calkowicie pomieszany z grupa. Rozroznienie:
  slope_within  = nachylenie log-intensywnosci wzgledem x WEWNATRZ tkanek (efekty stale tkanek usuniete),
  slope_between = nachylenie srednich tkanek wzgledem srodka tkanki (4 punkty).
Gradient fizyczny przewiduje slope_between ~ slope_within; efekt tkanki (biologia albo partia skrawka)
przewiduje slope_within ~ 0 przy duzym slope_between. Kontrola pozytywna: przesuniecie masy (ppm).
"""

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
d = dict(np.load(m8.CACHE.parent / "recal_fine.npz"))
tis = m8.tissue_of(d["xy"])
T = list(m8.TISSUES)
R = np.loadtxt(m8.OUT / "ranking_po_rekalibracji.csv", delimiter=";")
F = d["F"].astype(np.float32)
centers = d["edges"][:-1] + 0.01
cs = np.concatenate([np.zeros((len(F), 1), np.float32), np.cumsum(F, axis=1)], axis=1)
x, y = d["xy"][:, 0].astype(float), d["xy"][:, 1].astype(float)


def slopes(v, coord):
    vw = v.copy()
    cw = coord.copy()
    means, cmeans = [], []
    for t in T:
        k = tis == t
        means.append(v[k].mean())
        cmeans.append(coord[k].mean())
        vw[k] -= v[k].mean()
        cw[k] -= coord[k].mean()
    s_w = (vw * cw).sum() / (cw**2).sum()
    s_b = np.polyfit(cmeans, means, 1)[0]
    return s_w, s_b


s_w, s_b = slopes(d["ppm"], x)
print(f"KONTROLA (przesunięcie masy, ppm): nachylenie wewnątrz tkanek = {s_w * 100:.1f} ppm/100 px, "
      f"między tkankami = {s_b * 100:.1f} ppm/100 px")
s_wy, _ = slopes(d["ppm"], y)
print(f"  oraz wzdłuż y wewnątrz tkanek = {s_wy * 100:.1f} ppm/100 px")

tic_w, tic_b = slopes(np.log(d["tic"]), x)
print(f"log TIC po korekcji tła: wewnątrz {tic_w * 100:+.3f} /100px, między {tic_b * 100:+.3f} /100px")

order = np.argsort(R[:, 2])[::-1]
rows = []
for o in order[:200]:
    i = int(np.argmin(np.abs(centers - R[o, 0])))
    a = (cs[:, i + 11] - cs[:, i - 10]) / d["tic"]
    lv = np.log(a + np.percentile(a[a > 0], 5))
    sw, sb = slopes(lv, x)
    rows.append((R[o, 0], R[o, 2], sw * 100, sb * 100))
rows = np.array(rows)
ratio = rows[:, 2] / rows[:, 3]
print("\n200 najmocniej różnicujących pików (po rekalibracji):")
print(f"  mediana nachylenia między tkankami = {np.median(rows[:, 3]):+.3f} log/100px, "
      f"wewnątrz = {np.median(rows[:, 2]):+.3f} log/100px")
print(f"  korelacja (Spearman) nachylenia wewnątrz vs między = {stats.spearmanr(rows[:, 2], rows[:, 3])[0]:.2f}")
print(f"  odsetek pików, gdzie nachylenie wewnątrz ma ten sam znak co między: {100 * np.mean(np.sign(rows[:, 2]) == np.sign(rows[:, 3])):.0f}%")
print(f"  mediana stosunku wewnątrz/między: {np.median(ratio):.2f}")
print("\n  m/z      max|δ|  wewnątrz  między  (log/100px)")
for r in rows[:15]:
    print(f"  {r[0]:8.3f} {r[1]:6.2f} {r[2]:+8.3f} {r[3]:+8.3f}")
for m0 in (444.07, 690.27, 674.29, 353.05, 415.05):
    i = int(np.argmin(np.abs(centers - m0)))
    a = (cs[:, i + 11] - cs[:, i - 10]) / d["tic"]
    lv = np.log(a + np.percentile(a[a > 0], 5))
    sw, sb = slopes(lv, x)
    print(f"  Twoja lista {m0:8.2f}: wewnątrz {sw * 100:+.3f}, między {sb * 100:+.3f}")

fig, ax = plt.subplots(figsize=(6.5, 6))
ax.scatter(rows[:, 3], rows[:, 2], s=10)
lim = np.abs(rows[:, 2:]).max() * 1.1
ax.plot([-lim, lim], [-lim, lim], "r--", lw=0.8, label="gradient fizyczny (wewnątrz = między)")
ax.axhline(0, color="k", lw=0.5)
ax.axvline(0, color="k", lw=0.5)
ax.set_xlabel("nachylenie MIĘDZY tkankami [log/100 px]")
ax.set_ylabel("nachylenie WEWNĄTRZ tkanek [log/100 px]")
ax.legend(fontsize=8)
ax.set_title("200 najmocniej różnicujących pików")
fig.tight_layout()
fig.savefig(m8.OUT / "11_gradient_vs_tkanka.png", dpi=120)
