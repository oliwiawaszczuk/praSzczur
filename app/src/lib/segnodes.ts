// Node graph data model + node-type registry + evaluator for "Segmentacja →
// Segm Mapy Pikseli". Ten sam wzorzec Blender-node-style co mzgraphnodes.ts
// (rejestr typów węzłów + czysta logika ewaluacji, oddzielona od renderowania w
// SegGraphSubtab.svelte), ale inna domena: wejściem są zapisane mapy pikseli
// m/z (ten sam store co graf m/z — savedPixelMaps.svelte.ts), a przetwarzaniem
// jest segmentacja (k-means) zamiast operacji na intensywności.
//
// Segment wyekstrahowany z segmentacji (node "Wybór segmentów") ma dokładnie
// ten sam kształt co mapa m/z (SegMapValue = maska 0/1), więc zapisany node'em
// "Zapis" trafia do wspólnego rejestru zapisanych map i można go dalej
// łączyć/odejmować od map m/z w zakładce m/z → Mapa Node Graph (tam node
// "Łączenie" ma tryby subtract/mask_exclude/mask_keep właśnie pod ten
// przypadek — patrz CombineModeExt w mzgraphnodes.ts).

import type { SavedPixelMap, SavedPixelMapSource } from "./savedPixelMaps.svelte";
import { combineMasks } from "./tissueMerge";

export interface SegNodeParamDef {
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  default: number | string;
}

export type SegNodeCategory = "dane" | "przetwarzanie" | "wynik";

export const SEG_CATEGORY_ORDER: SegNodeCategory[] = ["dane", "przetwarzanie", "wynik"];
export const SEG_CATEGORY_LABELS: Record<SegNodeCategory, string> = {
  dane: "Dane",
  przetwarzanie: "Przetwarzanie",
  wynik: "Wynik",
};

/** Typ danych płynących przez port — "mapa" (zwykła mapa pikseli, jak w grafie
 * m/z) albo "segmentacja" (surowe etykiety klas k-means, jeszcze nie mapa).
 * Używane przy rozwiązywaniu połączeń (patrz findNearestPort w
 * SegGraphSubtab.svelte), żeby nie dało się podłączyć segmentacji tam, gdzie
 * oczekiwana jest mapa, bez przejścia przez "Wybór segmentów". */
export type SegPortKind = "mapa" | "segmentacja";

export interface SegNodeTypeDef {
  id: string;
  label: string;
  description: string;
  category: SegNodeCategory;
  hasInput: boolean;
  hasOutput: boolean;
  inputKind?: SegPortKind;
  outputKind?: SegPortKind;
  /** Wejście przyjmuje wiele przychodzących połączeń naraz (kmeans: kilka map
   * jako kanały cech na piksel). */
  multiInput?: boolean;
  params: SegNodeParamDef[];
}

export interface SegKmeansResult {
  k: number;
  width: number;
  height: number;
  tissueId: string;
  tissueLabel: string;
  labels: number[][];
  legend: { label: number; count: number }[];
  sources: SavedPixelMapSource[];
  /** Maska "prawdziwych" pikseli (AND masek wszystkich podłączonych map) użyta
   * przy uruchomieniu k-means — piksele tła (mask=0) są WYKLUCZONE z
   * klasteryzacji (nie zanieczyszczają klas realną segmentacją) i dostają
   * etykietę sentinel -1 w `labels` (poza 0..k-1, niewybieralną w "Wybór
   * segmentów" i przezroczystą w podglądzie — patrz SegLabelCanvas.svelte). */
  mask?: number[][];
}

export interface SegGraphNode {
  id: string;
  type: string;
  x: number;
  y: number;
  params: Record<string, number | string>;
  /** Tylko dla "map_source": id wybranej zapisanej mapy. */
  savedMapId?: string;
  /** Tylko dla "map_source": czy sekcja ze szczegółami jest rozwinięta. */
  expanded?: boolean;
  /** Tylko dla "kmeans": wynik ostatniego ręcznego przetworzenia — k-means nie
   * liczy się na bieżąco przy każdym renderze jak reszta node'ów (za ciężkie
   * przy przesuwaniu parametrów), tylko na przycisk "Przetwórz". */
  kmeansResult?: SegKmeansResult;
  /** Tylko dla "select_segments": zaznaczone etykiety klas — kilka zaznaczonych
   * to połączenie tych segmentów w jedną maskę. */
  selectedLabels?: number[];
  /** Tylko dla "save_output": nazwa, pod jaką zapisana zostanie nowa mapa. */
  saveName?: string;
}

export interface SegGraphEdge {
  id: string;
  from: string;
  to: string;
}

export interface SegGraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SegGraph {
  nodes: SegGraphNode[];
  edges: SegGraphEdge[];
  viewport: SegGraphViewport;
}

/** Kategoryczna, dobrze rozróżnialna paleta (Tableau-like) — cykliczna dla k >
 * 12 (raczej teoretyczny przypadek, k jest ograniczone do 10). */
export const SEG_PALETTE: string[] = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac",
];

export const SEG_NODE_TYPES: Record<string, SegNodeTypeDef> = {
  map_source: {
    id: "map_source",
    label: "Mapa m/z",
    description: "Zapisana mapa pikseli m/z z podzakładki \"Zapisane\" (ta sama lista co w grafie m/z).",
    category: "dane",
    hasInput: false,
    hasOutput: true,
    outputKind: "mapa",
    params: [],
  },
  kmeans: {
    id: "kmeans",
    label: "K-means",
    description: "Segmentuje piksele na k grup metodą k-means. Podłącz jedną mapę (klasteryzacja po intensywności) albo kilka (klasteryzacja po wektorze cech — warto je najpierw znormalizować w grafie m/z, żeby kanały miały porównywalną skalę). Przeliczane ręcznie przyciskiem \"Przetwórz\".",
    category: "przetwarzanie",
    hasInput: true,
    hasOutput: true,
    inputKind: "mapa",
    outputKind: "segmentacja",
    multiInput: true,
    params: [{ key: "k", label: "k (liczba grup)", min: 2, max: 10, step: 1, default: 3 }],
  },
  select_segments: {
    id: "select_segments",
    label: "Wybór segmentów",
    description: "Wybiera jedną lub kilka klas z wyniku segmentacji i zwraca maskę (0/1) jako zwykłą mapę pikseli — zaznaczenie kilku klas łączy je w jedną maskę.",
    category: "przetwarzanie",
    hasInput: true,
    hasOutput: true,
    inputKind: "segmentacja",
    outputKind: "mapa",
    params: [],
  },
  save_output: {
    id: "save_output",
    label: "Zapis",
    description: "Zapisuje wynikową maskę jako nową mapę pikseli w podzakładce \"Zapisane\" — stamtąd można ją dalej łączyć/odejmować od map m/z w zakładce m/z → Mapa Node Graph.",
    category: "wynik",
    hasInput: true,
    hasOutput: false,
    inputKind: "mapa",
    params: [],
  },
};

export const SEG_NODE_TYPE_LIST: SegNodeTypeDef[] = Object.values(SEG_NODE_TYPES);

let _idCounter = 0;
export function makeSegId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}

export function segDefaultParams(typeId: string): Record<string, number | string> {
  const def = SEG_NODE_TYPES[typeId];
  if (!def) return {};
  const out: Record<string, number | string> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

export function defaultSegGraph(): SegGraph {
  return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

// ── K-means (czysty TS, bez sieci) ──────────────────────────────────────
// Naiwna implementacja: k-means++ inicjalizacja + kilka losowych restartów
// (bierzemy wynik o najmniejszej inercji), żeby uniknąć złego lokalnego
// minimum przy niewielkim k. Piksele to wektory intensywności z podłączonych
// map (1 mapa = klasteryzacja 1D po intensywności).

function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
}

function kmeansPlusPlusInit(points: number[][], k: number, rng: () => number): number[][] {
  const centers: number[][] = [points[Math.floor(rng() * points.length)]];
  while (centers.length < k) {
    const dists = points.map((p) => Math.min(...centers.map((c) => dist2(p, c))));
    const sum = dists.reduce((a, b) => a + b, 0);
    if (sum <= 0) { centers.push(points[Math.floor(rng() * points.length)]); continue; }
    let r = rng() * sum;
    let idx = 0;
    for (; idx < dists.length; idx++) { r -= dists[idx]; if (r <= 0) break; }
    centers.push(points[Math.min(idx, points.length - 1)]);
  }
  return centers;
}

function kmeansOnce(points: number[][], k: number, rng: () => number, maxIter = 50): { labels: number[]; centers: number[][]; inertia: number } {
  let centers = kmeansPlusPlusInit(points, k, rng);
  const dim = points[0].length;
  const labels = new Array(points.length).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(points[i], centers[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; changed = true; }
    }
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < points.length; i++) {
      counts[labels[i]]++;
      for (let d = 0; d < dim; d++) sums[labels[i]][d] += points[i][d];
    }
    centers = centers.map((c, ci) => (counts[ci] > 0 ? sums[ci].map((s) => s / counts[ci]) : c));
    if (!changed && iter > 0) break;
  }
  let inertia = 0;
  for (let i = 0; i < points.length; i++) inertia += dist2(points[i], centers[labels[i]]);
  return { labels, centers, inertia };
}

// Deterministyczny PRNG (mulberry32) — wynik k-means jest powtarzalny dla tych
// samych danych wejściowych, co ułatwia debugowanie ("dlaczego segmentacja się
// zmieniła" zawsze ma jednoznaczną odpowiedź: zmieniły się dane, nie los).
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uruchamia k-means na `channels` (lista map, po jednej na kanał cechy —
 * każda o tym samym width×height) i zwraca mapę etykiet 0..k-1 + legendę
 * (liczność pikseli per klasa). Klasy są ponumerowane rosnąco wg średniej
 * intensywności pierwszego kanału, żeby numeracja była stabilna między
 * kolejnymi uruchomieniami na tych samych danych (inaczej losowa
 * inicjalizacja centroidów dawałaby za każdym razem inną kolejność etykiet).
 *
 * `validMask` (0/1, opcjonalna) — piksele tła (mask=0, poza faktycznym skanem
 * tkanki w imzML) są CAŁKOWICIE wykluczone z klasteryzacji: nie wchodzą do
 * `points`, nie wpływają na centroidy ani na inercję, i dostają w `labels`
 * sentinel -1 (poza 0..k-1) zamiast być siłą przypisane do jakiejś klasy. Bez
 * tego tło (duży, jednolity region zer) zdominowałoby k-means i albo
 * pochłonęłoby całą jedną klasę, albo zniekształciło pozostałe. */
export function runKmeans(
  channels: number[][][], k: number, validMask?: number[][], restarts = 5,
): { labels: number[][]; legend: { label: number; count: number }[] } {
  const h = channels[0].length;
  const w = channels[0][0].length;
  const points: number[][] = [];
  const pointCoords: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (validMask && validMask[y][x] === 0) continue;
      points.push(channels.map((ch) => ch[y][x]));
      pointCoords.push([y, x]);
    }
  }

  const labels: number[][] = Array.from({ length: h }, () => new Array(w).fill(-1));
  if (points.length === 0) return { labels, legend: [] };

  let best: { labels: number[]; centers: number[][]; inertia: number } | null = null;
  for (let r = 0; r < restarts; r++) {
    const rng = mulberry32(12345 + r * 7919);
    const res = kmeansOnce(points, k, rng);
    if (!best || res.inertia < best.inertia) best = res;
  }

  const order = best!.centers
    .map((c, i) => ({ i, mean: c.reduce((a, b) => a + b, 0) / c.length }))
    .sort((a, b) => a.mean - b.mean)
    .map((o) => o.i);
  const remap = new Array(k);
  order.forEach((origIdx, newIdx) => { remap[origIdx] = newIdx; });

  const counts = new Array(k).fill(0);
  for (let i = 0; i < points.length; i++) {
    const [y, x] = pointCoords[i];
    const lbl = remap[best!.labels[i]];
    labels[y][x] = lbl;
    counts[lbl]++;
  }
  return { labels, legend: counts.map((count, label) => ({ label, count })) };
}

// ── Ewaluacja grafu ──────────────────────────────────────────────────────

export interface SegMapValue {
  kind: "mapa";
  tissueId: string;
  tissueLabel: string;
  width: number;
  height: number;
  data: number[][];
  /** Maska "prawdziwych" pikseli (0/1) — patrz TissueImage.mask w api.ts.
   * Opcjonalna: mapy zapisane przed wprowadzeniem maski jej nie mają. */
  mask?: number[][];
  sources: SavedPixelMapSource[];
}

export interface SegLabelValue {
  kind: "segmentacja";
  tissueId: string;
  tissueLabel: string;
  width: number;
  height: number;
  k: number;
  /** Etykiety klas 0..k-1, albo -1 (sentinel "tło" — piksel wykluczony z
   * klasteryzacji, patrz SegKmeansResult.mask). */
  labels: number[][];
  legend: { label: number; count: number }[];
  mask?: number[][];
  sources: SavedPixelMapSource[];
}

export type SegValue = SegMapValue | SegLabelValue;

export type SegEvalOutcome =
  | { ok: true; value: SegValue }
  | { ok: false; error: string };

export function evaluateSegNode(
  graph: SegGraph,
  nodeId: string,
  mapCache: Record<string, SavedPixelMap>,
  savedMapExists: (id: string) => boolean,
  memo: Map<string, SegEvalOutcome> = new Map(),
  visiting: Set<string> = new Set(),
): SegEvalOutcome {
  const cached = memo.get(nodeId);
  if (cached) return cached;

  if (visiting.has(nodeId)) {
    const err: SegEvalOutcome = { ok: false, error: "wykryto cykl w grafie" };
    return err;
  }

  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, error: "brak węzła" };
  const def = SEG_NODE_TYPES[node.type];
  if (!def) return { ok: false, error: "nieznany typ węzła" };

  visiting.add(nodeId);
  const result = evaluateInner(graph, node, mapCache, savedMapExists, memo, visiting);
  visiting.delete(nodeId);
  memo.set(nodeId, result);
  return result;
}

function evaluateInner(
  graph: SegGraph,
  node: SegGraphNode,
  mapCache: Record<string, SavedPixelMap>,
  savedMapExists: (id: string) => boolean,
  memo: Map<string, SegEvalOutcome>,
  visiting: Set<string>,
): SegEvalOutcome {
  if (node.type === "map_source") {
    const id = node.savedMapId;
    if (!id) return { ok: false, error: "wybierz zapisaną mapę" };
    if (!savedMapExists(id)) return { ok: false, error: "wybrana mapa została usunięta" };
    const full = mapCache[id];
    if (!full) return { ok: false, error: "wczytywanie…" };
    return {
      ok: true,
      value: {
        kind: "mapa",
        tissueId: full.tissueId,
        tissueLabel: full.tissueLabel,
        width: full.width,
        height: full.height,
        data: full.data,
        mask: full.mask,
        sources: full.sources,
      },
    };
  }

  if (node.type === "kmeans") {
    const inEdges = graph.edges.filter((e) => e.to === node.id);
    if (inEdges.length === 0) return { ok: false, error: "podłącz przynajmniej jedną mapę" };
    const inputs: SegMapValue[] = [];
    for (const e of inEdges) {
      const r = evaluateSegNode(graph, e.from, mapCache, savedMapExists, memo, visiting);
      if (!r.ok) return r;
      if (r.value.kind !== "mapa") return { ok: false, error: "wejście k-means musi być mapą, nie wynikiem segmentacji" };
      inputs.push(r.value);
    }
    const { width, height, tissueId } = inputs[0];
    if (inputs.some((r) => r.width !== width || r.height !== height)) {
      return { ok: false, error: "podłączone mapy mają różne wymiary — nie można segmentować" };
    }
    if (inputs.some((r) => r.tissueId !== tissueId)) {
      return { ok: false, error: "podłączone mapy pochodzą z różnych tkanek" };
    }
    if (!node.kmeansResult) return { ok: false, error: "kliknij \"Przetwórz\", żeby policzyć segmentację" };
    const cur = node.kmeansResult;
    if (cur.width !== width || cur.height !== height || cur.tissueId !== tissueId) {
      return { ok: false, error: "wejście zmieniło się od ostatniego przetworzenia — kliknij \"Przetwórz\" ponownie" };
    }
    return {
      ok: true,
      value: {
        kind: "segmentacja",
        tissueId: cur.tissueId,
        tissueLabel: cur.tissueLabel,
        width: cur.width,
        height: cur.height,
        k: cur.k,
        labels: cur.labels,
        legend: cur.legend,
        mask: cur.mask,
        sources: cur.sources,
      },
    };
  }

  if (node.type === "select_segments") {
    const inEdge = graph.edges.find((e) => e.to === node.id);
    if (!inEdge) return { ok: false, error: "podłącz wejście (wynik k-means)" };
    const src = evaluateSegNode(graph, inEdge.from, mapCache, savedMapExists, memo, visiting);
    if (!src.ok) return src;
    if (src.value.kind !== "segmentacja") return { ok: false, error: "wejście musi być wynikiem segmentacji (np. k-means)" };
    const selected = node.selectedLabels ?? [];
    if (selected.length === 0) return { ok: false, error: "zaznacz przynajmniej jedną klasę" };
    const { width, height, labels } = src.value;
    // Sentinel -1 (tło, wykluczone z k-means) nigdy nie pasuje do zaznaczonych
    // etykiet 0..k-1, więc wychodzi tu jako 0 bez dodatkowego warunku.
    const data: number[][] = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => (selected.includes(labels[y][x]) ? 1 : 0)),
    );
    return {
      ok: true,
      value: { kind: "mapa", tissueId: src.value.tissueId, tissueLabel: src.value.tissueLabel, width, height, data, mask: src.value.mask, sources: src.value.sources },
    };
  }

  if (node.type === "save_output") {
    const inEdge = graph.edges.find((e) => e.to === node.id);
    if (!inEdge) return { ok: false, error: "podłącz wejście" };
    const src = evaluateSegNode(graph, inEdge.from, mapCache, savedMapExists, memo, visiting);
    if (!src.ok) return src;
    if (src.value.kind !== "mapa") return { ok: false, error: "podłącz maskę (przejdź przez \"Wybór segmentów\"), nie surową segmentację" };
    return src;
  }

  return { ok: false, error: "nieznany typ węzła" };
}

// Sprawdza, czy dodanie połączenia from→to utworzyłoby cykl — patrz
// wouldCreateCycle w mzgraphnodes.ts (identyczna logika, osobna kopia żeby
// oba grafy zostały niezależnymi modułami).
export function wouldCreateSegCycle(graph: SegGraph, fromId: string, toId: string): boolean {
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
