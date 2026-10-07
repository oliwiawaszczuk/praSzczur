"""
"Karta m/z": co sprawia, ze dane m/z rozroznia tkanki REF / KETAMIN / MDMA / PSYL (FMP-10, bregma 0.84).

Etap 1 (cache): jedno przejscie po wszystkich 16 341 surowych widmach:
  - korekcja tla (mediana blokowa ~10 Da, offset detektora ~0.75),
  - biny 0.25 Da (po korekcji tla) do analiz globalnych (ranking, kolokalizacja, segmentacja),
  - surowe okna ±2 Da wokol m/z z listy (ksztalt piku, izotopy, kalibracja),
  - czynniki normalizacji per piksel (TIC surowy, TIC po korekcji, RMS).
Etap 2: metryki per m/z w 5 grupach: (A) czy to prawdziwy pik / co to jest, (B) sila roznicowania,
  (C) charakter przestrzenny, (D) odpornosc na preprocessing i artefakty, (E) kontekst (kolokalizacja,
  sklad regionow). Etap 3: ranking calego widma i porownanie listy "dobrych" m/z z reszta pikow.

Uzycie: uv run python scripts/08_mz_marker_profile.py [--mz 444.2 --tol 0.1]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import stats
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

OUT = ROOT / "praOutputs" / "08_markery"
OUT.mkdir(parents=True, exist_ok=True)
CACHE = Path("/private/tmp/claude-501/-Users-praoliwia-Desktop-Study-AI-MED-praSzczur/"
             "11795fcb-4ebc-4105-a975-a0f374ba83a4/scratchpad/full_pass.npz")

TISSUES = {"T1": ("REF", 35, 107), "T2": ("KETAMIN", 156, 208), "T3": ("MDMA", 296, 348),
           "T4": ("PSYL", 402, 457)}
TCOL = {"T1": "#4c78a8", "T2": "#f58518", "T3": "#e45756", "T4": "#54a24b"}
BIN = 0.25
WIN = 2.0
# m/z badane w workspace'ach uzytkowniczki (tymczasowa lista "dobrych") + kalibranty FMP-10
USER_LIST = [309.19, 353.2, 415.0, 424.5, 444.2, 480.3, 496.0, 508.0, 674.5, 690.2, 957.5]
CALIBRANTS = {"FMP-10 lock mass": 555.2231, "DA 1A": 421.1911, "DA 2A": 674.2802, "DA 2B": 688.2959,
              "GABA 1A": 371.1754, "GABA-H2O 1A": 353.1648}

# --- adnotacja: FMP-10 1A = M + 268.1121 ; 2A = M + 2*268.1121 - 15.0235 (utrata CH3) ; 2B = M + 2*268.1121 - 1.0078
FMP1 = 268.1121
NEURO = {  # masy monoizotopowe (neutralne)
    "dopamina": 153.0790, "noradrenalina": 169.0739, "adrenalina": 183.0895, "serotonina (5-HT)": 176.0950,
    "3-metoksytyramina": 167.0946, "L-DOPA": 197.0688, "tyrozyna": 181.0739, "tryptofan": 204.0899,
    "5-HTP": 220.0848, "5-HIAA": 191.0582, "DOPAC": 168.0423, "HVA": 182.0579, "GABA": 103.0633,
    "glutaminian": 147.0532, "glutamina": 146.0691, "glicyna": 75.0320, "tauryna": 125.0147,
    "histamina": 111.0796, "tyramina": 137.0841, "tryptamina": 160.1000, "oktopamina": 153.0790,
    "putrescyna": 88.1000, "spermidyna": 145.1579, "agmatyna": 130.1218, "alanina": 89.0477,
    "seryna": 105.0426, "asparaginian": 133.0375, "MDMA": 193.1103, "MDA": 179.0946,
    "psylocyna": 204.1263, "norketamina": 223.0764, "ketamina": 237.0920,
}


def fmp_candidates(mz: float, tol: float = 0.15) -> list[str]:
    out = []
    for name, m in NEURO.items():
        for tag, val in (("1A", m + FMP1), ("2A", m + 2 * FMP1 - 15.0235), ("2B", m + 2 * FMP1 - 1.0078),
                         ("1A-H2O", m + FMP1 - 18.0106)):
            if abs(val - mz) <= tol:
                out.append(f"{name} {tag} ({val:.3f})")
    return out


def n_carbons_fmp(name_tag: str) -> int | None:
    formulas = {"serotonina (5-HT)": 10, "dopamina": 8, "noradrenalina": 8, "GABA": 4, "glutaminian": 5,
                "3-metoksytyramina": 9, "tyrozyna": 9, "tryptofan": 11}
    for k, c in formulas.items():
        if name_tag.startswith(k):
            n_fmp = 2 if (" 2A" in name_tag or " 2B" in name_tag) else 1
            return c + 20 * n_fmp - (1 if " 2A" in name_tag else 0)
    return None


# =========================================================================== etap 1
def baseline_block(x: np.ndarray, block: int = 300) -> np.ndarray:
    n = len(x)
    nb = n // block
    med = np.median(x[: nb * block].reshape(nb, block), axis=1)
    centers = np.arange(nb) * block + block / 2
    return np.interp(np.arange(n), centers, med)


def build_cache(targets: list[float]):
    from src.msi.loader import open_parser

    p = open_parser()
    xy = np.array(p.coordinates)[:, :2]
    mz = np.asarray(p.getspectrum(0)[0])
    step = float(np.median(np.diff(mz)))
    edges = np.arange(300.0, 1500.0 + BIN, BIN)
    b_idx = np.clip(np.digitize(mz, edges) - 1, 0, len(edges) - 2)
    starts = np.r_[0, np.flatnonzero(np.diff(b_idx)) + 1]
    centers = edges[b_idx[starts]] + BIN / 2
    half = int(round(WIN / step))
    w_idx = [int(np.argmin(np.abs(mz - t))) for t in targets]
    n = len(xy)
    B = np.zeros((n, len(starts)), np.float32)
    Wr = np.zeros((n, len(targets), 2 * half + 1), np.float32)
    tic_raw = np.zeros(n)
    tic_bg = np.zeros(n)
    rms_bg = np.zeros(n)
    noise = np.zeros(n)
    for i in range(n):
        x = np.asarray(p.getspectrum(i)[1], dtype=np.float64)
        base = baseline_block(x)
        y = np.clip(x - base, 0, None)
        B[i] = np.add.reduceat(y, starts)
        for j, c in enumerate(w_idx):
            Wr[i, j] = (x - base)[c - half: c + half + 1]
        tic_raw[i] = x.sum()
        tic_bg[i] = y.sum()
        rms_bg[i] = np.sqrt((y**2).mean())
        d = np.diff(x[mz > 1000])
        noise[i] = 1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2)
        if i % 2000 == 0:
            print(f"  {i}/{n}", flush=True)
    wmz = np.array([mz[c - half: c + half + 1] for c in w_idx])
    np.savez(CACHE, xy=xy, B=B, centers=centers, Wr=Wr, wmz=wmz, targets=np.array(targets),
             tic_raw=tic_raw, tic_bg=tic_bg, rms_bg=rms_bg, noise=noise)


# =========================================================================== pomocnicze
def tissue_of(xy):
    t = np.full(len(xy), "", dtype=object)
    for tid, (_, lo, hi) in TISSUES.items():
        t[(xy[:, 0] >= lo) & (xy[:, 0] <= hi)] = tid
    return t


def grid(xy_t, values):
    x0, y0 = xy_t.min(axis=0)
    H, W = xy_t[:, 1].max() - y0 + 1, xy_t[:, 0].max() - x0 + 1
    img = np.full((H, W), np.nan)
    img[xy_t[:, 1] - y0, xy_t[:, 0] - x0] = values
    return img


def morans_i(img: np.ndarray) -> float:
    m = ~np.isnan(img)
    z = np.where(m, img - np.nanmean(img), 0.0)
    ph = m[:, 1:] & m[:, :-1]
    pv = m[1:] & m[:-1]
    num = (z[:, 1:] * z[:, :-1])[ph].sum() + (z[1:] * z[:-1])[pv].sum()
    w = ph.sum() + pv.sum()
    den = (z[m] ** 2).sum()
    return float(m.sum() / w * num / den) if den > 0 and w > 0 else np.nan


def auc(a, b):
    """P(A > B) + 0.5 P(A = B) — 'prawdopodobienstwo, ze losowy piksel A ma wyzsza intensywnosc niz B'."""
    if len(a) == 0 or len(b) == 0:
        return np.nan
    u = stats.mannwhitneyu(a, b, alternative="two-sided").statistic
    return float(u / (len(a) * len(b)))


def hedges_g(a, b):
    na, nb = len(a), len(b)
    s = np.sqrt(((na - 1) * a.var(ddof=1) + (nb - 1) * b.var(ddof=1)) / (na + nb - 2))
    g = (a.mean() - b.mean()) / s if s > 0 else np.nan
    return float(g * (1 - 3 / (4 * (na + nb) - 9)))


def gini(v):
    v = np.sort(np.clip(v, 0, None))
    if v.sum() == 0:
        return np.nan
    n = len(v)
    return float((2 * np.arange(1, n + 1) - n - 1).dot(v) / (n * v.sum()))


# =========================================================================== etap 2
def load():
    d = dict(np.load(CACHE, allow_pickle=True))
    d["tissue"] = tissue_of(d["xy"])
    # Akwizycja obejmowala wylacznie obszar tkanek (praOutputs/00_tic_layout.png: piksele poza tkanka nie
    # byly mierzone), wiec wszystkie zmierzone piksele traktujemy jako tkanke.
    on = d["tissue"] != ""
    d["on"] = on
    return d


def intensity(d, mz0, tol, norm="tic_bg"):
    """Intensywnosc jonu per piksel: suma (po korekcji tla) w [mz0-tol, mz0+tol] z binow 0.25 Da
    albo — gdy m/z jest na liscie okien — z surowej siatki (dokladniejsze dla malych tol)."""
    targets = list(d["targets"])
    j = int(np.argmin(np.abs(np.array(targets) - mz0)))
    if abs(targets[j] - mz0) < 1e-6:
        wm = d["wmz"][j]
        sel = np.abs(wm - mz0) <= max(tol, 0.017)
        v = np.clip(d["Wr"][:, j, sel], 0, None).sum(axis=1).astype(float)
    else:
        c = d["centers"]
        sel = np.abs(c - mz0) <= max(tol, BIN / 2)
        v = d["B"][:, sel].sum(axis=1).astype(float)
    if norm == "none":
        return v
    f = {"tic_raw": d["tic_raw"], "tic_bg": d["tic_bg"], "rms": d["rms_bg"], "noise": d["noise"]}[norm]
    return v / f * np.median(f[d["on"]])


def peak_area(d, j, mz0, half=0.2):
    wm = d["wmz"][j]
    v = np.zeros(len(d["tissue"]))
    for t in TISSUES:
        k = d["on"] & (d["tissue"] == t)
        ms = d["Wr"][k, j].mean(axis=0)
        core = np.flatnonzero(np.abs(wm - mz0) <= 0.35)
        ap = wm[core[np.argmax(ms[core])]]
        sel = np.abs(wm - ap) <= half
        v[k] = np.clip(d["Wr"][k, j][:, sel], 0, None).sum(axis=1)
    return v / d["tic_bg"] * np.median(d["tic_bg"][d["on"]])


def profile(d, mz0, tol, plot=True):
    j = int(np.argmin(np.abs(d["targets"] - mz0)))
    has_win = abs(d["targets"][j] - mz0) < 1e-6
    on, tis = d["on"], d["tissue"]
    # Intensywnosc odporna na przesuniecie kalibracji miedzy tkankami (patrz 09_mass_shift_check.py):
    # pole piku ±0.2 Da wokol apeksu wyznaczonego OSOBNO dla kazdej tkanki. Stale okno ±tol (jak w appce)
    # zostaje tylko w D_odpornosc jako porownanie.
    v = peak_area(d, j, mz0) if has_win else intensity(d, mz0, tol)
    res = {"mz": mz0, "tol": tol, "kandydaci_FMP10": fmp_candidates(mz0)}

    # ---- A. prawdziwosc piku (pik w srednim widmie tkanki, apeks, FWHM, izotop M+1, SNR, % pikseli)
    A = {}
    if has_win:
        wm = d["wmz"][j]
        for tid in TISSUES:
            m = on & (tis == tid)
            ms = d["Wr"][m, j].mean(axis=0)
            core = np.abs(wm - mz0) <= 0.3
            k = np.flatnonzero(core)[np.argmax(ms[core])]
            apex = float(wm[k])
            hm = ms[k] / 2
            lft, rgt = k, k
            while lft > 0 and ms[lft] > hm:
                lft -= 1
            while rgt < len(ms) - 1 and ms[rgt] > hm:
                rgt += 1
            iso = np.abs(wm - (apex + 1.00336)) <= 0.05
            noise_mean = 1.4826 * np.median(np.abs(ms[np.abs(wm - mz0) > 0.6] - np.median(ms[np.abs(wm - mz0) > 0.6])))
            px_snr = d["Wr"][m, j, k] / np.maximum(d["noise"][m], 1e-9)
            A[TISSUES[tid][0]] = {
                "apeks_mz": round(apex, 3), "FWHM_Da": round(float(wm[rgt] - wm[lft]), 3),
                "wys_sredniego_piku": round(float(ms[k]), 3),
                "SNR_sredniego_widma": round(float(ms[k] / max(noise_mean, 1e-9)), 1),
                "M+1/M": round(float(ms[iso].max() / ms[k]), 3) if ms[k] > 0 else np.nan,
                "%_pikseli_SNR>=3": round(100 * float((px_snr >= 3).mean()), 1),
            }
        res["A_pik"] = A
        exp = [n_carbons_fmp(c) for c in res["kandydaci_FMP10"]]
        # M+1/M ~ 1.08% na atom C + ~1% od N/H (przyblizenie dla pochodnych FMP-10)
        res["A_oczekiwane_M+1/M"] = {c: round(0.0108 * n + 0.01, 3)
                                     for c, n in zip(res["kandydaci_FMP10"], exp) if n}

    # ---- B. roznicowanie (na pikselach tkanki; UWAGA: piksele nie sa niezaleznymi replikami)
    groups = {TISSUES[t][0]: v[on & (tis == t)] for t in TISSUES}
    names = list(groups)
    B = {"mediana": {k: float(np.median(g)) for k, g in groups.items()},
         "srednia": {k: float(g.mean()) for k, g in groups.items()},
         "P90": {k: float(np.percentile(g, 90)) for k, g in groups.items()}}
    ref = groups["REF"]
    B["log2FC_vs_REF(mediana)"] = {k: float(np.log2((np.median(g) + 1e-9) / (np.median(ref) + 1e-9)))
                                   for k, g in groups.items() if k != "REF"}
    B["AUC_vs_REF"] = {k: auc(g, ref) for k, g in groups.items() if k != "REF"}
    B["AUC_1_vs_reszta"] = {k: auc(g, np.concatenate([h for kk, h in groups.items() if kk != k]))
                            for k, g in groups.items()}
    B["Hedges_g_vs_REF"] = {k: hedges_g(g, ref) for k, g in groups.items() if k != "REF"}
    pair = {}
    for a in range(4):
        for b in range(a + 1, 4):
            pair[f"{names[a]}|{names[b]}"] = round(2 * auc(groups[names[a]], groups[names[b]]) - 1, 3)
    B["Cliff_delta_pary"] = pair
    H, _ = stats.kruskal(*groups.values())
    n_all = sum(len(g) for g in groups.values())
    B["KW_epsilon2"] = float((H - 4 + 1) / (n_all - 4))
    B["max_|Cliff|"] = float(max(abs(x) for x in pair.values()))
    res["B_roznicowanie"] = B

    # ---- C. przestrzen: Moran I, Gini (skupienie w hotspotach), % powierzchni > globalny P75
    C = {}
    thr = np.percentile(v[on], 75)
    for t in TISSUES:
        m = on & (tis == t)
        img = grid(d["xy"][m], v[m])
        C[TISSUES[t][0]] = {"Moran_I": round(morans_i(img), 3), "Gini": round(gini(v[m]), 3),
                            "CV": round(float(v[m].std() / max(v[m].mean(), 1e-12)), 3),
                            "%_pow>P75_global": round(100 * float((v[m] > thr).mean()), 1)}
    res["C_przestrzen"] = C

    # ---- D. odpornosc: AUC_1_vs_reszta przy roznych normalizacjach i tolerancjach; korelacje z artefaktami
    D = {"AUC_REF_vs_reszta_wg_normalizacji": {}, "Cliff_max_wg_tol": {}}
    g_fixed = [intensity(d, mz0, tol)[on & (tis == t)] for t in TISSUES]
    D["max_|Cliff|_stale_okno_tol(jak_w_appce)"] = round(max(abs(2 * auc(g_fixed[a], g_fixed[b]) - 1)
                                                         for a in range(4) for b in range(a + 1, 4)), 3)
    for nm in ("none", "tic_raw", "tic_bg", "rms", "noise"):
        vv = intensity(d, mz0, tol, nm)
        g = {TISSUES[t][0]: vv[on & (tis == t)] for t in TISSUES}
        D["AUC_REF_vs_reszta_wg_normalizacji"][nm] = {
            k: round(auc(x, np.concatenate([h for kk, h in g.items() if kk != k])), 3) for k, x in g.items()}
    for tl in (0.05, 0.1, 0.25, 0.5):
        vv = intensity(d, mz0, tl)
        g = [vv[on & (tis == t)] for t in TISSUES]
        D["Cliff_max_wg_tol"][tl] = round(max(abs(2 * auc(g[a], g[b]) - 1) for a in range(4) for b in range(a + 1, 4)), 3)
    lock = intensity(d, 555.2231, 0.1, "none")
    rho_edge, rho_lock, rho_tic = {}, {}, {}
    for t in TISSUES:
        m = on & (tis == t)
        img_on = grid(d["xy"][m], np.ones(m.sum()))
        dist = distance_transform_edt(np.nan_to_num(img_on) > 0)
        x0, y0 = d["xy"][m].min(axis=0)
        dd = dist[d["xy"][m][:, 1] - y0, d["xy"][m][:, 0] - x0]
        nm_ = TISSUES[t][0]
        rho_edge[nm_] = round(float(stats.spearmanr(v[m], dd)[0]), 3)
        rho_lock[nm_] = round(float(stats.spearmanr(v[m], lock[m])[0]), 3)
        rho_tic[nm_] = round(float(stats.spearmanr(intensity(d, mz0, tol, "none")[m], d["tic_bg"][m])[0]), 3)
    D["Spearman_z_odl_od_krawedzi"] = rho_edge
    D["Spearman_z_jonem_matrycy_555.22"] = rho_lock
    D["Spearman_surowej_z_TIC"] = rho_tic
    res["D_odpornosc"] = D

    # ---- E. kolokalizacja: najbardziej skorelowane biny (Spearman na pikselach tkanek)
    Bn = d["B"][on] / d["tic_bg"][on, None]
    vr = stats.rankdata(v[on])
    Rb = np.apply_along_axis(stats.rankdata, 0, Bn[:, d["topbins"]])
    r = np.array([np.corrcoef(vr, Rb[:, i])[0, 1] for i in range(Rb.shape[1])])
    cen = d["centers"][d["topbins"]]
    far = np.abs(cen - mz0) > 0.6
    order = np.argsort(r * far)[::-1][:8]
    res["E_kolokalizacja"] = [(round(float(cen[i]), 2), round(float(r[i]), 2),
                               "; ".join(fmp_candidates(float(cen[i]), 0.2)) or "-") for i in order]
    # sklad regionow: per klaster wspolnej segmentacji, mediana jonu per tkanka
    comp = {}
    for c in range(d["k"]):
        comp[c] = {TISSUES[t][0]: float(np.median(v[on & (tis == t) & (d["clu"] == c)]))
                   if (on & (tis == t) & (d["clu"] == c)).sum() > 20 else np.nan for t in TISSUES}
    res["E_mediana_w_klastrach"] = comp

    if plot:
        plot_card(d, mz0, tol, v, res, j if has_win else None)
    return res


def plot_card(d, mz0, tol, v, res, j):
    on, tis = d["on"], d["tissue"]
    fig = plt.figure(figsize=(17, 10))
    gs = fig.add_gridspec(3, 4, height_ratios=[1.1, 1, 1])
    vmax = np.percentile(v[on], 99.5)
    for i, t in enumerate(TISSUES):
        ax = fig.add_subplot(gs[0, i])
        m = tis == t
        img = grid(d["xy"][m], np.where(on[m], v[m], np.nan))
        ax.imshow(img, cmap="inferno", vmin=0, vmax=vmax, interpolation="nearest")
        c = res["C_przestrzen"][TISSUES[t][0]]
        ax.set_title(f"{TISSUES[t][0]}  Moran I={c['Moran_I']:.2f}", fontsize=10)
        ax.axis("off")
    ax = fig.add_subplot(gs[1, :2])
    data = [v[on & (tis == t)] for t in TISSUES]
    parts = ax.violinplot(data, showmedians=True, showextrema=False)
    for pc, t in zip(parts["bodies"], TISSUES):
        pc.set_facecolor(TCOL[t])
    ax.set_xticks(range(1, 5), [TISSUES[t][0] for t in TISSUES])
    ax.set_ylim(0, np.percentile(v[on], 99.5))
    b = res["B_roznicowanie"]
    ax.set_title(f"Pole piku wokół apeksu tkanki (TIC po korekcji tła)  ε²(KW)={b['KW_epsilon2']:.2f}  "
                 f"max|Cliff δ|={b['max_|Cliff|']:.2f}", fontsize=10)
    ax = fig.add_subplot(gs[1, 2:])
    if j is not None:
        wm = d["wmz"][j]
        for t in TISSUES:
            ax.plot(wm, d["Wr"][on & (tis == t), j].mean(axis=0), color=TCOL[t], label=TISSUES[t][0], lw=1.2)
        ax.axvspan(mz0 - tol, mz0 + tol, color="gray", alpha=0.15)
        ax.axvline(mz0 + 1.00336, color="gray", ls=":", lw=0.8)
        ax.legend(fontsize=8)
        ax.set_title("Średnie widmo tkanek ±2 Da (szare = okno tol, kropki = M+1)", fontsize=10)
    ax = fig.add_subplot(gs[2, :2])
    pairs = res["B_roznicowanie"]["Cliff_delta_pary"]
    ax.barh(list(pairs), list(pairs.values()), color=["#888" if abs(x) < 0.33 else "#d62728" for x in pairs.values()])
    ax.axvline(0, color="k", lw=0.6)
    for xv in (-0.474, -0.33, 0.33, 0.474):
        ax.axvline(xv, color="gray", ls=":", lw=0.6)
    ax.set_xlim(-1, 1)
    ax.set_title("Cliff δ par tkanek (|δ|>0.33 średni, >0.47 duży efekt)", fontsize=10)
    ax = fig.add_subplot(gs[2, 2:])
    comp = res["E_mediana_w_klastrach"]
    M = np.array([[comp[c][TISSUES[t][0]] for t in TISSUES] for c in comp])
    im = ax.imshow(M, cmap="viridis", aspect="auto")
    ax.set_xticks(range(4), [TISSUES[t][0] for t in TISSUES])
    ax.set_yticks(range(len(comp)), [f"region {c} ({d['clu_frac'][c]})" for c in comp], fontsize=7)
    ax.set_title("Mediana jonu w regionach wspólnej segmentacji (porównanie region-do-regionu)", fontsize=10)
    plt.colorbar(im, ax=ax)
    cand = "; ".join(res["kandydaci_FMP10"]) or "brak dopasowania FMP-10"
    fig.suptitle(f"m/z {mz0} ±{tol}  —  {cand}", fontsize=12)
    fig.tight_layout()
    fig.savefig(OUT / f"karta_{mz0:.2f}.png", dpi=110)
    plt.close(fig)


def common_segmentation(d, k=6):
    """Wspolna segmentacja wszystkich 4 tkanek (k-means na sqrt-TIC topowych binow) — pozwala porownac
    REGION z REGIONEM, zamiast calej tkanki (sklad regionow przekroju moze sie roznic miedzy tkankami)."""
    from sklearn.cluster import KMeans
    from sklearn.decomposition import PCA

    on = d["on"]
    X = np.sqrt(d["B"][on][:, d["topbins"]] / d["tic_bg"][on, None])
    X = (X - X.mean(0)) / (X.std(0) + 1e-9)
    Z = PCA(15, random_state=0).fit_transform(X)
    lab = KMeans(k, n_init=5, random_state=0).fit_predict(Z)
    clu = np.full(len(on), -1)
    clu[on] = lab
    d["clu"], d["k"] = clu, k
    frac = {}
    for c in range(k):
        frac[c] = "/".join(f"{100 * ((clu == c) & (d['tissue'] == t)).sum() / (on & (d['tissue'] == t)).sum():.0f}"
                           for t in TISSUES)
    d["clu_frac"] = frac


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mz", type=float, nargs="*")
    ap.add_argument("--tol", type=float, default=0.1)
    args = ap.parse_args()
    targets = sorted(set(USER_LIST + list(CALIBRANTS.values()) + (args.mz or [])))
    if not CACHE.exists() or not set(np.round(targets, 4)) <= set(np.round(np.load(CACHE)["targets"], 4)):
        print("Budowa cache (jedno przejście po imzML)...")
        build_cache(targets)
    d = load()
    on, tis = d["on"], d["tissue"]
    print("Piksele tkanki:", {TISSUES[t][0]: f"{(on & (tis == t)).sum()}/{(tis == t).sum()}" for t in TISSUES})

    # biny-piki globalne (do kolokalizacji, segmentacji, rankingu)
    mean_b = d["B"][on].mean(axis=0)
    from scipy.signal import find_peaks
    pk, _ = find_peaks(mean_b, prominence=np.median(mean_b) * 3)
    d["topbins"] = pk[np.argsort(mean_b[pk])[::-1][:400]]
    common_segmentation(d)
    print("Udział regionów (REF/KET/MDMA/PSYL, %):", d["clu_frac"])

    # ---- kalibracja masy
    print("\nKalibracja (apeks w średnim widmie wszystkich tkanek vs teoria):")
    cal = {}
    for name, m in CALIBRANTS.items():
        j = int(np.argmin(np.abs(d["targets"] - m)))
        wm = d["wmz"][j]
        ms = d["Wr"][on, j].mean(axis=0)
        core = np.abs(wm - m) <= 0.3
        k = np.flatnonzero(core)[np.argmax(ms[core])]
        noise = 1.4826 * np.median(np.abs(ms - np.median(ms)))
        cal[name] = (float(wm[k]), float(wm[k] - m), float(ms[k] / max(noise, 1e-9)))
        print(f"  {name:18s} teoria {m:9.4f}  apeks {wm[k]:9.4f}  Δ={wm[k] - m:+.3f} Da  wys/szum={cal[name][2]:.0f}")

    # ---- karty m/z
    todo = args.mz or USER_LIST
    allres = {}
    for m in todo:
        r = profile(d, m, args.tol)
        allres[m] = r
        b, a = r["B_roznicowanie"], r.get("A_pik", {})
        print(f"\n=== m/z {m} ±{args.tol}: {'; '.join(r['kandydaci_FMP10']) or 'brak kandydata FMP-10'}")
        for t, x in a.items():
            print(f"  {t:8s} apeks={x['apeks_mz']:.3f} FWHM={x['FWHM_Da']:.3f} SNR(śr)={x['SNR_sredniego_widma']:7.1f} "
                  f"M+1/M={x['M+1/M']:.2f} %px SNR≥3={x['%_pikseli_SNR>=3']:5.1f}")
        if r.get("A_oczekiwane_M+1/M"):
            print("  oczekiwane M+1/M:", r["A_oczekiwane_M+1/M"])
        print("  mediana:", {k: round(x, 3) for k, x in b["mediana"].items()})
        print("  log2FC vs REF:", {k: round(x, 2) for k, x in b["log2FC_vs_REF(mediana)"].items()})
        print("  AUC 1-vs-reszta:", {k: round(x, 2) for k, x in b["AUC_1_vs_reszta"].items()})
        print("  Cliff δ pary:", b["Cliff_delta_pary"], f" ε²={b['KW_epsilon2']:.3f}")
        print("  przestrzeń:", r["C_przestrzen"])
        print("  AUC wg normalizacji:", r["D_odpornosc"]["AUC_REF_vs_reszta_wg_normalizacji"])
        print("  max|Cliff| wg tol (stałe okno):", r["D_odpornosc"]["Cliff_max_wg_tol"],
              " | pole piku:", round(b["max_|Cliff|"], 3))
        print("  ρ z krawędzią:", r["D_odpornosc"]["Spearman_z_odl_od_krawedzi"],
              " ρ z matrycą 555:", r["D_odpornosc"]["Spearman_z_jonem_matrycy_555.22"])
        print("  kolokalizacja:", r["E_kolokalizacja"][:6])
        print("  mediana w regionach:", {c: {k: round(x, 3) for k, x in v.items()} for c, v in r["E_mediana_w_klastrach"].items()})
    with open(OUT / "karty.json", "w") as f:
        json.dump({str(k): v for k, v in allres.items()}, f, ensure_ascii=False, indent=1, default=float)

    if not args.mz:
        ranking(d)


def ranking(d):
    """Ranking wszystkich pikow (biny 0.25 Da) wg metryk roznicowania i przestrzeni; gdzie wypada lista uzytkowniczki."""
    on, tis = d["on"], d["tissue"]
    Bn = d["B"] / d["tic_bg"][:, None]
    rows = []
    for b in d["topbins"]:
        v = Bn[:, b]
        g = [v[on & (tis == t)] for t in TISSUES]
        H, _ = stats.kruskal(*g)
        eps = (H - 3) / (sum(map(len, g)) - 4)
        cl = [2 * auc(g[a], g[c]) - 1 for a in range(4) for c in range(a + 1, 4)]
        mi = np.nanmean([morans_i(grid(d["xy"][on & (tis == t)], v[on & (tis == t)])) for t in TISSUES])
        cv_between = np.std([np.median(x) for x in g]) / max(np.mean([np.median(x) for x in g]), 1e-12)
        rows.append((float(d["centers"][b]), eps, max(abs(c) for c in cl), mi, cv_between, float(Bn[on, b].mean())))
    R = np.array(rows)
    near = lambda m: np.argmin(np.abs(R[:, 0] - m))  # noqa: E731
    user_idx = [near(m) for m in USER_LIST if np.min(np.abs(R[:, 0] - m)) <= 0.3]
    names = ["ε² KW", "max|Cliff δ|", "Moran I (śr.)", "CV median między tkankami", "śr. intensywność"]
    print("\n=== Ranking 400 najsilniejszych pików — percentyl listy użytkowniczki w każdej metryce ===")
    for i, nm in enumerate(names, start=1):
        pct = [stats.percentileofscore(R[:, i], R[u, i]) for u in user_idx]
        print(f"  {nm:28s} mediana percentyla listy = {np.median(pct):5.1f}   (pojedyncze: {[round(p) for p in pct]})")
    order = np.argsort(R[:, 2])[::-1]
    print("\nTOP 25 m/z wg max|Cliff δ| (z ε², Moran I, kandydatem FMP-10):")
    for o in order[:25]:
        print(f"  {R[o, 0]:8.2f}  max|δ|={R[o, 2]:.2f}  ε²={R[o, 1]:.2f}  I={R[o, 3]:.2f}  "
              f"{'; '.join(fmp_candidates(R[o, 0], 0.15)) or '-'}")
    np.savetxt(OUT / "ranking_pikow.csv", R, delimiter=";", fmt="%.4f",
               header="mz;epsilon2_KW;max_abs_cliff;moran_I_mean;cv_between_tissue_medians;mean_intensity")
    fig, axs = plt.subplots(1, 3, figsize=(16, 4.5))
    for ax, (i, j) in zip(axs, [(2, 3), (1, 3), (5, 2)]):
        ax.scatter(R[:, i], R[:, j], s=8, c="#bbb", label="400 najsilniejszych pików")
        ax.scatter(R[user_idx, i], R[user_idx, j], s=40, c="#d62728", label="Twoja lista")
        for u in user_idx:
            ax.annotate(f"{R[u, 0]:.1f}", (R[u, i], R[u, j]), fontsize=7)
        ax.set_xlabel(["", "ε² KW", "max|Cliff δ|", "Moran I", "", "śr. intensywność"][i])
        ax.set_ylabel(["", "ε² KW", "max|Cliff δ|", "Moran I", "", "śr. intensywność"][j])
        if i == 5:
            ax.set_xscale("log")
    axs[0].legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(OUT / "ranking_lista_vs_reszta.png", dpi=120)
    plt.close(fig)
    # maska tkanek do kontroli
    fig, axs = plt.subplots(1, 4, figsize=(14, 3.5))
    for ax, t in zip(axs, TISSUES):
        m = tis == t
        ax.imshow(grid(d["xy"][m], np.where(on[m], d["clu"][m], np.nan)), cmap="tab10", vmin=0, vmax=9,
                  interpolation="nearest")
        ax.set_title(f"{TISSUES[t][0]}: wspólna segmentacja")
        ax.axis("off")
    fig.tight_layout()
    fig.savefig(OUT / "segmentacja_wspolna.png", dpi=120)
    plt.close(fig)


if __name__ == "__main__":
    main()
