import numpy as np

from src.msi.preprocessing import apply_extra_step, peak_pick_snr, smooth_matched


def _spectrum(seed=0):
    rng = np.random.default_rng(seed)
    mz = np.arange(300, 400, 0.0336)
    y = 0.75 + rng.normal(0, 0.03, len(mz))
    for c in (320.0, 350.0, 380.0):
        y += 5 * np.exp(-0.5 * ((mz - c) / (0.09 / 2.355)) ** 2)
    return mz, y


def test_peak_pick_snr_finds_injected_peaks():
    mz, y = _spectrum()
    out, n = peak_pick_snr(mz, y, snr=5)
    assert n >= 3
    for c in (320.0, 350.0, 380.0):
        k = np.abs(mz - c) < 0.1
        assert out[k].max() > 3


def test_smooth_matched_keeps_peak_height_better_than_wide_window():
    mz, y = _spectrum()
    sm = smooth_matched(mz, y, 5000)
    assert sm.max() > 0.6 * y.max()
    assert len(sm) == len(y)


def test_apply_extra_step_dispatch():
    mz, y = _spectrum()
    assert apply_extra_step("nope", mz, y, {}) is None
    out, info = apply_extra_step("peakpick_snr", mz, y, {"snr": 5})
    assert info["n_peaks"] >= 3 and out.shape == y.shape


def test_peak_pick_snr_window_keeps_only_window_maximum():
    mz = np.arange(300, 310, 0.1)
    y = np.full(len(mz), 1.0)
    y[50], y[53] = 10.0, 6.0  # 0.3 Da od siebie
    _, n_narrow = peak_pick_snr(mz, y, snr=3, max_window_da=0.1)
    _, n_wide = peak_pick_snr(mz, y, snr=3, max_window_da=0.5)
    assert n_narrow == 2 and n_wide == 1
