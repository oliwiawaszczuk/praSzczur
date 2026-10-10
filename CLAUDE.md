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
workspaces/      # dane per-workspace aplikacji praSzczur (patrz sekcja Workspace), w tym Node Graphy
boards/          # dane tablic (Tablica, Miro-like) aplikacji praSzczur (patrz sekcja Tablica)
app_settings.json # globalne ustawienia appki, niezależne od workspace'u (patrz sekcja Workspace)
app_docs.json    # treść zakładki Dokumentacja appki — poradnik + opisy node'ów (patrz sekcja Dokumentacja)
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
- **Colormap**: LUT-y w `app/src/lib/colormap.ts` (domyślnie Bruker-style); wybór to ustawienie GLOBALNE
  (`getSetting("colormap")`, Ustawienia → "Personalizacja"). Nowy renderer map m/z MUSI brać LUT z
  `activeLut()` (wołanego w `$effect`/`$derived`) albo `renderToCanvas()`, nigdy ze stałej `BRUKER_LUT`.
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

**Ustawienia GLOBALNE (nie per-workspace)** — rzadkie, tylko gdy coś naprawdę ma być wspólne dla
całej appki niezależnie od workspace'u (dziś: czułość zoomu/przesuwania płótna, wspólna dla
wszystkich Node Graphów i Tablicy) — idą przez `getSetting(key, fallback)` / `setSetting(key,
value)` z `$lib/appSettings.svelte`, zapisywane do `app_settings.json` w rootcie (endpointy
`/app_settings` w sidecarze), NIE przez `wsGet/wsSet`.

## Node Graph (wiele grafów per workspace)

Zakładka **Node Graph** ma **wiele niezależnych grafów per workspace** (w odróżnieniu od Tablicy —
grafy SĄ per-workspace, nie globalne), zarządzane przez `app/src/lib/nodegraphs.svelte.ts` +
endpointy `/workspaces/{wid}/nodegraphs/*` w sidecarze (ten sam wzorzec co "Zapisane mapy
pikseli"/"Zapisane widma": lekki rejestr metadanych + osobny plik danych per graf, plus osobny
endpoint `/data` do odczytu/zapisu pełnej treści grafu — jak boards).

- Struktura na dysku: `workspaces/<wid>/nodegraphs/registry.json` (lista grafów),
  `workspaces/<wid>/nodegraphs/<gid>.json` (nodes/edges/viewport/notes, autozapis debounced 300ms).
- Workspace zapamiętuje **ID ostatnio otwartego grafu** (`wsGet/wsSet("nodegraph_activeGraphId", ...)`)
  — jeśli żaden graf nie istnieje, aplikacja tworzy pusty automatycznie (ten sam wzorzec co Tablica).
- Przełącznik/tworzenie nowego grafu: dropdown + "+" w prawym sidebarze `NodeGraphTab.svelte`
  (nad listą typów node'ów). Zarządzanie (zmiana nazwy/usuwanie) — zakładka Ustawienia
  (`WorkspaceSettings.svelte`, karta "Node Graphy").
- Silnik grafu (typy node'ów, ewaluacja, node'y vs proste notatki tekstowe `Graph.notes`) —
  `app/src/lib/nodegraph.ts` + domenowe `nodegraph.mapa.ts` / `.segmentacja.ts` / `.widmo.ts`.
- **Wydajność:** ewaluacja grafu (`evaluateGraphNode`) i mapa krawędzi-po-celu MUSZĄ być liczone
  raz per zmianę grafu przez współdzielony `$derived.by` (patrz `evalMemo`/`edgesByTarget` w
  `NodeGraphTab.svelte`), NIGDY osobno per node/per odczyt — inaczej koszt renderu rośnie do O(N²)
  z liczbą node'ów.
- **Domena "Analiza grup"** (`nodegraph.analiza.ts`, port `zestaw` = zbiór widm-próbek, PLS-DA z
  CV w `src/msi/pls.py`) — workflow z MATLAB-a: zestaw → preprocessing → PLS-DA → Top m/z. Opis i
  różnice względem MATLAB-a: `docs/node-graph.md`, sekcja "Domena Analiza grup".
- **Domena "Markery przestrzenne"** (`nodegraph.markery.ts`, `src/msi/peaks.py` + `markers.py`,
  endpointy `/markers/*`) — piki → macierz piksel × pik (w sidecarze, `marker_cache/`, do grafu
  trafia tylko id) → rankingi m/z. Porty `piki`/`macierz`/`ranking`; węzeł z kilkoma wyjściami
  różnych rodzajów używa `NodeTypeDef.selectOutput`, a kod zakładki czyta wartość krawędzi przez
  `evalEdge(edge)`. Opis: `docs/node-graph.md`, sekcja "Domena Markery przestrzenne".
- **Domena "Analiza obrazu"** (`nodegraph.obraz.ts` + czyste `imageOps.ts`) — filtry/mapy cech/
  progowanie na POJEDYNCZEJ mapie, liczone w przeglądarce bez "Przetwórz"; wynik zapamiętany po
  (dane wejścia, parametry) — nowa operacja MUSI iść przez `cached()`/`mapOp()`, inaczej każda
  zmiana grafu liczy filtr od nowa. Opis: `docs/node-graph.md`, "Domena Analiza obrazu".
- "Wyślij do Node Graph" z innych zakładek (m/z, Widma, Zapisane) — most `$lib/graphInsert.svelte.ts`
  (`requestGraphInsert`/`pendingGraphInsert`): zapisuje obiekt do biblioteki (Zapisane
  mapy/Zapisane widma), przełącza zakładkę, `NodeGraphTab.svelte` pokazuje "duszka" pod kursorem
  do kliknięcia na płótnie (ten sam mechanizm co przeciąganie node'a z palety).

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

## Zestawy grup m/z (zakładka m/z → Grupy)

Zakładka Grupy ma **wiele nazwanych zestawów kolumn per workspace** (jak grafy/tablice): przełącznik +
"+" w pasku `WieleMz.svelte`, zmiana nazwy/usuwanie w Ustawieniach (karta "Zestawy grup m/z"). Stan w
`mzGroups.svelte.ts` przez `wsGet/wsSet`: `wielemz_sets` (lista), `wielemz_activeSetId`,
`wielemz_set_<id>` (kolumny + zaznaczenia + tryb łączenia). Stare klucze `wielemz_groups/_selection/
_combine_mode` są tylko migrowane do "Zestawu 1".

## Dokumentacja (zakładka — poradnik użytkownika, nie dokumentacja kodu)

Zakładka **Dokumentacja** to poradnik + opis DZIAŁANIA appki (nie kodu), globalny — NIE
per-workspace (ten sam duch co Tablica/Notatki). Lewy panel: spis w trzech niezależnie zwijanych
sekcjach (kliknięcie nagłówka chowa/pokazuje, animacja przez `grid-template-rows` 0fr↔1fr) —
**Poradniki** (własne strony usera, u góry) / **Zakładki aplikacji** / **Node Graph — typy node'ów**
(pogrupowane tak samo jak paleta w `NodeGraphTab.svelte`). Każda sekcja pokazuje naraz maks. ok. 5
pozycji (`.docs-nav-scroll { max-height: 168px; overflow-y: auto }`) — więcej przewija się w
środku sekcji, niezależnie od scrolla całego lewego panelu. Ikony sekcji/akcji to ręcznie pisane
inline SVG (Svelte `{#snippet}`, `stroke="currentColor"`) — świadomie BEZ emoji. Prawy panel: pełna
treść wybranej sekcji na całą szerokość (`Dokumentacja.svelte`).

- **Treść sekcji to Markdown** — edytor to zwykła `<textarea>` nad surowym źródłem MD, podgląd to
  wyrenderowany HTML przez `marked` (`marked.setOptions({ gfm: true, breaks: true })`), wstawiany
  przez `{@html bodyHtml}` w `.docs-markdown` (style dla h1–h3/list/code/blockquote/tabel
  zdefiniowane lokalnie w komponencie). Treść jest w 100% lokalna, autorska dla jednego usera —
  świadomie bez sanityzacji HTML (ten sam poziom zaufania co notatki Markdown w Obsidianie).
- **Tryb edycji jest GLOBALNY** — jeden przełącznik w górnym pasku (`editMode`), nie osobny
  przycisk "Edytuj" per sekcja. Gdy włączony: treść KAŻDEJ wybranej sekcji od razu jest polem
  tekstowym (surowy Markdown) z autozapisem (bez osobnego "Zapisz", ten sam duch co
  Notatki/Tablica), a w lewym panelu pojawiają się kontrolki strukturalne — "+" (dodaj własną
  stronę), uchwyt przeciągania (reorder przez Pointer Events jak w `WieleMz.svelte`, NIE natywny
  HTML5 DnD — niestabilny w webview Tauri) i usuwanie strony. Poza trybem edycji appka jest czysto
  do czytania/nawigacji.
- **Dane globalne**: `app_docs.json` w rootcie (endpointy `/app_docs` w sidecarze, ten sam wzorzec
  co `app_settings.json`), czytane/zapisywane przez `app/src/lib/appdocs.svelte.ts` — trzy klucze:
  `tabs` (nadpisania poradnika per zakładka), `nodes` (nadpisania opisu node'a), `pages` (lista
  własnych stron usera: `{id, title, body}`, kolejność = kolejność w tablicy). Domyślna (seed)
  treść sekcji per zakładka jest w `app/src/lib/docsSeed.ts` — `app_docs.json` trzyma tylko
  NADPISANIA tego, co user faktycznie edytował.
- **Synchronizacja z ikonką "(i)" na node'ach Node Grapha**: opis node'a NIE jest duplikowany —
  `NodeGraphTab.svelte` i `Dokumentacja.svelte` czytają dokładnie to samo przez
  `getNodeDoc(typeId, def.description)` (nadpisanie z `app_docs.json`, inaczej domyślny
  `NodeTypeDef.description` z kodu). Edycja w jednym miejscu natychmiast zmienia drugie, bo to
  jedno źródło danych, nie dwa zsynchronizowane.
- Klik ikonki "(i)" na node'ie przełącza zakładkę na Dokumentację i otwiera sekcję tego node'a —
  przez most `app/src/lib/docsNav.svelte.ts` (`requestDocsSection`/`consumePendingDocsSection`),
  ten sam wzorzec co "Wyślij do Node Graph" (`graphInsert.svelte.ts`), tylko w drugą stronę.

## Konwencje

- Wyniki dla użytkownika → `praOutputs/` jako `.md` + `.png`
- Kod analityczny → `scripts/` (jednorazowy) lub `src/msi/` (reużywalny)
- Wykresy: matplotlib, zapis do pliku przed pokazaniem użytkownikowi
- Komentarze i nazwy zmiennych: EN; raporty w `praOutputs/`: PL
