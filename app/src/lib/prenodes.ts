// Node graph data model + node-type registry for the "preWidma" preprocessing
// graph editor (Blender-node-style). Single source of truth used both for the
// right-click palette and for rendering node params.

export interface PreNodeParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
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
  params: Record<string, number>;
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

export function defaultParams(typeId: string): Record<string, number> {
  const def = NODE_TYPES[typeId];
  if (!def) return {};
  const out: Record<string, number> = {};
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

// Walks the graph backward from `nodeId` to a source node, returning the
// ordered list of processing steps to apply (source excluded) plus the
// source type encountered ("raw" | "binned"), or null if no source is
// reachable (dangling chain).
export function buildChain(
  graph: PreGraph,
  nodeId: string,
): { source: "raw" | "binned"; steps: { method: string; params: Record<string, number> }[] } | null {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const incomingByTarget = new Map<string, PreEdge>();
  for (const e of graph.edges) incomingByTarget.set(e.to, e);

  const chain: { method: string; params: Record<string, number> }[] = [];
  let cur = nodesById.get(nodeId);
  const visited = new Set<string>();
  while (cur) {
    if (visited.has(cur.id)) return null; // cycle guard
    visited.add(cur.id);
    if (cur.type === "source_raw") return { source: "raw", steps: chain.reverse() };
    if (cur.type === "source_binned") return { source: "binned", steps: chain.reverse() };
    // Only real processing methods (both ports present) become chain steps —
    // an "output" node (input-only, no ports beyond it) is just the walk's
    // starting point and must not itself be sent as a method.
    const curDef = NODE_TYPES[cur.type];
    if (curDef?.hasInput && curDef?.hasOutput) {
      chain.push({ method: cur.type, params: cur.params });
    }
    const inEdge = incomingByTarget.get(cur.id);
    if (!inEdge) return null;
    cur = nodesById.get(inEdge.from);
  }
  return null;
}
