"""
FastAPI sidecar — serwuje dane MSI dla aplikacji praSzczur.
Port: 7432
"""

from contextlib import asynccontextmanager
from pathlib import Path
import sys
import time
import json
import shutil
import uuid
import asyncio
from datetime import datetime, timezone
from typing import AsyncIterator

import os
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

ROOT           = Path(os.environ.get("PRASZCZUR_ROOT", Path(__file__).resolve().parents[2]))
WORKSPACES_DIR = ROOT / "workspaces"
SRC_DIR        = ROOT / "src"
sys.path.insert(0, str(ROOT))

# ── Cache ──────────────────────────────────────────────────────────────────
_cache: dict[str, dict] = {}   # tissue_id → {spectra, coords, mz_bins}
_tissues_meta: list[dict] = [] # wykryte tkanki (x_min, x_max, label, is_ref)
_imzml_path: str = ""          # ostatnio przetworzony plik imzML
_active_workspace_id: str = "" # aktywny workspace


# ── Workspace helpers ────────────────────────────────────────────────────────
_REGISTRY_FILE = WORKSPACES_DIR / "registry.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_registry() -> dict:
    try:
        if _REGISTRY_FILE.exists():
            return json.loads(_REGISTRY_FILE.read_text())
    except Exception:
        pass
    return {"active_id": "", "workspaces": []}


def _save_registry(reg: dict) -> None:
    WORKSPACES_DIR.mkdir(parents=True, exist_ok=True)
    _REGISTRY_FILE.write_text(json.dumps(reg, indent=2))


def _workspace_dir(wid: str) -> Path:
    return WORKSPACES_DIR / wid


def DATA_DIR() -> Path:
    return _workspace_dir(_active_workspace_id) / "processed"


def _settings_file(wid: str) -> Path:
    return _workspace_dir(wid) / "workspace.json"


def _imzml_path_file(wid: str) -> Path:
    return _workspace_dir(wid) / "imzml_path.txt"


def _find_ws(reg: dict, wid: str) -> dict | None:
    return next((w for w in reg["workspaces"] if w["id"] == wid), None)


def _ensure_default_workspace() -> dict:
    """Wczytuje registry; jeśli brak workspace'ów, tworzy domyślny i migruje
    ewentualne stare dane z data/processed/ (poprzedni, jednoworkspace'owy model)."""
    reg = _load_registry()
    if not reg["workspaces"]:
        wid = uuid.uuid4().hex[:12]
        now = _now_iso()
        reg["workspaces"] = [{"id": wid, "name": "Domyślny", "createdAt": now, "updatedAt": now}]
        reg["active_id"] = wid
        ws_dir = _workspace_dir(wid)
        (ws_dir / "processed").mkdir(parents=True, exist_ok=True)
        _settings_file(wid).write_text("{}")

        legacy = ROOT / "data" / "processed"
        if legacy.exists():
            for f in legacy.glob("*.npz"):
                shutil.copy(f, ws_dir / "processed" / f.name)
            legacy_path_file = legacy / "imzml_path.txt"
            if legacy_path_file.exists():
                shutil.copy(legacy_path_file, _imzml_path_file(wid))
        _save_registry(reg)
    elif not reg.get("active_id") or not _find_ws(reg, reg["active_id"]):
        reg["active_id"] = reg["workspaces"][0]["id"]
        _save_registry(reg)
    return reg


def _load_imzml_path() -> str:
    """Odczytuje zapisaną ścieżkę imzML aktywnego workspace."""
    try:
        f = _imzml_path_file(_active_workspace_id)
        if f.exists():
            p = f.read_text().strip()
            if p and Path(p).exists():
                return p
    except Exception:
        pass
    return ""


def _save_imzml_path(path: str) -> None:
    """Zapisuje ścieżkę imzML aktywnego workspace."""
    try:
        _workspace_dir(_active_workspace_id).mkdir(parents=True, exist_ok=True)
        _imzml_path_file(_active_workspace_id).write_text(path)
    except Exception:
        pass


def _load_npz_files() -> list[str]:
    """Ładuje wszystkie dostępne pliki .npz z DATA_DIR aktywnego workspace. Zwraca listę tissue_id."""
    global _imzml_path
    _cache.clear()
    _imzml_path = _load_imzml_path()
    found = []
    DATA_DIR().mkdir(parents=True, exist_ok=True)
    for path in sorted(DATA_DIR().glob("*.npz")):
        tid = path.stem
        d = np.load(path)
        _cache[tid] = {
            "spectra": d["spectra"],
            "coords":  d["coords"],
            "mz_bins": d["mz_bins"],
        }
        found.append(tid)
    return found


def _build_tissues_meta(tissue_ids: list[str]) -> list[dict]:
    """Buduje metadane tkanek z załadowanych danych."""
    meta = []
    for i, tid in enumerate(tissue_ids):
        coords = _cache[tid]["coords"]
        xs = coords[:, 0].astype(int)
        ys = coords[:, 1].astype(int)
        meta.append({
            "id":       tid,
            "label":    tid.replace("_", " "),
            "x_min":    int(xs.min()),
            "x_max":    int(xs.max()),
            "y_min":    int(ys.min()),
            "y_max":    int(ys.max()),
            "n_spectra": int(len(coords)),
            "is_ref":   i == 0,
        })
    return meta


def _detect_tissues_from_tic(col_tic: np.ndarray, x_offset: int,
                               threshold_pct: float = 5.0) -> list[dict]:
    """Detekcja granic tkanek z profilu kolumnowego TIC.

    Strategia:
    1. Kolumny z col_tic == 0 to pewne przerwy (brak spektrów).
    2. Kolumny > 0 grupujemy w segmenty, pomijając krótkie przerwy
       (min_gap = max(3, threshold_pct% * szerokości)).
    3. Odrzucamy segmenty zbyt wąskie (< min_width kolumn).
    """
    n = len(col_tic)
    if n == 0 or col_tic.max() == 0:
        return []

    # Próg: ułamek maksimum profilu (eliminuje szum, zachowuje tkankę)
    threshold = float(col_tic.max()) * (threshold_pct / 100.0)
    is_tissue = col_tic >= threshold

    # Łącz przerwy krótsze niż min_gap kolumn
    min_gap = max(3, int(n * 0.01))
    i = 0
    while i < n:
        if not is_tissue[i]:
            j = i
            while j < n and not is_tissue[j]:
                j += 1
            if (j - i) < min_gap and i > 0 and j < n:
                is_tissue[i:j] = True
            i = max(i + 1, j)
        else:
            i += 1

    # Znajdź segmenty
    min_width = max(2, int(n * 0.005))
    tissues, in_t, start = [], False, 0
    for i, v in enumerate(is_tissue):
        if v and not in_t:
            start = i
            in_t = True
        elif not v and in_t:
            in_t = False
            if (i - start) >= min_width:
                idx = len(tissues)
                tissues.append({
                    "id":     f"T{idx+1}",
                    "label":  f"T{idx+1}",
                    "x_min":  int(start + x_offset),
                    "x_max":  int(i - 1 + x_offset),
                    "is_ref": idx == 0,
                })
    if in_t and (n - start) >= min_width:
        idx = len(tissues)
        tissues.append({
            "id":     f"T{idx+1}",
            "label":  f"T{idx+1}",
            "x_min":  int(start + x_offset),
            "x_max":  int(n - 1 + x_offset),
            "is_ref": idx == 0,
        })
    return tissues


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    global _tissues_meta, _active_workspace_id
    reg = _ensure_default_workspace()
    _active_workspace_id = reg["active_id"]
    ids = _load_npz_files()
    _tissues_meta = _build_tissues_meta(ids)
    yield


app = FastAPI(title="praSzczur API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Health ─────────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> dict:
    return {"status": "ok", "loaded": bool(_cache), "n_tissues": len(_cache)}


# ── Dataset status ─────────────────────────────────────────────────────────
@app.get("/dataset_status")
def dataset_status() -> dict:
    npz_files = []
    for path in sorted(DATA_DIR().glob("*.npz")):
        stat = path.stat()
        npz_files.append({
            "id":       path.stem,
            "filename": path.name,
            "size_mb":  round(stat.st_size / 1024**2, 2),
            "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
        })

    mz_bins = _cache[list(_cache.keys())[0]]["mz_bins"] if _cache else np.array([])
    return {
        "data_dir":    str(DATA_DIR()),
        "npz_files":   npz_files,
        "tissues":     _tissues_meta,
        "n_tissues":   len(_cache),
        "mz_min":      float(mz_bins.min()) if len(mz_bins) else 0,
        "mz_max":      float(mz_bins.max()) if len(mz_bins) else 0,
        "n_bins":      int(len(mz_bins)),
    }


# ── TIC data ───────────────────────────────────────────────────────────────
@app.get("/tic_data")
def tic_data(threshold_pct: float = 5.0) -> dict:
    """Zwraca 2D TIC + profil kolumnowy + auto-wykryte granice tkanek."""
    if not _cache:
        raise HTTPException(503, "Dane nie załadowane")

    # Globalne granice
    all_coords = np.vstack([d["coords"] for d in _cache.values()])
    gx_min, gy_min = int(all_coords[:, 0].min()), int(all_coords[:, 1].min())
    gx_max, gy_max = int(all_coords[:, 0].max()), int(all_coords[:, 1].max())
    W = gx_max - gx_min + 1
    H = gy_max - gy_min + 1

    # Pełny obraz TIC
    tic_2d = np.zeros((H, W), dtype=np.float32)
    for d in _cache.values():
        coords = d["coords"]
        tic_vals = d["spectra"].sum(axis=1)
        xs = coords[:, 0].astype(int) - gx_min
        ys = coords[:, 1].astype(int) - gy_min
        tic_2d[ys, xs] = tic_vals

    # Profil kolumnowy
    col_tic = tic_2d.mean(axis=0)

    # Normalizacja 2D TIC → 0–1 (do wyświetlenia)
    vmax = float(tic_2d.max())
    tic_norm = (tic_2d / vmax).tolist() if vmax > 0 else tic_2d.tolist()

    # Normalizacja profilu → 0–1
    col_max = float(col_tic.max())
    col_norm = (col_tic / col_max).tolist() if col_max > 0 else col_tic.tolist()

    # Auto-detekcja
    detected = _detect_tissues_from_tic(col_tic, gx_min, threshold_pct)

    return {
        "tic_image":    tic_norm,       # 2D, H×W, 0–1
        "width":        W,
        "height":       H,
        "x_offset":     gx_min,
        "col_profile":  col_norm,       # 1D, długość W, 0–1
        "detected":     detected,       # lista tkanek
        "n_detected":   len(detected),
    }


# ── Default tissue bounds (from src/msi/constants.py) ──────────────────────
@app.get("/default_tissues")
def default_tissues() -> dict:
    """Zwraca domyślne granice tkanek potwierdzone wizualnie."""
    from src.msi.constants import TISSUE_BOUNDS
    tissues = []
    for i, (name, (x_min, x_max)) in enumerate(TISSUE_BOUNDS.items()):
        tissues.append({
            "id":     name,
            "label":  name,
            "x_min":  x_min,
            "x_max":  x_max,
            "is_ref": i == 0,
        })
    return {"tissues": tissues, "n_tissues": len(tissues)}


# ── Detect tissues from cache ───────────────────────────────────────────────
@app.get("/detect_tissues")
def detect_tissues(threshold_pct: float = 5.0) -> dict:
    tic = tic_data(threshold_pct)
    return {"detected": tic["detected"], "n_detected": tic["n_detected"]}


# ── Detect tissues directly from imzML file (no preprocessing needed) ───────
@app.get("/detect_from_imzml")
def detect_from_imzml(path: str, threshold_pct: float = 5.0) -> dict:
    """Wykrywa ROI z pliku imzML na podstawie samych współrzędnych spektrów."""
    from pyimzml.ImzMLParser import ImzMLParser

    imzml_path = Path(path)
    if not imzml_path.is_absolute():
        imzml_path = ROOT / imzml_path

    if not imzml_path.exists():
        raise HTTPException(404, f"Brak pliku: {path}")

    ibd_candidates = [f for f in imzml_path.parent.glob("*")
                      if f.suffix.lower() == ".ibd"]
    matching = [f for f in ibd_candidates
                if f.stem.lower() == imzml_path.stem.lower()]
    if not matching:
        names = ", ".join(f.name for f in ibd_candidates) or "brak"
        raise HTTPException(404,
            f"Brak pasującego .ibd dla '{imzml_path.name}'. Znalezione: {names}")

    p = ImzMLParser(str(imzml_path))
    coords = np.array(p.coordinates)

    xs = coords[:, 0].astype(int)
    ys = coords[:, 1].astype(int)
    gx_min, gx_max = int(xs.min()), int(xs.max())
    gy_min, gy_max = int(ys.min()), int(ys.max())
    W = gx_max - gx_min + 1
    H = gy_max - gy_min + 1

    # Mapa obecności spektrów (bez czytania danych spektralnych)
    presence = np.zeros((H, W), dtype=np.float32)
    presence[ys - gy_min, xs - gx_min] = 1.0
    col_profile = presence.mean(axis=0)

    # Detekcja po przerwach w koordynatach X
    xs_unique = np.unique(xs)
    min_gap_x = max(2, int(W * 0.01))
    gap_idx_x = np.where(np.diff(xs_unique) > min_gap_x)[0]
    starts_x = np.concatenate([[0], gap_idx_x + 1])
    ends_x   = np.concatenate([gap_idx_x, [len(xs_unique) - 1]])

    # Detekcja po przerwach w koordynatach Y
    ys_unique = np.unique(ys)
    min_gap_y = max(2, int(H * 0.01))
    gap_idx_y = np.where(np.diff(ys_unique) > min_gap_y)[0]
    starts_y = np.concatenate([[0], gap_idx_y + 1])
    ends_y   = np.concatenate([gap_idx_y, [len(ys_unique) - 1]])

    # Profil wierszy (symetrycznie do col_profile)
    row_profile = presence.mean(axis=1)
    row_max = float(row_profile.max())
    row_norm = (row_profile / row_max).tolist() if row_max > 0 else row_profile.tolist()

    # Grid segmentów X×Y — filtruj puste komórki (brak spektrów w przecięciu)
    detected = []
    tid = 1
    for sx, ex in zip(starts_x, ends_x):
        x0, x1 = int(xs_unique[sx]), int(xs_unique[ex])
        for sy, ey in zip(starts_y, ends_y):
            y0, y1 = int(ys_unique[sy]), int(ys_unique[ey])
            mask = ((xs >= x0) & (xs <= x1) & (ys >= y0) & (ys <= y1))
            if mask.sum() == 0:
                continue
            detected.append({
                "id":     f"T{tid}",
                "label":  f"T{tid}",
                "x_min":  x0, "x_max": x1,
                "y_min":  y0, "y_max": y1,
                "is_ref": tid == 1,
            })
            tid += 1

    col_max = float(col_profile.max())
    col_norm = (col_profile / col_max).tolist() if col_max > 0 else col_profile.tolist()

    return {
        "detected":       detected,
        "n_detected":     len(detected),
        "col_profile":    col_norm,
        "row_profile":    row_norm,
        "presence_image": presence.tolist(),
        "width":          W,
        "height":         H,
        "x_offset":       gx_min,
        "y_offset":       gy_min,
    }


# ── Sample spectrum (szybki podgląd widma z imzML) ─────────────────────────
@app.get("/sample_spectrum")
def sample_spectrum(path: str, n_samples: int = 300, x_min: int = -1, x_max: int = -1) -> dict:
    """Zwraca sumę widm z n losowych spektrów — do podglądu zakresu m/z.
    Jeśli x_min/x_max podane, pobiera tylko spektra z tej kolumny X (tkanka referencyjna)."""
    from pyimzml.ImzMLParser import ImzMLParser
    imzml_path = Path(path)
    if not imzml_path.is_absolute():
        imzml_path = ROOT / imzml_path
    if not imzml_path.exists():
        raise HTTPException(404, f"Brak pliku: {path}")

    p = ImzMLParser(str(imzml_path))
    coords_arr = np.array(p.coordinates)

    if x_min >= 0 and x_max >= 0:
        mask = (coords_arr[:, 0] >= x_min) & (coords_arr[:, 0] <= x_max)
        valid = np.where(mask)[0]
    else:
        valid = np.arange(len(p.coordinates))

    rng = np.random.default_rng(42)
    indices = rng.choice(valid, size=min(n_samples, len(valid)), replace=False)
    indices.sort()

    # Zbierz wszystkie punkty m/z żeby znaleźć zakres
    all_mz = []
    all_int = []
    for i in indices:
        try:
            mz, ints = p.getspectrum(int(i))
            all_mz.append(np.asarray(mz, dtype=np.float64))
            all_int.append(np.asarray(ints, dtype=np.float64))
        except Exception:
            continue

    if not all_mz:
        raise HTTPException(500, "Brak danych spektralnych")

    mz_min_data = float(min(m.min() for m in all_mz))
    mz_max_data = float(max(m.max() for m in all_mz))

    # Binuj na 8000 punktów do wyświetlenia (lepsza rozdzielczość, ~0.15 Da/pkt)
    n_disp = 8000
    bin_edges = np.linspace(mz_min_data, mz_max_data, n_disp + 1)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2
    summed = np.zeros(n_disp, dtype=np.float64)
    for mz_arr, int_arr in zip(all_mz, all_int):
        idx = np.searchsorted(bin_centers, mz_arr, side="left")
        idx = np.clip(idx, 0, n_disp - 1)
        np.add.at(summed, idx, int_arr)

    vmax = float(summed.max())
    norm = (summed / vmax).tolist() if vmax > 0 else summed.tolist()
    return {
        "mz": bin_centers.tolist(),
        "intensity": norm,
        "mz_min": mz_min_data,
        "mz_max": mz_max_data,
        "n_samples": len(all_mz),
    }


# ── Spectrum window — pełna rozdzielczość dla bin preview ─────────────────
@app.get("/spectrum_window")
def spectrum_window(path: str, mz_lo: float, mz_hi: float,
                    x_min: int = -1, x_max: int = -1, n_avg: int = 20) -> dict:
    """Zwraca uśrednione widmo w oknie [mz_lo, mz_hi] przy pełnej rozdzielczości.
    n_avg spektrów (domyślnie 20) — wystarczy do widoczności struktury bez wygładzania."""
    from pyimzml.ImzMLParser import ImzMLParser
    imzml_path = Path(path)
    if not imzml_path.is_absolute():
        imzml_path = ROOT / imzml_path
    if not imzml_path.exists():
        raise HTTPException(404, f"Brak pliku: {path}")

    p = ImzMLParser(str(imzml_path))
    coords_arr = np.array(p.coordinates)

    if x_min >= 0 and x_max >= 0:
        mask = (coords_arr[:, 0] >= x_min) & (coords_arr[:, 0] <= x_max)
        valid = np.where(mask)[0]
    else:
        valid = np.arange(len(p.coordinates))

    rng = np.random.default_rng(42)
    indices = rng.choice(valid, size=min(n_avg, len(valid)), replace=False)
    indices.sort()

    # Pobierz pierwsze widmo żeby mieć pełną oś m/z
    mz_ref, _ = p.getspectrum(int(indices[0]))
    mz_ref = np.asarray(mz_ref, dtype=np.float64)

    # Indeksy w oknie
    lo_i = np.searchsorted(mz_ref, mz_lo, side="left")
    hi_i = np.searchsorted(mz_ref, mz_hi, side="right")
    if lo_i >= hi_i:
        raise HTTPException(400, "Puste okno m/z")

    mz_win = mz_ref[lo_i:hi_i]
    sum_int = np.zeros(len(mz_win), dtype=np.float64)
    count = 0
    for i in indices:
        try:
            _, ints = p.getspectrum(int(i))
            ints = np.asarray(ints, dtype=np.float64)
            sum_int += ints[lo_i:hi_i]
            count += 1
        except Exception:
            continue

    avg_int = sum_int / max(count, 1)
    # Normalizuj do globalnego max z całego uśrednionego widma (nie lokalnego!)
    # ale globalna normalizacja musi być taka sama jak w sample_spectrum
    # Pobieramy globalny max osobno
    global_max = 0.0
    for i in indices[:5]:  # wystarczy 5 spektrów do globalnego max
        try:
            _, ints = p.getspectrum(int(i))
            global_max = max(global_max, float(np.max(ints)))
        except Exception:
            continue
    if global_max <= 0:
        global_max = float(avg_int.max()) or 1.0

    norm = (avg_int / global_max).tolist()
    return {
        "mz": mz_win.tolist(),
        "intensity": norm,
        "n_points": len(mz_win),
        "n_avg": count,
        "global_max": global_max,
    }


# ── Ion image ──────────────────────────────────────────────────────────────
@app.get("/ion_image")
def ion_image(mz: float, tol: float = 0.3) -> dict:
    if not _cache:
        raise HTTPException(503, "Dane nie załadowane")

    result = {}
    for tid, d in _cache.items():
        mz_bins   = d["mz_bins"]
        spectra   = d["spectra"]
        coords    = d["coords"]

        # Gwarantuj, że zapytanie trafi w co najmniej jeden bin
        bin_size = float(mz_bins[1] - mz_bins[0]) if len(mz_bins) > 1 else 0.0
        effective_tol = max(tol, bin_size / 2.0)
        mask = np.abs(mz_bins - mz) <= effective_tol
        intensities = spectra[:, mask].sum(axis=1).astype(np.float64) if mask.any() \
                      else np.zeros(len(coords), dtype=np.float64)

        xs, ys = coords[:, 0].astype(int), coords[:, 1].astype(int)
        x0, y0 = xs.min(), ys.min()
        img = np.zeros((ys.max()-y0+1, xs.max()-x0+1), dtype=np.float64)
        img[ys-y0, xs-x0] = intensities

        vmax_local = float(img.max())
        meta = next((m for m in _tissues_meta if m["id"] == tid), {})
        result[tid] = {
            "label":  meta.get("label", tid),
            "_img":   img,
            "width":  int(xs.max()-x0+1),
            "height": int(ys.max()-y0+1),
            "vmax":   vmax_local,
        }

    # Wspólny vmax przez wszystkie tkanki
    global_vmax = max((v["vmax"] for v in result.values()), default=1.0)
    if global_vmax <= 0:
        global_vmax = 1.0
    for tid, v in result.items():
        img = v.pop("_img")
        v["data"] = (img / global_vmax).tolist()
        v["vmax"] = global_vmax   # ten sam dla każdej tkanki

    return {"mz": mz, "tol": tol, "tissues": result}


@app.get("/ion_image_raw")
def ion_image_raw(mz: float, tol: float = 0.3) -> dict:
    """Jak /ion_image, ale liczy sumę intensywności bezpośrednio z oryginalnego
    pliku imzML (mz ± tol), z pominięciem binowania z .npz."""
    if not _cache:
        raise HTTPException(503, "Dane nie załadowane")
    if not _imzml_path:
        raise HTTPException(503, "Brak ścieżki do pliku imzML — uruchom preprocessing raz aby zapamiętać ścieżkę.")
    path = Path(_imzml_path)
    if not path.exists():
        raise HTTPException(404, f"Plik {path} nie istnieje")

    from pyimzml.ImzMLParser import ImzMLParser
    p = ImzMLParser(str(path))
    raw_coords = np.array(p.coordinates)
    coord_to_idx = {(int(rx), int(ry)): i for i, (rx, ry, *_ ) in enumerate(raw_coords)}

    result = {}
    for tid, d in _cache.items():
        coords = d["coords"]
        xs, ys = coords[:, 0].astype(int), coords[:, 1].astype(int)
        x0, y0 = xs.min(), ys.min()
        img = np.zeros((ys.max()-y0+1, xs.max()-x0+1), dtype=np.float64)
        for x, y in zip(xs, ys):
            idx = coord_to_idx.get((int(x), int(y)))
            if idx is None:
                continue
            mz_arr, ints = p.getspectrum(idx)
            mz_arr = np.asarray(mz_arr, dtype=np.float64)
            ints   = np.asarray(ints,   dtype=np.float64)
            mask = np.abs(mz_arr - mz) <= tol
            img[y-y0, x-x0] = float(ints[mask].sum()) if mask.any() else 0.0

        vmax_local = float(img.max())
        meta = next((m for m in _tissues_meta if m["id"] == tid), {})
        result[tid] = {
            "label":  meta.get("label", tid),
            "_img":   img,
            "width":  int(xs.max()-x0+1),
            "height": int(ys.max()-y0+1),
            "vmax":   vmax_local,
        }

    global_vmax = max((v["vmax"] for v in result.values()), default=1.0)
    if global_vmax <= 0:
        global_vmax = 1.0
    for tid, v in result.items():
        img = v.pop("_img")
        v["data"] = (img / global_vmax).tolist()
        v["vmax"] = global_vmax

    return {"mz": mz, "tol": tol, "tissues": result}


@app.get("/mz_profile")
def mz_profile(mz: float, tol: float = 0.3, n: int = 7) -> dict:
    """Summed intensity across all tissues for n bins around mz."""
    if not _cache:
        raise HTTPException(503, "Dane nie załadowane")
    first = list(_cache.values())[0]
    mz_bins = first["mz_bins"]
    bin_size = float(mz_bins[1] - mz_bins[0]) if len(mz_bins) > 1 else tol
    half = n // 2
    sample_mzs = [mz + (k - half) * bin_size for k in range(n)]
    points = []
    for smz in sample_mzs:
        total = 0.0
        for d in _cache.values():
            mb = d["mz_bins"]
            sp = d["spectra"]
            mask = np.abs(mb - smz) <= bin_size / 2.0 + 1e-9
            if mask.any():
                total += float(sp[:, mask].sum())
        points.append({"mz": round(smz, 4), "intensity": total})
    return {"points": points, "bin_size": round(bin_size, 4)}


# ── Preprocess (SSE stream) ────────────────────────────────────────────────
@app.post("/process")
async def process(body: dict) -> StreamingResponse:
    """
    Uruchamia preprocessing z podanymi parametrami.
    Streamuje postęp jako Server-Sent Events.
    body: { bin_size, mz_min, mz_max, tissues: [{id, x_min, x_max, label, is_ref}] }
    """
    from src.msi.constants import MZ_MIN, MZ_MAX, BIN_SIZE

    bin_size   = float(body.get("bin_size",  BIN_SIZE))
    bin_agg    = str(body.get("bin_agg", "sum"))  # "sum" | "mean" | "peak_apex"
    mz_min     = float(body.get("mz_min",   MZ_MIN))
    mz_max     = float(body.get("mz_max",   MZ_MAX))
    tissues    = body.get("tissues", _tissues_meta)
    imzml_path = Path(body["imzml_path"]) if body.get("imzml_path") else \
                 ROOT / "source" / "FMP10_Rat_brain_breg_084.imzML"
    if not imzml_path.is_absolute():
        imzml_path = ROOT / imzml_path

    async def generate():
        yield _sse("start", {"message": "Uruchamianie preprocessingu…"})

        try:
            from pyimzml.ImzMLParser import ImzMLParser

            if not imzml_path.exists():
                yield _sse("error", {"message": f"Brak pliku: {imzml_path.name}"})
                return

            # Szukaj .ibd/.IBD z tą samą nazwą (case-insensitive)
            ibd_candidates = [f for f in imzml_path.parent.glob("*")
                              if f.suffix.lower() == ".ibd"]
            matching_ibd = [f for f in ibd_candidates if f.stem.lower() == imzml_path.stem.lower()]
            if not matching_ibd:
                names = ", ".join(f.name for f in ibd_candidates) or "brak"
                yield _sse("error", {"message":
                    f"Brak pasującego pliku .ibd dla '{imzml_path.name}'. "
                    f"Znalezione pliki .ibd: {names}. "
                    f"Plik .ibd musi mieć tę samą nazwę co .imzML."})
                return

            yield _sse("progress", {"step": "loading", "pct": 5,
                                     "message": "Wczytywanie imzML…"})
            p = ImzMLParser(str(imzml_path))
            coords_arr = np.array(p.coordinates)

            bin_centers = np.arange(mz_min + bin_size/2, mz_max, bin_size)
            n_bins = len(bin_centers)
            yield _sse("progress", {"step": "binning", "pct": 10,
                                     "message": f"Binning: {n_bins} binów po {bin_size} Da"})

            buffers = {t["id"]: {"spectra": [], "coords": []} for t in tissues}
            n_total = len(p.coordinates)

            # Buduj listę tkanek z zakresami (x,y) — obsługuje siatki 2D
            def find_tissue(x: int, y: int) -> dict | None:
                for t in tissues:
                    if (t["x_min"] <= x <= t["x_max"] and
                            t.get("y_min", -10**9) <= y <= t.get("y_max", 10**9)):
                        return t
                return None

            half = bin_size / 2.0
            for i in range(n_total):
                x, y = int(coords_arr[i, 0]), int(coords_arr[i, 1])
                t = find_tissue(x, y)
                if t is None:
                    continue
                try:
                    mz_arr, ints = p.getspectrum(i)
                    mz_arr = np.asarray(mz_arr, dtype=np.float64)
                    ints   = np.asarray(ints,   dtype=np.float32)
                except Exception:
                    continue
                binned = np.zeros(n_bins, dtype=np.float32)
                idx = np.searchsorted(bin_centers, mz_arr - half, side="right")
                in_range = (idx < n_bins) & (
                    np.abs(mz_arr - bin_centers[np.clip(idx, 0, n_bins-1)]) <= half
                )
                if bin_agg == "mean":
                    counts = np.zeros(n_bins, dtype=np.int32)
                    np.add.at(binned, idx[in_range], ints[in_range])
                    np.add.at(counts, idx[in_range], 1)
                    np.divide(binned, counts, out=binned, where=counts > 0)
                elif bin_agg == "peak_apex":
                    # bierze maksimum surowych punktów w oknie bina (bez sumowania/uśredniania)
                    np.maximum.at(binned, idx[in_range], ints[in_range])
                else:
                    np.add.at(binned, idx[in_range], ints[in_range])
                buffers[t["id"]]["spectra"].append(binned)
                buffers[t["id"]]["coords"].append([x, y])

                if i % 500 == 0:
                    pct = 10 + int(80 * i / n_total)
                    yield _sse("progress", {"step": "processing", "pct": pct,
                                             "message": f"Spektrum {i}/{n_total}"})
                    await asyncio.sleep(0)  # yield kontroli

            yield _sse("progress", {"step": "saving", "pct": 92,
                                     "message": "Zapis plików .npz…"})
            DATA_DIR().mkdir(parents=True, exist_ok=True)
            for old in DATA_DIR().glob("*.npz"):
                old.unlink()
            summary = []
            for t in tissues:
                tid  = t["id"]
                buf  = buffers[tid]
                if not buf["spectra"]:
                    continue
                spectra_arr = np.stack(buf["spectra"])
                coords_out  = np.array(buf["coords"], dtype=np.int16)
                out_path = DATA_DIR() / f"{tid}.npz"
                np.savez_compressed(out_path, spectra=spectra_arr,
                                    coords=coords_out, mz_bins=bin_centers)
                summary.append({"id": tid, "n_spectra": len(buf["spectra"])})
                await asyncio.sleep(0)

            # Przeładuj cache
            global _imzml_path
            _imzml_path = str(imzml_path)
            _save_imzml_path(_imzml_path)
            _cache.clear()
            _tissues_meta.clear()
            ids = _load_npz_files()
            _tissues_meta.extend(_build_tissues_meta(ids))
            _touch_workspace(_active_workspace_id)

            yield _sse("done", {"message": "Preprocessing zakończony", "summary": summary})

        except Exception as exc:
            import traceback
            yield _sse("error", {"message": str(exc), "trace": traceback.format_exc()})

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


def _sse(event: str, data: dict) -> str:
    import json as _json
    return f"event: {event}\ndata: {_json.dumps(data)}\n\n"


# ── Pixel spectrum ─────────────────────────────────────────────────────────
@app.get("/pixel_spectrum_raw")
def pixel_spectrum_raw(tissue: str, x: int, y: int) -> dict:
    """Zwraca oryginalne (niebinowane) widmo dla piksela z pliku imzML."""
    if not _imzml_path:
        raise HTTPException(503, "Brak ścieżki do pliku imzML — uruchom preprocessing")
    path = Path(_imzml_path)
    if not path.exists():
        raise HTTPException(404, f"Plik {path} nie istnieje")
    try:
        from pyimzml.ImzMLParser import ImzMLParser
        p = ImzMLParser(str(path))
        coords_arr = np.array(p.coordinates)
        idx = np.where((coords_arr[:, 0] == x) & (coords_arr[:, 1] == y))[0]
        if len(idx) == 0:
            raise HTTPException(404, f"Brak piksela ({x},{y})")
        mz_arr, ints = p.getspectrum(int(idx[0]))
        return {"tissue": tissue, "x": x, "y": y,
                "mz": [round(float(m), 6) for m in mz_arr],
                "intensity": [float(v) for v in ints]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/pixel_spectrum")
def pixel_spectrum(tissue: str, x: int, y: int) -> dict:
    """Zwraca pełne widmo binned dla piksela (x, y) w tkance."""
    if tissue not in _cache:
        raise HTTPException(404, f"Tkanka '{tissue}' nie jest załadowana")
    d = _cache[tissue]
    coords = d["coords"]
    mask = (coords[:, 0] == x) & (coords[:, 1] == y)
    idx = np.where(mask)[0]
    if len(idx) == 0:
        raise HTTPException(404, f"Brak piksela ({x},{y}) w tkance '{tissue}'")
    spectrum = d["spectra"][idx[0]].tolist()
    mz_bins  = d["mz_bins"].tolist()
    return {"tissue": tissue, "x": x, "y": y, "mz": mz_bins, "intensity": spectrum}


# ── Tissue pixel map for Widma tab ────────────────────────────────────────
@app.get("/tissue_pixel_map")
def tissue_pixel_map(tissue: str, mz: float = -1.0, tol: float = 0.3,
                     global_vmax: float = -1.0) -> dict:
    """Zwraca listę pikseli tkanki z opcjonalną intensywnością jonu (mz±tol).
    global_vmax: jeśli > 0, normalizuje przez tę wartość (jak ion_image) zamiast
    lokalnego max — zapewnia spójną skalę kolorów z zakładką m/z."""
    if tissue not in _cache:
        raise HTTPException(404, f"Tkanka '{tissue}' nie jest załadowana")
    d = _cache[tissue]
    coords  = d["coords"]
    mz_bins = d["mz_bins"]
    xs = coords[:, 0].tolist()
    ys = coords[:, 1].tolist()
    if mz > 0:
        bin_size = float(mz_bins[1] - mz_bins[0]) if len(mz_bins) > 1 else 0.0
        effective_tol = max(tol, bin_size / 2.0)
        mask = np.abs(mz_bins - mz) <= effective_tol
        if mask.any():
            intensities = d["spectra"][:, mask].sum(axis=1)
        else:
            intensities = np.zeros(len(coords), dtype=np.float32)
        local_vmax = float(intensities.max()) if intensities.max() > 0 else 1.0
        norm_by = global_vmax if global_vmax > 0 else local_vmax
        values = (intensities / norm_by).tolist()
    else:
        tic = d["spectra"].sum(axis=1).astype(np.float32)
        local_vmax = float(tic.max()) if tic.max() > 0 else 1.0
        norm_by = global_vmax if global_vmax > 0 else local_vmax
        values = (tic / norm_by).tolist()
    return {"tissue": tissue, "xs": xs, "ys": ys, "values": values}


# ── Workspaces ────────────────────────────────────────────────────────────
def _touch_workspace(wid: str) -> None:
    reg = _load_registry()
    ws = _find_ws(reg, wid)
    if ws:
        ws["updatedAt"] = _now_iso()
        _save_registry(reg)


@app.get("/workspaces")
def list_workspaces() -> dict:
    reg = _load_registry()
    return {"workspaces": reg["workspaces"], "active_id": reg["active_id"]}


@app.post("/workspaces")
def create_workspace(body: dict) -> dict:
    name = (body.get("name") or "Nowy workspace").strip() or "Nowy workspace"
    reg = _load_registry()
    wid = uuid.uuid4().hex[:12]
    now = _now_iso()
    ws = {"id": wid, "name": name, "createdAt": now, "updatedAt": now}
    reg["workspaces"].append(ws)
    _save_registry(reg)
    (_workspace_dir(wid) / "processed").mkdir(parents=True, exist_ok=True)
    _settings_file(wid).write_text("{}")
    return ws


@app.put("/workspaces/{wid}")
def update_workspace(wid: str, body: dict) -> dict:
    reg = _load_registry()
    ws = _find_ws(reg, wid)
    if not ws:
        raise HTTPException(404, f"Workspace '{wid}' nie istnieje")
    if "name" in body and body["name"].strip():
        ws["name"] = body["name"].strip()
    ws["updatedAt"] = _now_iso()
    _save_registry(reg)
    return ws


@app.delete("/workspaces/{wid}")
def delete_workspace(wid: str) -> dict:
    reg = _load_registry()
    if not _find_ws(reg, wid):
        raise HTTPException(404, f"Workspace '{wid}' nie istnieje")
    if len(reg["workspaces"]) <= 1:
        raise HTTPException(400, "Nie można usunąć jedynego workspace")
    reg["workspaces"] = [w for w in reg["workspaces"] if w["id"] != wid]
    if reg["active_id"] == wid:
        reg["active_id"] = reg["workspaces"][0]["id"]
    _save_registry(reg)
    shutil.rmtree(_workspace_dir(wid), ignore_errors=True)
    return {"ok": True}


@app.post("/workspaces/{wid}/activate")
def activate_workspace(wid: str) -> dict:
    global _active_workspace_id, _tissues_meta
    reg = _load_registry()
    if not _find_ws(reg, wid):
        raise HTTPException(404, f"Workspace '{wid}' nie istnieje")
    reg["active_id"] = wid
    _save_registry(reg)
    _active_workspace_id = wid
    ids = _load_npz_files()
    _tissues_meta = _build_tissues_meta(ids)
    return {"ok": True, "active_id": wid}


@app.get("/workspaces/{wid}/settings")
def get_workspace_settings(wid: str) -> dict:
    f = _settings_file(wid)
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text())
    except Exception:
        return {}


@app.put("/workspaces/{wid}/settings")
def put_workspace_settings(wid: str, body: dict) -> dict:
    reg = _load_registry()
    if not _find_ws(reg, wid):
        raise HTTPException(404, f"Workspace '{wid}' nie istnieje")
    _workspace_dir(wid).mkdir(parents=True, exist_ok=True)
    _settings_file(wid).write_text(json.dumps(body))
    _touch_workspace(wid)
    return {"ok": True}


@app.post("/workspaces/{wid}/export")
def export_workspace(wid: str, body: dict) -> dict:
    reg = _load_registry()
    ws = _find_ws(reg, wid)
    if not ws:
        raise HTTPException(404, f"Workspace '{wid}' nie istnieje")
    dest_dir = Path(body["dest_dir"])
    if not dest_dir.exists():
        raise HTTPException(404, f"Brak folderu docelowego: {dest_dir}")
    safe_name = "".join(c if c.isalnum() or c in " _-" else "_" for c in ws["name"]).strip() or wid
    out_dir = dest_dir / f"praSzczur_workspace_{safe_name}"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(_workspace_dir(wid), out_dir)
    return {"ok": True, "path": str(out_dir)}


@app.post("/workspaces/import")
def import_workspace(body: dict) -> dict:
    src_dir = Path(body["src_dir"])
    if not src_dir.exists() or not (src_dir / "workspace.json").exists():
        raise HTTPException(400, f"'{src_dir}' nie jest poprawnym folderem workspace")
    reg = _load_registry()
    wid = uuid.uuid4().hex[:12]
    now = _now_iso()
    name = src_dir.name.replace("praSzczur_workspace_", "") or "Zaimportowany"
    shutil.copytree(src_dir, _workspace_dir(wid))
    reg["workspaces"].append({"id": wid, "name": name, "createdAt": now, "updatedAt": now})
    _save_registry(reg)
    return {"id": wid, "name": name, "createdAt": now, "updatedAt": now}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=7432, log_level="warning")
