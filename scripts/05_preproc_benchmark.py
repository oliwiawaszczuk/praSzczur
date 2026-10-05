"""
Benchmark metod preprocessingu / detekcji pikow na SUROWYCH widmach MALDI-TOF (FMP10).

Brak "prawdy" dla danych rzeczywistych, wiec test jest polsyntetyczny:
  - tlo = prawdziwe surowe widma z regionu 900-1500 Da (praktycznie bez pikow, realny szum
    elektroniczny + dryf linii bazowej),
  - piki = wstrzykniete gaussy o FWHM zmierzonym na prawdziwych pikach (~0.08 Da),
    losowe pozycje sub-probkowe, amplituda A * sigma_szumu.
Dla kazdej metody (cecha detekcyjna) prog jest kalibrowany na widmach TYLKO-SZUM tak, by
liczba falszywych pikow = FP_PER_100DA / 100 Da; potem mierzymy TPR (czulosc) wstrzyknietych pikow.
Wyniki: praOutputs/05_*.png (+ metryki w stdout, uzyte w praOutputs/05_preprocessing_research.md).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import median_filter, uniform_filter1d
from scipy.signal import find_peaks, savgol_filter, stft

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

OUT = ROOT / "praOutputs"
CACHE = ROOT / "data" / "interim" / "raw_sample.npz"
N_SAMPLE = 300
FWHM_DA = 0.08
FP_PER_100DA = 0.5
AMPLITUDES = [1.5, 2, 3, 4, 6, 10]  # w jednostkach sigma szumu bialego
rng = np.random.default_rng(0)


def load_sample() -> tuple[np.ndarray, np.ndarray]:
    if CACHE.exists():
        d = np.load(CACHE)
        return d["spectra"], d["mz"]
    from src.msi.loader import open_parser

    p = open_parser()
    n = len(p.coordinates)
    idx = np.sort(rng.choice(n, N_SAMPLE, replace=False))
    mz = np.asarray(p.getspectrum(int(idx[0]))[0])
    spectra = np.array([np.asarray(p.getspectrum(int(i))[1], dtype=np.float32) for i in idx])
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(CACHE, spectra=spectra, mz=mz, idx=idx)
    return spectra, mz


def detrend(x: np.ndarray, size: int) -> np.ndarray:
    """Wspolny dla wszystkich metod krok linii bazowej: mediana kroczaca (odporna na piki)."""
    return x - median_filter(x, size=size, mode="nearest")


def robust_sigma(x: np.ndarray) -> float:
    return float(1.4826 * np.median(np.abs(x - np.median(x))))


def white_noise_sigma(x: np.ndarray) -> float:
    """sigma szumu bialego z roznic pierwszego rzedu (odporne na wolne trendy i piki)."""
    d = np.diff(x)
    return robust_sigma(d) / np.sqrt(2)


def gauss_peak(grid: np.ndarray, center: float, amp: float, fwhm: float) -> np.ndarray:
    s = fwhm / 2.3548
    return amp * np.exp(-0.5 * ((grid - center) / s) ** 2)


# ---------------------------------------------------------------- features
def f_raw(x):
    return x


def f_ma(w):
    return lambda x: uniform_filter1d(x, w, mode="nearest")


def f_sg(w, o):
    return lambda x: savgol_filter(x, w, o)


def f_gauss(sig_pts):
    def f(x):
        from scipy.ndimage import gaussian_filter1d

        return gaussian_filter1d(x, sig_pts, mode="nearest")

    return f


def f_ma_sq(w):
    """Pomysl 'srednia w oknie + kwadrat': monotoniczna transformacja => ten sam ranking."""
    return lambda x: np.clip(uniform_filter1d(x, w, mode="nearest"), 0, None) ** 2


def f_tompkins(w):
    """Pan-Tompkins: pochodna -> kwadrat -> calkowanie w oknie."""

    def f(x):
        d = np.gradient(x)
        return uniform_filter1d(d**2, w, mode="nearest")

    return f


def ricker(width: float, n: int | None = None) -> np.ndarray:
    n = n or int(10 * width) | 1
    t = np.arange(n) - n // 2
    a = width
    w = (1 - (t / a) ** 2) * np.exp(-0.5 * (t / a) ** 2)
    return w / np.sqrt(np.sum(w**2))


def make_cwt(widths):
    kernels = [ricker(w) for w in widths]

    def f(x):
        from scipy.signal import fftconvolve

        return np.stack([fftconvolve(x, k, mode="same") for k in kernels])  # (n_scales, n)

    f.multi = True
    return f


def make_stft(nperseg=16, band=(0.05, 0.35)):
    def f(x):
        freqs, _, Z = stft(x, nperseg=nperseg, noverlap=nperseg - 1, boundary="even", padded=False)
        m = (freqs >= band[0]) & (freqs <= band[1])
        e = (np.abs(Z[m]) ** 2).sum(axis=0)
        # stft ma dlugosc ~ n (hop=1); dopasuj do n
        if len(e) < len(x):
            e = np.pad(e, (0, len(x) - len(e)), mode="edge")
        return e[: len(x)]

    return f


def build_methods(binned: bool):
    if binned:
        return {
            "bez wygładzania": f_raw,
            "MA w=3": f_ma(3),
            "SG w=5,o=2": f_sg(5, 2),
            "SG w=15,o=3 (domyślne w appce)": f_sg(15, 3),
            "CWT Ricker (szer. 0.7-2 bin)": make_cwt([0.7, 1, 1.5, 2]),
        }
    return {
        "bez wygładzania": f_raw,
        "MA w=3": f_ma(3),
        "MA w=5": f_ma(5),
        "SG w=7,o=2": f_sg(7, 2),
        "SG w=15,o=3 (domyślne w appce)": f_sg(15, 3),
        "Gauss σ=1 pkt (filtr dopasowany)": f_gauss(1.0),
        "MA w=5 → kwadrat": f_ma_sq(5),
        "Tompkins (pochodna²→okno 5)": f_tompkins(5),
        "STFT (moc w paśmie pików)": make_stft(),
        "CWT Ricker (szer. 1-4 pkt)": make_cwt([1, 1.5, 2, 3, 4]),
    }


# ---------------------------------------------------------------- evaluation
def to_feature(f, x, scales=None):
    out = f(x)
    if getattr(f, "multi", False):
        out = out / scales[:, None]
        out = out.max(axis=0)
    return out


def fit_scales(f, noise_specs):
    if not getattr(f, "multi", False):
        return None
    coefs = np.concatenate([f(x) for x in noise_specs], axis=1)
    return np.array([robust_sigma(c) for c in coefs])


def calibrate_threshold(f, noise_specs, da_total, scales, masks):
    zmax = []
    feats = [to_feature(f, x, scales) for x in noise_specs]
    allf = np.concatenate(feats)
    med, sig = np.median(allf), robust_sigma(allf)
    for ft, m in zip(feats, masks):
        z = (ft - med) / sig
        pk, _ = find_peaks(z)
        zmax.append(z[pk[~m[pk]]])  # pomijamy realne piki/spike'i tla
    zmax = np.sort(np.concatenate(zmax))[::-1]
    n_allowed = max(int(FP_PER_100DA / 100 * da_total), 1)
    thr = zmax[min(n_allowed, len(zmax) - 1)]
    return med, sig, thr


def tpr(f, specs, truth_idx, tol, med, sig, thr, scales):
    hit = tot = 0
    for x, ti in zip(specs, truth_idx):
        z = (to_feature(f, x, scales) - med) / sig
        pk, _ = find_peaks(z, height=thr)
        if len(pk) == 0:
            tot += len(ti)
            continue
        pos = np.searchsorted(pk, ti)
        left = np.abs(pk[np.clip(pos - 1, 0, len(pk) - 1)] - ti)
        right = np.abs(pk[np.clip(pos, 0, len(pk) - 1)] - ti)
        hit += int((np.minimum(left, right) <= tol).sum())
        tot += len(ti)
    return hit / tot


def run_benchmark(spectra, mz, binned: bool, agg: str = "sum"):
    sel = (mz >= 900) & (mz <= 1500)
    bg = spectra[:, sel].astype(float)
    mzb = mz[sel]
    step = np.median(np.diff(mzb))
    if binned:
        bs = 0.3
        edges = np.arange(mzb[0], mzb[-1] + bs, bs)
        bins = np.digitize(mzb, edges) - 1
        nb = bins.max() + 1
        step = bs

        def to_bin(x):
            if agg == "max":
                out = np.full(nb, -np.inf)
                np.maximum.at(out, bins, x)
                return out
            return np.bincount(bins, weights=x, minlength=nb)

        grid_mz = edges[:nb] + bs / 2
    else:
        to_bin = lambda x: x  # noqa: E731
        grid_mz = mzb
    sigma = np.median([white_noise_sigma(x) for x in bg])
    det_size = 21 if binned else 301
    def real_mask(x, pad):
        """Punkty bliskie realnym pikom/spike'om w 'pustym' regionie (>6σ) — wykluczane z kalibracji."""
        m = np.abs(detrend(x, 301)) > 6 * white_noise_sigma(x)
        m = uniform_filter1d(m.astype(float), 61) > 0
        if binned:
            m = np.bincount(bins, weights=m.astype(float), minlength=nb) > 0
            m = uniform_filter1d(m.astype(float), 7) > 0
        return m

    noise_pool = [detrend(to_bin(x), det_size) for x in bg[:80]]
    noise_masks = [real_mask(x, 0) for x in bg[:80]]
    inj_masks = [real_mask(x, 0) for x in bg[80:140]]
    inj_pool = bg[80:140]
    da_total = (grid_mz[-1] - grid_mz[0]) * len(noise_pool) * (1 - np.mean([m.mean() for m in noise_masks]))
    methods = build_methods(binned)
    # sigma w jednostkach siatki: dla binned suma po ~9 punktach => sigma_bin zmierzone empirycznie
    sig_grid = np.median([white_noise_sigma(x) for x in noise_pool])
    res = {k: [] for k in methods}
    spacing_da = 2.0
    for amp in AMPLITUDES:
        specs, truth = [], []
        for x, im in zip(inj_pool, inj_masks):
            centers = np.arange(mzb[0] + 1.0, mzb[-1] - 1.0, spacing_da) + rng.uniform(-0.3, 0.3)
            y = x.copy()
            for c in centers:
                y += gauss_peak(mzb, c, amp * sigma, FWHM_DA)
            yb = to_bin(y)
            specs.append(detrend(yb, det_size))
            ti = np.searchsorted(grid_mz, centers)
            truth.append(ti[~im[np.clip(ti, 0, len(im) - 1)]])
        tol = 1 if binned else 2
        for name, f in methods.items():
            scales = fit_scales(f, noise_pool[:30])
            med, sg, thr = calibrate_threshold(f, noise_pool, da_total, scales, noise_masks)
            res[name].append(tpr(f, specs, truth, tol, med, sg, thr, scales))
    return res, sigma, sig_grid, step


def retention_table():
    """Zachowanie wysokosci/szerokosci piku (bez szumu) po wygladzaniu — raw vs binned 0.3."""
    rows = []
    for label, step in (("surowe (0.0336 Da)", 0.03362), ("bin 0.3 Da", 0.3)):
        grid = np.arange(-8, 8, step)
        if step > 0.1:
            fine = np.arange(-8, 8, 0.0336)
            base = gauss_peak(fine, 0.07, 1.0, FWHM_DA)
            edges = np.arange(-8, 8 + step, step)
            y = np.bincount(np.digitize(fine, edges) - 1, weights=base, minlength=len(edges) - 1)[: len(grid)]
        else:
            y = gauss_peak(grid, 0.07, 1.0, FWHM_DA)
        for name, f in (("SG 5/2", f_sg(5, 2)), ("SG 7/2", f_sg(7, 2)), ("SG 15/3", f_sg(15, 3)),
                        ("MA 5", f_ma(5)), ("Gauss σ=1", f_gauss(1.0))):
            z = f(y)
            rows.append((label, name, z.max() / y.max()))
    return rows


def main():
    spectra, mz = load_sample()
    print("próbka:", spectra.shape, "krok m/z", np.median(np.diff(mz)))

    # --- charakterystyka szumu
    x = spectra[0].astype(float)
    bands = [(300, 400), (400, 600), (600, 800), (800, 1000), (1000, 1500)]
    noise_rows = []
    for lo, hi in bands:
        k = (mz >= lo) & (mz < hi)
        seg = spectra[:, k].astype(float)
        sig = np.median([white_noise_sigma(s) for s in seg])
        base = np.median(seg)
        det = np.array([detrend(s, 301) for s in seg])
        ac1 = np.mean([np.corrcoef(d[:-1], d[1:])[0, 1] for d in det])
        noise_rows.append((lo, hi, base, sig, ac1))
        print(f"{lo}-{hi} Da: mediana={base:.3f}  sigma_biały={sig:.4f}  autokorelacja(lag1)={ac1:.3f}")

    print("\n-- retencja wysokości piku (idealny pik, brak szumu) --")
    for r in retention_table():
        print(f"{r[0]:20s} {r[1]:12s} {r[2]*100:6.1f}%")

    print("\n-- benchmark detekcji (TPR przy FP=0.5/100Da) --")
    res_raw, sigma, _, _ = run_benchmark(spectra, mz, binned=False)
    print("sigma szumu (raw):", sigma)
    for k, v in res_raw.items():
        print(f"{k:38s}", " ".join(f"{a:5.2f}" for a in v))
    res_bin, _, sg_bin, _ = run_benchmark(spectra, mz, binned=True)
    print("\n-- po binningu 0.3 Da --")
    for k, v in res_bin.items():
        print(f"{k:38s}", " ".join(f"{a:5.2f}" for a in v))
    res_bmax, _, _, _ = run_benchmark(spectra, mz, binned=True, agg="max")
    print("\n-- po binningu 0.3 Da, agregacja = MAX (peak_apex) --")
    for k, v in res_bmax.items():
        print(f"{k:38s}", " ".join(f"{a:5.2f}" for a in v))
    print("amplitudy [σ_raw]:", AMPLITUDES)

    # --- wykresy
    fig, axes = plt.subplots(1, 2, figsize=(14, 5), sharey=True)
    for ax, res, title in ((axes[0], res_raw, "Surowa siatka (0.034 Da)"), (axes[1], res_bin, "Po binningu 0.3 Da (suma)")):
        for k, v in res.items():
            ax.plot(AMPLITUDES, v, marker="o", label=k, lw=2 if "Ricker" in k or "domyślne" in k else 1.3)
        ax.set_xlabel("amplituda piku [σ szumu białego, surowe]")
        ax.set_title(title)
        ax.grid(alpha=0.3)
        ax.legend(fontsize=7)
    axes[1].plot(AMPLITUDES, res_bmax["bez wygładzania"], "k--", label="bin MAX, bez wygładzania")
    axes[1].legend(fontsize=7)
    axes[0].set_ylabel(f"czułość (TPR) przy {FP_PER_100DA} FP / 100 Da")
    fig.tight_layout()
    fig.savefig(OUT / "05a_detection_benchmark.png", dpi=140)
    plt.close(fig)

    # przyklad na prawdziwym widmie: region 560-580 Da
    k = (mz >= 562) & (mz <= 572)
    spec = spectra[np.argmax(spectra[:, (mz >= 569) & (mz <= 569.5)].max(axis=1))].astype(float)
    fig, axs = plt.subplots(4, 1, figsize=(12, 9), sharex=True)
    meths = [("surowe", f_raw), ("SG 15/3 (appka)", f_sg(15, 3)), ("SG 7/2", f_sg(7, 2)), ("Gauss σ=1", f_gauss(1.0))]
    for ax, (n, f) in zip(axs, meths):
        ax.plot(mz[k], f(spec)[k], lw=1)
        ax.set_ylabel(n)
        ax.grid(alpha=0.3)
    axs[-1].set_xlabel("m/z [Da]")
    fig.suptitle("Realne widmo (jeden piksel), 562-572 Da")
    fig.tight_layout()
    fig.savefig(OUT / "05b_smoothing_example.png", dpi=140)
    plt.close(fig)

    # charakterystyka szumu
    fig, axs = plt.subplots(1, 3, figsize=(15, 4))
    mean = spectra.mean(axis=0)
    axs[0].plot(mz, mean, lw=0.6)
    axs[0].set_yscale("log")
    axs[0].set_title("Średnie widmo (log) — offset ≈ 0.75, nie 0")
    axs[1].bar([f"{a}-{b}" for a, b, *_ in noise_rows], [r[3] for r in noise_rows])
    axs[1].set_title("σ szumu białego [a.u.] wg pasma m/z")
    d1 = spectra[0, (mz > 1000)].astype(float)
    axs[2].hist(detrend(d1, 301), bins=100)
    axs[2].set_title("Rozkład szumu (900-1500 Da, po usunięciu trendu)")
    fig.tight_layout()
    fig.savefig(OUT / "05c_noise_characterization.png", dpi=140)
    plt.close(fig)


if __name__ == "__main__":
    main()
