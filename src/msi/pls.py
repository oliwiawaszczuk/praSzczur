"""PLS-DA dla zestawów widm (odpowiednik workflow MATLAB: msbackadj/mssgolay + plsregress).

Jednostką próbki jest jedno widmo (np. uśredniona tkanka albo segment), a nie piksel —
tak samo jak w skryptach MATLAB (`skrypt_ostateczny_*_KM_5dni_neg.m`), gdzie jeden plik
.txt = jedna próbka. Etykiety: grupa A = +1, grupa B = -1 (jak kolumna 2 macierzy `class_*`).

Mapowanie MATLAB → Python:
    mssgolay(x, d, 'SPAN', 3)        → scipy.signal.savgol_filter (okno nieparzyste, polyorder 2)
    msbackadj(..., 'WINDOWSIZE')     → SNIP (baseline_correction_snip) — inna metoda, ten sam cel
    data ./ sum(data, 2)             → normalizacja do sumy (TIC = 1)
    plsregress(X, Y, lv, 'CV', c)    → sklearn PLSRegression(scale=False) + własne CV
    PLSmsep(2, :)                    → msep_cv   (błąd CV Y dla 0..LV składowych)
    cumsum(100 * pctVar(2, :))       → pct_var_y (skumulowana wariancja Y, %)
    beta(2:end)                      → beta
"""

from __future__ import annotations

import numpy as np
from scipy.signal import savgol_filter
from sklearn.cross_decomposition import PLSRegression
from sklearn.model_selection import StratifiedKFold

from src.msi.preprocessing import baseline_correction_snip


def quantize(arr: np.ndarray, sig: int = 5) -> list[float]:
    """Zaokrągla do `sig` cyfr znaczących względem maksimum wektora — krótszy JSON
    (zestawy widm trafiają do pliku grafu), bez zauważalnej utraty dokładności."""
    a = np.asarray(arr, dtype=float)
    peak = float(np.max(np.abs(a))) if a.size else 0.0
    if peak <= 0 or not np.isfinite(peak):
        return a.tolist()
    decimals = sig - 1 - int(np.floor(np.log10(peak)))
    return np.round(a, decimals).tolist()


def preprocess_matrix(
    mz: np.ndarray,
    samples: np.ndarray,
    mz_min: float,
    mz_max: float,
    smooth_window: int = 3,
    baseline_iterations: int = 40,
    normalize: str = "tic",
) -> tuple[np.ndarray, np.ndarray]:
    """Kroki 7–8 skryptu MATLAB na macierzy (n_próbek, n_mz): zakres → wygładzanie →
    linia bazowa → normalizacja. Zwraca (mz_po_przycięciu, macierz)."""
    mz = np.asarray(mz, dtype=float)
    X = np.asarray(samples, dtype=float)
    keep = (mz >= mz_min) & (mz <= mz_max)
    if keep.sum() < 10:
        raise ValueError("Zakres m/z zawiera mniej niż 10 punktów")
    mz, X = mz[keep], X[:, keep]

    out = np.empty_like(X)
    for i, y in enumerate(X):
        if smooth_window >= 3:
            w = int(smooth_window) | 1
            if w <= len(y):
                y = savgol_filter(y, window_length=w, polyorder=min(2, w - 1))
        if baseline_iterations > 0:
            y, _ = baseline_correction_snip(y, iterations=int(baseline_iterations))
        if normalize == "tic":
            s = y.sum()
            if s > 0:
                y = y / s
        elif normalize == "max":
            m = y.max()
            if m > 0:
                y = y / m
        out[i] = y
    return mz, out


def _fit(Xc: np.ndarray, yc: np.ndarray, n_comp: int) -> PLSRegression:
    pls = PLSRegression(n_components=n_comp, scale=False, max_iter=500, tol=1e-8)
    pls.fit(Xc, yc.reshape(-1, 1))
    return pls


def _msep_by_k(X: np.ndarray, y: np.ndarray, folds, lv: int) -> np.ndarray:
    """CV: sumy kwadratów reszt Y dla k = 0..lv składowych (wiersz = k)."""
    sse = np.zeros(lv + 1)
    for tr, te in folds:
        xm, ym = X[tr].mean(axis=0), y[tr].mean()
        pls = _fit(X[tr] - xm, y[tr] - ym, lv)
        T = (X[te] - xm) @ pls.x_rotations_            # (n_te, lv)
        q = pls.y_loadings_.ravel()                    # (lv,)
        sse[0] += float(np.sum((y[te] - ym) ** 2))
        pred = np.zeros(len(te))
        for k in range(1, lv + 1):
            pred = pred + T[:, k - 1] * q[k - 1]
            sse[k] += float(np.sum((y[te] - (pred + ym)) ** 2))
    return sse


def _cv_predict(X: np.ndarray, y: np.ndarray, folds, lv: int) -> np.ndarray:
    ycv = np.zeros(len(y))
    for tr, te in folds:
        xm, ym = X[tr].mean(axis=0), y[tr].mean()
        pls = _fit(X[tr] - xm, y[tr] - ym, lv)
        ycv[te] = ((X[te] - xm) @ pls.x_rotations_ @ pls.y_loadings_.T).ravel() + ym
    return ycv


def _make_folds(y: np.ndarray, n_folds: int, seed: int):
    y_cls = (y > 0).astype(int)
    n_splits = max(2, min(n_folds, int(np.bincount(y_cls).min())))
    skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=seed)
    return list(skf.split(np.zeros(len(y)), y_cls)), n_splits


def pls_da(
    a: np.ndarray,
    b: np.ndarray,
    lv: int = 8,
    n_folds: int = 5,
    seed: int = 0,
    n_perm: int = 0,
) -> dict:
    """PLS-DA A(+1) vs B(-1) na zestawach widm (n_A, p) i (n_B, p)."""
    A = np.asarray(a, dtype=float)
    B = np.asarray(b, dtype=float)
    if A.ndim != 2 or B.ndim != 2 or A.shape[1] != B.shape[1]:
        raise ValueError("Zestawy A i B muszą mieć tę samą siatkę m/z")
    if min(len(A), len(B)) < 2:
        raise ValueError("Każda grupa potrzebuje co najmniej 2 próbek")

    X = np.vstack([A, B])
    y = np.concatenate([np.ones(len(A)), -np.ones(len(B))])
    n, p = X.shape

    folds, n_splits = _make_folds(y, n_folds, seed)
    min_train = min(len(tr) for tr, _ in folds)
    lv_eff = int(max(1, min(lv, min_train - 1, p)))

    sse = _msep_by_k(X, y, folds, lv_eff)
    msep = sse / n
    best_lv = int(np.argmin(msep[1:]) + 1)

    xm, ym = X.mean(axis=0), y.mean()
    pls = _fit(X - xm, y - ym, lv_eff)
    coef = (pls.x_rotations_ @ pls.y_loadings_.T).ravel()
    intercept = float(ym - xm @ coef)
    yfit = X @ coef + intercept

    ss_tot = float(np.sum((y - ym) ** 2))
    contrib = (pls.x_scores_ * pls.y_loadings_.ravel()) ** 2
    pct_var = 100.0 * contrib.sum(axis=0) / ss_tot

    ycv = _cv_predict(X, y, folds, lv_eff)
    press = float(np.sum((y - ycv) ** 2))
    r2 = 1.0 - float(np.sum((y - yfit) ** 2)) / ss_tot
    q2 = 1.0 - press / ss_tot

    perm_p = None
    perm_q2: list[float] = []
    if n_perm > 0:
        rng = np.random.default_rng(seed)
        for _ in range(int(n_perm)):
            yp = rng.permutation(y)
            fp, _ = _make_folds(yp, n_folds, int(rng.integers(1_000_000)))
            lv_p = int(max(1, min(lv_eff, min(len(tr) for tr, _ in fp) - 1)))
            ycv_p = _cv_predict(X, yp, fp, lv_p)
            perm_q2.append(1.0 - float(np.sum((yp - ycv_p) ** 2)) / ss_tot)
        perm_p = float((1 + sum(q >= q2 for q in perm_q2)) / (1 + len(perm_q2)))

    return {
        "lv": lv_eff,
        "lv_requested": int(lv),
        "best_lv": best_lv,
        "n_folds": n_splits,
        "n_a": int(len(A)),
        "n_b": int(len(B)),
        "beta": quantize(coef, 6),
        "intercept": intercept,
        "y": y.tolist(),
        "yfit": yfit.tolist(),
        "ycv": ycv.tolist(),
        "msep_cv": msep.tolist(),
        "pct_var_y": np.cumsum(pct_var).tolist(),
        "r2": r2,
        "q2": q2,
        "rmsecv": float(np.sqrt(press / n)),
        "cv_accuracy": float(np.mean(np.sign(ycv) == y)),
        "perm_p": perm_p,
        "perm_q2": [round(v, 4) for v in perm_q2],
    }
