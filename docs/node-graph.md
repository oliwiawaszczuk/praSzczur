# Node Graph

Zakładka **Node Graph** (`app/src/lib/NodeGraphTab.svelte`) to jedno, wspólne płótno
node'ów w stylu Blendera, na którym mieszają się domeny **Mapa pikseli** (mapy
m/z), **Segmentacja** (k-means) i **Widmo** (przetwarzanie/łączenie widm).
Zastąpiła dwie wcześniejsze, niemal identyczne implementacje: dawny
`mzgraphnodes.ts` + `MzGraphSubtab.svelte` (podzakładka m/z → "Mapa Node
Graph") i `segnodes.ts` + `SegGraphSubtab.svelte` (cała zakładka
"Segmentacja") — usunięte.

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
  `mapa/intensity_range`, `mapa/curve`, `mapa/combine`, `mapa/invert`,
  `mapa/save_output`) + logika (`combineArrays`, `applyCurve`,
  `computeHistogram`).
- `app/src/lib/nodegraph.segmentacja.ts` — węzły domeny Segmentacja
  (`segmentacja/kmeans`, `segmentacja/select_segments`,
  `segmentacja/merge_segments`, `segmentacja/invert_segment`,
  `segmentacja/remove_islands`) + k-means (`runKmeans`, k-means++ init,
  mulberry32 PRNG) + usuwanie wysepek (`removeIslands`, łączenie składowych
  spójnych po 4-sąsiedztwie).
- `app/src/lib/nodegraph.widmo.ts` — węzły domeny Widmo (`widmo/spectrum_source`,
  `widmo/from_segment`, `widmo/combine`, `widmo/normalize`, `widmo/smooth`,
  `widmo/baseline`, `widmo/peakpick`, `widmo/compare`, `widmo/save_spectrum`)
  + logika łączenia/normalizacji (`combineVectors`, `normalizeVector`) — patrz
  "Węzły operujące na widmach" niżej.
- `app/src/lib/spectraLibrary.svelte.ts` — biblioteka "Zapisane widma"
  (analogiczna do `savedPixelMaps.svelte.ts`, ale osobny rejestr per workspace
  i osobny kształt danych `{mz, intensity}`), zasilana z zakładki Widma
  (przycisk 💾 przy warstwie) i z węzła `widmo/save_spectrum`.
- `app/src/lib/SpectrumTracesPlot.svelte` / `SpectrumZoomModal.svelte` —
  wspólny mini-wykres Plotly (wiele nałożonych widm) używany w podglądzie
  węzłów Widmo w Node Graph i w jego powiększeniu na cały ekran. Celowo NIE
  to samo co już istniejący `SpectrumPlot.svelte` (pojedyncze widmo + jego
  wersja "po przetworzeniu" jako overlay z synchronizacją osi między dwoma
  wykresami, używany w `PreNodesEditor.svelte`/preWidma) — inny przypadek
  użycia i inny kształt propsów, stąd osobny plik zamiast przeciążania tamtego.
- `app/src/lib/NodeGraphTab.svelte` — jedyny canvas engine (pan/zoom, drag,
  zaznaczanie, połączenia, menu z wyszukiwarką, prawy panel node'ów),
  renderowanie treści węzła per typ.

Każdy plik domenowy woła `registerNodeTypes([...])` przy imporcie (side-effect
na moduł) — dlatego `NodeGraphTab.svelte` importuje wszystkie trzy pliki
domenowe jawnie (`import "$lib/nodegraph.mapa"` itd.), nawet jeśli nie
potrzebuje ich named exports w tym miejscu. Bez tego `NODE_TYPES` byłby pusty.

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
Każde gniazdo ma `kind: PortKind` (`"widmo" | "mapa" | "segmentacja" |
"segment"`) i stały kolor kropki (`PORT_KIND_COLORS`) — **łączyć można
wyłącznie gniazda tego samego `kind`**, bez żadnej niejawnej koercji. Silnik
pilnuje tego w dwóch miejscach:

**"mapa" i "segment" to dwa świadomie różne rodzaje, mimo tego samego
kształtu danych (0/1 albo ciągła intensywność, macierz `number[][]`).** Mapa
m/z (`MapaValue`, `kind: "mapa"`) to ciągła intensywność, segment
(`SegmentValue`, `kind: "segment"`) to zawsze binarna maska przynależności
wyekstrahowana z wyniku k-means (węzeł "Wybór segmentów"). Wcześniejsza
wersja tego refaktoru reprezentowała segment jako `MapaValue` z
`mode: "segment"` — to zostało świadomie zmienione na osobny `PortKind`, bo
konwencja "ten sam kształt = ten sam kind" pozwalała przypadkiem podłączyć
zwykłą "Mapa m/z" tam, gdzie węzeł oczekiwał segmentu (i odwrotnie), np. do
"Łączenie segmentów"/"Odwrócenie segmentu"/"Usuwanie wysepek" — te węzły
mają dziś input **i** output `kind: "segment"`, więc to się już nie kompiluje
na poziomie połączenia (nie da się nawet dociągnąć). Konsekwencja: segment ma
też własne węzły źródła/zapisu (`segmentacja/segment_source` /
`segmentacja/save_segment`), bo `mapa/map_source`/`mapa/save_output`
(kind: "mapa") go nie przyjmą — obie pary czytają/piszą do tej samej
biblioteki "Zapisane" (`SavedPixelMapMode`), tylko przefiltrowanej po `mode`
(`nonSegmentSavedMaps`/`segmentSavedMaps` w `NodeGraphTab.svelte`), więc np.
segment zapisany dawno temu jako zwykła mapa (przed tym rozdzieleniem) nadal
pojawi się pod "Mapa m/z", nie pod "Zapisany segment" — to nie jest
migrowane wstecznie.

**Konwencja kolorów podglądu segmentu jest stała i obowiązuje wszędzie**
(patrz komentarz przy `SegmentValue` w `nodegraph.ts` i
`SegmentMaskCanvas.svelte`, jedyne miejsce, które to rysuje): `data[y][x] ===
1` → **czarny** (segment/zaznaczone), `data[y][x] === 0` → **biały** (poza
segmentem, ale wciąż tkanka), `mask[y][x] === 0` → w pełni przezroczyste
(piksel poza faktycznym skanem tkanki — pomijany przez KAŻDĄ operację:
k-means, łączenie, usuwanie wysepek — nie liczy się jako "0"/tło, tylko jak
gdyby nie istniał). Segment świadomie NIE renderuje się przez `colormap.ts`
(ten sam LUT co ciągła intensywność m/z) — segment to nie intensywność.

1. **Przy przeciąganiu połączenia** (`findNearestSocket` w
   `NodeGraphTab.svelte`) — nie da się nawet dociągnąć do niepasującego
   gniazda.
2. **Przy ewaluacji** (`evaluateGraphNode` w `nodegraph.ts`) — obrona w głąb,
   na wypadek grafu wczytanego z dysku sprzed zmiany typu węzła.

**Kolory są wyprowadzone w jednym miejscu, nie duplikowane.** Kolory krawędzi
(`EDGE_COLORS`/`EDGE_COLOR_DRAG` w `NodeGraphTab.svelte`) liczą się z
`PORT_KIND_COLORS` przez `hexToRgba()`, zamiast być osobno wpisanymi
literałami rgba — dawniej te dwie listy potrafiły się rozjechać (np.
`segmentacja` miała inny odcień w kropce portu niż w krawędzi). `segmentacja`
ma dziś kolor fioletowy (`#b48ce0`), świadomie inny odcień niż niebieski
`widmo` — te dwa rodzaje portów mają wyglądać wyraźnie inaczej na pierwszy
rzut oka, nie tylko przy uważnym porównaniu.

**Kropka legendy w prawym panelu pokazuje, co węzeł PRZYJMUJE.**
`nodeTypeDotBackground()` koloruje kropkę przy nazwie typu w sidebarze wg
rodzajów jego **wejść** (nie wyjścia) — to praktyczna wskazówka "co mogę
podłączyć do tego node'a". Węzły źródłowe bez wejść (np. "Mapa m/z") pokazują
zamiast tego kolor swojego wyjścia. Węzeł z **kilkoma różnymi rodzajami
wejść** naraz dostaje kropkę podzieloną równo między te kolory
(`conic-gradient`, po jednej działce na rodzaj) zamiast pokazywać tylko
pierwszy z nich — dziś żaden zarejestrowany typ jeszcze tego nie robi, ale
mechanizm jest gotowy pod przyszłe węzły łączące np. mapę i segmentację w
jednym wejściu.

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
praktyce **wszystkie trzy domeny są dziś synchroniczne**. K-means nie liczy
się automatycznie przy każdym renderze — użytkownik odpala go ręcznym
przyciskiem ("Przetwórz"), wynik trafia do cache'a na węźle
(`node.kmeansResult`), a `evaluate()` tylko czyta ten cache i zwraca błąd
("kliknij Przetwórz…"), jeśli cache jest pusty albo nieaktualny (wejście się
zmieniło od ostatniego przetworzenia). Cztery węzły domeny Widmo, które
wymagają wywołania backendu (`widmo/smooth`, `widmo/baseline`,
`widmo/peakpick` — algorytmy scipy w `src/msi/preprocessing.py`, przez nowy
endpoint `/spectrum_process`; `widmo/from_segment` — agregacja potencjalnie
tysięcy pikseli segmentu, przez nowy endpoint `/segment_spectrum`) idą
dokładnie tym samym wzorcem: `node.widmoProcessCache` (analogiczne do
`kmeansResult`) + ręczny przycisk "Przetwórz" w `NodeGraphTab.svelte`
(`runSpectrumProcessNode`/`runFromSegmentNode`). Świadoma decyzja: przepisanie
silnika na faktycznie asynchroniczny byłoby ryzykowne, bo `evalNode()` jest
dziś wołane wprost w renderze Svelte w wielu miejscach (`previewHeight`,
`nodeHeight`, treść węzła) — rozszerzenie sprawdzonego wzorca kosztuje mniej
niż przepisanie silnika drugi raz.

## UI płótna

- **Prawy panel node'ów** (`.ng-sidebar`) — zwijany/rozwijany przyciskiem z
  boku (animacja szerokości), lista typów węzłów pogrupowana domena → etap.
  Przeciąganie elementu listy na płótno dodaje węzeł w miejscu upuszczenia,
  dokładnie tak samo jak wybór z menu kontekstowego (`addNode(typeId, pos)`
  przyjmuje opcjonalną jawną pozycję światową zamiast zawsze czytać
  `palettePos.world`) — celowo NIE przez natywne HTML5 drag'n'drop
  (`draggable`/`dataTransfer`), bo jest zawodne pod Tauri/WKWebView (drop
  czasem po prostu nie odpalał się), tylko przez ten sam mechanizm
  pointer-eventowy co przeciąganie node'a/marquee (`paletteDrag`,
  `onSidebarItemPointerDown`/`onPaletteDragMove`/`onPaletteDragUp`).
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
- **"F" dopasowuje widok do zaznaczenia, jeśli coś jest zaznaczone** — inaczej
  (jak dawniej) do wszystkich node'ów. `fitAll()` liczy bounding box tylko po
  `graph.nodes` przefiltrowanych przez `selectedNodeIds`, gdy zbiór nie jest
  pusty.
- **Kropka portu stackuje się tylko w obrębie własnego node'a.** `.mnode` ma
  jawny `z-index: 1` (nie tylko `position: absolute`), co tworzy dla niego
  własny kontekst stackowania CSS — bez tego `.port` (jawny `z-index: 5`, bo
  musi być nad ciałem WŁASNEGO node'a) przebijał się ponad WSZYSTKIMI innymi
  node'ami globalnie, niezależnie od tego, który faktycznie leżał na wierzchu
  (typowa pułapka CSS: `position` bez `z-index` nie tworzy kontekstu
  stackowania, więc potomek z `z-index` "ucieka" poza swojego rodzica).
- **Usuwanie działa na całym zaznaczeniu.** Delete/Backspace (`requestDeleteSelection`)
  albo "Usuń" w menu prawego klawisza na node'ie należącym do wieloznaczenia
  (`requestDeleteNode`) usuwają **wszystkie** aktualnie zaznaczone node'y
  naraz, nie tylko ten jeden pod kursorem/klikiem. Potwierdzenie
  (`ConfirmModal`) zawsze wypisuje z nazwy wszystkie node'y, które faktycznie
  znikną (`deleteMessage`), więc nie da się przez pomyłkę usunąć całej grupy
  bez zobaczenia, co się w niej znajduje. Kliknięcie prawym na pojedynczym
  node'ie spoza bieżącego zaznaczenia usuwa tylko ten jeden węzeł, tak jak
  wcześniej.
- **Przeciągnięcie połączenia w puste miejsce otwiera wyszukiwarkę.**
  Puszczenie ciągniętej z kropki linii (patrz `connDrag`) nad pustym płótnem
  (żadne pasujące gniazdo w zasięgu `findNearestSocket`) nie odrzuca po
  prostu przeciągnięcia — otwiera menu dodawania węzła w tym miejscu
  (`resolveConnection(true, e)` → `openPaletteAt(..., connDrag)`),
  **przefiltrowane do typów mających pasujące gniazdo** (przeciwny kierunek,
  ten sam `kind` — patrz `pendingConn`/`typeAcceptsConn`). Wybór typu z tej
  listy od razu dodaje node **i** dokańcza połączenie do jego pierwszego
  pasującego gniazda (`addNode`). Puszczenie dokładnie na niepasującym porcie
  (nie na pustym miejscu) nadal po prostu nic nie robi — `onPortPointerUp`
  woła `resolveConnection(false, ...)`, bez otwierania wyszukiwarki.

## Węzły operujące na segmentach

Segment wyekstrahowany przez "Wybór segmentów" jest `SegmentValue`
(`kind: "segment"`, patrz sekcja o gniazdach wyżej) — pięć węzłów domeny
Segmentacja operują wyłącznie na tym rodzaju (input **i** output
`kind: "segment"`), świadomie **osobnych typów** od odpowiedników domeny Mapa
(nie ponownego użycia `mapa/combine`/`mapa/invert` z innym `domain`), bo to
inny rodzaj gniazda — nie da się ich pomylić nawet przy podłączaniu:

- **`segmentacja/select_segments`** ("Wybór segmentów") — jedyne miejsce, w
  którym `SegmentacjaValue` (pełny, wieloklasowy wynik k-means) staje się
  `SegmentValue` (pojedyncza maska 0/1); zaznaczenie kilku klas łączy je w
  jeden segment.
- **`segmentacja/merge_segments`** ("Łączenie segmentów") — łączy wiele
  podłączonych segmentów operacją mnogościową: suma (OR) albo różnica
  (pierwsze podłączone wejście minus wszystkie pozostałe). Inaczej niż
  `mapa/combine`, którego tryby (średnia, suma, iloczyn…) są myślane pod
  ciągłą intensywność, wynik tu zawsze zostaje czystą maską 0/1.
- **`mapa/invert`** / **`segmentacja/invert_segment`** — odwrócenie kolorów,
  dwa osobne węzły dla dwóch domen mimo tej samej matematyki (`v → 1 − v`,
  co dla maski 0/1 to zwykłe zaprzeczenie) — bo semantycznie odwracają różne
  rzeczy (intensywność mapy vs. przynależność do segmentu) i operują na
  różnych `kind`.
- **`segmentacja/remove_islands`** ("Usuwanie wysepek") — proste łączenie
  składowych spójnych (4-sąsiedztwo, bez przekątnych) na masce segmentu;
  każda składowa nie większa niż parametr "Maks. rozmiar (px)" (`islandMax`,
  suwak 1–20, domyślnie 1 — czyli domyślnie usuwane są tylko całkiem
  odizolowane pojedyncze piksele) zostaje wyzerowana. Piksele poza
  `mask` (poza faktycznym skanem tkanki) są pomijane, nie traktowane jak
  "0"/tło. Implementacja: `removeIslands()` w `nodegraph.segmentacja.ts`.
- **`segmentacja/save_segment`** / **`segmentacja/segment_source`**
  ("Zapis segmentu" / "Zapisany segment") — odpowiedniki
  `mapa/save_output`/`mapa/map_source`, ale dla `kind: "segment"`; zapisują/
  czytają do tej samej biblioteki "Zapisane" (`SavedPixelMapMode` ma wartość
  `"segment"`), tylko przefiltrowanej po `mode` w obie strony — "Mapa m/z"
  pokazuje wyłącznie zapisy NIE będące segmentem, "Zapisany segment"
  odwrotnie (patrz `nonSegmentSavedMaps`/`segmentSavedMaps` w
  `NodeGraphTab.svelte`).

## Węzły operujące na widmach

Widmo (`WidmoValue`, `kind: "widmo"`, wektor `intensity` na wspólnej osi `mz`)
to trzecia domena — **niezależna od starszego, liniowego edytora
preprocessingu "preWidma"** (`prenodes.ts`/`PreNodesEditor.svelte`, patrz
"Świadomie poza zakresem" niżej): tamten graf projektuje ZESTAW DANYCH (jeden
łańcuch bez gałęzi, dla całej tkanki), ten operuje na POJEDYNCZYCH, już
wyliczonych widmach płynących przez ogólny DAG i może łączyć się z innymi
domenami (patrz `widmo/from_segment` niżej — pierwszy węzeł w Node Graph, który
faktycznie **łączy dwie różne domeny w jednym potoku**, nie tylko dwa różne
"kind" obok siebie na płótnie).

- **`widmo/spectrum_source`** / **`widmo/save_spectrum`** ("Zapisane widmo" /
  "Zapis") — odpowiedniki `mapa/map_source`/`mapa/save_output`, ale czytają/
  piszą do OSOBNEJ biblioteki "Zapisane widma" (`spectraLibrary.svelte.ts`,
  endpointy `/workspaces/{wid}/spectra`) — inny kształt danych (`mz`/`intensity`,
  nie siatka pikseli), więc nie ma sensu współdzielić rejestru z mapami/
  segmentami. Biblioteka zasilana jest też z zakładki Widma (przycisk 💾 przy
  warstwie w `Widma.svelte`) — dokładnie tak jak mapy pikseli mają swoje źródło
  poza Node Graph (podzakładka "Zapisane").
- **`widmo/from_segment`** ("Widmo z segmentu") — jedyny most między domenami
  Segmentacja i Widmo: przyjmuje `SegmentValue` (`kind: "segment"`), agreguje
  widma WSZYSTKICH pikseli segmentu (suma/średnia/maksimum/różnica) w jedno
  widmo. Agregacja tysięcy pikseli jest zbyt kosztowna, żeby ciągnąć pojedynczo
  do przeglądarki — liczona na backendzie (`POST /segment_spectrum`, offset
  lokalnej maski segmentu → bezwzględne (x,y) bierze z `_tissues_meta`, bo
  geometria tkanki jest ta sama niezależnie od wybranego zestawu/binningu),
  przeliczana ręcznie przyciskiem "Przetwórz" (patrz sekcja o ewaluacji wyżej).
- **`widmo/combine`** ("Łączenie") — jak `mapa/combine`, ale na wektorach 1D
  zamiast macierzy 2D: suma/średnia/maksimum/różnica (pierwsze wejście minus
  reszta) wielu widm tej samej tkanki i siatki m/z (`combineVectors` w
  `nodegraph.widmo.ts`). Świadomie bez trybów `multiply`/`mask_*` z
  `mapa/combine` — nie mają sensownego odpowiednika dla widm.
  "Porównanie widm" (`widmo/compare` niżej) świadomie NIE duplikuje różnicy
  jako danych — do tego służy właśnie ten węzeł z trybem "różnica".
- **`widmo/normalize`** ("Normalizacja") — tryby brak/max/TIC, **liczone po
  stronie klienta** (nie przez backendowe `normalize_tic`) — `normalize_tic`
  w Pythonie normalizuje do MEDIANY TIC CAŁEJ TKANKI (sensowne dla widma
  pojedynczego piksela w kontekście jednego zestawu danych), ale widmo płynące
  tu przez graf może już być połączeniem/agregacją wielu pikseli, więc jedyna
  spójna opcja to normalizacja do WŁASNEGO maksimum/sumy (`normalizeVector`,
  ta sama logika co `normalize()` w `Widma.svelte`).
- **`widmo/smooth`** / **`widmo/baseline`** / **`widmo/peakpick`**
  ("Wygładzanie" / "Korekcja linii bazowej" / "Wykrywanie pików") — te same
  algorytmy scipy co w `preWidma`/`src/msi/preprocessing.py`
  (`smooth_savgol`/`baseline_correction_snip`/`peak_pick`), ale przez nowy
  endpoint `POST /spectrum_process`, który — inaczej niż `/preprocess`/
  `/preprocess_chain` — przyjmuje DOWOLNE `mz`/`intensity` wprost w body,
  zamiast wskazywać piksel `(tissue, x, y)` z dysku (widmo tutaj może być już
  wynikiem łączenia/agregacji, nie istnieje jako pojedynczy piksel). Ręczny
  przycisk "Przetwórz" jak przy `widmo/from_segment`.
- **`widmo/compare`** ("Porównanie widm") — węzeł **czysto podglądowy**:
  przyjmuje dwa widma (gniazda `a`/`b`, nie `multi`) i pokazuje je nałożone na
  jednym wykresie, opcjonalnie z trzecią linią — różnicą A−B (checkbox "pokaż
  różnicę"). Świadomie **bez wyjścia liczbowego** (`outputs: []`, jak
  `mapa/save_output`) — żeby użyć różnicy jako danych dalej w grafie, trzeba
  użyć `widmo/combine` z trybem "różnica" na dwóch wejściach; ten węzeł
  dubluje wtedy istniejącą semantykę zamiast definiować drugą.

Podgląd na żywo węzłów widma (mini-wykres w ciele node'a + przycisk "⤢" →
`SpectrumZoomModal.svelte` na cały ekran) używa wspólnego
`SpectrumTracesPlot.svelte` — ten sam ciemny motyw/hover co w zakładce Widma,
ale to CELOWO inny komponent niż istniejący `SpectrumPlot.svelte`
(pojedyncze widmo + overlay "po przetworzeniu" z synchronizacją osi, używany w
`PreNodesEditor.svelte`) — inny kształt propsów (lista wielu nałożonych
trace'ów, nie jedno widmo + jego wariant), więc osobny plik zamiast
przeciążania tamtego różnymi trybami.

## Świadomie poza zakresem tego refaktoru

- **`prenodes.ts` / `PreNodesEditor.svelte` / zakładka "preWidma"** — legacy,
  nietknięte. To osobny, starszy eksperyment nad grafem preprocessingu widm
  (liniowy łańcuch, bez gałęzi/DAG, projektuje ZESTAW DANYCH całej tkanki).
  Domena Widmo w Node Graph (`nodegraph.widmo.ts`) jest nowym, niezależnym
  kodem — operuje na pojedynczych widmach płynących przez ogólny DAG, nie
  dubluje tamtego (patrz "Węzły operujące na widmach" wyżej).
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

1. Wybierz plik domeny (`nodegraph.mapa.ts` / `.segmentacja.ts` /
   `.widmo.ts`) albo załóż nowy dla nowej domeny.
2. Dopisz wpis do listy przekazywanej `registerNodeTypes()`: `id`
   (namespaced `domena/nazwa`), `label`, `description`, `domain`, `stage`,
   `inputs`/`outputs` (gniazda z `kind`), `params`, `evaluate()`.
3. Jeśli węzeł potrzebuje własnych pól na `GraphNode` (jak `curvePoints` czy
   `kmeansResult`) — dopisz je jako opcjonalne pole w `nodegraph.ts`.
4. Dopisz gałąź `{:else if node.type === "..."}` w `NodeGraphTab.svelte`
   (sekcja `mnode-body`) renderującą kontrolki węzła, oraz, jeśli trzeba,
   wpis w `nodeWidth()`/`nodeHeight()`. Do kontrolek używaj współdzielonych
   klas: `.ds-select` dla dropdownów (1:1 ze `Sidebar.svelte`), `.cb-input`/
   `.cb-label` dla checkboxów, a dla suwaka z polem liczbowym `.field-head` +
   `.param-value-input` (pole liczbowe) + zwykły `input[type="range"]`
   (globalnie ostylowany w tym pliku — kolorowy track/thumb) — to jest
   dokładnie wzorzec węzła "Wykrywanie pików" w `PreNodesEditor.svelte`
   (patrz np. `segmentacja/kmeans`'owe `k` albo `segmentacja/remove_islands`'owe
   `islandMax` w `NodeGraphTab.svelte` jako gotowe przykłady) — nie twórz
   wariantów lokalnie ani nie wracaj do starego, ad-hoc stylu suwaka.
   Do przycinania/zaokrąglania wartości liczbowej użyj generycznego
   `setNodeParamClamped(node, key, value, min, max)` (zaokrągla do liczby
   całkowitej) albo `setNodeParamClampedFloat(...)` (bez zaokrąglania — dla
   parametrów z krokiem dziesiętnym, np. `widmo/peakpick`'owe
   `prominence_frac`) zamiast pisać własny clamp per pole. Węzły domeny Widmo
   z prostymi parametrami (`widmo/smooth`/`baseline`/`peakpick`) renderują je
   przez generyczną pętlę `{#each NODE_TYPES[node.type]?.params as p}`
   (dokładnie wzorzec `{#each def.params as p}` z `PreNodesEditor.svelte`) —
   preferuj to podejście zamiast ręcznego pola per parametr, gdy węzeł nie ma
   żadnych kontrolek specyficznych poza tym, co niesie `NodeParamDef`.
5. Nowy typ węzła pojawi się automatycznie zarówno w menu dodawania
   (wyszukiwarka + kategorie), jak i w prawym panelu (`groupedNodeTypes` w
   `NodeGraphTab.svelte` czyta ten sam rejestr) — nic dodatkowo nie trzeba
   tam wpisywać.
