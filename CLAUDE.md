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
workspaces/      # dane per-workspace aplikacji praSzczur (patrz sekcja Workspace)
boards/          # dane tablic (Tablica, Miro-like) aplikacji praSzczur (patrz sekcja Tablica)
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

- `data/processed/<tissue>.npz` — zbinnowane spektra per tkanka (dane "domyślne"/eksploracyjne, poza appką)
- Odtwarzanie: `uv run python scripts/01_preprocess.py` (po zmianie BIN_SIZE/TISSUE_BOUNDS)
- Ładowanie: `np.load("data/processed/T1_ref.npz")` → klucze: `spectra`, `coords`, `mz_bins`
- W aplikacji praSzczur każdy workspace ma **własną** kopię: `workspaces/<id>/processed/<tissue>.npz` + `workspaces/<id>/imzml_path.txt` — patrz sekcja Workspace poniżej.

## Workspace (WAŻNE przy dodawaniu nowych funkcji do aplikacji)

Aplikacja praSzczur ma koncepcję **workspace'ów** — każdy to osobny "projekt" (własny plik imzML,
własne przetworzone dane `.npz`, własne ustawienia UI), przechowywany w `workspaces/<id>/`
i zarządzany przez `app/src/lib/workspace.svelte.ts` + endpointy `/workspaces/*` w sidecarze.

**Zasada przy dodawaniu nowej funkcjonalności we froncie (Svelte):** każdy stan UI, który
sensownie powinien przetrwać restart aplikacji lub różnić się między workspace'ami (wybrane
zakładki/tryby, parametry przetwarzania, listy/etykiety/kolory, zapamiętane warstwy, checkboxy
trybów wyświetlania, zapisane zapytania m/z, itp.) **musi** być zapisywany przez
`wsGet(key, fallback)` / `wsSet(key, value)` z `$lib/workspace.svelte`, a NIE przez zwykły
`localStorage`, zmienną modułową czy stan tylko w pamięci komponentu. `wsSet` zapisuje
(debounced) do sidecara per aktywny workspace — dzięki temu przełączenie/eksport/import
workspace'u przenosi też te ustawienia. Zobacz istniejące wzorce w `DaneTab.svelte`,
`Sidebar.svelte`, `Widma.svelte` (np. `wsGet("dane_binSize", 0.3)`).

## Tablica (freeform whiteboard, Miro-like)

Zakładka **Tablica** to niezależna od workspace'ów, freeform tablica (obrazy + tekst, drag/resize/rotate,
zoom/pan, multi-select, kopiuj-wklej) zbudowana na **Konva.js** (`app/src/lib/BoardCanvas.svelte`).

- **Tablice są globalne, NIE per-workspace** — jedna wspólna lista widoczna niezależnie od aktywnego
  workspace'u, przechowywana w `boards/<board_id>/` (osobny top-level folder, sibling do `workspaces/`),
  zarządzana przez `app/src/lib/board.svelte.ts` + endpointy `/boards/*` w sidecarze.
- Każdy workspace zapamiętuje tylko **ID ostatnio otwartej tablicy** (`wsGet/wsSet("tablica_activeBoardId", ...)`)
  — jeśli żadna tablica nie istnieje, aplikacja tworzy pustą automatycznie.
- Struktura na dysku: `boards/registry.json` (lista tablic), `boards/<id>/board.json` (obiekty + viewport,
  autozapis debounced 800ms), `boards/<id>/assets/` (wgrane obrazy, endpoint upload `/boards/{id}/assets`).
- Komponenty: `Tablica.svelte` (tab + spinanie stanu), `BoardCanvas.svelte` (Konva Stage/Layer/Transformer:
  render obiektów, zoom/pan myszką, multi-select rubber-band, resize/rotate przez `Transformer`, edycja
  tekstu przez overlay `<textarea>`), `BoardSidebar.svelte` (lista tablic gdy brak zaznaczenia, właściwości
  obiektu — kolor/rozmiar/bold dla tekstu, przezroczystość dla obrazu — gdy coś zaznaczone).

## Konwencje

- Wyniki dla użytkownika → `praOutputs/` jako `.md` + `.png`
- Kod analityczny → `scripts/` (jednorazowy) lub `src/msi/` (reużywalny)
- Wykresy: matplotlib, zapis do pliku przed pokazaniem użytkownikowi
- Komentarze i nazwy zmiennych: EN; raporty w `praOutputs/`: PL
