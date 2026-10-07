"""
Porownanie lancuchow preprocessingu na calej tkance T1 (surowe widma) wg spojnosci przestrzennej.

Miara: Moran's I (sasiedztwo 4-polaczeniowe) map jonowych poszczegolnych binow m/z. Prawdziwy sygnal
biologiczny tworzy struktury w tkance (I > 0), szum i artefakty pojedynczych pikseli nie (I ~ 0).
Raportujemy srednie I dla (a) 300 najsilniejszych binow 0.5 Da (ten sam zestaw dla wszystkich lancuchow,
wyznaczony po korekcji tla) i (b) binow w regionie 1000-1500 Da (szum; im nizsze, tym mniej artefaktow).
UWAGA: miara premiuje wygladzanie przestrzenne, wiec NIE uzywamy jej do oceny filtrow przestrzennych.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import median_filter

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
from src.msi.preprocessing import (  # noqa: E402
    baseline_correction_snip, peak_pick, peak_pick_snr, smooth_matched,
)

BIN = 0.5
X_RANGE = (35, 107)  # T1_ref
CACHE = Path("/private/tmp/claude-501/-Users-praoliwia-Desktop-Study-AI-MED-praSzczur/"
             "11795fcb-4ebc-4105-a975-a0f374ba83a4/scratchpad/T1_raw.npz")


def load_t1():
    if CACHE.exists():
        d = np.load(CACHE)
        return d["S"], d["mz"], d["xy"]
    from src.msi.loader import open_parser

    p = open_parser()
    xy = np.array(p.coordinates)[:, :2]
    idx = np.where((xy[:, 0] >= X_RANGE[0]) & (xy[:, 0] <= X_RANGE[1]))[0]
    mz = np.asarray(p.getspectrum(int(idx[0]))[0])
    S = np.array([np.asarray(p.getspectrum(int(i))[1], dtype=np.float32) for i in idx])
    np.savez(CACHE, S=S, mz=mz, xy=xy[idx])
    return S, mz, xy[idx]


S, mz, xy = load_t1()
print("T1:", S.shape)
edges = np.arange(mz[0], mz[-1] + BIN, BIN)
b_idx = np.digitize(mz, edges) - 1
nb = b_idx.max() + 1
starts = np.r_[0, np.flatnonzero(np.diff(b_idx)) + 1]
centers = edges[: len(starts)] + BIN / 2


def bin_sum(x):
    return np.add.reduceat(x, starts)


def bin_max(x):
    return np.maximum.reduceat(x, starts)


def tic(x):
    t = x.sum()
    return x / t if t > 0 else x


def rows(fn, X=S):
    return np.array([fn(x.astype(np.float64)) for x in X])


# ---- siatka pikseli
x0, y0 = xy.min(axis=0)
H, W = xy[:, 1].max() - y0 + 1, xy[:, 0].max() - x0 + 1
gy, gx = xy[:, 1] - y0, xy[:, 0] - x0
present = np.zeros((H, W), bool)
present[gy, gx] = True


def moran(F: np.ndarray) -> np.ndarray:
    """Moran's I per kolumna (bin) dla macierzy (n_pikseli, n_binow)."""
    n, B = F.shape
    img = np.zeros((H, W, B), np.float64)
    img[gy, gx] = F - F.mean(axis=0)
    m = present[..., None]
    pair_h = present[:, 1:] & present[:, :-1]
    pair_v = present[1:, :] & present[:-1, :]
    num = (img[:, 1:] * img[:, :-1] * pair_h[..., None]).sum((0, 1)) \
        + (img[1:] * img[:-1] * pair_v[..., None]).sum((0, 1))
    w = pair_h.sum() + pair_v.sum()
    den = ((img * m) ** 2).sum((0, 1))
    return (n / (2 * w)) * (2 * num) / np.maximum(den, 1e-12) * 1.0


# ---- lancuchy
def nobase(x):  # linia bazowa medianowa na surowym widmie (offset detektora)
    return np.clip(x - median_filter(x, size=301, mode="nearest"), 0, None)


def pp_binned(x):
    return peak_pick(centers, x, 0.02)[0]


pipes = {}
Xs = {}
print("liczenie lancuchow...")
Xsum = rows(bin_sum)
Xs["P0n bin(sum) → TIC"] = rows(tic, Xsum)
Xs["P0  bin(sum) → TIC → peakpick (Twój)"] = rows(pp_binned, Xs["P0n bin(sum) → TIC"])
Xs["P1  bin(max) → TIC → peakpick"] = rows(pp_binned, rows(tic, rows(bin_max)))
Xs["P2  bin(sum) → SNIP → TIC → peakpick"] = rows(
    pp_binned, rows(lambda x: tic(baseline_correction_snip(x, 40)[0]), Xsum))
Xs["P5  tło(mediana,raw) → bin(sum) → TIC"] = rows(lambda x: tic(bin_sum(nobase(x))))
Xs["P6  P5 → peakpick"] = rows(pp_binned, Xs["P5  tło(mediana,raw) → bin(sum) → TIC"])
Xs["P7  SNR-piki(raw) → bin(sum) → TIC"] = rows(
    lambda x: tic(bin_sum(peak_pick_snr(mz, x, 4.0, 10.0, 0.1, "centroidy")[0] - 0.0)))
Xs["P8  tło → SNR-piki(raw) → bin(sum) → TIC"] = rows(
    lambda x: tic(bin_sum(peak_pick_snr(mz, nobase(x), 4.0, 10.0, 0.1, "centroidy")[0])))
Xs["P9  dopasowane → SNR-piki → bin(sum) → TIC"] = rows(
    lambda x: tic(bin_sum(peak_pick_snr(mz, smooth_matched(mz, nobase(x)), 4.0, 10.0, 0.1, "centroidy")[0])))
Xs["P10 P5 → sqrt"] = np.sqrt(Xs["P5  tło(mediana,raw) → bin(sum) → TIC"])
Xs["P11 P8 → sqrt"] = np.sqrt(Xs["P8  tło → SNR-piki(raw) → bin(sum) → TIC"])

ref = Xs["P5  tło(mediana,raw) → bin(sum) → TIC"]
top = np.argsort(ref.mean(axis=0))[::-1][:300]
noise_bins = np.flatnonzero(centers >= 1000)
print(f"\n{'łańcuch':52s} {'I(top300)':>10s} {'I(szum>1000)':>13s} {'niezerowe/px':>13s}")
res = {}
for name, X in Xs.items():
    I = moran(X)
    nz = (X > 0).sum(axis=1).mean()
    res[name] = (I[top].mean(), I[noise_bins].mean(), nz)
    print(f"{name:52s} {I[top].mean():10.3f} {I[noise_bins].mean():13.3f} {nz:13.0f}")


# ================= część 2: normalizacja po korekcji tła, lista pikow globalna, robustnosc zbioru top300
print("\n--- robustność: top300 wyznaczone z P0n (bez korekcji tła) ---")
top_alt = np.argsort(Xs["P0n bin(sum) → TIC"].mean(axis=0))[::-1][:300]
for name in ("P0n bin(sum) → TIC", "P0  bin(sum) → TIC → peakpick (Twój)", "P5  tło(mediana,raw) → bin(sum) → TIC",
             "P9  dopasowane → SNR-piki → bin(sum) → TIC"):
    print(f"  {name:52s} I(top300_alt)={moran(Xs[name])[top_alt].mean():.3f}")

Y = rows(lambda x: bin_sum(nobase(x)))  # po korekcji tła, przed normalizacją
print("\n--- normalizacja po korekcji tła (I top300) ---")
ticv = Y.sum(axis=1)
norms = {
    "brak": np.ones(len(Y)),
    "TIC": ticv,
    "pierwiastek z TIC": np.sqrt(ticv),
    "RMS": np.sqrt((Y**2).mean(axis=1)),
    "mediana niezerowych": np.array([np.median(r[r > 0]) if (r > 0).any() else 1 for r in Y]),
}
for k, f in norms.items():
    print(f"  {k:24s} {moran((Y / f[:, None]))[top].mean():.3f}   (CV współczynnika {np.std(f)/np.mean(f):.2f})")

print("\n--- globalna lista pików (z widma średniego) zamiast zerowania per piksel ---")
mean_spec = Y.mean(axis=0)
sel_mask = peak_pick_snr(centers, mean_spec, 5.0, 25.0, 1.0, "centroidy")[0] > 0
print(f"  wybrane biny: {sel_mask.sum()} z {len(sel_mask)}")
Pn = Y / ticv[:, None]
I_all = moran(Pn)
print(f"  I wybranych = {I_all[sel_mask].mean():.3f},  I odrzuconych = {I_all[~sel_mask].mean():.3f},  I wszystkich = {I_all.mean():.3f}")
pp_user = Xs["P0  bin(sum) → TIC → peakpick (Twój)"]
print(f"  (Twój peakpick per piksel: średnio {int((pp_user > 0).sum(axis=1).mean())} binów/piksel, "
      f"a biny, które CHOCIAŻ RAZ przeżyły: {int((pp_user > 0).any(axis=0).sum())})")
fr = (pp_user > 0).mean(axis=0)
sel_by_occ = fr > 0.2
print(f"  biny zachowane w >20% pikseli przez Twój peakpick: {int(sel_by_occ.sum())}")


print("\n--- SNIP (istniejący node) na surowych vs mediana, potem bin(sum) → TIC ---")
for it in (40, 100):
    Z = rows(lambda x: tic(bin_sum(baseline_correction_snip(x, it)[0])))
    I = moran(Z)
    print(f"  SNIP {it} iter. na surowych: I(top300)={I[top].mean():.3f}  I(top_alt)={I[top_alt].mean():.3f}  I(szum)={I[noise_bins].mean():.3f}")
