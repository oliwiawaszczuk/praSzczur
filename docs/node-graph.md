# Node Graph

Zakładka **Node Graph** (`app/src/lib/NodeGraphTab.svelte`) to jedno, wspólne płótno
node'ów w stylu Blendera, na którym mieszają się domeny **Mapa pikseli** (mapy
m/z) i **Segmentacja** (k-means). Zastąpiła dwie wcześniejsze, niemal
identyczne implementacje: dawny `mzgraphnodes.ts` + `MzGraphSubtab.svelte`
(podzakładka m/z → "Mapa Node Graph") i `segnodes.ts` + `SegGraphSubtab.svelte`
(cała zakładka "Segmentacja") — usunięte.

## Dlaczego ten refaktor

`MzGraphSubtab.svelte` i `SegGraphSubtab.svelte` były kod-w-kod niemal
identyczne (te same nazwy funkcji, prawie te same numery linii: pan/zoom,
drag node'a, drag portu, menu kontekstowe, wykrywanie cykli) — canvas engine
został skopiowany, zmieniał się tylko rejestr typów węzłów. Do tego domeny
łączyły się wyłącznie **pośrednio**, przez zapis do biblioteki "Zapisane mapy"
i ponowny import w drugim grafie. Ujednolicenie usuwa duplikację silnika i
pozwala łączyć węzły różnych domen **bezpośrednio, w jednym grafie**.

## Architektura

### Pliki

- `app/src/lib/nodegraph.ts` — silnik domenowo-agnostyczny: typy (`GraphNode`,
  `GraphEdge`, `Graph`, `NodeTypeDef`, `PortSocketDef`, `NodeValue`), rejestr
  scalony `NODE_TYPES`, ewaluator (`evaluateGraphNode`), wykrywanie cykli
  (`wouldCreateCycle`).
- `app/src/lib/nodegraph.mapa.ts` — węzły domeny Mapa (`mapa/map_source`,
  `mapa/intensity_range`, `mapa/curve`, `mapa/combine`, `mapa/save_output`) +
  logika (`combineArrays`, `applyCurve`, `computeHistogram`).
- `app/src/lib/nodegraph.segmentacja.ts` — węzły domeny Segmentacja
  (`segmentacja/kmeans`, `segmentacja/select_segments`) + k-means (`runKmeans`,
  k-means++ init, mulberry32 PRNG).
- `app/src/lib/NodeGraphTab.svelte` — jedyny canvas engine (pan/zoom, drag,
  zaznaczanie, połączenia, menu z wyszukiwarką, prawy panel node'ów),
  renderowanie treści węzła per typ.

Każdy plik domenowy woła `registerNodeTypes([...])` przy imporcie (side-effect
na moduł) — dlatego `NodeGraphTab.svelte` importuje oba pliki domenowe jawnie
(`import "$lib/nodegraph.mapa"` itd.), nawet jeśli nie potrzebuje ich named
exports w tym miejscu. Bez tego `NODE_TYPES` byłby pusty.

**Domena Widmo jeszcze nie istnieje.** `PortKind`/`NodeDomain` w `nodegraph.ts`
mają wartość `"widmo"` zarezerwowaną pod przyszłość (kolor kropki już
przydzielony w `PORT_KIND_COLORS`), ale żaden plik domenowy jej dziś nie
używa — to celowo puste miejsce, nie martwy kod do usunięcia. Wcześniejsza
wersja tej zakładki miała prowizoryczną domenę Widmo (przetwarzanie widm,
most `widmo/to_mapa` materializujący mapę z widma) — została usunięta na
prośbę użytkowniczki, bo dubluje `preWidma`/`PreNodesEditor.svelte` (patrz
"Świadomie poza zakresem" niżej) i bo docelowa domena Widmo w Node Graph ma
być zaprojektowana od zera, niezależnie.

### Jeden węzeł, jedna struktura

`GraphNode` to jeden płaski typ z opcjonalnymi polami per-typ (`savedMapId`,
`curvePoints`, `kmeansResult`, `selectedLabels`, `saveName`) — bez
discriminated union. `NodeTypeDef` niesie metadane (`label`, `description`,
`domain`, `stage`), listę gniazd (`inputs`/`outputs`) i `evaluate()` —
dodanie nowego typu węzła to jeden wpis w rejestrze domeny, bez dotykania
silnika.

### Gniazda (porty) — typowane, wielokrotne

Zamiast jednego portu wejściowego/wyjściowego per węzeł (dawny model), każdy
węzeł ma **listę gniazd** (`PortSocketDef[]`) z osobna dla wejść i wyjść.
Każde gniazdo ma `kind: PortKind` (`"widmo" | "mapa" | "segmentacja"`) i stały
kolor kropki (`PORT_KIND_COLORS`) — **łączyć można wyłącznie gniazda tego
samego `kind`**, bez żadnej niejawnej koercji. Silnik pilnuje tego w dwóch
miejscach:

1. **Przy przeciąganiu połączenia** (`findNearestSocket` w
   `NodeGraphTab.svelte`) — nie da się nawet dociągnąć do niepasującego
   gniazda.
2. **Przy ewaluacji** (`evaluateGraphNode` w `nodegraph.ts`) — obrona w głąb,
   na wypadek grafu wczytanego z dysku sprzed zmiany typu węzła.

Dziś każdy węzeł ma co najwyżej jedno gniazdo wejściowe i jedno wyjściowe
(gniazdo `multi: true`, jak w "Łączenie" czy "K-means", przyjmuje **wiele
połączeń do tego samego gniazda**, to nie to samo co wiele gniazd). Model
świadomie wspiera węzły z **kilkoma odrębnymi gniazdami** (np. przyszły węzeł
biorący naraz wejście "mapa" i "segmentacja") — `portPos()` układa gniazda w
kolejne wiersze (`ROW_H = 20px`) pod nagłówkiem węzła, więc dodanie drugiego
gniazda po tej samej stronie nie wymaga zmian w silniku, tylko w
`nodeHeight()` per typ węzła (żeby zostawić miejsce na dodatkowy wiersz).

### Ewaluacja: zawsze synchroniczna, cache na węźle dla operacji ciężkich

`evaluate()` ma sygnaturę dopuszczającą `Promise<EvalOutcome>`, ale w
praktyce **obie domeny są dziś synchroniczne**. K-means nie liczy się
automatycznie przy każdym renderze — użytkownik odpala go ręcznym przyciskiem
("Przetwórz"), wynik trafia do cache'a na węźle (`node.kmeansResult`), a
`evaluate()` tylko czyta ten cache i zwraca błąd ("kliknij Przetwórz…"),
jeśli cache jest pusty albo nieaktualny (wejście się zmieniło od ostatniego
przetworzenia).

## UI płótna

- **Prawy panel node'ów** (`.ng-sidebar`) — zwijany/rozwijany przyciskiem z
  boku (animacja szerokości), lista typów węzłów pogrupowana domena → etap.
  Element listy jest `draggable` — upuszczenie go na płótno (`ondrop` na
  `.nodegraph-canvas`) dodaje węzeł w miejscu upuszczenia, dokładnie tak samo
  jak wybór z menu kontekstowego (`addNode(typeId, pos)` przyjmuje opcjonalną
  jawną pozycję światową zamiast zawsze czytać `palettePos.world`).
- **Menu dodawania węzła** (wyszukiwarka + kategorie) otwiera się dwoma
  równoważnymi gestami, przez wspólne `openPaletteAt(clientX, clientY)`:
  prawy klik na płótnie (`onCanvasContextMenu`) albo klawisz **spacja** w
  ostatniej znanej pozycji kursora (`lastMouseClient`, aktualizowane w
  `onCanvasPointerMove`).
- **Pozycjonowanie menu przy krawędzi** — po wyrenderowaniu menu (rozmiar
  zależy od treści: liczby wyników wyszukiwania) `clampMenuPos()` mierzy
  realny `getBoundingClientRect()` menu i, jeśli wychodzi poza krawędź
  płótna, przestawia je na drugą stronę punktu zaczepienia (w prawo→w lewo,
  w dół→w górę) zamiast pozwolić, żeby się ucięło. Dotyczy zarówno menu
  dodawania węzła, jak i menu węzła (prawy klik na node).
- **Zaznaczanie i grupy** — kliknięcie węzła zaznacza go pojedynczo;
  shift+klik dołącza/odłącza węzeł z zaznaczenia; przeciągnięcie po pustym
  płótnie rysuje prostokąt (marquee) i zaznacza wszystkie węzły, których
  bounding box się z nim przecina (shift podczas przeciągania = dodaj do
  istniejącego zaznaczenia zamiast zastępować). Przeciąganie dowolnego
  zaznaczonego węzła przesuwa **całą grupę** naraz (`dragGroupOrigin` w
  `NodeGraphTab.svelte` zapisuje pozycje startowe wszystkich zaznaczonych
  węzłów). Kliknięcie pustego miejsca (bez ruchu myszy) czyści zaznaczenie.

## Świadomie poza zakresem tego refaktoru

- **`prenodes.ts` / `PreNodesEditor.svelte` / zakładka "preWidma"** — legacy,
  nietknięte. To osobny, starszy eksperyment nad grafem preprocessingu widm
  (liniowy łańcuch, bez gałęzi/DAG). Docelowa domena Widmo w Node Graph — gdy
  powstanie — ma być nowym kodem, niezależnym od tamtego.
- **Bez migracji starych grafów.** Stare klucze workspace (`mzgraph_graph`,
  klucz grafu segmentacji) nie są już czytane przez UI — nowa zakładka
  zawsze startuje z pustym grafem pod kluczem `nodegraph_graph`. Świadoma
  decyzja: prościej i bez ryzyka błędów konwersji niż pisanie importera dla
  starego kształtu danych. Stare klucze zostają fizycznie na dysku
  workspace'u, po prostu nieużywane.
- **Multi-select nie ma jeszcze grupowego usuwania/kopiowania** — dziś
  zaznaczenie służy wyłącznie do wspólnego przesuwania. Usuwanie (Delete/
  Backspace, menu prawego klawisza) wciąż działa na pojedynczym węźle.

## Jak dodać nowy typ węzła

1. Wybierz plik domeny (`nodegraph.mapa.ts` / `.segmentacja.ts`) albo załóż
   nowy dla nowej domeny (np. `nodegraph.widmo.ts`, gdy powstanie).
2. Dopisz wpis do listy przekazywanej `registerNodeTypes()`: `id`
   (namespaced `domena/nazwa`), `label`, `description`, `domain`, `stage`,
   `inputs`/`outputs` (gniazda z `kind`), `params`, `evaluate()`.
3. Jeśli węzeł potrzebuje własnych pól na `GraphNode` (jak `curvePoints` czy
   `kmeansResult`) — dopisz je jako opcjonalne pole w `nodegraph.ts`.
4. Dopisz gałąź `{:else if node.type === "..."}` w `NodeGraphTab.svelte`
   (sekcja `mnode-body`) renderującą kontrolki węzła, oraz, jeśli trzeba,
   wpis w `nodeWidth()`/`nodeHeight()`. Do kontrolek używaj współdzielonych
   klas (`.ds-select` dla dropdownów, `.cb-input`/`.cb-label` dla
   checkboxów, `.slider-row`/`.ng-range`/`.ng-number` dla suwaka z polem
   liczbowym) — to jest ujednolicony zestaw kontrolek 1:1 ze stylem
   `Sidebar.svelte` (zakładka m/z), nie twórz wariantów lokalnie.
5. Nowy typ węzła pojawi się automatycznie zarówno w menu dodawania
   (wyszukiwarka + kategorie), jak i w prawym panelu (`groupedNodeTypes` w
   `NodeGraphTab.svelte` czyta ten sam rejestr) — nic dodatkowo nie trzeba
   tam wpisywać.
