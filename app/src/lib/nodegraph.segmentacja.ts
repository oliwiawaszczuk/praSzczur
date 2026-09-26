// Domena "Segmentacja" dla ujednoliconego node graphu (patrz nodegraph.ts).
// Przeniesione bez zmian logiki z dawnego segnodes.ts (k-means + select
// segments) — tylko rejestr i evaluate() dopasowane do generycznego silnika.
//
// Segment wyekstrahowany z segmentacji (węzeł "Wybór segmentów") ma dokładnie
// ten sam kształt co mapa m/z (MapaValue = maska 0/1), więc dalej można go
// łączyć/odejmować przez "mapa/combine" w tym samym, wspólnym grafie.

import { registerNodeTypes, type NodeTypeDef, type MapaValue, type SegmentacjaValue, type EvalOutcome } from "./nodegraph";

/** Kategoryczna, dobrze rozróżnialna paleta (Tableau-like) — cykliczna dla k >
 * 12 (raczej teoretyczny przypadek, k jest ograniczone do 10). */
export const SEG_PALETTE: string[] = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac",
];

// ── K-means (czysty TS, bez sieci) ──────────────────────────────────────
// Naiwna implementacja: k-means++ inicjalizacja + kilka losowych restartów
// (bierzemy wynik o najmniejszej inercji), żeby uniknąć złego lokalnego
// minimum przy niewielkim k.

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

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uruchamia k-means na `channels` (lista map, po jednej na kanał cechy) i
 * zwraca mapę etykiet 0..k-1 + legendę. `validMask` (0/1, opcjonalna) —
 * piksele tła są CAŁKOWICIE wykluczone z klasteryzacji i dostają etykietę
 * sentinel -1. Patrz oryginalny opis w dawnym segnodes.ts. */
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

const SEGMENTACJA_NODE_TYPES: NodeTypeDef[] = [
  {
    id: "segmentacja/kmeans",
    label: "K-means",
    description: "Segmentuje piksele na k grup metodą k-means. Podłącz jedną mapę (klasteryzacja po intensywności) albo kilka (klasteryzacja po wektorze cech — warto je najpierw znormalizować w domenie Mapa, żeby kanały miały porównywalną skalę). Przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapy", kind: "mapa", multi: true }],
    outputs: [{ id: "out", label: "segmentacja", kind: "segmentacja" }],
    params: [{ key: "k", label: "k (liczba grup)", min: 2, max: 10, step: 1, default: 3 }],
    evaluate(node, inputs): EvalOutcome {
      const results = inputs.in as MapaValue[];
      if (results.length === 0) return { ok: false, error: "podłącz przynajmniej jedną mapę" };
      const { width, height, tissueId } = results[0];
      if (results.some((r) => r.width !== width || r.height !== height)) {
        return { ok: false, error: "podłączone mapy mają różne wymiary — nie można segmentować" };
      }
      if (results.some((r) => r.tissueId !== tissueId)) {
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
          kind: "segmentacja", tissueId: cur.tissueId, tissueLabel: cur.tissueLabel,
          width: cur.width, height: cur.height, k: cur.k, labels: cur.labels, legend: cur.legend,
          mask: cur.mask, sources: cur.sources,
        },
      };
    },
  },
  {
    id: "segmentacja/select_segments",
    label: "Wybór segmentów",
    description: "Wybiera jedną lub kilka klas z wyniku segmentacji i zwraca maskę (0/1) jako zwykłą mapę pikseli — zaznaczenie kilku klas łączy je w jedną maskę.",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segmentacja", kind: "segmentacja" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentacjaValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście (wynik k-means)" };
      const selected = node.selectedLabels ?? [];
      if (selected.length === 0) return { ok: false, error: "zaznacz przynajmniej jedną klasę" };
      const { width, height, labels } = src;
      const data: number[][] = Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x) => (selected.includes(labels[y][x]) ? 1 : 0)),
      );
      return {
        ok: true,
        value: { kind: "mapa", tissueId: src.tissueId, tissueLabel: src.tissueLabel, width, height, data, mask: src.mask, mode: "segment", sources: src.sources },
      };
    },
  },
];

registerNodeTypes(SEGMENTACJA_NODE_TYPES);
