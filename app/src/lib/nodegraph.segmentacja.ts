// Domena "Segmentacja" dla ujednoliconego node graphu (patrz nodegraph.ts).
// Przeniesione bez zmian logiki z dawnego segnodes.ts (k-means + select
// segments) — tylko rejestr i evaluate() dopasowane do generycznego silnika.
//
// Segment wyekstrahowany z segmentacji (węzeł "Wybór segmentów") jest OSOBNYM
// rodzajem gniazda ("segment", nie "mapa") — mapa m/z to ciągła intensywność,
// segment to zawsze binarna maska przynależności. Świadomie NIE da się więc
// podłączyć zwykłej "Mapa m/z" wprost do "Łączenie segmentów"/"Odwrócenie
// segmentu"/"Usuwanie wysepek" — to inny rodzaj danych (patrz komentarz przy
// `SegmentValue` w nodegraph.ts, tam też jest ustalona konwencja kolorów
// czarny/biały dla podglądu segmentu).

import { combineMasks } from "./tissueMerge";
import { registerNodeTypes, dedupeSources, type NodeTypeDef, type MapaValue, type SegmentacjaValue, type SegmentValue, type EvalOutcome } from "./nodegraph";

/** Etykiety trybu węzła "Łączenie segmentów" — operacje mnogościowe na
 * maskach 0/1 (w odróżnieniu od "mapa/combine", które łączy ciągłą
 * intensywność; tu wynik ma zawsze pozostać czystą maską 0/1). */
export const MERGE_MODE_LABELS: Record<string, string> = {
  sum: "suma (suma zbiorów)",
  difference: "różnica (pierwszy − reszta)",
};
export const MERGE_MODE_LIST: string[] = ["sum", "difference"];

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

/** Usuwa małe, odizolowane skupiska pikseli ("wysepki") z binarnej maski
 * (0/1) — proste łączenie składowych spójnych po 4-sąsiedztwie (bez
 * przekątnych, "prosty algorytm" zgodnie z prośbą), każda składowa mniejsza
 * lub równa `maxSize` pikseli zostaje wyzerowana (albo zjedynkowana, gdy
 * `invert` — patrz niżej). */
function removeIslands(data: number[][], maxSize: number, invert: boolean): number[][] {
  const h = data.length;
  const w = data[0]?.length ?? 0;
  const visited: boolean[][] = Array.from({ length: h }, () => new Array(w).fill(false));
  const out = data.map((row) => [...row]);
  // `invert`: szukamy małych skupisk DRUGIEGO koloru (tła/poza segmentem,
  // wartość 0) zamiast segmentu (1) — usunięcie takiego skupiska oznacza
  // wypełnienie go jedynką (1), czyli "zalatanie" małej dziury w segmencie.
  const target = invert ? 0 : 1;
  const fillValue = invert ? 1 : 0;
  const isFg = (y: number, x: number) => (data[y][x] >= 0.5 ? 1 : 0) === target;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isFg(y, x) || visited[y][x]) continue;
      const stack: [number, number][] = [[y, x]];
      visited[y][x] = true;
      const comp: [number, number][] = [];
      while (stack.length) {
        const [cy, cx] = stack.pop()!;
        comp.push([cy, cx]);
        const neighbors: [number, number][] = [[cy - 1, cx], [cy + 1, cx], [cy, cx - 1], [cy, cx + 1]];
        for (const [ny, nx] of neighbors) {
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          if (visited[ny][nx] || !isFg(ny, nx)) continue;
          visited[ny][nx] = true;
          stack.push([ny, nx]);
        }
      }
      if (comp.length <= maxSize) {
        for (const [cy, cx] of comp) out[cy][cx] = fillValue;
      }
    }
  }
  return out;
}

const SEGMENTACJA_NODE_TYPES: NodeTypeDef[] = [
  {
    id: "segmentacja/kmeans",
    label: "K-means",
    description: "Segmentuje piksele na k grup metodą k-means na podstawie JEDNEJ podłączonej mapy m/z (intensywności). Warto najpierw znormalizować/przekształcić mapę w domenie Mapa (krzywa, zakres intensywności), żeby segmentacja lepiej rozróżniała klasy. Przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
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
    description: "Wybiera jedną lub kilka klas z wyniku segmentacji i zwraca segment (maskę 0/1) — zaznaczenie kilku klas łączy je w jeden segment.",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segmentacja", kind: "segmentacja" }],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
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
        value: { kind: "segment", tissueId: src.tissueId, tissueLabel: src.tissueLabel, width, height, data, mask: src.mask, sources: src.sources },
      };
    },
  },
  {
    id: "segmentacja/merge_segments",
    label: "Łączenie segmentów",
    description: "Łączy wiele segmentów w jeden zbiorem: suma (OR) albo różnica (pierwsze podłączone wejście minus wszystkie pozostałe).",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segmenty", kind: "segment", multi: true }],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [{ key: "mode", label: "Sposób łączenia", default: "sum", options: MERGE_MODE_LIST }],
    evaluate(node, inputs): EvalOutcome {
      const results = inputs.in as SegmentValue[];
      if (results.length === 0) return { ok: false, error: "podłącz przynajmniej jeden segment" };
      const { width, height, tissueId } = results[0];
      if (results.some((r) => r.width !== width || r.height !== height)) {
        return { ok: false, error: "podłączone segmenty mają różne wymiary" };
      }
      if (results.some((r) => r.tissueId !== tissueId)) {
        return { ok: false, error: "podłączone segmenty pochodzą z różnych tkanek" };
      }
      const mode = (node.params.mode as string) ?? "sum";
      const data: number[][] = Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x) => {
          const vals = results.map((r) => (r.data[y][x] >= 0.5 ? 1 : 0));
          if (mode === "difference") return vals[0] && !vals.slice(1).some((v) => v) ? 1 : 0;
          return vals.some((v) => v) ? 1 : 0;
        }),
      );
      const mask = combineMasks(results.map((r) => r.mask), height, width);
      return {
        ok: true,
        value: {
          kind: "segment", tissueId, tissueLabel: results[0].tissueLabel, width, height, data, mask,
          sources: dedupeSources(results.flatMap((r) => r.sources)),
        },
      };
    },
  },
  {
    id: "segmentacja/segments_to_segmentation",
    label: "Kolorowanie segmentów",
    description: "Łączy wiele segmentów w jeden wynik segmentacji, nadając każdemu podłączonemu segmentowi osobną klasę/kolor (jak wynik K-means) — przydatne, żeby zobaczyć kilka niezależnie zbudowanych/przetworzonych segmentów naraz na jednej mapie klas. Działa jak warstwy — mogą na siebie nachodzić, a piksel należący do kilku podłączonych segmentów naraz dostaje klasę tego podłączonego NAJPÓŹNIEJ (niżej na liście połączeń = wyżej w stosie warstw, tak jak w Tablicy).",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segmenty", kind: "segment", multi: true }],
    outputs: [{ id: "out", label: "segmentacja", kind: "segmentacja" }],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const results = inputs.in as SegmentValue[];
      if (results.length === 0) return { ok: false, error: "podłącz przynajmniej jeden segment" };
      const { width, height, tissueId } = results[0];
      if (results.some((r) => r.width !== width || r.height !== height)) {
        return { ok: false, error: "podłączone segmenty mają różne wymiary" };
      }
      if (results.some((r) => r.tissueId !== tissueId)) {
        return { ok: false, error: "podłączone segmenty pochodzą z różnych tkanek" };
      }
      // Warstwy: segment podłączony PÓŹNIEJ (wyższy indeks = niżej na liście
      // połączeń w UI) przykrywa te podłączone wcześniej tam, gdzie się
      // nakładają — stąd szukamy od KOŃCA, nie findIndex (który dawałby
      // pierwszeństwo najwcześniej podłączonemu, "pod spodem" pozostałych).
      const mask = combineMasks(results.map((r) => r.mask), height, width);
      // WAŻNE: piksele poza faktycznym skanem tkanki (mask===0) muszą dostać
      // sentinel -1 WPROST tutaj — tak jak runKmeans robi to dla swojego
      // `labels` (patrz komentarz przy SegmentValue w nodegraph.ts). Inaczej
      // SegLabelCanvas (który NIE dostaje osobno `mask`, tylko `labels` —
      // ocenia wyłącznie `label < 0`) koloruje też róg poza tkanką, jeśli
      // `data` akurat miało tam wartość ≥0.5 — stąd podgląd bez owalnego
      // wycięcia tkanki, wypełniony kolorem aż po same rogi prostokąta.
      const counts = new Array(results.length).fill(0);
      const labels: number[][] = Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x) => {
          if (mask && mask[y][x] === 0) return -1;
          let idx = -1;
          for (let k = results.length - 1; k >= 0; k--) {
            if (results[k].data[y][x] >= 0.5) { idx = k; break; }
          }
          if (idx >= 0) counts[idx]++;
          return idx;
        }),
      );
      return {
        ok: true,
        value: {
          kind: "segmentacja", tissueId, tissueLabel: results[0].tissueLabel, width, height,
          k: results.length, labels, legend: counts.map((count, label) => ({ label, count })), mask,
          sources: dedupeSources(results.flatMap((r) => r.sources)),
        },
      };
    },
  },
  {
    id: "segmentacja/invert_segment",
    label: "Odwrócenie segmentu",
    description: "Odwraca segment (maskę 0/1) — zaznaczone piksele stają się niezaznaczonymi i odwrotnie.",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segment", kind: "segment" }],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście (segment)" };
      const data = src.data.map((row) => row.map((v) => (v >= 0.5 ? 0 : 1)));
      return { ok: true, value: { ...src, data } };
    },
  },
  {
    id: "segmentacja/remove_islands",
    label: "Usuwanie wysepek",
    description: "Usuwa małe, odizolowane skupiska pikseli (\"wysepki\") z segmentu — proste łączenie składowych spójnych (4-sąsiedztwo); usuwa skupiska nie większe niż ustawiony próg. Piksele poza faktycznym skanem tkanki nie są brane pod uwagę. Checkbox \"Odwróć kolory\" przełącza usuwanie wysepek na drugi kolor (tło/poza segmentem) — efektywnie zalatuje małe dziury wewnątrz segmentu zamiast usuwać jego małe wysepki.",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segment", kind: "segment" }],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [{ key: "islandMax", label: "Maks. rozmiar (px)", min: 1, max: 20, step: 1, default: 1 }],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście (segment)" };
      const maxSize = Math.max(1, Math.round(Number(node.params.islandMax ?? 1)));
      const data = removeIslands(src.data, maxSize, node.invertIslandTarget ?? false);
      return { ok: true, value: { ...src, data } };
    },
  },
  {
    id: "segmentacja/save_segment",
    label: "Zapis segmentu",
    description: "Zapisuje segment (maskę 0/1) jako zapis w podzakładce \"Zapisane\" (tryb: segment) — osobny węzeł od \"mapa/Zapis\", bo segment to inny rodzaj danych niż zwykła mapa m/z.",
    domain: "segmentacja", stage: "wynik",
    inputs: [{ id: "in", label: "segment", kind: "segment" }],
    outputs: [],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście" };
      return { ok: true, value: src };
    },
  },
  {
    id: "segmentacja/segment_source",
    label: "Zapisany segment",
    description: "Wczytuje wcześniej zapisany segment z podzakładki \"Zapisane\" — lista pokazuje wyłącznie zapisy zapisane jako segment (węzłem \"Zapis segmentu\"), nie zwykłe mapy m/z.",
    domain: "segmentacja", stage: "dane",
    inputs: [],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [],
    evaluate(node, _inputs, ctx): EvalOutcome {
      const id = node.savedMapId;
      if (!id) return { ok: false, error: "wybierz zapisany segment" };
      if (!ctx.savedMapExists(id)) return { ok: false, error: "wybrany segment został usunięty" };
      const full = ctx.mapCache[id];
      if (!full) return { ok: false, error: "wczytywanie…" };
      return {
        ok: true,
        value: {
          kind: "segment", tissueId: full.tissueId, tissueLabel: full.tissueLabel,
          width: full.width, height: full.height, data: full.data, mask: full.mask, sources: full.sources,
        },
      };
    },
  },
];

registerNodeTypes(SEGMENTACJA_NODE_TYPES);
