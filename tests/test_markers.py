import numpy as np

from src.msi.markers import (
    colocalization_groups,
    integrate_windows,
    lock_mass_ppm,
    morans_i,
    region_contrast,
    spatial_ranking,
    to_grid,
)
from src.msi.peaks import als_baseline, describe_peaks, flag_isotopes


def _gauss(x, mu, fwhm, h=1.0):
    s = fwhm / 2.3548
    return h * np.exp(-0.5 * ((x - mu) / s) ** 2)


def test_describe_peaks_fwhm_centroid_snr():
    rng = np.random.default_rng(0)
    mz = np.arange(400, 420, 0.01)
    y = _gauss(mz, 405.0, 0.1, 10) + _gauss(mz, 412.3, 0.2, 5) + rng.normal(0, 0.05, len(mz)) + 1.0
    peaks = describe_peaks(mz, y, snr=5, half_window_da=0.1, noise="mad")
    found = sorted(p["mz"] for p in peaks)
    assert len(found) == 2
    assert abs(found[0] - 405.0) < 0.01 and abs(found[1] - 412.3) < 0.01
    p0 = min(peaks, key=lambda p: abs(p["mz"] - 405))
    assert abs(p0["fwhm"] - 0.1) < 0.03
    assert abs(p0["centroid"] - 405.0) < 0.01
    assert p0["r2"] is not None and p0["r2"] > 0.9
    assert p0["lo"] < 405.0 < p0["hi"]


def test_flag_isotopes_marks_m_plus_1():
    peaks = [
        {"mz": 500.0, "height": 10.0},
        {"mz": 501.0034, "height": 3.0},
        {"mz": 503.5, "height": 2.0},
    ]
    out = flag_isotopes(peaks)
    assert "isotope_of" not in out[0]
    assert out[1]["isotope_of"] == 500.0
    assert "isotope_of" not in out[2]


def test_als_baseline_removes_slope():
    x = np.linspace(0, 1, 2000)
    base = 2 + 3 * x
    y = base + _gauss(x, 0.5, 0.01, 5)
    z = als_baseline(y, lam=1e6, p=0.001)
    assert np.abs(z - base)[np.abs(x - 0.5) > 0.05].max() < 0.2


def test_integrate_windows_and_lock_mass():
    mz = np.arange(550, 560, 0.005)
    lock = 555.2231
    shift_ppm = 40
    y = _gauss(mz, lock * (1 + shift_ppm * 1e-6), 0.1, 100)
    ppm, h = lock_mass_ppm(mz, y, lock)
    assert abs(ppm - shift_ppm) < 3 and h > 90
    s, n = integrate_windows(mz, np.ones_like(mz), np.array([551.0]), np.array([552.0]))
    assert n[0] in (200, 201) and s[0] == n[0]  # krańce okna zależą od zaokrągleń siatki arange


def _two_tissues(seed=0):
    rng = np.random.default_rng(seed)
    xs, ys = np.meshgrid(np.arange(30), np.arange(20))
    xy1 = np.c_[xs.ravel(), ys.ravel()]
    xy2 = xy1 + [100, 0]
    xy = np.vstack([xy1, xy2])
    tissue = np.r_[np.zeros(len(xy1), int), np.ones(len(xy2), int)]
    left = (xy[:, 0] % 100) < 15
    structured = np.where(left, 5.0, 1.0) + rng.normal(0, 0.2, len(xy))
    noise = 3 + rng.normal(0, 1, len(xy))
    X = np.c_[noise, structured, structured * 2 + rng.normal(0, 0.1, len(xy))]
    return X, xy, tissue, left


def test_morans_i_structure_vs_noise():
    X, xy, tissue, _ = _two_tissues()
    m = tissue == 0
    assert morans_i(to_grid(xy[m], X[m, 1])) > 0.7
    assert abs(morans_i(to_grid(xy[m], X[m, 0]))) < 0.15


def test_spatial_ranking_puts_structured_first():
    X, xy, tissue, _ = _two_tissues()
    det = np.ones_like(X, dtype=bool)
    rows = spatial_ranking(
        X, det, xy, tissue, ["T1", "T2"], np.ones(len(X)), np.array([400.0, 500.0, 600.0])
    )
    assert rows[-1]["peak"] == 0
    assert set(rows[0]["per_tissue"]) == {"T1", "T2"}


def test_region_contrast_and_colocalization():
    X, xy, tissue, left = _two_tissues()
    m = tissue == 0
    res = region_contrast(X[m], left[m].astype(int), np.array([400.0, 500.0, 600.0]))
    rows = res["rows"]
    assert rows[1]["max_cliff"] > 0.9 and rows[1]["eps2"] > 0.5
    assert rows[0]["max_cliff"] < 0.3
    g = colocalization_groups(X, [1, 2, 0], r_threshold=0.8)
    assert g[2]["rep"] == 1 and g[0]["rep"] == 0
