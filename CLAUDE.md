# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Środowisko

- **Python**: uv, venv w `.venv/`, Python 3.14
- **Uruchamianie**: zawsze `uv run python skrypt.py` lub `uv run jupyter notebook`
- **Linting**: `uv run ruff check src/`
- **Testy**: `uv run pytest`

## Struktura

```
source/          # dane surowe — NIE RUSZAĆ
src/msi/         # biblioteka analityczna (loader.py, ...)
scripts/         # jednorazowe skrypty analityczne
praOutputs/      # raporty i wykresy dla użytkownika (.md + .png)
docs/            # dokumentacja techniczna (dataset.md, ...)
```

## Dataset

- Plik: `source/FMP10_Rat_brain_breg_084.imzML` + `.ibd`
- MALDI-TOF, continuous mode, 16 341 spektrów, m/z 300–1500 Da (35 700 punktów)
- Piksele: x ∈ [35,457], y ∈ [35,139] (~150 µm/piksel)
- Loader: `from src.msi.loader import open_parser, get_metadata, get_ion_image`

## Aplikacja praSzczur

- **Plik do uruchomienia**: `praSzczur.app` (w root projektu)
- **Dev mode**: `cd app && pnpm tauri dev`
- **Rebuild**: `cd app && pnpm tauri build` → kopiuj z `src-tauri/target/release/bundle/macos/`
- **Sidecar**: `app/sidecar/main.py` — FastAPI na porcie 7432, uruchamiany automatycznie przez .app
- **Frontend**: `app/src/` — SvelteKit + Svelte 5, komponenty w `app/src/lib/`
- **Colormap**: Bruker-style LUT w `app/src/lib/colormap.ts`
- **Stack**: Tauri v2 (Rust) + SvelteKit + Python FastAPI sidecar

## Dane przetworzone

- `data/processed/<tissue>.npz` — zbinnowane spektra per tkanka
- Odtwarzanie: `uv run python scripts/01_preprocess.py` (po zmianie BIN_SIZE/TISSUE_BOUNDS)
- Ładowanie: `np.load("data/processed/T1_ref.npz")` → klucze: `spectra`, `coords`, `mz_bins`

## Konwencje

- Wyniki dla użytkownika → `praOutputs/` jako `.md` + `.png`
- Kod analityczny → `scripts/` (jednorazowy) lub `src/msi/` (reużywalny)
- Wykresy: matplotlib, zapis do pliku przed pokazaniem użytkownikowi
- Komentarze i nazwy zmiennych: EN; raporty w `praOutputs/`: PL
