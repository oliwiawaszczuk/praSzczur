// Ujednolicony silnik grafu node'ów (Blender-style) — współdzielony przez
// domeny Mapa (mapy pikseli m/z) i Segmentacja (k-means). Zastępuje dawne,
// niemal identyczne kopie mzgraphnodes.ts + segnodes.ts (patrz
// docs/node-graph.md). Domena Widmo (przetwarzanie widm) jeszcze nie
// istnieje — `PortKind`/`NodeDomain` mają na nią zarezerwowaną wartość
// "widmo", ale żaden plik nie rejestruje pod nią dziś żadnych węzłów.
//
// Model portów: węzeł ma N typowanych gniazd wejściowych i M wyjściowych
// (PortSocketDef), każde o swoim `kind`. Gniazda łączy się WYŁĄCZNIE gdy
// `kind` się dokładnie zgadza (kolor kropki = kind, patrz PORT_KIND_COLORS) —
// świadomie żadnej koercji między rodzajami. To projektowane pod przyszłe
// węzły z wieloma gniazdami naraz (np. węzeł biorący jednocześnie "mapa" i
// "segmentacja"), nie tylko pod dzisiejszy przypadek 1 wejście + 1 wyjście.

import type { SavedPixelMap, SavedPixelMapSource } from "./savedPixelMaps.svelte";
import type { SavedSpectrum, SavedSpectrumSource } from "./spectraLibrary.svelte";

// "segment" to ŚWIADOMIE osobny rodzaj od "mapa" — mapa m/z to ciągła
// intensywność, segment to zawsze binarna maska przynależności (0/1)
// wyekstrahowana z wyniku k-means. Rozdzielenie typów uniemożliwia
// przypadkowe podłączenie zwykłej mapy m/z tam, gdzie węzeł oczekuje
// segmentu (i odwrotnie) — patrz "Wybór segmentów" / "Łączenie segmentów" /
// "Odwrócenie segmentu" / "Usuwanie wysepek" w nodegraph.segmentacja.ts,
// wszystkie operują WYŁĄCZNIE na kind "segment".
export type PortKind = "widmo" | "mapa" | "segmentacja" | "segment";

// Rozróżnialne, stałe kolory kropek per rodzaj gniazda — używane spójnie
// wszędzie (kropki portów, krawędzie, kropka typu w prawym panelu/legendzie).
// Każdy rodzaj ma wyraźnie inny odcień, żeby dwa rodzaje portów nigdy nie
// wyglądały na ten sam kolor na pierwszy rzut oka.
export const PORT_KIND_COLORS: Record<PortKind, string> = {
  widmo: "#5b9bd5",
  // NIE żółty accent appki (#ffc951) — kropki portów/krawędzie "mapa" zlewały
  // się wizualnie z żółtymi obwódkami/podświetleniami reszty UI (ten sam
  // powód co magenta marker w Widma.svelte COLORS[0]).
  mapa: "#f2994a",
  segmentacja: "#b48ce0",
  segment: "#7bc47f",
};

export const PORT_KIND_LABELS: Record<PortKind, string> = {
  widmo: "Widmo",
  mapa: "Mapa",
  segmentacja: "Segmentacja",
  segment: "Segment",
};

export type NodeStage = "dane" | "przetwarzanie" | "wynik";
export type NodeDomain = "widmo" | "mapa" | "segmentacja";

export const DOMAIN_ORDER: NodeDomain[] = ["widmo", "mapa", "segmentacja"];
export const DOMAIN_LABELS: Record<NodeDomain, string> = {
  widmo: "Widmo",
  mapa: "Mapa pikseli",
  segmentacja: "Segmentacja",
};
export const STAGE_ORDER: NodeStage[] = ["dane", "przetwarzanie", "wynik"];
export const STAGE_LABELS: Record<NodeStage, string> = {
  dane: "Dane",
  przetwarzanie: "Przetwarzanie",
  wynik: "Wynik",
};

export interface PortSocketDef {
  /** Stabilne id gniazda w obrębie typu węzła — referencjonowane przez
   * GraphEdge.fromSocket/toSocket. Nie zmieniać po tym, jak jakikolwiek
   * zapisany graf mógł zacząć go używać. */
  id: string;
  label: string;
  kind: PortKind;
  /** Gniazdo wejściowe przyjmuje wiele przychodzących połączeń naraz (np.
   * "Łączenie" — kilka map jako źródła, albo "K-means" — kilka map jako
   * kanały cech). Bez znaczenia dla gniazd wyjściowych. */
  multi?: boolean;
}

export interface NodeParamDef {
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  default: number | string;
  /** Present for select-style (string enum) params instead of a numeric slider. */
  options?: string[];
}

export interface NodeTypeDef {
  /** Namespaced po domenie, np. "mapa/map_source", "widmo/bin_size" — unika
   * kolizji id między trzema rejestrami scalanymi w jeden NODE_TYPES. */
  id: string;
  label: string;
  /** Krótki podtytuł pod nazwą (np. nazwa algorytmu) — opcjonalny. */
  detail?: string;
  description: string;
  domain: NodeDomain;
  stage: NodeStage;
  inputs: PortSocketDef[];
  outputs: PortSocketDef[];
  params: NodeParamDef[];
  /** Ewaluacja jest dziś zawsze synchroniczna — ciężkie operacje (k-means)
   * idą przez ręczny przycisk "Przetwórz", a wynik cache'uje się na węźle
   * (patrz GraphNode.kmeansResult) — evaluate tylko czyta ten cache.
   * Sygnatura i tak dopuszcza Promise, żeby nie trzeba było przepisywać
   * silnika drugi raz, gdyby przyszła domena (np. Widmo) tego wymagała. */
  evaluate: (
    node: GraphNode,
    inputs: Record<string, NodeValue[]>,
    ctx: EvalContext,
  ) => EvalOutcome | Promise<EvalOutcome>;
}

export interface CurvePoint {
  x: number; // 0–100
  y: number; // 0–100
}
export const DEFAULT_CURVE_POINTS: CurvePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 100 }];

export interface KmeansResult {
  k: number;
  width: number;
  height: number;
  tissueId: string;
  tissueLabel: string;
  labels: number[][];
  legend: { label: number; count: number }[];
  sources: MapSource[];
  mask?: number[][];
}

export type MapSource = SavedPixelMapSource;

/** Wynik ostatniego ręcznego przeliczenia dla węzłów widma, które wymagają
 * wywołania backendu (widmo/smooth, widmo/baseline, widmo/peakpick,
 * widmo/from_segment) — ten sam duch co KmeansResult: ciężka/sieciowa
 * operacja NIE liczy się automatycznie przy każdym renderze, tylko ręcznym
 * przyciskiem "Przetwórz", wynik cache'uje się na węźle, evaluate() czyta
 * cache i zwraca błąd, jeśli jest pusty albo `inputSignature` nie zgadza się
 * z aktualnym wejściem (wejście zmieniło się od ostatniego przetworzenia). */
export interface WidmoProcessCache {
  inputSignature: string;
  mz: number[];
  intensity: number[];
}

export interface GraphNode {
  id: string;
  type: string;
  x: number;
  y: number;
  params: Record<string, number | string>;
  // ── Pola specyficzne dla poszczególnych typów węzłów (jeden płaski kształt,
  // sprawdzony wzorzec z MzGraphNode/SegGraphNode — bez discriminated union) ──
  /** "mapa/map_source" / "segmentacja/segment_source": id wybranej zapisanej
   * mapy/segmentu. */
  savedMapId?: string;
  /** Czy sekcja ze szczegółami jest rozwinięta (map_source/segment_source). */
  expanded?: boolean;
  /** "curve": punkty kontrolne krzywej intensywności. */
  curvePoints?: CurvePoint[];
  /** "segmentacja/kmeans": wynik ostatniego ręcznego przetworzenia. */
  kmeansResult?: KmeansResult;
  /** "segmentacja/select_segments": zaznaczone etykiety klas. */
  selectedLabels?: number[];
  /** "mapa/save_output" / "segmentacja/save_segment" / "widmo/save_spectrum":
   * nazwa, pod jaką zapisany zostanie nowy wynik. */
  saveName?: string;
  /** "widmo/spectrum_source": id wybranego zapisanego widma z biblioteki
   * "Zapisane widma" (osobna od "Zapisane" mapy pikseli — inny rodzaj danych,
   * patrz WidmoValue). */
  savedSpectrumId?: string;
  /** "widmo/compare": czy w podglądzie pokazywać też trzecią linię — różnicę
   * (a − b) obu podłączonych widm, oprócz ich nałożenia. */
  showDiff?: boolean;
  /** "segmentacja/remove_islands": gdy true, usuwa małe skupiska DRUGIEGO
   * koloru (tła/poza segmentem) zamiast segmentu — efektywnie wypełnia małe
   * "dziury" wewnątrz segmentu zamiast usuwać małe wysepki segmentu. Osobna,
   * dodatkowa opcja od node'a "Odwrócenie segmentu" (invert_segment), który
   * zostaje bez zmian jako pełne odwrócenie maski. */
  invertIslandTarget?: boolean;
  /** "widmo/smooth" / "widmo/baseline" / "widmo/peakpick" / "widmo/from_segment":
   * wynik ostatniego ręcznego przetworzenia (patrz WidmoProcessCache). */
  widmoProcessCache?: WidmoProcessCache;
}

export interface GraphEdge {
  id: string;
  from: string; fromSocket: string;
  to: string; toSocket: string;
}

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

/** Wolna notatka tekstowa na płótnie Node Graph — NIE jest typem węzła w
 * NODE_TYPES (żadnych portów/evaluate, nie płynie przez nią żadna wartość),
 * to czysto wizualna adnotacja, podzbiór BoardTextObject z board.svelte.ts
 * (bez rotate/opacity/zIndex — proste nakładki, nie pełnoprawne obiekty
 * tablicy). Dodane dopiero po naprawie wydajności grafu (patrz evalMemo w
 * NodeGraphTab.svelte), żeby nie dokładać kolejnego elementu do już wolnego
 * płótna. */
export interface GraphTextNote {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  fontSize: number;
  bold: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport: GraphViewport;
  notes: GraphTextNote[];
}

export function defaultGraph(): Graph {
  return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, notes: [] };
}

let _idCounter = 0;
export function makeId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}

// ── Wartości płynące przez graf ──────────────────────────────────────────

export interface MapaValue {
  kind: "mapa";
  tissueId: string;
  tissueLabel: string;
  width: number;
  height: number;
  data: number[][];
  mask?: number[][];
  mode: string;
  sources: MapSource[];
}

export interface SegmentacjaValue {
  kind: "segmentacja";
  tissueId: string;
  tissueLabel: string;
  width: number;
  height: number;
  k: number;
  labels: number[][];
  legend: { label: number; count: number }[];
  mask?: number[][];
  sources: MapSource[];
}

/** Pojedynczy wyekstrahowany segment — zawsze binarna maska (0/1), NIGDY
 * ciągła intensywność (stąd osobny `kind` od `MapaValue`, patrz komentarz
 * przy `PortKind`). Konwencja wizualna (patrz `SegmentMaskCanvas.svelte`,
 * jedyne miejsce, które to rysuje) jest STAŁA i obowiązuje we wszystkich
 * węzłach segmentowych: `data[y][x] === 1` → CZARNY (segment/zaznaczone),
 * `data[y][x] === 0` → BIAŁY (poza segmentem, ale wciąż w obrębie tkanki),
 * `mask[y][x] === 0` → w pełni przezroczyste (piksel poza faktycznym
 * skanem tkanki — nie brany pod uwagę w ŻADNEJ operacji: k-means,
 * łączenie, usuwanie wysepek itd. traktują go jak nieistniejący, nie jak
 * "tło" o wartości 0). */
export interface SegmentValue {
  kind: "segment";
  tissueId: string;
  tissueLabel: string;
  width: number;
  height: number;
  data: number[][];
  mask?: number[][];
  sources: MapSource[];
}

/** Widmo płynące przez graf — wektor intensywności na wspólnej osi `mz`.
 * `sources` śledzi pochodzenie (piksel/e, tryb agregacji segmentu…) tak samo
 * jak `MapSource` dla map, tylko w kształcie właściwym dla widm (patrz
 * SavedSpectrumSource w spectraLibrary.svelte.ts — ten sam typ, żeby zapis do
 * biblioteki (`widmo/save_spectrum`) nie musiał niczego konwertować). */
export interface WidmoValue {
  kind: "widmo";
  tissueId: string;
  tissueLabel: string;
  label: string;
  mz: number[];
  intensity: number[];
  mode: SavedSpectrum["mode"];
  sources: SavedSpectrumSource[];
}

export type NodeValue = MapaValue | SegmentacjaValue | SegmentValue | WidmoValue;

export interface EvalContext {
  mapCache: Record<string, SavedPixelMap>;
  savedMapExists: (id: string) => boolean;
  /** Analogiczne do mapCache/savedMapExists, ale dla biblioteki "Zapisane
   * widma" (widmo/spectrum_source) — osobny cache, bo inny rodzaj danych. */
  spectrumCache: Record<string, SavedSpectrum>;
  savedSpectrumExists: (id: string) => boolean;
}

export type EvalOutcome =
  | { ok: true; value: NodeValue }
  | { ok: false; error: string };

// ── Rejestr scalony z plików domenowych (patrz nodegraph.mapa.ts /
// .segmentacja.ts) — wypełniany przez registerNodeTypes, nie ręcznie. ──────
export const NODE_TYPES: Record<string, NodeTypeDef> = {};

export function registerNodeTypes(defs: NodeTypeDef[]): void {
  for (const d of defs) NODE_TYPES[d.id] = d;
}

export function nodeTypeList(): NodeTypeDef[] {
  return Object.values(NODE_TYPES);
}

export function defaultParamsFor(typeId: string): Record<string, number | string> {
  const def = NODE_TYPES[typeId];
  if (!def) return {};
  const out: Record<string, number | string> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

// ── Ewaluacja grafu (generyczna, per-gniazdo) ───────────────────────────

export function evaluateGraphNode(
  graph: Graph,
  nodeId: string,
  ctx: EvalContext,
  memo: Map<string, EvalOutcome> = new Map(),
  visiting: Set<string> = new Set(),
): EvalOutcome {
  const cached = memo.get(nodeId);
  if (cached) return cached;

  if (visiting.has(nodeId)) {
    const err: EvalOutcome = { ok: false, error: "wykryto cykl w grafie" };
    return err;
  }

  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, error: "brak węzła" };
  const def = NODE_TYPES[node.type];
  if (!def) return { ok: false, error: "nieznany typ węzła" };

  visiting.add(nodeId);
  const result = evaluateInner(graph, node, def, ctx, memo, visiting);
  visiting.delete(nodeId);
  // evaluate() jest dziś zawsze sync (patrz komentarz przy NodeTypeDef), więc
  // tu zawsze dostajemy EvalOutcome, nigdy Promise — rzutowanie jest bezpieczne.
  const outcome = result as EvalOutcome;
  memo.set(nodeId, outcome);
  return outcome;
}

function evaluateInner(
  graph: Graph,
  node: GraphNode,
  def: NodeTypeDef,
  ctx: EvalContext,
  memo: Map<string, EvalOutcome>,
  visiting: Set<string>,
): EvalOutcome | Promise<EvalOutcome> {
  const inputs: Record<string, NodeValue[]> = {};
  for (const socket of def.inputs) {
    const edges = graph.edges.filter((e) => e.to === node.id && e.toSocket === socket.id);
    const values: NodeValue[] = [];
    for (const e of edges) {
      const r = evaluateGraphNode(graph, e.from, ctx, memo, visiting);
      if (!r.ok) return r;
      if (r.value.kind !== socket.kind) {
        return { ok: false, error: `gniazdo "${socket.label}" oczekuje ${PORT_KIND_LABELS[socket.kind]}, podłączono ${PORT_KIND_LABELS[r.value.kind]}` };
      }
      values.push(r.value);
    }
    inputs[socket.id] = values;
  }
  return def.evaluate(node, inputs, ctx);
}

/** Sprawdza, czy dodanie połączenia from→to (na poziomie węzłów, gniazdo bez
 * znaczenia dla wykrywania cykli) utworzyłoby cykl — wywoływane PRZED
 * faktycznym dodaniem połączenia. */
export function wouldCreateCycle(graph: Graph, fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  const outgoing = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from)!.push(e.to);
  }
  const stack = [toId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === fromId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of outgoing.get(cur) ?? []) stack.push(next);
  }
  return false;
}

export function dedupeSources(all: MapSource[]): MapSource[] {
  const seen = new Set<string>();
  const out: MapSource[] = [];
  for (const s of all) {
    const key = `${s.mz}|${s.tol}|${s.datasetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
