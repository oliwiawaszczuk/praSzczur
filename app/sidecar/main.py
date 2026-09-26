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
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse

ROOT           = Path(os.environ.get("PRASZCZUR_ROOT", Path(__file__).resolve().parents[2]))
WORKSPACES_DIR = ROOT / "workspaces"
BOARDS_DIR     = ROOT / "boards"
SRC_DIR        = ROOT / "src"
sys.path.insert(0, str(ROOT))

# ── Cache ──────────────────────────────────────────────────────────────────
_cache: dict[str, dict] = {}   # tissue_id → {spectra, coords, mz_bins}
_imzml_parser_cache: dict[str, tuple] = {}  # path → (ImzMLParser, coords_arr)
_target_tic_cache: dict[str, float] = {}  # tissue_id → mediana TIC (dla normalize())


def _get_imzml_parser(path: Path):
    """Zwraca (i cache'uje) sparsowany ImzMLParser + tablicę koordynatów.
    Parsowanie samego XML-a imzML jest kosztowne (tysiące widm) — bez cache
    każde żądanie widma piksela od nowa parsowałoby cały plik."""
    key = str(path)
    cached = _imzml_parser_cache.get(key)
    if cached is not None:
        return cached
    from pyimzml.ImzMLParser import ImzMLParser
    p = ImzMLParser(key)
    coords_arr = np.array(p.coordinates)
    _imzml_parser_cache[key] = (p, coords_arr)
    return p, coords_arr
_tissues_meta: list[dict] = [] # wykryte tkanki (x_min, x_max, label, is_ref)
_imzml_path: str = ""          # ostatnio przetworzony plik imzML
_active_workspace_id: str = "" # aktywny workspace
_active_dataset_id: str = ""   # aktywny zestaw danych (w ramach workspace'u)

RAW_DATASET_ID = "__raw__"     # pseudo-zestaw: surowy plik imzML jako źródło łańcucha


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
    return _dataset_dir(_active_dataset_id, _active_workspace_id)


def _settings_file(wid: str) -> Path:
    return _workspace_dir(wid) / "workspace.json"


def _imzml_path_file(wid: str) -> Path:
    return _workspace_dir(wid) / "imzml_path.txt"


def _find_ws(reg: dict, wid: str) -> dict | None:
    return next((w for w in reg["workspaces"] if w["id"] == wid), None)


# ── Zestawy danych (Datasets) ───────────────────────────────────────────────
# Każdy workspace ma własny rejestr zestawów danych — zwykły binning z zakładki
# Dane oraz kolejne, będące wynikiem pipeline'u preprocessingu z preWidma.
# Struktura: workspaces/<wid>/datasets/registry.json + datasets/<did>/*.npz


def _datasets_root(wid: str) -> Path:
    return _workspace_dir(wid) / "datasets"


def _datasets_registry_file(wid: str) -> Path:
    return _datasets_root(wid) / "registry.json"


def _dataset_dir(did: str, wid: str) -> Path:
    return _datasets_root(wid) / did


def _find_dataset(reg: dict, did: str) -> dict | None:
    return next((d for d in reg["datasets"] if d["id"] == did), None)


def _load_datasets_registry_raw(wid: str) -> dict | None:
    f = _datasets_registry_file(wid)
    try:
        if f.exists():
            reg = json.loads(f.read_text())
            if reg.get("datasets"):
                return reg
    except Exception:
        pass
    return None


def _save_datasets_registry(reg: dict, wid: str) -> None:
    _datasets_root(wid).mkdir(parents=True, exist_ok=True)
    _datasets_registry_file(wid).write_text(json.dumps(reg, indent=2))


def _ensure_datasets_registry(wid: str) -> dict:
    """Wczytuje rejestr zestawów workspace'u; jeśli brak, migruje starą,
    jednozestawową strukturę `processed/` (jeśli są tam jakieś .npz) do nowego,
    zwykłego zestawu — bez żadnej specjalnej/chronionej nazwy czy id, zestaw
    jest od razu w pełni edytowalny/usuwalny jak każdy inny."""
    reg = _load_datasets_registry_raw(wid)
    if reg is not None:
        changed = False
        # Migracja: stare wpisy 'binned' z płaskim `params` -> ujednolicone `steps`
        # zaczynające się od mz_range/bin_size z surowego imzML.
        for ds in reg["datasets"]:
            if ds.get("kind") == "binned" and "params" in ds and "steps" not in ds:
                p = ds.pop("params") or {}
                ds["source_dataset_id"] = RAW_DATASET_ID
                ds["steps"] = [
                    {"method": "mz_range", "params": {
                        "mz_min": p.get("mz_min"), "mz_max": p.get("mz_max")}},
                    {"method": "bin_size", "params": {
                        "bin_size": p.get("bin_size"), "bin_agg": p.get("bin_agg", "sum")}},
                ]
                changed = True
        if changed:
            _save_datasets_registry(reg, wid)
        return reg

    now = _now_iso()
    root = _datasets_root(wid)
    root.mkdir(parents=True, exist_ok=True)

    legacy = _workspace_dir(wid) / "processed"
    legacy_files = list(legacy.glob("*.npz")) if legacy.exists() else []
    if legacy_files:
        did = uuid.uuid4().hex[:12]
        dest_dir = root / did
        dest_dir.mkdir(parents=True, exist_ok=True)
        for f in legacy_files:
            dest = dest_dir / f.name
            if not dest.exists():
                shutil.copy(f, dest)
        reg = {
            "active_id": did,
            "datasets": [{
                "id": did, "name": "Zbinowany (import)", "kind": "binned",
                "createdAt": now, "updatedAt": now,
            }],
        }
    else:
        reg = {"active_id": "", "datasets": []}
    _save_datasets_registry(reg, wid)
    return reg


# ── Zapisane mapy pikseli (Wiele m/z → zapis pojedynczej/połączonej tkanki) ──
# Każdy workspace ma własny rejestr zapisanych map pikseli — metadane w
# registry.json (bez danych pikselowych, żeby lista do galerii była lekka),
# pełne dane (w tym `data`) w osobnym pliku <id>.json per zapis.
# Struktura: workspaces/<wid>/pixel_maps/registry.json + pixel_maps/<id>.json


def _pixel_maps_root(wid: str) -> Path:
    return _workspace_dir(wid) / "pixel_maps"


def _pixel_maps_registry_file(wid: str) -> Path:
    return _pixel_maps_root(wid) / "registry.json"


def _pixel_map_data_file(pmid: str, wid: str) -> Path:
    return _pixel_maps_root(wid) / f"{pmid}.json"


def _find_pixel_map(reg: dict, pmid: str) -> dict | None:
    return next((m for m in reg["maps"] if m["id"] == pmid), None)


def _ensure_pixel_maps_registry(wid: str) -> dict:
    f = _pixel_maps_registry_file(wid)
    try:
        if f.exists():
            reg = json.loads(f.read_text())
            if "maps" in reg:
                return reg
    except Exception:
        pass
    return {"maps": []}


def _save_pixel_maps_registry(reg: dict, wid: str) -> None:
    _pixel_maps_root(wid).mkdir(parents=True, exist_ok=True)
    _pixel_maps_registry_file(wid).write_text(json.dumps(reg, indent=2))


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


def _get_dataset_cache(did: str) -> dict:
    """Zwraca dane zestawu `did` w aktywnym workspace (bez trwałego cache'owania,
    jeśli to nie jest aktualnie aktywny zestaw). Puste `did` = aktywny zestaw."""
    if not did or did == _active_dataset_id:
        return _cache
    out: dict = {}
    for path in sorted(_dataset_dir(did, _active_workspace_id).glob("*.npz")):
        tid = path.stem
        d = np.load(path)
        out[tid] = {"spectra": d["spectra"], "coords": d["coords"], "mz_bins": d["mz_bins"]}
    return out


def _build_tissues_meta(tissue_ids: list[str], cache: dict | None = None) -> list[dict]:
    """Buduje metadane tkanek z załadowanych danych."""
    cache = cache if cache is not None else _cache
    meta = []
    for i, tid in enumerate(tissue_ids):
        coords = cache[tid]["coords"]
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
    global _tissues_meta, _active_workspace_id, _active_dataset_id
    reg = _ensure_default_workspace()
    _active_workspace_id = reg["active_id"]
    dreg = _ensure_datasets_registry(_active_workspace_id)
    _active_dataset_id = dreg["active_id"]
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
def dataset_status(dataset: str = "") -> dict:
    data_dir = _dataset_dir(dataset, _active_workspace_id) if dataset else DATA_DIR()
    cache = _get_dataset_cache(dataset)
    npz_files = []
    for path in sorted(data_dir.glob("*.npz")):
        stat = path.stat()
        npz_files.append({
            "id":       path.stem,
            "filename": path.name,
            "size_mb":  round(stat.st_size / 1024**2, 2),
            "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
        })

    mz_bins = cache[list(cache.keys())[0]]["mz_bins"] if cache else np.array([])
    return {
        "data_dir":    str(data_dir),
        "npz_files":   npz_files,
        "tissues":     _tissues_meta if not dataset or dataset == _active_dataset_id else _build_tissues_meta(list(cache.keys()), cache),
        "n_tissues":   len(cache),
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


@app.get("/imzml_native_range")
def imzml_native_range(path: str = "") -> dict:
    """Zwraca natywny zakres m/z (min/max) pliku imzML. Dataset jest w trybie
    "continuous" (wspólna oś m/z dla wszystkich pikseli — patrz docs/dataset.md),
    więc wystarczy odczytać pierwsze widmo, żeby poznać cały natywny zakres.
    Używane do ograniczenia suwaków node'a "Zakres m/z" do realnych granic pliku,
    zamiast dowolnych, twardo zakodowanych wartości."""
    imzml_path = Path(path) if path else Path(_imzml_path)
    if not imzml_path.is_absolute():
        imzml_path = ROOT / imzml_path
    if not str(imzml_path) or not imzml_path.exists():
        raise HTTPException(404, f"Brak pliku: {imzml_path}")
    p, _coords = _get_imzml_parser(imzml_path)
    mz_arr, _ints = p.getspectrum(0)
    mz_arr = np.asarray(mz_arr, dtype=np.float64)
    if len(mz_arr) == 0:
        raise HTTPException(422, "Puste widmo — brak natywnej osi m/z")
    return {"mz_min": float(mz_arr.min()), "mz_max": float(mz_arr.max()), "n_points": int(len(mz_arr))}


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
def ion_image(mz: float, tol: float = 0.3, dataset: str = "") -> dict:
    cache = _get_dataset_cache(dataset)
    if not cache:
        raise HTTPException(503, "Dane nie załadowane")

    result = {}
    for tid, d in cache.items():
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


# ── Binning ze źródła surowego (współdzielone przez /process i build_pipeline) ─
async def _bin_from_imzml(imzml_path: Path, tissues: list[dict], mz_min: float,
                           mz_max: float, bin_size: float, bin_agg: str,
                           target_dir: Path, result: dict):
    """Parsuje surowy plik imzML i binuje widma każdego piksela do zadanego
    zakresu/bin_size, zapisując jeden .npz per tkanka do `target_dir`.
    Generator SSE-progress; wynik (`summary` albo `error`) zwracany przez
    mutację słownika `result`, bo async-generator nie może mieć `return value`."""
    from pyimzml.ImzMLParser import ImzMLParser

    if not imzml_path.exists():
        result["error"] = f"Brak pliku: {imzml_path.name}"
        yield _sse("error", {"message": result["error"]})
        return

    ibd_candidates = [f for f in imzml_path.parent.glob("*")
                      if f.suffix.lower() == ".ibd"]
    matching_ibd = [f for f in ibd_candidates if f.stem.lower() == imzml_path.stem.lower()]
    if not matching_ibd:
        names = ", ".join(f.name for f in ibd_candidates) or "brak"
        result["error"] = (
            f"Brak pasującego pliku .ibd dla '{imzml_path.name}'. "
            f"Znalezione pliki .ibd: {names}. "
            f"Plik .ibd musi mieć tę samą nazwę co .imzML.")
        yield _sse("error", {"message": result["error"]})
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
    target_dir.mkdir(parents=True, exist_ok=True)
    for old in target_dir.glob("*.npz"):
        old.unlink()
    summary = []
    for t in tissues:
        tid  = t["id"]
        buf  = buffers[tid]
        if not buf["spectra"]:
            continue
        spectra_arr = np.stack(buf["spectra"])
        coords_out  = np.array(buf["coords"], dtype=np.int16)
        out_path = target_dir / f"{tid}.npz"
        np.savez_compressed(out_path, spectra=spectra_arr,
                            coords=coords_out, mz_bins=bin_centers)
        summary.append({"id": tid, "n_spectra": len(buf["spectra"])})
        await asyncio.sleep(0)

    result["summary"] = summary


async def _materialize_raw_native(imzml_path: Path, tissues: list[dict], target_dir: Path, result: dict):
    """Jak `_bin_from_imzml`, ale bez binningu — zapisuje widma piksela z ich
    natywną, wspólną osią m/z (tryb continuous, patrz docs/dataset.md), bez
    żadnej zmiany zakresu/rozdzielczości. Materializuje "Dane oryginalne"
    (surowy plik imzML) 1:1 jako zestaw danych — bo w trybie continuous surowe
    dane to już poprawna, jednolita tablica per piksel i binning nie jest do
    tego strukturalnie potrzebny (mz_range/bin_size to opcjonalne kroki, które
    użytkownik może, ale nie musi, dodać do łańcucha)."""
    from pyimzml.ImzMLParser import ImzMLParser

    if not imzml_path.exists():
        result["error"] = f"Brak pliku: {imzml_path.name}"
        yield _sse("error", {"message": result["error"]})
        return

    ibd_candidates = [f for f in imzml_path.parent.glob("*")
                      if f.suffix.lower() == ".ibd"]
    matching_ibd = [f for f in ibd_candidates if f.stem.lower() == imzml_path.stem.lower()]
    if not matching_ibd:
        names = ", ".join(f.name for f in ibd_candidates) or "brak"
        result["error"] = (
            f"Brak pasującego pliku .ibd dla '{imzml_path.name}'. "
            f"Znalezione pliki .ibd: {names}. "
            f"Plik .ibd musi mieć tę samą nazwę co .imzML.")
        yield _sse("error", {"message": result["error"]})
        return

    yield _sse("progress", {"step": "loading", "pct": 5,
                             "message": "Wczytywanie imzML…"})
    p = ImzMLParser(str(imzml_path))
    coords_arr = np.array(p.coordinates)
    n_total = len(p.coordinates)

    def find_tissue(x: int, y: int) -> dict | None:
        for t in tissues:
            if (t["x_min"] <= x <= t["x_max"] and
                    t.get("y_min", -10**9) <= y <= t.get("y_max", 10**9)):
                return t
        return None

    native_mz: np.ndarray | None = None
    buffers = {t["id"]: {"spectra": [], "coords": []} for t in tissues}

    for i in range(n_total):
        x, y = int(coords_arr[i, 0]), int(coords_arr[i, 1])
        t = find_tissue(x, y)
        if t is None:
            continue
        try:
            mz_arr, ints = p.getspectrum(i)
            ints = np.asarray(ints, dtype=np.float32)
        except Exception:
            continue
        if native_mz is None:
            native_mz = np.asarray(mz_arr, dtype=np.float64)
        buffers[t["id"]]["spectra"].append(ints)
        buffers[t["id"]]["coords"].append([x, y])

        if i % 500 == 0:
            pct = 5 + int(85 * i / n_total)
            yield _sse("progress", {"step": "processing", "pct": pct,
                                     "message": f"Spektrum {i}/{n_total}"})
            await asyncio.sleep(0)

    if native_mz is None:
        result["error"] = "Brak spektrów w wybranych tkankach"
        yield _sse("error", {"message": result["error"]})
        return

    yield _sse("progress", {"step": "saving", "pct": 92,
                             "message": "Zapis plików .npz…"})
    target_dir.mkdir(parents=True, exist_ok=True)
    for old in target_dir.glob("*.npz"):
        old.unlink()
    summary = []
    for t in tissues:
        tid = t["id"]
        buf = buffers[tid]
        if not buf["spectra"]:
            continue
        spectra_arr = np.stack(buf["spectra"])
        coords_out = np.array(buf["coords"], dtype=np.int16)
        np.savez_compressed(target_dir / f"{tid}.npz", spectra=spectra_arr,
                            coords=coords_out, mz_bins=native_mz)
        summary.append({"id": tid, "n_spectra": len(buf["spectra"])})
        await asyncio.sleep(0)

    result["summary"] = summary


# ── Preprocess (SSE stream) ────────────────────────────────────────────────
@app.post("/process")
async def process(body: dict) -> StreamingResponse:
    """
    Uruchamia binning z podanymi parametrami (zakres m/z + bin size/agregacja)
    wprost z surowego imzML. Streamuje postęp jako Server-Sent Events.
    body: { bin_size, bin_agg, mz_min, mz_max, tissues: [{id, x_min, x_max, label, is_ref}],
            dataset_id?, dataset_name? }
    dataset_id: docelowy zestaw danych (domyślnie aktywny zestaw workspace'u,
    a jeśli workspace nie ma jeszcze żadnego — nowy zestaw z losowym id).

    Utrzymywane dla wstecznej kompatybilności — docelowa ścieżka to
    `/workspaces/{wid}/datasets/{did}/build_pipeline` z `source_dataset_id="__raw__"`
    i krokami `mz_range`/`bin_size` (zob. zakładka "Zestaw danych").
    """
    from src.msi.constants import MZ_MIN, MZ_MAX, BIN_SIZE

    bin_size   = float(body.get("bin_size",  BIN_SIZE))
    bin_agg    = str(body.get("bin_agg", "sum"))  # "sum" | "mean" | "peak_apex"
    mz_min     = float(body.get("mz_min",   MZ_MIN))
    mz_max     = float(body.get("mz_max",   MZ_MAX))
    tissues    = body.get("tissues", _tissues_meta)
    dataset_id   = body.get("dataset_id") or _active_dataset_id or uuid.uuid4().hex[:12]
    dataset_name = body.get("dataset_name")
    target_dir   = _dataset_dir(dataset_id, _active_workspace_id)
    imzml_path = Path(body["imzml_path"]) if body.get("imzml_path") else \
                 ROOT / "source" / "FMP10_Rat_brain_breg_084.imzML"
    if not imzml_path.is_absolute():
        imzml_path = ROOT / imzml_path

    async def generate():
        yield _sse("start", {"message": "Uruchamianie preprocessingu…"})
        try:
            result: dict = {}
            async for ev in _bin_from_imzml(imzml_path, tissues, mz_min, mz_max,
                                             bin_size, bin_agg, target_dir, result):
                yield ev
            if result.get("error"):
                return
            summary = result["summary"]

            # Zarejestruj/zaktualizuj zestaw danych (ujednolicony format `steps`)
            # i uczyń go aktywnym.
            global _imzml_path, _active_dataset_id
            _imzml_path = str(imzml_path)
            _save_imzml_path(_imzml_path)
            dreg = _ensure_datasets_registry(_active_workspace_id)
            ds = _find_dataset(dreg, dataset_id)
            now = _now_iso()
            if ds is None:
                ds = {"id": dataset_id, "name": dataset_name or "Zbinowany",
                      "kind": "binned", "createdAt": now}
                dreg["datasets"].append(ds)
            elif dataset_name:
                ds["name"] = dataset_name
            ds["kind"] = "binned"
            ds["updatedAt"] = now
            ds["source_dataset_id"] = RAW_DATASET_ID
            ds["steps"] = [
                {"method": "mz_range", "params": {"mz_min": mz_min, "mz_max": mz_max}},
                {"method": "bin_size", "params": {"bin_size": bin_size, "bin_agg": bin_agg}},
            ]
            ds.pop("params", None)
            dreg["active_id"] = dataset_id
            _save_datasets_registry(dreg, _active_workspace_id)
            _active_dataset_id = dataset_id

            _cache.clear()
            _tissues_meta.clear()
            ids = _load_npz_files()
            _tissues_meta.extend(_build_tissues_meta(ids))
            _touch_workspace(_active_workspace_id)

            yield _sse("done", {"message": "Preprocessing zakończony", "summary": summary,
                                 "dataset_id": dataset_id})

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
        p, coords_arr = _get_imzml_parser(path)
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


def _target_tic(tissue: str, cache: dict | None = None) -> float:
    """Mediana TIC (całkowitego prądu jonowego) tkanki — referencja dla normalize()."""
    cache = cache if cache is not None else _cache
    cache_key = tissue if cache is _cache else f"{id(cache)}:{tissue}"
    if cache_key in _target_tic_cache:
        return _target_tic_cache[cache_key]
    if tissue not in cache:
        raise HTTPException(404, f"Tkanka '{tissue}' nie jest załadowana")
    d = cache[tissue]
    tic = float(np.median(d["spectra"].sum(axis=1)))
    _target_tic_cache[cache_key] = tic
    return tic


@app.get("/preprocess")
def preprocess(tissue: str, x: int, y: int, method: str,
                window: int = 15, polyorder: int = 3,
                iterations: int = 40, prominence: float = 0.02) -> dict:
    """Stosuje wybraną metodę preprocessingu widma do surowego widma piksela
    (z pliku imzML) i zwraca widmo przed/po do porównania na wykresie."""
    if not _imzml_path:
        raise HTTPException(503, "Brak ścieżki do pliku imzML — uruchom preprocessing")
    path = Path(_imzml_path)
    if not path.exists():
        raise HTTPException(404, f"Plik {path} nie istnieje")
    try:
        p, coords_arr = _get_imzml_parser(path)
        idx = np.where((coords_arr[:, 0] == x) & (coords_arr[:, 1] == y))[0]
        if len(idx) == 0:
            raise HTTPException(404, f"Brak piksela ({x},{y})")
        mz_arr, ints = p.getspectrum(int(idx[0]))
        mz_arr = np.asarray(mz_arr, dtype=float)
        ints = np.asarray(ints, dtype=float)

        from src.msi.preprocessing import (
            smooth_savgol, baseline_correction_snip, normalize_tic, peak_pick,
        )

        info: dict = {}
        if method == "smooth":
            after = smooth_savgol(ints, window=window, polyorder=polyorder)
        elif method == "baseline":
            after, baseline = baseline_correction_snip(ints, iterations=iterations)
            info["baseline_max"] = round(float(baseline.max()), 3)
        elif method == "normalize":
            target = _target_tic(tissue, _cache)
            after, factor = normalize_tic(ints, target_tic=target)
            info["factor"] = round(factor, 4)
        elif method == "peakpick":
            after, n_peaks = peak_pick(mz_arr, ints, prominence_frac=prominence)
            info["n_peaks"] = n_peaks
        else:
            raise HTTPException(400, f"Nieznana metoda '{method}'")

        return {
            "tissue": tissue, "x": x, "y": y, "method": method, "info": info,
            "mz": [round(float(m), 6) for m in mz_arr],
            "intensity_before": [float(v) for v in ints],
            "intensity_after": [float(v) for v in after],
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/preprocess_chain")
def preprocess_chain(body: dict) -> dict:
    """Stosuje uporządkowany łańcuch metod preprocessingu (zbudowany z grafu
    node'ów w zakładce preWidma) do widma piksela i zwraca widmo przed/po.

    Body: {tissue, x, y, source: "raw"|"binned", steps: [{method, params}]}.
    """
    tissue = body.get("tissue")
    x = body.get("x")
    y = body.get("y")
    source = body.get("source", "raw")
    dataset = body.get("dataset", "")
    steps = body.get("steps") or []
    if tissue is None or x is None or y is None:
        raise HTTPException(400, "Brak tissue/x/y")

    from src.msi.preprocessing import (
        smooth_savgol, baseline_correction_snip, normalize_tic, peak_pick,
    )

    try:
        cache = _cache
        if source == "raw":
            if not _imzml_path:
                raise HTTPException(503, "Brak ścieżki do pliku imzML — uruchom preprocessing")
            path = Path(_imzml_path)
            if not path.exists():
                raise HTTPException(404, f"Plik {path} nie istnieje")
            p, coords_arr = _get_imzml_parser(path)
            idx = np.where((coords_arr[:, 0] == x) & (coords_arr[:, 1] == y))[0]
            if len(idx) == 0:
                raise HTTPException(404, f"Brak piksela ({x},{y})")
            mz_arr, ints = p.getspectrum(int(idx[0]))
            mz_arr = np.asarray(mz_arr, dtype=float)
            ints = np.asarray(ints, dtype=float)
        elif source == "binned":
            cache = _get_dataset_cache(dataset)
            if tissue not in cache:
                raise HTTPException(404, f"Tkanka '{tissue}' nie jest załadowana")
            d = cache[tissue]
            coords = d["coords"]
            mask = (coords[:, 0] == x) & (coords[:, 1] == y)
            idx = np.where(mask)[0]
            if len(idx) == 0:
                raise HTTPException(404, f"Brak piksela ({x},{y}) w tkance '{tissue}'")
            mz_arr = np.asarray(d["mz_bins"], dtype=float)
            ints = np.asarray(d["spectra"][idx[0]], dtype=float)
        else:
            raise HTTPException(400, f"Nieznane źródło '{source}'")

        intensity_before = ints.copy()
        cur = ints.copy()
        steps_applied = []
        for step in steps:
            method = step.get("method")
            params = step.get("params") or {}
            info: dict = {}
            if method == "smooth":
                cur = smooth_savgol(cur, window=int(params.get("window", 15)))
            elif method == "baseline":
                cur, baseline = baseline_correction_snip(cur, iterations=int(params.get("iterations", 40)))
                info["baseline_max"] = round(float(baseline.max()), 3)
            elif method == "normalize":
                target = _target_tic(tissue, cache)
                cur, factor = normalize_tic(cur, target_tic=target)
                info["factor"] = round(factor, 4)
            elif method == "peakpick":
                cur, n_peaks = peak_pick(mz_arr, cur, prominence_frac=float(params.get("prominence_frac", 0.02)))
                info["n_peaks"] = n_peaks
            elif method == "mz_range":
                mz_lo = float(params.get("mz_min", mz_arr.min() if len(mz_arr) else 0))
                mz_hi = float(params.get("mz_max", mz_arr.max() if len(mz_arr) else 0))
                mask = (mz_arr >= mz_lo) & (mz_arr <= mz_hi)
                mz_arr = mz_arr[mask]
                cur = cur[mask]
                info["n_points"] = int(mask.sum())
            elif method == "bin_size":
                bs = float(params.get("bin_size", 0.3))
                agg = str(params.get("bin_agg", "sum"))
                if bs > 0 and len(mz_arr) > 1:
                    centers = np.arange(mz_arr.min() + bs / 2, mz_arr.max(), bs)
                    nb = len(centers)
                    half = bs / 2
                    binned = np.zeros(nb, dtype=np.float64)
                    idx = np.searchsorted(centers, mz_arr - half, side="right")
                    in_range = (idx < nb) & (np.abs(mz_arr - centers[np.clip(idx, 0, nb-1)]) <= half)
                    if agg == "mean":
                        counts = np.zeros(nb, dtype=np.int32)
                        np.add.at(binned, idx[in_range], cur[in_range])
                        np.add.at(counts, idx[in_range], 1)
                        np.divide(binned, counts, out=binned, where=counts > 0)
                    elif agg == "peak_apex":
                        np.maximum.at(binned, idx[in_range], cur[in_range])
                    else:
                        np.add.at(binned, idx[in_range], cur[in_range])
                    mz_arr = centers
                    cur = binned
                info["n_bins"] = len(mz_arr)
            else:
                raise HTTPException(400, f"Nieznana metoda '{method}'")
            steps_applied.append({"method": method, "info": info})

        return {
            "tissue": tissue, "x": x, "y": y,
            "mz": [round(float(m), 6) for m in mz_arr],
            "intensity_before": [float(v) for v in intensity_before],
            "intensity_after": [float(v) for v in cur],
            "steps_applied": steps_applied,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/pixel_spectrum")
def pixel_spectrum(tissue: str, x: int, y: int, dataset: str = "") -> dict:
    """Zwraca pełne widmo binned dla piksela (x, y) w tkance (opcjonalnie z
    wybranego zestawu danych — domyślnie aktywny zestaw workspace'u)."""
    cache = _get_dataset_cache(dataset)
    if tissue not in cache:
        raise HTTPException(404, f"Tkanka '{tissue}' nie jest załadowana")
    d = cache[tissue]
    coords = d["coords"]
    mask = (coords[:, 0] == x) & (coords[:, 1] == y)
    idx = np.where(mask)[0]
    if len(idx) == 0:
        raise HTTPException(404, f"Brak piksela ({x},{y}) w tkance '{tissue}'")
    spectrum = d["spectra"][idx[0]].tolist()
    mz_bins  = d["mz_bins"].tolist()
    return {"tissue": tissue, "x": x, "y": y, "mz": mz_bins, "intensity": spectrum}


# ── Tissue pixel map for Widma tab ────────────────────────────────────────
def _tissue_pixel_map_raw(tissue: str, mz: float, tol: float, global_vmax: float) -> dict:
    """Jak tissue_pixel_map, ale liczy intensywność bezpośrednio z oryginalnego
    pliku imzML (mz ± tol lub TIC), z pominięciem binowania z .npz — używane
    gdy dataset == RAW_DATASET_ID ("Dane oryginalne"). Współrzędne pikseli
    tkanki bierzemy z aktywnego zestawu (_cache), sama geometria tkanki nie
    zależy od binowania."""
    if tissue not in _cache:
        raise HTTPException(404, f"Tkanka '{tissue}' nie jest załadowana")
    if not _imzml_path:
        raise HTTPException(503, "Brak ścieżki do pliku imzML — uruchom preprocessing raz "
                                  "aby zapamiętać ścieżkę.")
    path = Path(_imzml_path)
    if not path.exists():
        raise HTTPException(404, f"Plik {path} nie istnieje")

    from pyimzml.ImzMLParser import ImzMLParser
    p = ImzMLParser(str(path))
    raw_coords = np.array(p.coordinates)
    coord_to_idx = {(int(rx), int(ry)): i for i, (rx, ry, *_ ) in enumerate(raw_coords)}

    coords = _cache[tissue]["coords"]
    xs = coords[:, 0].astype(int).tolist()
    ys = coords[:, 1].astype(int).tolist()
    values_raw: list[float] = []
    for x, y in zip(xs, ys):
        idx = coord_to_idx.get((x, y))
        if idx is None:
            values_raw.append(0.0)
            continue
        mz_arr, ints = p.getspectrum(idx)
        mz_arr = np.asarray(mz_arr, dtype=np.float64)
        ints   = np.asarray(ints,   dtype=np.float64)
        if mz > 0:
            mask = np.abs(mz_arr - mz) <= tol
            values_raw.append(float(ints[mask].sum()) if mask.any() else 0.0)
        else:
            values_raw.append(float(ints.sum()))

    arr = np.array(values_raw, dtype=np.float64)
    local_vmax = float(arr.max()) if arr.max() > 0 else 1.0
    norm_by = global_vmax if global_vmax > 0 else local_vmax
    values = (arr / norm_by).tolist()
    return {"tissue": tissue, "xs": xs, "ys": ys, "values": values}


@app.get("/tissue_pixel_map")
def tissue_pixel_map(tissue: str, mz: float = -1.0, tol: float = 0.3,
                     global_vmax: float = -1.0, dataset: str = "") -> dict:
    """Zwraca listę pikseli tkanki z opcjonalną intensywnością jonu (mz±tol).
    global_vmax: jeśli > 0, normalizuje przez tę wartość (jak ion_image) zamiast
    lokalnego max — zapewnia spójną skalę kolorów z zakładką m/z."""
    if dataset == RAW_DATASET_ID:
        return _tissue_pixel_map_raw(tissue, mz, tol, global_vmax)
    cache = _get_dataset_cache(dataset)
    if tissue not in cache:
        raise HTTPException(404, f"Tkanka '{tissue}' nie jest załadowana")
    d = cache[tissue]
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
    _ensure_datasets_registry(wid)
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
    global _active_workspace_id, _active_dataset_id, _tissues_meta
    reg = _load_registry()
    if not _find_ws(reg, wid):
        raise HTTPException(404, f"Workspace '{wid}' nie istnieje")
    reg["active_id"] = wid
    _save_registry(reg)
    _active_workspace_id = wid
    dreg = _ensure_datasets_registry(wid)
    _active_dataset_id = dreg["active_id"]
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


# ── Zestawy danych (Datasets) ───────────────────────────────────────────────
@app.get("/workspaces/{wid}/datasets")
def list_datasets(wid: str) -> dict:
    reg = _load_registry()
    if not _find_ws(reg, wid):
        raise HTTPException(404, f"Workspace '{wid}' nie istnieje")
    dreg = _ensure_datasets_registry(wid)
    return {"datasets": dreg["datasets"], "active_id": dreg["active_id"]}


@app.post("/workspaces/{wid}/datasets")
def create_dataset(wid: str, body: dict) -> dict:
    reg = _load_registry()
    if not _find_ws(reg, wid):
        raise HTTPException(404, f"Workspace '{wid}' nie istnieje")
    dreg = _ensure_datasets_registry(wid)
    name = (body.get("name") or "Nowy zestaw").strip() or "Nowy zestaw"
    kind = body.get("kind", "empty")
    did = uuid.uuid4().hex[:12]
    now = _now_iso()
    ds = {"id": did, "name": name, "kind": kind, "createdAt": now, "updatedAt": now}
    dreg["datasets"].append(ds)
    _save_datasets_registry(dreg, wid)
    _dataset_dir(did, wid).mkdir(parents=True, exist_ok=True)
    return ds


@app.put("/workspaces/{wid}/datasets/{did}")
def rename_dataset(wid: str, did: str, body: dict) -> dict:
    dreg = _ensure_datasets_registry(wid)
    ds = _find_dataset(dreg, did)
    if not ds:
        raise HTTPException(404, f"Zestaw '{did}' nie istnieje")
    if "name" in body and body["name"].strip():
        ds["name"] = body["name"].strip()
    ds["updatedAt"] = _now_iso()
    _save_datasets_registry(dreg, wid)
    return ds


@app.delete("/workspaces/{wid}/datasets/{did}")
def delete_dataset(wid: str, did: str) -> dict:
    global _active_dataset_id, _tissues_meta
    dreg = _ensure_datasets_registry(wid)
    if not _find_dataset(dreg, did):
        raise HTTPException(404, f"Zestaw '{did}' nie istnieje")
    if len(dreg["datasets"]) <= 1:
        raise HTTPException(400, "Nie można usunąć jedynego zestawu danych")
    was_active = dreg["active_id"] == did
    dreg["datasets"] = [d for d in dreg["datasets"] if d["id"] != did]
    if was_active:
        dreg["active_id"] = dreg["datasets"][0]["id"]
    _save_datasets_registry(dreg, wid)
    shutil.rmtree(_dataset_dir(did, wid), ignore_errors=True)
    if wid == _active_workspace_id and was_active:
        _active_dataset_id = dreg["active_id"]
        ids = _load_npz_files()
        _tissues_meta = _build_tissues_meta(ids)
    return {"ok": True}


@app.post("/workspaces/{wid}/datasets/{did}/activate")
def activate_dataset(wid: str, did: str) -> dict:
    global _active_dataset_id, _tissues_meta
    dreg = _ensure_datasets_registry(wid)
    if not _find_dataset(dreg, did):
        raise HTTPException(404, f"Zestaw '{did}' nie istnieje")
    dreg["active_id"] = did
    _save_datasets_registry(dreg, wid)
    if wid == _active_workspace_id:
        _active_dataset_id = did
        ids = _load_npz_files()
        _tissues_meta = _build_tissues_meta(ids)
    return {"ok": True, "active_id": did}


@app.post("/workspaces/{wid}/datasets/{did}/build_pipeline")
async def build_pipeline_dataset(wid: str, did: str, body: dict) -> StreamingResponse:
    """Buduje/przebudowuje zestaw danych `did` z łańcucha kroków (graf node'ów
    w edytorze "Zestaw danych"/preWidma). Body: { source_dataset_id, steps }.

    `source_dataset_id` to albo `"__raw__"` (surowy imzML — w trybie continuous
    to już poprawna, jednolita tablica per piksel, więc `steps` mogą być puste,
    zawierać dowolną kombinację/kolejność kroków — `mz_range`/`bin_size` NIE są
    wymagane), albo id innego, już istniejącego zestawu (`binned`/`pipeline`).
    """
    source_id = body.get("source_dataset_id")
    steps = body.get("steps") or []
    if not source_id:
        raise HTTPException(400, "Brak source_dataset_id")

    dreg = _ensure_datasets_registry(wid)
    if not _find_dataset(dreg, did):
        raise HTTPException(404, f"Zestaw '{did}' nie istnieje")

    is_raw_source = source_id == RAW_DATASET_ID
    if not is_raw_source:
        src_dir = _dataset_dir(source_id, wid)
        if not src_dir.exists():
            raise HTTPException(404, f"Zestaw źródłowy '{source_id}' nie istnieje")

    from src.msi.preprocessing import (
        smooth_savgol, baseline_correction_snip, normalize_tic, peak_pick,
    )

    async def generate():
        global _imzml_path, _active_dataset_id, _tissues_meta
        yield _sse("start", {"message": "Budowanie zestawu…"})
        try:
            out_dir = _dataset_dir(did, wid)
            summary: list[dict] = []
            per_pixel_steps = steps
            src_files: list[Path]

            if is_raw_source:
                imzml_path = Path(body.get("imzml_path") or _imzml_path or "")
                if not imzml_path or not imzml_path.is_absolute():
                    imzml_path = ROOT / imzml_path if imzml_path.parts else imzml_path
                if not str(imzml_path) or not imzml_path.exists():
                    yield _sse("error", {"message": "Brak ścieżki do pliku imzML"})
                    return
                tissues = body.get("tissues") or _tissues_meta

                result: dict = {}
                async for ev in _materialize_raw_native(imzml_path, tissues, out_dir, result):
                    yield ev
                if result.get("error"):
                    return
                summary = result["summary"]
                src_files = sorted(out_dir.glob("*.npz"))

                _imzml_path = str(imzml_path)
                _save_imzml_path(_imzml_path)
            else:
                src_dir = _dataset_dir(source_id, wid)
                src_files = sorted(src_dir.glob("*.npz"))
                if not src_files:
                    yield _sse("error", {"message": f"Zestaw źródłowy '{source_id}' jest pusty"})
                    return
                out_dir.mkdir(parents=True, exist_ok=True)
                if out_dir.resolve() != src_dir.resolve():
                    for old in out_dir.glob("*.npz"):
                        old.unlink()

            if per_pixel_steps:
                summary = []
                for fi, path in enumerate(src_files):
                    tid = path.stem
                    d = np.load(path)
                    spectra = d["spectra"].astype(np.float64)
                    mz_bins = d["mz_bins"]
                    coords  = d["coords"]
                    n = len(spectra)
                    target_tic = float(np.median(spectra.sum(axis=1))) if n else 0.0

                    # `mz_range`/`bin_size` zmieniają oś m/z (nie tylko intensywności)
                    # — ale robią to identycznie dla każdego piksela (ta sama oś
                    # wejściowa, te same parametry), więc finalną oś liczymy raz z
                    # góry, żeby od razu przygotować bufor wyjściowy o właściwym
                    # kształcie zamiast zakładać, że wynik ma tyle samo punktów co
                    # wejście (`np.zeros_like(spectra)` byłoby błędne dla tych kroków).
                    final_mz = mz_bins
                    for step in per_pixel_steps:
                        method = step.get("method")
                        params = step.get("params") or {}
                        if method == "mz_range":
                            mz_lo = float(params.get("mz_min", final_mz.min() if len(final_mz) else 0))
                            mz_hi = float(params.get("mz_max", final_mz.max() if len(final_mz) else 0))
                            final_mz = final_mz[(final_mz >= mz_lo) & (final_mz <= mz_hi)]
                        elif method == "bin_size":
                            bs = float(params.get("bin_size", 0.3))
                            if bs > 0 and len(final_mz) > 1:
                                final_mz = np.arange(final_mz.min() + bs / 2, final_mz.max(), bs)
                    out = np.zeros((n, len(final_mz)), dtype=np.float32)

                    for i in range(n):
                        cur = spectra[i]
                        cur_mz = mz_bins
                        for step in per_pixel_steps:
                            method = step.get("method")
                            params = step.get("params") or {}
                            if method == "smooth":
                                cur = smooth_savgol(cur, window=int(params.get("window", 15)))
                            elif method == "baseline":
                                cur, _b = baseline_correction_snip(cur, iterations=int(params.get("iterations", 40)))
                            elif method == "normalize":
                                cur, _f = normalize_tic(cur, target_tic=target_tic)
                            elif method == "peakpick":
                                cur, _n = peak_pick(cur_mz, cur, prominence_frac=float(params.get("prominence_frac", 0.02)))
                            elif method == "mz_range":
                                mz_lo = float(params.get("mz_min", cur_mz.min() if len(cur_mz) else 0))
                                mz_hi = float(params.get("mz_max", cur_mz.max() if len(cur_mz) else 0))
                                mask = (cur_mz >= mz_lo) & (cur_mz <= mz_hi)
                                cur_mz = cur_mz[mask]
                                cur = cur[mask]
                            elif method == "bin_size":
                                bs = float(params.get("bin_size", 0.3))
                                agg = str(params.get("bin_agg", "sum"))
                                if bs > 0 and len(cur_mz) > 1:
                                    centers = np.arange(cur_mz.min() + bs / 2, cur_mz.max(), bs)
                                    nb = len(centers)
                                    half = bs / 2
                                    binned = np.zeros(nb, dtype=np.float64)
                                    idx = np.searchsorted(centers, cur_mz - half, side="right")
                                    in_range = (idx < nb) & (np.abs(cur_mz - centers[np.clip(idx, 0, nb - 1)]) <= half)
                                    if agg == "mean":
                                        counts = np.zeros(nb, dtype=np.int32)
                                        np.add.at(binned, idx[in_range], cur[in_range])
                                        np.add.at(counts, idx[in_range], 1)
                                        np.divide(binned, counts, out=binned, where=counts > 0)
                                    elif agg == "peak_apex":
                                        np.maximum.at(binned, idx[in_range], cur[in_range])
                                    else:
                                        np.add.at(binned, idx[in_range], cur[in_range])
                                    cur_mz = centers
                                    cur = binned
                        out[i] = cur
                        if i % 200 == 0:
                            pct = int(100 * (fi + i / max(n, 1)) / len(src_files))
                            yield _sse("progress", {"step": "processing", "pct": pct,
                                                     "message": f"{tid}: {i}/{n}"})
                            await asyncio.sleep(0)
                    np.savez_compressed(out_dir / f"{tid}.npz", spectra=out.astype(np.float32),
                                        coords=coords, mz_bins=final_mz)
                    summary.append({"id": tid, "n_spectra": n})
            elif not is_raw_source:
                # Brak kroków per-pixel — po prostu skopiuj dane źródłowe do zestawu.
                summary = []
                for path in src_files:
                    if out_dir.resolve() != path.parent.resolve():
                        shutil.copy(path, out_dir / path.name)
                    d = np.load(path)
                    summary.append({"id": path.stem, "n_spectra": len(d["spectra"])})

            dreg2 = _ensure_datasets_registry(wid)
            ds = _find_dataset(dreg2, did)
            if ds is not None:
                ds["updatedAt"] = _now_iso()
                ds["kind"] = "binned" if is_raw_source else "pipeline"
                ds["source_dataset_id"] = source_id
                ds["steps"] = steps
                ds.pop("params", None)
                _save_datasets_registry(dreg2, wid)

            if wid == _active_workspace_id and did == _active_dataset_id:
                ids = _load_npz_files()
                _tissues_meta = _build_tissues_meta(ids)
            _touch_workspace(wid)

            yield _sse("done", {"message": "Zestaw zbudowany", "summary": summary, "dataset_id": did})
        except Exception as exc:
            import traceback
            yield _sse("error", {"message": str(exc), "trace": traceback.format_exc()})

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@app.get("/workspaces/{wid}/datasets/{did}/graph")
def get_dataset_graph(wid: str, did: str) -> dict:
    """Zwraca zapisany graf node'ów (edycja przetwarzania) dla zestawu `did`,
    albo pusty obiekt jeśli zestaw nie ma jeszcze zapisanego grafu."""
    dreg = _ensure_datasets_registry(wid)
    ds = _find_dataset(dreg, did)
    if not ds:
        raise HTTPException(404, f"Zestaw '{did}' nie istnieje")
    return ds.get("graph") or {}


@app.put("/workspaces/{wid}/datasets/{did}/graph")
def put_dataset_graph(wid: str, did: str, body: dict) -> dict:
    """Zapisuje graf node'ów (nodes/edges/viewport) dla zestawu `did` — to
    reprezentacja do edycji/podglądu; wykonywalny łańcuch (`steps`) zapisuje
    się osobno przy `build_pipeline`."""
    dreg = _ensure_datasets_registry(wid)
    ds = _find_dataset(dreg, did)
    if not ds:
        raise HTTPException(404, f"Zestaw '{did}' nie istnieje")
    ds["graph"] = body
    ds["updatedAt"] = _now_iso()
    _save_datasets_registry(dreg, wid)
    return {"ok": True}


# ── Zapisane mapy pikseli (Wiele m/z) ───────────────────────────────────────

@app.get("/workspaces/{wid}/pixel_maps")
def list_pixel_maps(wid: str) -> dict:
    reg = _load_registry()
    if not _find_ws(reg, wid):
        raise HTTPException(404, f"Workspace '{wid}' nie istnieje")
    preg = _ensure_pixel_maps_registry(wid)
    return {"maps": preg["maps"]}


@app.post("/workspaces/{wid}/pixel_maps")
def create_pixel_map(wid: str, body: dict) -> dict:
    reg = _load_registry()
    if not _find_ws(reg, wid):
        raise HTTPException(404, f"Workspace '{wid}' nie istnieje")
    preg = _ensure_pixel_maps_registry(wid)
    pmid = uuid.uuid4().hex[:12]
    now = _now_iso()
    meta = {
        "id": pmid,
        "name": (body.get("name") or "Zapisana mapa").strip() or "Zapisana mapa",
        "tissueId": body.get("tissueId", ""),
        "tissueLabel": body.get("tissueLabel", ""),
        "width": body.get("width", 0),
        "height": body.get("height", 0),
        "vmax": body.get("vmax", 0),
        "mode": body.get("mode", "single"),
        "sources": body.get("sources", []),
        "createdAt": now, "updatedAt": now,
    }
    preg["maps"].append(meta)
    _save_pixel_maps_registry(preg, wid)
    full = {**meta, "data": body.get("data", [])}
    _pixel_maps_root(wid).mkdir(parents=True, exist_ok=True)
    _pixel_map_data_file(pmid, wid).write_text(json.dumps(full))
    return meta


@app.get("/workspaces/{wid}/pixel_maps/{pmid}")
def get_pixel_map(wid: str, pmid: str) -> dict:
    """Zwraca pełny rekord zapisanej mapy (w tym `data`) — wołane leniwie per
    karta w galerii "Zapisane", nie przy samej liście (żeby lista była lekka)."""
    preg = _ensure_pixel_maps_registry(wid)
    if not _find_pixel_map(preg, pmid):
        raise HTTPException(404, f"Mapa '{pmid}' nie istnieje")
    f = _pixel_map_data_file(pmid, wid)
    if not f.exists():
        raise HTTPException(404, f"Dane mapy '{pmid}' nie istnieją")
    return json.loads(f.read_text())


@app.put("/workspaces/{wid}/pixel_maps/{pmid}")
def rename_pixel_map(wid: str, pmid: str, body: dict) -> dict:
    preg = _ensure_pixel_maps_registry(wid)
    m = _find_pixel_map(preg, pmid)
    if not m:
        raise HTTPException(404, f"Mapa '{pmid}' nie istnieje")
    if "name" in body and body["name"].strip():
        m["name"] = body["name"].strip()
    m["updatedAt"] = _now_iso()
    _save_pixel_maps_registry(preg, wid)
    return m


@app.delete("/workspaces/{wid}/pixel_maps/{pmid}")
def delete_pixel_map(wid: str, pmid: str) -> dict:
    preg = _ensure_pixel_maps_registry(wid)
    if not _find_pixel_map(preg, pmid):
        raise HTTPException(404, f"Mapa '{pmid}' nie istnieje")
    preg["maps"] = [m for m in preg["maps"] if m["id"] != pmid]
    _save_pixel_maps_registry(preg, wid)
    _pixel_map_data_file(pmid, wid).unlink(missing_ok=True)
    return {"ok": True}


# ── Boards (Tablica) ──────────────────────────────────────────────────────
# Tablice są niezależne od workspace'ów — jedna wspólna lista, osobny folder
# na dysku (boards/), widoczna niezależnie od aktywnego workspace'u.
_BOARDS_REGISTRY_FILE = BOARDS_DIR / "registry.json"


def _load_boards_registry() -> dict:
    try:
        if _BOARDS_REGISTRY_FILE.exists():
            return json.loads(_BOARDS_REGISTRY_FILE.read_text())
    except Exception:
        pass
    return {"boards": []}


def _save_boards_registry(reg: dict) -> None:
    BOARDS_DIR.mkdir(parents=True, exist_ok=True)
    _BOARDS_REGISTRY_FILE.write_text(json.dumps(reg, indent=2))


def _board_dir(bid: str) -> Path:
    return BOARDS_DIR / bid


def _board_json_file(bid: str) -> Path:
    return _board_dir(bid) / "board.json"


def _board_assets_dir(bid: str) -> Path:
    return _board_dir(bid) / "assets"


def _find_board(reg: dict, bid: str) -> dict | None:
    return next((b for b in reg["boards"] if b["id"] == bid), None)


_EMPTY_BOARD = {"objects": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}


@app.get("/boards")
def list_boards() -> dict:
    reg = _load_boards_registry()
    return {"boards": reg["boards"]}


@app.post("/boards")
def create_board(body: dict) -> dict:
    name = (body.get("name") or "Nowa tablica").strip() or "Nowa tablica"
    reg = _load_boards_registry()
    bid = uuid.uuid4().hex[:12]
    now = _now_iso()
    b = {"id": bid, "name": name, "createdAt": now, "updatedAt": now}
    reg["boards"].append(b)
    _save_boards_registry(reg)
    _board_assets_dir(bid).mkdir(parents=True, exist_ok=True)
    _board_json_file(bid).write_text(json.dumps(_EMPTY_BOARD))
    return b


@app.put("/boards/{bid}")
def rename_board(bid: str, body: dict) -> dict:
    reg = _load_boards_registry()
    b = _find_board(reg, bid)
    if not b:
        raise HTTPException(404, f"Tablica '{bid}' nie istnieje")
    if "name" in body and body["name"].strip():
        b["name"] = body["name"].strip()
    b["updatedAt"] = _now_iso()
    _save_boards_registry(reg)
    return b


@app.delete("/boards/{bid}")
def delete_board(bid: str) -> dict:
    reg = _load_boards_registry()
    if not _find_board(reg, bid):
        raise HTTPException(404, f"Tablica '{bid}' nie istnieje")
    reg["boards"] = [b for b in reg["boards"] if b["id"] != bid]
    _save_boards_registry(reg)
    shutil.rmtree(_board_dir(bid), ignore_errors=True)
    return {"ok": True}


@app.get("/boards/{bid}/data")
def get_board(bid: str) -> dict:
    f = _board_json_file(bid)
    if not f.exists():
        raise HTTPException(404, f"Tablica '{bid}' nie istnieje")
    try:
        return json.loads(f.read_text())
    except Exception:
        return dict(_EMPTY_BOARD)


@app.put("/boards/{bid}/data")
def save_board(bid: str, body: dict) -> dict:
    reg = _load_boards_registry()
    b = _find_board(reg, bid)
    if not b:
        raise HTTPException(404, f"Tablica '{bid}' nie istnieje")
    _board_dir(bid).mkdir(parents=True, exist_ok=True)
    _board_json_file(bid).write_text(json.dumps(body))
    b["updatedAt"] = _now_iso()
    _save_boards_registry(reg)
    return {"ok": True}


@app.post("/boards/{bid}/assets")
async def upload_board_asset(bid: str, file: UploadFile = File(...)) -> dict:
    reg = _load_boards_registry()
    if not _find_board(reg, bid):
        raise HTTPException(404, f"Tablica '{bid}' nie istnieje")
    assets_dir = _board_assets_dir(bid)
    assets_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(file.filename or "").suffix.lower() or ".png"
    if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"):
        raise HTTPException(400, f"Niedozwolony format pliku: {ext}")
    asset_id = uuid.uuid4().hex[:16]
    filename = f"{asset_id}{ext}"
    dest = assets_dir / filename
    data = await file.read()
    dest.write_bytes(data)
    return {"id": asset_id, "filename": filename, "url": f"/boards/{bid}/assets/{filename}"}


@app.get("/boards/{bid}/assets/{filename}")
def get_board_asset(bid: str, filename: str):
    path = _board_assets_dir(bid) / filename
    if ".." in filename or not path.exists():
        raise HTTPException(404, "Brak pliku")
    return FileResponse(path)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=7432, log_level="warning")
