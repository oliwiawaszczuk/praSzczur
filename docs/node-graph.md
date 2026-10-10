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

### Postprocessing mocno zaszumionych segmentacji

Sześć węzłów do czyszczenia masek, w których widać gołym okiem spójną
strukturę anatomiczną, ale wynik segmentacji jest usiany szumem "sól i
pieprz" na zewnątrz i dziurami w środku — "Usuwanie wysepek" (wyżej) radzi
sobie tylko z pojedynczymi, małymi (≤20px) izolowanymi skupiskami. Cztery
pierwsze są czysto klienckie (ten sam powód co k-means/GMM: siatka tkanki to
~44k pikseli, tani koszt w JS, zostają w pełni synchroniczne); dwa ostatnie
wymagają backendu i idą wzorcem "Przetwórz" + cache z domeny Widmo.

- **`segmentacja/local_density`** ("Wygładzanie gęstością") — liczy lokalną
  gęstość segmentu w oknie (promień, suwak) wokół każdego piksela (obraz
  całkowy/prefix sums, `boxDensity()`, koszt O(1) per piksel) i przywraca
  piksel do 1, jeśli gęstość przekracza próg. Jeden operator, który
  JEDNOCZEŚNIE tłumi szum na zewnątrz struktury i zalatuje dziury w środku —
  polecany jako pierwszy krok postprocessingu.
- **`segmentacja/morphology`** ("Operacja morfologiczna") — erozja/dylatacja/
  otwarcie/zamknięcie (dropdown trybu + promień + kształt sąsiedztwa
  diament/kwadrat), `erodeDilate()`/`morphologyOp()`. Jeden węzeł zamiast
  czterech osobnych typów, zgodnie z konwencją "Jeden węzeł, jedna
  struktura" (patrz np. `merge_segments`'owy dropdown trybu).
- **`segmentacja/keep_largest`** ("Największe składowe") — zostawia tylko K
  największych (wg liczby pikseli) składowych spójnych, zerując resztę
  (`connectedComponents()`, generalizacja flood-fillu z `removeIslands`) —
  odrzuca przypadkowe skupiska szumu niezależnie od ich rozmiaru (w
  odróżnieniu od progu bezwzględnego w "Usuwaniu wysepek").
- **`segmentacja/fill_holes`** ("Wypełnij wszystkie dziury") — flood-fill
  tła od brzegu siatki (`fillHolesFull()`), bez limitu rozmiaru dziury —
  uzupełnienie "Usuwania wysepek" (+ "Odwróć kolory", limit 20px) dla
  rozległego, gęsto podziurawionego wnętrza struktury.
- **`segmentacja/active_contour`** ("Aktywny kontur") — dopasowuje gładki,
  zamknięty kontur do maski energią REGIONALNĄ (wariancja wewnątrz/na
  zewnątrz konturu, nie próg piksel-po-pikselu), więc odporne na pojedyncze
  piksele szumu i dziury — `skimage.segmentation.morphological_chan_vese`
  przez nowy endpoint `POST /segment_morphsnakes`
  (`src/msi/segmentation_post.py`). Cache: `GraphNode.morphSnakesCache`.
- **`segmentacja/spectral_refine`** ("Dopasowanie do widm") — JEDYNY węzeł
  postprocessingu, który wraca do oryginalnych widm zamiast zostać czysto
  geometryczną operacją na masce 0/1: erozja maski (rdzeń/tło) na
  faktycznej siatce 2D tkanki (`scipy.ndimage.binary_erosion`), widmo
  referencyjne rdzenia i tła (średnia widm z `_get_dataset_cache`, ten sam
  dostęp co `/segment_spectrum`), podobieństwo kosinusowe KAŻDEGO piksela
  tkanki do obu referencji (`src.msi.segmentation_post.cosine_scores`), próg
  przy 0. Parametr "Iteracje" > 1 powtarza cykl (self-training: nowa maska →
  nowe referencje → nowy wynik). Endpoint `POST /segment_spectral_refine`.
  Cache: `GraphNode.spectralRefineCache`.

Odcisk wejścia dla dwóch ostatnich (`segMaskInputSignature()` w
`nodegraph.segmentacja.ts`) — jak `widmoInputSignature` w domenie Widmo: nie
porównuje maski piksel-po-pikselu, tylko tanie, ale czułe na zmianę sygnały
(wymiary + liczba pikseli segmentu + parametry węzła).

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
- **`widmo/mz_list`** ("Lista m/z (próg)") — też węzeł czysto podglądowy
  (`outputs: []`): dwa suwaki, próg dolny/górny jako ułamek maksimum widma
  (`maxIntensity`/`filterMzByIntensityBand` w `nodegraph.widmo.ts`), pokazuje
  wejściowe widmo z dwiema poziomymi liniami progów (te same 3 trace'y przez
  `SpectrumTracesPlot`, próg jako stała intensywność na całej siatce m/z) i
  listę m/z, których intensywność wpada w to pasmo, jako tekst do skopiowania
  w formacie `[m1;m2;...]` (`formatMzListText`/`parseMzListText` w
  `mzListFormat.ts`) — ten sam format przyjmuje modal "Lista m/z" w zakładce
  m/z → Grupy (`MzListModal.svelte`), gdzie każde wklejone m/z staje się
  własną grupą/kolumną.

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

## Domena "Analiza grup" (PLS-DA, workflow z MATLAB-a)

Odpowiednik skryptów `Matlab/.../skrypt_ostateczny_*_KM_5dni_neg.m`. Pliki:
`nodegraph.analiza.ts` (węzły + czyste funkcje), `src/msi/pls.py` (algorytmy,
testy w `tests/test_pls.py`), endpointy `/tissue_spectra`, `/set_preprocess`,
`/pls_da` w sidecarze, `PlsDiagnostics.svelte` (okno wykresów diagnostycznych).

- **Jednostką próbki jest widmo** (tkanka albo segment), nie piksel — jak w
  MATLAB-ie (1 plik `.txt` = 1 próbka). Stąd rodzaj portu `zestaw`
  (`ZestawValue`: N widm na wspólnej osi m/z). Wyjście PLS-DA to zwykłe
  `widmo` (beta(m/z)), więc dalej działają węzły domeny Widmo.
- Mapowanie: `mssgolay` → Savitzky-Golay, `msbackadj` → SNIP, `data./sum` →
  TIC, `plsregress` → `sklearn.PLSRegression(scale=False)` + własne CV,
  `PLSmsep`/`pctVar` → wykresy w "Diagnostyka", `maxk(abs(beta))` → "Top m/z".
- Różnice względem MATLAB-a (świadome): `min. odstęp m/z` w "Top m/z" (0 =
  zachowanie MATLAB-a; bez niego top-k to zwykle sąsiednie biny jednego piku),
  opcjonalny test permutacyjny Q² (przy kilku próbkach i tysiącach m/z PLS łatwo
  się przeucza), foldy CV stratyfikowane po grupie.
- Cache zestawów (`GraphNode.zestawCache`) trafia do pliku grafu — dlatego węzły
  zestawu zapisują widma zaokrąglone do 5 cyfr znaczących (`quantize`).


## Domena "Markery przestrzenne" (automatyczny ranking m/z)

Cel: automatycznie znaleźć m/z, które tworzą strukturę przestrzenną albo różnicują regiony
tkanki — nie tylko "czy to pik", ale "czy ten pik jest informatywny przestrzennie". Pliki:
`nodegraph.markery.ts` (węzły + czyste funkcje: filtr, powtarzalność, łączenie rankingów, CSV,
adnotacja FMP-10), `src/msi/peaks.py` (detekcja i opis pików), `src/msi/markers.py` (macierz,
metryki, rankingi; testy `tests/test_markers.py`), endpointy `/markers/*` w sidecarze.

Pipeline (zalecany):

```
Widmo z segmentu (średnia, surowe) → [Wygładzanie] → Korekcja linii bazowej
  → Wykrywanie pików (lista) → Filtr jakości pików → Macierz piksel × pik (+ opcjonalne ROI)
  → Ranking przestrzenny ─┐
  → Kontrast regionów ────┼→ Grupy kolokalizacji → Powtarzalność → Ranking łączony
                          │                                      → Mapa z rankingu / Tabela rankingu
                          └→ (wyjście "wynik (widmo)" Rankingu łączonego → istniejący "Top m/z")
```

- **Nowe rodzaje portów:** `piki` (lista `PeakInfo`), `macierz` (`MacierzValue` — tylko id +
  podsumowanie; sama macierz piksel × pik leży w `workspaces/<wid>/marker_cache/<id>.npz`, bo w
  JSON-ie grafu miałaby dziesiątki MB), `ranking` (`RankingValue`, wiersze malejąco po `score`).
- **Kilka wyjść różnych rodzajów:** `NodeTypeDef.selectOutput(value, socketId)` — silnik
  (`evaluateInner`) i `evalEdge()` w `NodeGraphTab.svelte` mapują wynik węzła na gniazdo krawędzi
  (dziś: "Ranking łączony" → `ranking` + `widmo`). W kodzie zakładki wartość z krawędzi czytamy
  przez `evalEdge(edge)`, nie `evalNode(edge.from)`.
- **Detekcja na średnim widmie, pomiar w każdym pikselu** — detekcja per piksel przy tym SNR to szum.
- **Rekalibracja przed macierzą:** przesunięcie masy per piksel z centroidu jonu matrycy FMP-10
  (555.2231; przy słabym sygnale mediana ostatnich wiarygodnych pikseli tej tkanki). Na danych
  FMP10 bregma 0.84: −16 / +5 / +19 / +45 ppm (T1–T4) — zgodne z `scripts/09_mass_shift_check.py`.
  Bez tego ranking "różnicujących" m/z łapie artefakt kalibracji.
- **Normalizacja:** TIC po korekcji tła (jak `tic_bg` w 08); RMS jako test odporności. Świadomie
  bez normalizacji do 100% maksimum (IsotopeakeR) — zaciera różnice całkowitej intensywności.
- **Dwa niezależne rankingi:** bez etykiet (Moran I, Gini, kary za korelację z krawędzią i
  matrycą) i kontrast regionów (AUC 1-vs-reszta per region, ε² KW, |Cliff δ|). "Kontrast regionów"
  ostrzega o double dipping, gdy segmentacja powstała z m/z będących kolumnami macierzy.
  Bez p-wartości — piksele nie są niezależnymi powtórzeniami.
- **Powtarzalność między tkankami:** "zgodne" = najgorszy percentyl po tkankach (markery
  anatomiczne); "specyficzne" = efekt jednej tkanki (uwaga na gradient położenia na szkiełku,
  `scripts/11_position_gradient_test.py`).

Co przeniesiono z repo IsotopeakeR (M. Dulewicz) i co zmieniono:

| IsotopeakeR | tu | zmiana |
|---|---|---|
| `my_detect_peaks` (MAD·SNR) | `detect_peaks(noise="mad")` | domyślnie szum lokalny (okno 10 Da) — szum spada ~2× w 300–1000 Da; σ z różnic, gdy widmo po obcięciu tła ma MAD = 0 |
| `find_bounds_valley` | `valley_bounds` | punkt doliny należy do piku (piki na surowej siatce mają 2–4 punkty) |
| `calc_peak_params`, `calc_auc` | `peak_params` | apeks z interpolacji parabolicznej, FWHM z interpolacji liniowej |
| nlsLM asym. Gauss, R² | `fit_asym_gauss` | okno dopasowania ≥ ±4 punkty |
| `.als_baseline` (gęsty `solve`) | `als_baseline` | macierz rzadka — gęsta wersja jest niewykonalna dla 35 700 punktów |
| `transform_intensity`, `normalize_rmse` | `widmo/transform`, tryb RMS w `widmo/normalize` | — |
| SG okno 49, skala 100% | — | świadomie nie (piki ~0.06–0.1 Da tu vs kilka Da w trybie liniowym) |

Walidacja na danych FMP10 (300 pików ze średniego widma T1, filtr → 155, macierz 16 341 × 155
w ~16 s): mediana FWHM 0.078 Da, mediana R² 0.98; w top-10 rankingu przestrzennego są m.in.
674.29 (DA 2A, kalibrant FMP-10) oraz m/z z ręcznej listy (957.4, 353.06, 415.04, 424.07).

## Domena "Analiza obrazu" (pojedyncza mapa m/z)

Operacje na JEDNEJ mapie (intensywność = "kolor"). Pliki: `imageOps.ts` (czyste funkcje na
`Grid` = wartości + maska, bez importów), `nodegraph.obraz.ts` (węzły). Liczone w przeglądarce —
mapy mają ~4–7 tys. pikseli tkanki (FMP10: 89 × 74 px na tkankę), najwolniejszy NLM ~20 ms — więc
bez "Przetwórz", suwaki działają na żywo. Wynik każdej operacji jest zapamiętany po (tablica danych
wejścia, parametry): te same dane → TEN SAM obiekt wyniku, więc ponowne liczenie `evalMemo` (przy
każdej zmianie grafu) nie liczy filtrów od nowa, a kolejne node'y w łańcuchu też trafiają w cache.
Dodatkowe informacje do podglądu (próg, σ szumu, tabela obiektów) idą bokiem przez
`OBRAZ_INFO` (WeakMap po wartości wyjścia); drugie wyjścia (segment obok mapy) przez `selectOutput`.

**Maska wszędzie:** piksel poza skanem nie wchodzi do żadnego okna; zero wewnątrz tkanki to
prawdziwa wartość (typowa mapa FMP10 ma ~44% takich zer). Szum σ szacowany z różnic sąsiednich
pikseli z sygnałem (`estimateNoise`) — zwykły MAD przy tylu zerach daje 0.

| Grupa | Węzły |
|---|---|
| Przygotowanie | Usuwanie hotspotów (P99 / mediana+k·MAD), Stabilizacja wariancji (sqrt/log, w przód/odwrotna), Filtr medianowy |
| Odszumianie | Rozmycie Gaussa (odniesienie), Filtr bilateralny, Non-local means, Total variation (ROF/Chambolle) — parametry siły jako wielokrotność σ szumu |
| Kontrast | CLAHE (tylko do oglądania/segmentacji) |
| Mapy cech | Lokalny CV, Skupiska (Gi* / LISA; mapa + segment), Krawędzie (Sobel; Canny jako segment) |
| Progowanie / obiekty | Progowanie (Otsu, Triangle, percentyl, multi-Otsu; segment + segmentacja; "pomiń zera"), Obiekty (spójne składowe, min. pole, top N, tabela) |
| Ocena | Karta jakości (Moran I, spatial chaos, Gini, CV, % sygnału, σ, SNR, histogram), Szum metody (residuum przed−po + werdykt) |

Walidacja `imageOps.ts` względem scikit-image (syntetyczny obraz pasy + koło + szum σ = 0.08):
Gauss identyczny (max Δ 1e-15); TV r = 0.9997, NLM r = 0.999, bilateral r = 0.997 (różnice z detali
implementacji: skimage waży łatki NLM Gaussem i dyskretyzuje wagi bilateral); progi Otsu/Triangle/
multi-Otsu w obrębie jednego binu histogramu; `estimateNoise` 0.082 vs prawdziwe 0.08. Spatial chaos
to port 1:1 `pyImagingMSpec.measure_of_chaos` (dylatacja krzyżem, erozja kwadratem, 4-spójność).

Na mapie FMP10 m/z 674.27 (T1) "Szum metody" (Moran I residuum, domyślne parametry): Gauss 0.24
(usuwa strukturę), mediana 0.05, bilateral 0.03, TV −0.04 — filtry z zachowaniem krawędzi usuwają
głównie szum, zwykły Gauss zjada granice.

Świadomie poza zakresem: BM3D i sieci neuronowe (ciężkie zależności/trenowanie, mały zysk przy tak
małych obrazach), tekstura GLCM (do dodania, jeśli będzie potrzebna).
