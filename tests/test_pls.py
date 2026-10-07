import numpy as np

from src.msi.pls import pls_da, preprocess_matrix, quantize


def _groups(n=8, p=300, seed=0, effect=1.0):
    rng = np.random.default_rng(seed)
    mz = np.linspace(400, 1000, p)
    base = np.exp(-0.5 * ((mz - 600) / 4) ** 2) + 0.5 * np.exp(-0.5 * ((mz - 800) / 4) ** 2)
    marker = np.exp(-0.5 * ((mz - 700) / 3) ** 2)
    a = np.array([base + effect * marker + rng.normal(0, 0.05, p) for _ in range(n)])
    b = np.array([base + rng.normal(0, 0.05, p) for _ in range(n)])
    return mz, a, b


def test_pls_finds_marker_mz():
    mz, a, b = _groups()
    res = pls_da(a, b, lv=3, n_folds=4)
    beta = np.asarray(res["beta"])
    assert abs(mz[np.argmax(np.abs(beta))] - 700) < 8
    assert beta[np.argmax(np.abs(beta))] > 0          # A (+1) ma wyższy marker
    assert res["q2"] > 0.8 and res["cv_accuracy"] == 1.0
    assert len(res["msep_cv"]) == res["lv"] + 1
    assert len(res["pct_var_y"]) == res["lv"]


def test_pls_noise_has_low_q2_and_permutation_p():
    mz, a, b = _groups(effect=0.0)
    res = pls_da(a, b, lv=3, n_folds=4, n_perm=30)
    assert res["q2"] < 0.3
    assert res["perm_p"] > 0.05


def test_lv_capped_by_training_size():
    _, a, b = _groups(n=3)
    res = pls_da(a, b, lv=8, n_folds=3)
    assert res["lv"] < 8 and res["lv_requested"] == 8


def test_preprocess_matrix_crop_and_tic():
    mz, a, _ = _groups()
    out_mz, out = preprocess_matrix(mz, a, 500, 900, smooth_window=3, baseline_iterations=20)
    assert out_mz.min() >= 500 and out_mz.max() <= 900
    assert np.allclose(out.sum(axis=1), 1.0)


def test_quantize_keeps_relative_precision():
    v = np.array([1.234567e-4, 9.87654e-5, 0.0])
    q = np.asarray(quantize(v))
    assert np.allclose(q, v, rtol=1e-3, atol=1e-9)
