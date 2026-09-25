// Node graph data model + node-type registry for the "preWidma" preprocessing
// graph editor (Blender-node-style). Single source of truth used both for the
// right-click palette and for rendering node params.

export interface PreNodeParamDef {
  key: string;
  label: string;
  /** Numeric slider params (default). Omit min/max/step/default when `options` is set. */
  min?: number;
  max?: number;
  step?: number;
  default: number | string;
  /** Present for select-style (string enum) params instead of a numeric slider. */
  options?: string[];
}

export type PreNodeCategory = "dane" | "preprocessing" | "wynik";

export const CATEGORY_ORDER: PreNodeCategory[] = ["dane", "preprocessing", "wynik"];
export const CATEGORY_LABELS: Record<PreNodeCategory, string> = {
  dane: "Dane",
  preprocessing: "Preprocessing",
  wynik: "Wynik",
};

export interface PreNodeTypeDef {
  id: string;
  label: string;
  /** Short subtitle shown below the header, separated by a divider (e.g. the underlying algorithm name). */
  detail?: string;
  description: string;
  category: PreNodeCategory;
  hasInput: boolean;
  hasOutput: boolean;
  params: PreNodeParamDef[];
}

export interface PreNode {
  id: string;
  type: string;
  x: number;
  y: number;
  params: Record<string, number | string>;
  /** Tylko dla source_binned: id wybranego zestawu danych (puste = aktywny zestaw workspace'u). */
  datasetId?: string;
  /** Tylko dla kategorii "preprocessing": czy węzeł jest aktywny (domyślnie true).
   * Wygaszony (false) węzeł jest pomijany w łańcuchu — dane przechodzą przez niego bez zmian. */
  enabled?: boolean;
}

export interface PreEdge {
  id: string;
  from: string; // source node id (output port)
  to: string;   // target node id (input port)
}

export interface PreViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface PreGraph {
  nodes: PreNode[];
  edges: PreEdge[];
  viewport: PreViewport;
}

export const NODE_TYPES: Record<string, PreNodeTypeDef> = {
  source_raw: {
    id: "source_raw",
    label: "Dane oryginalne",
    description: "Surowe widmo z pliku imzML, bez przetwarzania.",
    category: "dane",
    hasInput: false,
    hasOutput: true,
    params: [],
  },
  source_binned: {
    id: "source_binned",
    label: "Dane przetworzone",
    // Actual bin size is filled in dynamically by the editor (per-workspace value).
    detail: "bin size",
    description: "Widmo zbinnowane wg aktualnego bin size z zakładki Dane.",
    category: "dane",
    hasInput: false,
    hasOutput: true,
    params: [],
  },
  mz_range: {
    id: "mz_range",
    label: "Zakres m/z",
    description: "Ogranicza zakres m/z pobierany z surowego imzML przed binningiem.",
    category: "dane",
    hasInput: true,
    hasOutput: true,
    params: [
      { key: "mz_min", label: "mz min", min: 50, max: 3000, step: 1, default: 300 },
      { key: "mz_max", label: "mz max", min: 50, max: 3000, step: 1, default: 1500 },
    ],
  },
  bin_size: {
    id: "bin_size",
    label: "Bin size",
    description: "Binning widma do zadanej szerokości bina, wybraną metodą agregacji.",
    category: "dane",
    hasInput: true,
    hasOutput: true,
    params: [
      { key: "bin_size", label: "bin size [Da]", min: 0.01, max: 5, step: 0.01, default: 0.3 },
      { key: "bin_agg", label: "agregacja", default: "sum", options: ["sum", "mean", "peak_apex"] },
    ],
  },
  smooth: {
    id: "smooth",
    label: "Wygładzanie",
    detail: "Savitzky-Golay",
    description: "Wygładza widmo filtrem Savitzky-Golay redukując szum.",
    category: "preprocessing",
    hasInput: true,
    hasOutput: true,
    params: [
      { key: "window", label: "okno [pkt]", min: 5, max: 51, step: 2, default: 15 },
    ],
  },
  baseline: {
    id: "baseline",
    label: "Korekcja linii bazowej",
    detail: "SNIP",
    description: "Usuwa tło (linię bazową) metodą SNIP.",
    category: "preprocessing",
    hasInput: true,
    hasOutput: true,
    params: [
      { key: "iterations", label: "iteracje", min: 5, max: 100, step: 5, default: 40 },
    ],
  },
  normalize: {
    id: "normalize",
    label: "Normalizacja",
    detail: "TIC",
    description: "Normalizuje widmo do sumy całkowitego prądu jonowego (TIC).",
    category: "preprocessing",
    hasInput: true,
    hasOutput: true,
    params: [],
  },
  peakpick: {
    id: "peakpick",
    label: "Wykrywanie pików",
    description: "Zeruje wszystko poza wykrytymi pikami (na podstawie prominence).",
    category: "preprocessing",
    hasInput: true,
    hasOutput: true,
    params: [
      { key: "prominence_frac", label: "próg (ułamek max)", min: 0.001, max: 0.2, step: 0.001, default: 0.02 },
    ],
  },
  output: {
    id: "output",
    label: "Wynik",
    description: "Węzeł wynikowy — realizuje cały łańcuch przetwarzania podłączonych węzłów, od źródła danych aż do tego węzła, i zwraca finalne widmo.",
    category: "wynik",
    hasInput: true,
    hasOutput: false,
    params: [],
  },
};

export const NODE_TYPE_LIST: PreNodeTypeDef[] = Object.values(NODE_TYPES);

let _idCounter = 0;
export function makeId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}

export function defaultParams(typeId: string): Record<string, number | string> {
  const def = NODE_TYPES[typeId];
  if (!def) return {};
  const out: Record<string, number | string> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

export function defaultGraph(): PreGraph {
  const raw: PreNode = { id: makeId("node"), type: "source_raw", x: -300, y: -80, params: {} };
  const binned: PreNode = { id: makeId("node"), type: "source_binned", x: -300, y: 80, params: {} };
  const out: PreNode = { id: makeId("node"), type: "output", x: 220, y: 0, params: {} };
  return {
    nodes: [raw, binned, out],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/** Domyślny graf dla nowo tworzonego zestawu danych: surowy imzML → zakres m/z
 * → bin size → wynik. Używany przez zakładkę "Zestaw danych". */
export function defaultDatasetGraph(): PreGraph {
  const raw: PreNode = { id: makeId("node"), type: "source_raw", x: -420, y: 0, params: {} };
  const range: PreNode = { id: makeId("node"), type: "mz_range", x: -220, y: 0, params: defaultParams("mz_range") };
  const bin: PreNode = { id: makeId("node"), type: "bin_size", x: -20, y: 0, params: defaultParams("bin_size") };
  const out: PreNode = { id: makeId("node"), type: "output", x: 180, y: 0, params: {} };
  return {
    nodes: [raw, range, bin, out],
    edges: [
      { id: makeId("edge"), from: raw.id, to: range.id },
      { id: makeId("edge"), from: range.id, to: bin.id },
      { id: makeId("edge"), from: bin.id, to: out.id },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/** Stały, tylko-do-odczytu graf dla zestawu "original" (chroniony — traktowany
 * jako sam surowy imzML, bez żadnych kroków pomiędzy). */
export function originalDatasetGraph(): PreGraph {
  const raw: PreNode = { id: makeId("node"), type: "source_raw", x: -260, y: 0, params: {} };
  const out: PreNode = { id: makeId("node"), type: "output", x: 60, y: 0, params: {} };
  return {
    nodes: [raw, out],
    edges: [{ id: makeId("edge"), from: raw.id, to: out.id }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/** Odtwarza graf node'ów z rzeczywistego, zapisanego łańcucha zestawu danych
 * (`source_dataset_id` + `steps`) — używane gdy zestaw nie ma jeszcze
 * zapisanego grafu (edycji wizualnej), np. bo powstał przez starszą ścieżkę
 * (legacy `params`/`steps`) albo `/process`. Węzły są rozłożone liniowo w
 * kolejności łańcucha, z parametrami dokładnie takimi, jak zapisane w
 * `steps[i].params` — więc to, co widać, zawsze zgadza się z tym, co dataset
 * faktycznie zapamiętał o swojej budowie. */
export function graphFromSteps(
  sourceDatasetId: string,
  steps: { method: string; params: Record<string, number | string> }[],
): PreGraph {
  const STEP_X = 220;
  const sourceType = sourceDatasetId === "__raw__" ? "source_raw" : "source_binned";
  const source: PreNode = {
    id: makeId("node"), type: sourceType, x: 0, y: 0, params: {},
    ...(sourceType === "source_binned" ? { datasetId: sourceDatasetId } : {}),
  };
  const nodes: PreNode[] = [source];
  const edges: PreEdge[] = [];
  let prev = source;
  let x = STEP_X;
  for (const step of steps) {
    const node: PreNode = { id: makeId("node"), type: step.method, x, y: 0, params: { ...step.params } };
    nodes.push(node);
    edges.push({ id: makeId("edge"), from: prev.id, to: node.id });
    prev = node;
    x += STEP_X;
  }
  const out: PreNode = { id: makeId("node"), type: "output", x, y: 0, params: {} };
  nodes.push(out);
  edges.push({ id: makeId("edge"), from: prev.id, to: out.id });
  return { nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

// Walks the graph backward from `nodeId` to a source node, returning the
// ordered list of processing steps to apply (source excluded) plus the
// source type encountered ("raw" | "binned"), or null if no source is
// reachable (dangling chain).
export function buildChain(
  graph: PreGraph,
  nodeId: string,
): { source: "raw" | "binned"; datasetId?: string; steps: { method: string; params: Record<string, number | string> }[] } | null {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const incomingByTarget = new Map<string, PreEdge>();
  for (const e of graph.edges) incomingByTarget.set(e.to, e);

  const chain: { method: string; params: Record<string, number | string> }[] = [];
  let cur = nodesById.get(nodeId);
  const visited = new Set<string>();
  while (cur) {
    if (visited.has(cur.id)) return null; // cycle guard
    visited.add(cur.id);
    if (cur.type === "source_raw") return { source: "raw", steps: chain.reverse() };
    if (cur.type === "source_binned") return { source: "binned", datasetId: cur.datasetId, steps: chain.reverse() };
    // Only real processing methods (both ports present) become chain steps —
    // an "output" node (input-only, no ports beyond it) is just the walk's
    // starting point and must not itself be sent as a method.
    const curDef = NODE_TYPES[cur.type];
    // Wygaszony node (enabled === false) jest pomijany — dane przechodzą przez
    // niego bez zmian, jakby był bezpośrednio podłączony w tym miejscu grafu.
    if (curDef?.hasInput && curDef?.hasOutput && cur.enabled !== false) {
      chain.push({ method: cur.type, params: cur.params });
    }
    const inEdge = incomingByTarget.get(cur.id);
    if (!inEdge) return null;
    cur = nodesById.get(inEdge.from);
  }
  return null;
}
