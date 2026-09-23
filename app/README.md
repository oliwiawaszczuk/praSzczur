# praSzczur

Desktopowa aplikacja do eksploracji danych MSI (mass spectrometry imaging) z pliku `.imzML`
(MALDI-TOF, tryb continuous). Pozwala wykryć tkanki na skrawku, zbinować widma, przeglądać
mapy jonowe (ion images) dla wybranego m/z i przeglądać widma pojedynczych pikseli.

## Stack

- **Tauri v2** (Rust) — natywny shell desktopowy (macOS)
- **SvelteKit + Svelte 5** (runes: `$state`, `$props`, `$effect`) — frontend, `app/src/`
- **Python FastAPI sidecar** — `app/sidecar/main.py`, nasłuchuje na `http://127.0.0.1:7432`,
  uruchamiany automatycznie przez `.app` (w dev mode trzeba go mieć uruchomionego osobno albo
  zaufać `pnpm tauri dev`, który go odpala)
- **Plotly.js** — wykresy widm (zakładka Widma)
- **Bruker-style colormap** — `app/src/lib/colormap.ts` (black→blue→cyan→green→yellow→orange→red→white),
  współdzielony między zakładką m/z a zakładką Widma, żeby obraz tkanki wyglądał identycznie
  w obu miejscach (te same kolory, ten sam zakres jasności `dispMin`/`dispMax`)

## Uruchamianie

- **Dev**: `cd app && pnpm tauri dev`
- **Build**: `cd app && pnpm tauri build` → gotowa `.app` w
  `src-tauri/target/release/bundle/macos/praSzczur.app`. Po buildzie kopiujemy ją do roota
  projektu (`../praSzczur.app`), bo to jest plik, który się realnie uruchamia.
- **Typecheck**: `pnpm exec svelte-check --tsconfig ./tsconfig.json`

## Workspace — kluczowa koncepcja

Aplikacja jest wielo-projektowa: każdy **workspace** to osobny "projekt" — własny plik imzML,
własne przetworzone dane `.npz`, własne ustawienia UI. Dane trzymane są w
`workspaces/<id>/` (w roocie repo, poza `app/`):

```
workspaces/<id>/
  imzml_path.txt     # ścieżka do źródłowego .imzML
  processed/*.npz    # zbinowane spektra per tkanka (spectra, coords, mz_bins)
  workspace.json     # zapisany stan UI (patrz niżej)
```

Rejestr workspace'ów: `workspaces/registry.json` (lista + `active_id`).

**Stan UI** (wybrana zakładka, parametry binowania, etykiety/kolory tkanek, zapisane warstwy
widm, checkboxy trybów wyświetlania, zapisane zapytania m/z, itd.) jest scalony w jeden obiekt
i zapisywany (debounced, `PUT /workspaces/{id}/settings`) przez
`app/src/lib/workspace.svelte.ts`:

```ts
import { wsGet, wsSet } from "$lib/workspace.svelte";

let binSize = $state(wsGet("dane_binSize", 0.3));
$effect(() => { wsSet("dane_binSize", binSize); });
```

**Zasada dla nowych funkcji:** każdy stan, który powinien przetrwać restart aplikacji lub różnić
się między workspace'ami, ma iść przez `wsGet`/`wsSet` — nie przez `localStorage` ani zmienną
tylko w pamięci komponentu. Przełączenie/eksport/import workspace'u ma wtedy przenosić też te
ustawienia. Szczegóły i przykłady: `CLAUDE.md` (sekcja "Workspace").

Zarządzanie workspace'ami (tworzenie/przełączanie/zmiana nazwy/usuwanie/eksport/import) —
zakładka **Ustawienia**, komponent `WorkspaceSettings.svelte`.

## Zakładki

Aktywne w UI:

- **Dane** (`DaneTab.svelte`) — wczytanie pliku `.imzML`, wykrywanie tkanek (mapa TIC + profil
  kolumnowy), ustawienie zakresu m/z i bin size, **algorytm agregacji binów**: `sum` (suma),
  `mean` (średnia) lub `peak_apex` (maksimum surowych punktów widma w oknie bina, bez
  sumowania/uśredniania — per piksel niezależnie), uruchomienie preprocessingu (SSE progress).
- **m/z** (`Sidebar.svelte` + `IonGrid.svelte`) — wpisanie m/z + tolerancji, siatka map jonowych
  per tkanka. Dwa źródła danych:
  - domyślnie: suma intensywności z **zbinowanych** danych `.npz` (`GET /ion_image`)
  - checkbox "Oryginalne m/z" + osobny przycisk "Załaduj": suma intensywności **bezpośrednio
    z pliku imzML** w oknie mz±tol, z pominięciem binowania (`GET /ion_image_raw`) — wolniejsze
    (parsuje cały imzML per request), ale niezależne od bin size użytego przy preprocessingu.
  Suwak "Zakres" (`dispMin`/`dispMax`, 0..1 ułamek `vmax`) kontroluje jasność/okno wyświetlania
  obrazu jonowego — **nie** ma wpływu na oś Y wykresu widma w zakładce Widma (to były kiedyś te
  same zmienne i się myliły — rozdzielone celowo).
- **Widma** (`Widma.svelte`) — mapa pikseli wybranej tkanki (te same kolory/LUT/jasność co
  zakładka m/z), klikanie piksela dodaje "warstwę" (widmo) na wykresie Plotly. Checkbox
  "Oryginalne widmo" przełącza widmo warstwy między zbinowanym (`GET /pixel_spectrum`) a
  surowym z imzML (`GET /pixel_spectrum_raw`); obok checkboxa pokazuje aktualny bin size.
  Przerywane pionowe kreski ("biny") nakładane na oryginalne widmo pokazują realną,
  zbinowaną intensywność w każdym binie (nie średnią surowych punktów) — przy kilku widocznych
  warstwach uśrednioną po warstwach dla tego samego bina.
- **Ustawienia** — zarządzanie workspace'ami.

Ukryte z nawigacji (kod i placeholder-content zostały, tylko nie ma przycisku w tabbarze —
`TABS` w `+page.svelte` nadal je zawiera, filtrowane tylko przy renderze):
- **Preprocessing** — zarezerwowane pod normalizację/korekcję bazowej linii/redukcję szumu.
- **Segmentacja** — zarezerwowane pod klasteryzację pikseli.

## Sidecar — API (FastAPI, port 7432)

Kluczowe endpointy (`app/sidecar/main.py`):

| Endpoint | Opis |
|---|---|
| `GET /health` | ping |
| `GET /dataset_status`, `/default_tissues` | metadane aktualnie wczytanych/przetworzonych danych |
| `GET /detect_from_imzml` | detekcja tkanek z pliku imzML (TIC + profil) |
| `GET /sample_spectrum`, `/spectrum_window` | podgląd widma (próbkowanie / okno wokół bina) na zakładce Dane |
| `POST /process` | preprocessing → binowanie (SSE progress), zapis `.npz` per tkanka |
| `GET /ion_image` | mapa jonowa ze zbinowanych danych |
| `GET /ion_image_raw` | mapa jonowa bezpośrednio z imzML (mz±tol), z pominięciem binowania |
| `GET /mz_profile` | mini-profil intensywności wokół m/z (widoczek w Sidebar) |
| `GET /pixel_spectrum`, `/pixel_spectrum_raw` | widmo pojedynczego piksela — zbinowane / surowe |
| `GET /tissue_pixel_map` | mapa pikseli tkanki dla wybranego m/z (zakładka Widma) |
| `GET/POST/PUT/DELETE /workspaces*` | CRUD workspace'ów, aktywacja, ustawienia, eksport/import |

## Struktura frontendu

```
app/src/
  routes/+page.svelte      # layout aplikacji, tabbar, globalny stan (tissues, dispMin/Max, ...)
  lib/
    DaneTab.svelte         # zakładka Dane
    Sidebar.svelte         # panel boczny zakładki m/z (input m/z, tolerancja, zakres, lista)
    IonGrid.svelte / IonCanvas.svelte   # siatka map jonowych (zakładka m/z)
    Widma.svelte           # zakładka Widma (Plotly + mapa pikseli)
    WorkspaceSettings.svelte, ConfirmModal.svelte
    workspace.svelte.ts    # centralny store workspace (wsGet/wsSet)
    colormap.ts            # Bruker-style LUT, współdzielony m/z ↔ Widma
    api.ts                 # klient fetch do sidecara
```

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).
