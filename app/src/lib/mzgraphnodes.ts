// Node graph data model + node-type registry + evaluator for the "Mapa Node
// Graph" subtab (m/z → Mapa Node Graph). Drugi, niezależny preprocessing —
// tym razem nie na widmach (patrz prenodes.ts / PreNodesEditor.svelte), ale
// na już zapisanych mapach pikseli m/z (podzakładka "Zapisane"). Ten sam
// wzorzec Blender-node-style co prenodes.ts: rejestr typów węzłów + czysta
// logika ewaluacji grafu, oddzielona od renderowania (MzGraphSubtab.svelte).

import type { CombineMode } from "./tissueMerge";
import { windowValue } from "./tissueMerge";
import type { SavedPixelMap, SavedPixelMapSource } from "./savedPixelMaps.svelte";

export interface MzNodeParamDef {
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  default: number | string;
  /** Present for select-style (string enum) params instead of a numeric slider. */
  options?: string[];
}

export type MzNodeCategory = "dane" | "przetwarzanie" | "wynik";

export const MZ_CATEGORY_ORDER: MzNodeCategory[] = ["dane", "przetwarzanie", "wynik"];
export const MZ_CATEGORY_LABELS: Record<MzNodeCategory, string> = {
  dane: "Dane",
  przetwarzanie: "Przetwarzanie",
  wynik: "Wynik",
};

export interface MzNodeTypeDef {
  id: string;
  label: string;
  description: string;
  category: MzNodeCategory;
  hasInput: boolean;
  hasOutput: boolean;
  /** Wejście przyjmuje WIELE przychodzących połączeń naraz (np. "Łączenie") —
   * zamiast domyślnego zastępowania jednego połączenia nowym. */
  multiInput?: boolean;
  params: MzNodeParamDef[];
}

export interface MzGraphNode {
  id: string;
  type: string;
  x: number;
  y: number;
  params: Record<string, number | string>;
  /** Tylko dla "map_source": id wybranej zapisanej mapy (z podzakładki Zapisane). */
  savedMapId?: string;
  /** Tylko dla "map_source": czy sekcja ze szczegółami (nazwa/mode/źródła) jest rozwinięta. */
  expanded?: boolean;
  /** Tylko dla "save_output": nazwa, pod jaką zapisana zostanie nowa mapa. */
  saveName?: string;
  /** Tylko dla "curve": punkty kontrolne krzywej (x/y w procentach 0–100),
   * posortowane po x. Pierwszy punkt ma x=0, ostatni x=100. */
  curvePoints?: MzCurvePoint[];
}

export interface MzCurvePoint {
  x: number; // 0–100
  y: number; // 0–100
}

export const DEFAULT_CURVE_POINTS: MzCurvePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 100 }];

export interface MzGraphEdge {
  id: string;
  from: string; // source node id (output port)
  to: string;   // target node id (input port)
}

export interface MzGraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface MzGraph {
  nodes: MzGraphNode[];
  edges: MzGraphEdge[];
  viewport: MzGraphViewport;
}

export const MZ_NODE_TYPES: Record<string, MzNodeTypeDef> = {
  map_source: {
    id: "map_source",
    label: "Mapa m/z",
    description: "Zapisana mapa pikseli m/z z podzakładki \"Zapisane\".",
    category: "dane",
    hasInput: false,
    hasOutput: true,
    params: [],
  },
  intensity_range: {
    id: "intensity_range",
    label: "Zakres intensywności",
    description: "Przycina/rozciąga intensywność mapy do zadanego okna 0–100%.",
    category: "przetwarzanie",
    hasInput: true,
    hasOutput: true,
    params: [],
  },
  curve: {
    id: "curve",
    label: "Krzywa intensywności",
    description: "Nieliniowe przekształcenie intensywności krzywą (jak Poziomy/Krzywe w GIMP) — z histogramem, pomaga np. przygasić piksele bliskie 100%.",
    category: "przetwarzanie",
    hasInput: true,
    hasOutput: true,
    params: [],
  },
  combine: {
    id: "combine",
    label: "Łączenie",
    description: "Łączy wiele map pikseli (tej samej tkanki) w jedną, wybraną metodą.",
    category: "przetwarzanie",
    hasInput: true,
    hasOutput: true,
    multiInput: true,
    params: [],
  },
  save_output: {
    id: "save_output",
    label: "Zapis",
    description: "Zapisuje mapę wynikową jako nową mapę pikseli w podzakładce \"Zapisane\".",
    category: "wynik",
    hasInput: true,
    hasOutput: false,
    params: [],
  },
};

export const MZ_NODE_TYPE_LIST: MzNodeTypeDef[] = Object.values(MZ_NODE_TYPES);

export const COMBINE_MODE_LABELS: Record<CombineMode, string> = {
  mean: "średnia",
  sum: "suma",
  max: "maksimum",
  multiply: "iloczyn",
};

export const COMBINE_MODE_LIST: CombineMode[] = ["mean", "sum", "max", "multiply"];

let _idCounter = 0;
export function makeMzId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}

export function mzDefaultParams(typeId: string): Record<string, number | string> {
  const def = MZ_NODE_TYPES[typeId];
  if (!def) return {};
  const out: Record<string, number | string> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

export function defaultMzGraph(): MzGraph {
  return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

// ── Ewaluacja grafu ──────────────────────────────────────────────────────
// Czysta funkcja: dla danego node'a rekurencyjnie liczy wynikową mapę
// pikseli, schodząc po grafie do liści "map_source". Dane samych zapisanych
// map (2D array) muszą być już wczytane do `mapCache` (pobrane przez
// fetchSavedMapData) — ewaluator nie robi żadnych zapytań sieciowych.

export interface MzEvalResult {
  tissueId: string;
  tissueLabel: string;
  width: number;
  height: number;
  data: number[][];
  mode: CombineMode | "single";
  sources: SavedPixelMapSource[];
}

export type MzEvalOutcome =
  | { ok: true; value: MzEvalResult }
  | { ok: false; error: string };

function combineArrays(arrays: number[][][], mode: CombineMode): number[][] {
  const h = arrays[0].length;
  const w = arrays[0][0]?.length ?? 0;
  const out: number[][] = Array.from({ length: h }, () => new Array(w).fill(0));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const vals = arrays.map((a) => a[y][x]);
      let v: number;
      if (mode === "sum") v = vals.reduce((a, b) => a + b, 0);
      else if (mode === "max") v = Math.max(...vals);
      else if (mode === "multiply") v = vals.reduce((a, b) => a * b, 1);
      else v = vals.reduce((a, b) => a + b, 0) / vals.length; // mean
      out[y][x] = v;
    }
  }
  return out;
}

// Kawałkowo-liniowa interpolacja krzywej (jak "Curves"/"Levels" w GIMP): v w
// skali 0–1 (konwencja aplikacji: 1.0 = 100%), punkty w procentach 0–100.
// Poza zakresem punktów wartość jest przycinana do skrajnego punktu (płasko).
export function applyCurve(v: number, points: MzCurvePoint[]): number {
  if (points.length < 2) return v;
  const xv = v * 100;
  const first = points[0];
  const last = points[points.length - 1];
  if (xv <= first.x) return first.y / 100;
  if (xv >= last.x) return last.y / 100;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (xv >= a.x && xv <= b.x) {
      const t = b.x === a.x ? 0 : (xv - a.x) / (b.x - a.x);
      return (a.y + t * (b.y - a.y)) / 100;
    }
  }
  return v;
}

/** Histogram wartości mapy (do podglądu w edytorze krzywej) — `bins` koszyków
 * równomiernie rozłożonych na 0–100%, wartości poza zakresem [0,100] lądują
 * w skrajnym koszyku (np. suma/iloczyn może dać >100%). */
export function computeHistogram(data: number[][], bins = 40): number[] {
  const counts = new Array(bins).fill(0);
  for (const row of data) {
    for (const v of row) {
      const pct = v * 100;
      let idx = Math.floor((pct / 100) * bins);
      if (idx < 0) idx = 0;
      if (idx >= bins) idx = bins - 1;
      counts[idx]++;
    }
  }
  return counts;
}

function dedupeSources(all: SavedPixelMapSource[]): SavedPixelMapSource[] {
  const seen = new Set<string>();
  const out: SavedPixelMapSource[] = [];
  for (const s of all) {
    const key = `${s.mz}|${s.tol}|${s.datasetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function evaluateMzNode(
  graph: MzGraph,
  nodeId: string,
  mapCache: Record<string, SavedPixelMap>,
  savedMapExists: (id: string) => boolean,
  memo: Map<string, MzEvalOutcome> = new Map(),
  visiting: Set<string> = new Set(),
): MzEvalOutcome {
  const cached = memo.get(nodeId);
  if (cached) return cached;

  if (visiting.has(nodeId)) {
    const err: MzEvalOutcome = { ok: false, error: "wykryto cykl w grafie" };
    return err;
  }

  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, error: "brak węzła" };
  const def = MZ_NODE_TYPES[node.type];
  if (!def) return { ok: false, error: "nieznany typ węzła" };

  visiting.add(nodeId);
  const result = evaluateInner(graph, node, mapCache, savedMapExists, memo, visiting);
  visiting.delete(nodeId);
  memo.set(nodeId, result);
  return result;
}

function evaluateInner(
  graph: MzGraph,
  node: MzGraphNode,
  mapCache: Record<string, SavedPixelMap>,
  savedMapExists: (id: string) => boolean,
  memo: Map<string, MzEvalOutcome>,
  visiting: Set<string>,
): MzEvalOutcome {
  if (node.type === "map_source") {
    const id = node.savedMapId;
    if (!id) return { ok: false, error: "wybierz zapisaną mapę" };
    if (!savedMapExists(id)) return { ok: false, error: "wybrana mapa została usunięta" };
    const full = mapCache[id];
    if (!full) return { ok: false, error: "wczytywanie…" };
    return {
      ok: true,
      value: {
        tissueId: full.tissueId,
        tissueLabel: full.tissueLabel,
        width: full.width,
        height: full.height,
        data: full.data,
        mode: full.mode === "single" ? "single" : full.mode,
        sources: full.sources,
      },
    };
  }

  if (node.type === "intensity_range") {
    const inEdge = graph.edges.find((e) => e.to === node.id);
    if (!inEdge) return { ok: false, error: "podłącz wejście" };
    const src = evaluateMzNode(graph, inEdge.from, mapCache, savedMapExists, memo, visiting);
    if (!src.ok) return src;
    const minPct = Number(node.params.min ?? 0);
    const maxPct = Number(node.params.max ?? 100);
    const data = src.value.data.map((row) => row.map((v) => windowValue(v, minPct / 100, maxPct / 100, false)));
    return { ok: true, value: { ...src.value, data } };
  }

  if (node.type === "curve") {
    const inEdge = graph.edges.find((e) => e.to === node.id);
    if (!inEdge) return { ok: false, error: "podłącz wejście" };
    const src = evaluateMzNode(graph, inEdge.from, mapCache, savedMapExists, memo, visiting);
    if (!src.ok) return src;
    const points = node.curvePoints && node.curvePoints.length >= 2 ? node.curvePoints : DEFAULT_CURVE_POINTS;
    const sorted = [...points].sort((a, b) => a.x - b.x);
    const data = src.value.data.map((row) => row.map((v) => applyCurve(v, sorted)));
    return { ok: true, value: { ...src.value, data } };
  }

  if (node.type === "combine") {
    const inEdges = graph.edges.filter((e) => e.to === node.id);
    if (inEdges.length === 0) return { ok: false, error: "podłącz przynajmniej jedną mapę" };
    const results: MzEvalResult[] = [];
    for (const e of inEdges) {
      const r = evaluateMzNode(graph, e.from, mapCache, savedMapExists, memo, visiting);
      if (!r.ok) return r;
      results.push(r.value);
    }
    const { width, height } = results[0];
    if (results.some((r) => r.width !== width || r.height !== height)) {
      return { ok: false, error: "podłączone mapy mają różne wymiary — nie można połączyć" };
    }
    const tissueId = results[0].tissueId;
    if (results.some((r) => r.tissueId !== tissueId)) {
      return { ok: false, error: "podłączone mapy pochodzą z różnych tkanek" };
    }
    const mode = (node.params.mode as CombineMode) ?? "mean";
    const data = results.length === 1 ? results[0].data : combineArrays(results.map((r) => r.data), mode);
    return {
      ok: true,
      value: {
        tissueId,
        tissueLabel: results[0].tissueLabel,
        width,
        height,
        data,
        mode: results.length === 1 ? results[0].mode : mode,
        sources: dedupeSources(results.flatMap((r) => r.sources)),
      },
    };
  }

  if (node.type === "save_output") {
    const inEdge = graph.edges.find((e) => e.to === node.id);
    if (!inEdge) return { ok: false, error: "podłącz wejście" };
    return evaluateMzNode(graph, inEdge.from, mapCache, savedMapExists, memo, visiting);
  }

  return { ok: false, error: "nieznany typ węzła" };
}

// Sprawdza, czy dodanie połączenia from→to utworzyłoby cykl (zanim je
// faktycznie dodamy) — używane przez edytor przy rozwiązywaniu connection
// dragu, żeby nie dało się w ogóle stworzyć nieprawidłowego grafu.
export function wouldCreateCycle(graph: MzGraph, fromId: string, toId: string): boolean {
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
