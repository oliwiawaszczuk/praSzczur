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

/** Odcisk wejścia dla węzłów segmentu z ręcznym "Przetwórz" wymagających
 * backendu (segmentacja/active_contour, segmentacja/spectral_refine) — jak
 * widmoInputSignature w nodegraph.widmo.ts: nie porównuje maski piksel-po-
 * pikselu, tylko tanie, ale czułe na zmianę sygnały — wymiary + liczba
 * pikseli segmentu (suma 0/1, tania do policzenia, bo `data` jest już w
 * pamięci) + parametry węzła. */
export function segMaskInputSignature(
  tissueId: string, width: number, height: number, data: number[][], params: Record<string, number | string>,
): string {
  let sum = 0;
  for (const row of data) for (const v of row) if (v >= 0.5) sum++;
  return `${tissueId}|${width}x${height}|${sum}|${JSON.stringify(params)}`;
}

/** Etykiety trybu węzła "Łączenie segmentów" — operacje mnogościowe na
 * maskach 0/1 (w odróżnieniu od "mapa/combine", które łączy ciągłą
 * intensywność; tu wynik ma zawsze pozostać czystą maską 0/1). */
export const MERGE_MODE_LABELS: Record<string, string> = {
  sum: "suma (suma zbiorów)",
  difference: "różnica (pierwszy − reszta)",
};
export const MERGE_MODE_LIST: string[] = ["sum", "difference"];

/** Wybór algorytmu klastrowania dla node'a "Segmentacja" (mapa) — cztery
 * najczęściej używane w literaturze MSI (k-means, hierarchiczne, GMM,
 * DBSCAN — patrz np. przegląd metod nienadzorowanych dla MSI,
 * nature.com/articles/s41598-022-19365-4) plus prosta kwantylowa jako
 * szybka, deterministyczna alternatywa. */
export const KMEANS_ALGORITHM_LABELS: Record<string, string> = {
  kmeans: "k-means (minimalizacja wariancji)",
  hierarchical: "hierarchiczne (aglomeracyjne)",
  gmm: "GMM (mieszanina Gaussów)",
  dbscan: "DBSCAN (gęstościowe)",
  quantile: "kwantyle (równe liczebności grup)",
};
export const KMEANS_ALGORITHM_LIST: string[] = ["kmeans", "hierarchical", "gmm", "dbscan", "quantile"];
/** DBSCAN nie bierze `k` (liczba grup wynika z gęstości danych) — ma własne
 * parametry `eps`/`minPts`. Reszta algorytmów używa wspólnego `k`. */
export const DBSCAN_ALGORITHMS = new Set(["dbscan"]);

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

type ClusterOnceFn = (points: number[][], k: number, rng: () => number) => { labels: number[]; centers: number[][]; inertia: number };

/** Wspólny szkielet k-means/k-medoids: ekstrakcja punktów z `channels`
 * (wykluczając tło przez `validMask`), kilka restartów z różnym seedem (bierzemy
 * wynik o najmniejszej inercji), przemapowanie etykiet tak, żeby klasa 0 miała
 * najniższą średnią (stabilna, powtarzalna kolejność kolorów), złożenie
 * z powrotem w mapę `labels[y][x]` + legenda. */
function runClustering(
  channels: number[][][], k: number, onceFn: ClusterOnceFn, validMask?: number[][], restarts = 5,
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
    const res = onceFn(points, k, rng);
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

/** Uruchamia k-means na `channels` (lista map, po jednej na kanał cechy) i
 * zwraca mapę etykiet 0..k-1 + legendę. `validMask` (0/1, opcjonalna) —
 * piksele tła są CAŁKOWICIE wykluczone z klasteryzacji i dostają etykietę
 * sentinel -1. Patrz oryginalny opis w dawnym segnodes.ts. */
export function runKmeans(
  channels: number[][][], k: number, validMask?: number[][], restarts = 5,
): { labels: number[][]; legend: { label: number; count: number }[] } {
  return runClustering(channels, k, kmeansOnce, validMask, restarts);
}

/** Segmentacja kwantylowa — ZAMIAST minimalizacji wariancji (jak k-means),
 * dzieli piksele na k grup o (prawie) RÓWNEJ LICZEBNOŚCI, posortowanych wg
 * skalarnego wyniku (suma kanałów wejściowych). Dla typowych, skośnych
 * histogramów intensywności MSI daje wyraźnie INNY podział niż k-means (stąd
 * sensowna druga opcja w dropboxie — wcześniejsza wersja, k-medoids, dawała
 * praktycznie te same granice co k-means, bo medoid ≈ średnia przy zwartych
 * klastrach). Deterministyczna, bez restartów/losowości — sortowanie O(N log N). */
export function runQuantile(
  channels: number[][][], k: number, validMask?: number[][],
): { labels: number[][]; legend: { label: number; count: number }[] } {
  const h = channels[0].length;
  const w = channels[0][0].length;
  const scores: number[] = [];
  const pointCoords: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (validMask && validMask[y][x] === 0) continue;
      let score = 0;
      for (const ch of channels) score += ch[y][x];
      scores.push(score);
      pointCoords.push([y, x]);
    }
  }

  const labels: number[][] = Array.from({ length: h }, () => new Array(w).fill(-1));
  if (scores.length === 0) return { labels, legend: [] };

  const order = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const n = order.length;
  const counts = new Array(k).fill(0);
  for (let rank = 0; rank < n; rank++) {
    const label = Math.min(k - 1, Math.floor((rank * k) / n));
    const [y, x] = pointCoords[order[rank]];
    labels[y][x] = label;
    counts[label]++;
  }
  return { labels, legend: counts.map((count, label) => ({ label, count })) };
}

/** Klastrowanie hierarchiczne (aglomeracyjne, linkage="average", ważone
 * liczebnością) — ZAMIAST iteracyjnego dopasowania do centroidów (k-means),
 * zaczyna od wielu małych grup i łączy najbliższe pary, aż zostanie
 * dokładnie k grup. Pełne O(n³) aglomeracyjne łączenie na dziesiątkach
 * tysięcy pikseli byłoby za wolne, więc dane są najpierw ZGRUBIANE do co
 * najwyżej `COARSEN_M` mikroklastrów przez szybki k-means — właściwe
 * łączenie najbliższych par dzieje się już tylko NA NICH (O(M³), trywialne
 * dla M≈150), a każdy piksel dziedziczy finalną etykietę swojego
 * mikroklastra. */
const COARSEN_M = 150;

export function runHierarchical(
  channels: number[][][], k: number, validMask?: number[][],
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
  const dim = points[0].length;
  const kEff = Math.max(1, Math.min(k, points.length));

  // Krok 1: zgrubienie do mikroklastrów (pomijane, gdy danych jest mało).
  let microOf: number[];
  let centers: number[][];
  let weights: number[];
  if (points.length <= COARSEN_M) {
    microOf = points.map((_, i) => i);
    centers = points.map((p) => [...p]);
    weights = points.map(() => 1);
  } else {
    const rng = mulberry32(555);
    const res = kmeansOnce(points, COARSEN_M, rng, 25);
    microOf = res.labels;
    centers = Array.from({ length: COARSEN_M }, () => new Array(dim).fill(0));
    weights = new Array(COARSEN_M).fill(0);
    for (let i = 0; i < points.length; i++) {
      const m = microOf[i];
      weights[m]++;
      for (let d = 0; d < dim; d++) centers[m][d] += points[i][d];
    }
    for (let m = 0; m < COARSEN_M; m++) {
      if (weights[m] > 0) centers[m] = centers[m].map((s) => s / weights[m]);
    }
  }

  // Krok 2: aglomeracyjne łączenie najbliższych par (average linkage, ważone).
  const microIds = centers.map((_, i) => i).filter((i) => weights[i] > 0);
  const mergeOf = new Map<number, number>();
  microIds.forEach((id) => mergeOf.set(id, id));
  const clusterCentroid = new Map<number, { centroid: number[]; weight: number }>();
  microIds.forEach((id) => clusterCentroid.set(id, { centroid: centers[id], weight: weights[id] }));

  let clusters = [...clusterCentroid.keys()];
  while (clusters.length > kEff) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = dist2(clusterCentroid.get(clusters[i])!.centroid, clusterCentroid.get(clusters[j])!.centroid);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    }
    const a = clusterCentroid.get(clusters[bi])!;
    const b = clusterCentroid.get(clusters[bj])!;
    const totalW = a.weight + b.weight;
    const merged = a.centroid.map((v, d) => (v * a.weight + b.centroid[d] * b.weight) / totalW);
    const keepId = clusters[bi];
    const dropId = clusters[bj];
    clusterCentroid.set(keepId, { centroid: merged, weight: totalW });
    clusterCentroid.delete(dropId);
    for (const [microId, curClusterId] of mergeOf) {
      if (curClusterId === dropId) mergeOf.set(microId, keepId);
    }
    clusters = [...clusterCentroid.keys()];
  }

  // Finalne etykiety 0..kEff-1 wg rosnącej średniej (ta sama konwencja
  // "kolor = ranga wartości" co w pozostałych algorytmach).
  const order = clusters
    .map((id) => {
      const c = clusterCentroid.get(id)!.centroid;
      return { id, mean: c.reduce((a, b) => a + b, 0) / c.length };
    })
    .sort((a, b) => a.mean - b.mean)
    .map((o) => o.id);
  const remap = new Map<number, number>();
  order.forEach((id, idx) => remap.set(id, idx));

  const counts = new Array(order.length).fill(0);
  for (let i = 0; i < points.length; i++) {
    const microId = points.length <= COARSEN_M ? i : microOf[i];
    const clusterId = mergeOf.get(microId)!;
    const lbl = remap.get(clusterId)!;
    const [y, x] = pointCoords[i];
    labels[y][x] = lbl;
    counts[lbl]++;
  }
  return { labels, legend: counts.map((count, label) => ({ label, count })) };
}

/** Gaussian Mixture Model (EM, diagonalna macierz kowariancji per klaster) —
 * w przeciwieństwie do k-means (sferyczne, jednakowej "wielkości" skupiska)
 * dopasowuje każdemu klastrowi WŁASNĄ wariancję per kanał, więc lepiej
 * radzi sobie z klastrami o różnym rozrzucie — wg przeglądu metod dla MSI
 * (nature.com/articles/s41598-022-19365-4) GMM dawało najlepsze wyniki
 * spośród porównywanych metod nienadzorowanych. Inicjalizacja jak w
 * k-means (k-means++), kilka restartów (bierzemy najwyższe
 * log-likelihood), twarde przypisanie do klasy o najwyższym
 * prawdopodobieństwie post-hoc — ta appka zawsze przechowuje pojedynczą
 * etykietę per piksel, nie rozkład prawdopodobieństwa. */
function gmmOnce(points: number[][], k: number, rng: () => number, maxIter: number): { labels: number[]; resp: number[][]; logLik: number } {
  const dim = points[0].length;
  const n = points.length;
  let means = kmeansPlusPlusInit(points, k, rng).map((c) => [...c]);
  let variances: number[][] = Array.from({ length: k }, () => new Array(dim).fill(1));
  {
    const globalMean = new Array(dim).fill(0);
    for (const p of points) for (let d = 0; d < dim; d++) globalMean[d] += p[d] / n;
    const globalVar = new Array(dim).fill(0);
    for (const p of points) for (let d = 0; d < dim; d++) globalVar[d] += (p[d] - globalMean[d]) ** 2 / n;
    for (let c = 0; c < k; c++) variances[c] = globalVar.map((v) => Math.max(v, 1e-6));
  }
  let weights = new Array(k).fill(1 / k);

  const EPS_VAR = 1e-6;
  function gaussLogPdf(p: number[], mean: number[], variance: number[]): number {
    let s = 0;
    for (let d = 0; d < dim; d++) {
      const v = Math.max(variance[d], EPS_VAR);
      s += -0.5 * Math.log(2 * Math.PI * v) - ((p[d] - mean[d]) ** 2) / (2 * v);
    }
    return s;
  }

  const resp: number[][] = Array.from({ length: n }, () => new Array(k).fill(0));
  let logLik = -Infinity;
  for (let iter = 0; iter < maxIter; iter++) {
    let newLogLik = 0;
    for (let i = 0; i < n; i++) {
      const logProbs = new Array(k);
      let maxLog = -Infinity;
      for (let c = 0; c < k; c++) {
        logProbs[c] = Math.log(Math.max(weights[c], 1e-12)) + gaussLogPdf(points[i], means[c], variances[c]);
        if (logProbs[c] > maxLog) maxLog = logProbs[c];
      }
      let sumExp = 0;
      for (let c = 0; c < k; c++) sumExp += Math.exp(logProbs[c] - maxLog);
      const logSumExp = maxLog + Math.log(sumExp);
      newLogLik += logSumExp;
      for (let c = 0; c < k; c++) resp[i][c] = Math.exp(logProbs[c] - logSumExp);
    }
    const nk = new Array(k).fill(0);
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) nk[c] += resp[i][c];
    const newMeans = Array.from({ length: k }, () => new Array(dim).fill(0));
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) for (let d = 0; d < dim; d++) newMeans[c][d] += resp[i][c] * points[i][d];
    for (let c = 0; c < k; c++) if (nk[c] > 1e-9) for (let d = 0; d < dim; d++) newMeans[c][d] /= nk[c];
    const newVariances = Array.from({ length: k }, () => new Array(dim).fill(0));
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) for (let d = 0; d < dim; d++) newVariances[c][d] += resp[i][c] * (points[i][d] - newMeans[c][d]) ** 2;
    for (let c = 0; c < k; c++) if (nk[c] > 1e-9) for (let d = 0; d < dim; d++) newVariances[c][d] = Math.max(newVariances[c][d] / nk[c], EPS_VAR);

    means = newMeans.map((m, c) => (nk[c] > 1e-9 ? m : means[c]));
    variances = variances.map((v, c) => (nk[c] > 1e-9 ? newVariances[c] : v));
    weights = nk.map((v) => Math.max(v / n, 1e-6));

    if (iter > 0 && Math.abs(newLogLik - logLik) < 1e-4 * Math.abs(logLik || 1)) { logLik = newLogLik; break; }
    logLik = newLogLik;
  }

  const labels = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let best = 0, bestP = -Infinity;
    for (let c = 0; c < k; c++) if (resp[i][c] > bestP) { bestP = resp[i][c]; best = c; }
    labels[i] = best;
  }
  return { labels, resp, logLik };
}

export function runGMM(
  channels: number[][][], k: number, validMask?: number[][], restarts = 3,
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
  const kEff = Math.max(1, Math.min(k, points.length));

  let best: { labels: number[]; logLik: number } | null = null;
  for (let r = 0; r < restarts; r++) {
    const rng = mulberry32(99999 + r * 613);
    const res = gmmOnce(points, kEff, rng, 30);
    if (!best || res.logLik > best.logLik) best = res;
  }

  const dim = points[0].length;
  const sums = Array.from({ length: kEff }, () => new Array(dim).fill(0));
  const rawCounts = new Array(kEff).fill(0);
  for (let i = 0; i < points.length; i++) {
    rawCounts[best!.labels[i]]++;
    for (let d = 0; d < dim; d++) sums[best!.labels[i]][d] += points[i][d];
  }
  const order = sums
    .map((s, i) => ({ i, mean: rawCounts[i] > 0 ? s.reduce((a, b) => a + b, 0) / (dim * rawCounts[i]) : 0 }))
    .sort((a, b) => a.mean - b.mean)
    .map((o) => o.i);
  const remap = new Array(kEff);
  order.forEach((origIdx, newIdx) => { remap[origIdx] = newIdx; });

  const counts = new Array(kEff).fill(0);
  for (let i = 0; i < points.length; i++) {
    const [y, x] = pointCoords[i];
    const lbl = remap[best!.labels[i]];
    labels[y][x] = lbl;
    counts[lbl]++;
  }
  return { labels, legend: counts.map((count, label) => ({ label, count })) };
}

/** 1D DBSCAN, DOKŁADNY (nie przybliżony) i O(n log n) — dla pojedynczego
 * kanału (najczęstszy przypadek: jedna podłączona mapa) eps-sąsiedztwo
 * punktu w POSORTOWANEJ tablicy to zawsze CIĄGŁY przedział (bo odległość =
 * |różnica wartości|), więc dwuwskaźnikowym przesuwnym oknem liczymy w O(n)
 * zasięg [lo,hi] KAŻDEGO punktu zamiast porównywać go z każdym innym. Core
 * points (zasięg ≥ minPts) łączone są w klastry przez scalanie nachodzących
 * na siebie przedziałów (jeden przebieg po posortowanych punktach); punkty
 * brzegowe (non-core) szukają najbliższego core punktu WYŁĄCZNIE w swoim
 * (z definicji < minPts elementów) oknie — stąd ten krok jest tani mimo
 * pozornie zagnieżdżonej pętli. Siatka haszująca (poprzednia wersja) miała
 * degenerujący się do O(n²) przypadek, gdy duży, gęsty klaster mieścił się
 * w jednej/dwóch sąsiadujących komórkach (typowe dla MSI — rozległe,
 * jednorodne obszary tkanki) — przy ~44k pikseli to było ponad 8s, tu <10ms. */
function dbscan1D(sortedValues: number[], eps: number, minPts: number): number[] {
  const n = sortedValues.length;
  const loIdx = new Array(n), hiIdx = new Array(n);
  { let l = 0; for (let i = 0; i < n; i++) { while (sortedValues[i] - sortedValues[l] > eps) l++; loIdx[i] = l; } }
  { let r = n - 1; for (let i = n - 1; i >= 0; i--) { while (sortedValues[r] - sortedValues[i] > eps) r--; hiIdx[i] = r; } }
  const isCore = new Array(n);
  for (let i = 0; i < n; i++) isCore[i] = (hiIdx[i] - loIdx[i] + 1) >= minPts;

  const clusterOf = new Array(n).fill(-1);
  let cid = -1, reach = -1;
  for (let i = 0; i < n; i++) {
    if (!isCore[i]) continue;
    if (loIdx[i] > reach) cid++;
    clusterOf[i] = cid;
    reach = Math.max(reach, hiIdx[i]);
  }
  for (let i = 0; i < n; i++) {
    if (isCore[i] || clusterOf[i] !== -1) continue;
    for (let j = loIdx[i]; j <= hiIdx[i]; j++) { if (isCore[j]) { clusterOf[i] = clusterOf[j]; break; } }
  }
  return clusterOf;
}

/** Ogólny (wielowymiarowy) DBSCAN przez siatkę haszującą (cell size = eps) —
 * używany tylko gdy podłączono WIĘCEJ niż jedną mapę jako kanały cech (dim >
 * 1), gdzie dokładna sztuczka 1D się nie stosuje. Rzadszy przypadek użycia
 * niż pojedyncza mapa, więc degenerujący się do O(n²) scenariusz gęstych,
 * jednokomórkowych skupisk jest tu zaakceptowanym kompromisem. */
function dbscanGridND(points: number[][], eps: number, minPts: number): number[] {
  const dim = points[0].length;
  const epsSq = eps * eps;
  const grid = new Map<string, number[]>();
  const cellKey = (cell: number[]) => cell.join(",");
  points.forEach((p, i) => {
    const cell = p.map((v) => Math.floor(v / eps));
    const key = cellKey(cell);
    const arr = grid.get(key);
    if (arr) arr.push(i); else grid.set(key, [i]);
  });

  function neighbors(i: number): number[] {
    const p = points[i];
    const base = p.map((v) => Math.floor(v / eps));
    const out: number[] = [];
    const cur = new Array(dim).fill(0);
    function recurse(dIdx: number) {
      if (dIdx === dim) {
        const arr = grid.get(cellKey(cur));
        if (arr) for (const j of arr) if (dist2(p, points[j]) <= epsSq) out.push(j);
        return;
      }
      for (const o of [-1, 0, 1]) { cur[dIdx] = base[dIdx] + o; recurse(dIdx + 1); }
    }
    recurse(0);
    return out;
  }

  const visited = new Array(points.length).fill(false);
  const clusterOf = new Array(points.length).fill(-1);
  let nextCluster = 0;
  for (let i = 0; i < points.length; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const neigh = neighbors(i);
    if (neigh.length < minPts) continue;
    const cid = nextCluster++;
    clusterOf[i] = cid;
    const queue = [...neigh];
    while (queue.length > 0) {
      const j = queue.pop()!;
      if (!visited[j]) {
        visited[j] = true;
        const jNeigh = neighbors(j);
        if (jNeigh.length >= minPts) queue.push(...jNeigh.filter((x) => !visited[x]));
      }
      if (clusterOf[j] < 0) clusterOf[j] = cid;
    }
  }
  return clusterOf;
}

/** DBSCAN (gęstościowe grupowanie) — ZAMIAST ustalonej liczby grup k,
 * znajduje gęste skupiska automatycznie na podstawie promienia sąsiedztwa
 * `eps` (w znormalizowanej [0,1] przestrzeni cech — każdy kanał osobno
 * min-max, żeby parametr był przenośny między mapami o różnej skali) i
 * minimalnej liczby sąsiadów `minPts`. Piksele nienależące do żadnego
 * gęstego skupiska ("szum") dostają etykietę sentinel -1 — DOKŁADNIE tę
 * samą, którą reszta kodu już traktuje jako "poza tkanką/przezroczyste"
 * (patrz SegLabelCanvas.svelte oraz komentarz przy SegmentValue w
 * nodegraph.ts), więc szum po prostu znika z podglądu zamiast dostawać
 * mylący, dodatkowy kolor. */
export function runDBSCAN(
  channels: number[][][], eps: number, minPts: number, validMask?: number[][],
): { labels: number[][]; legend: { label: number; count: number }[] } {
  const h = channels[0].length;
  const w = channels[0][0].length;
  const rawPoints: number[][] = [];
  const pointCoords: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (validMask && validMask[y][x] === 0) continue;
      rawPoints.push(channels.map((ch) => ch[y][x]));
      pointCoords.push([y, x]);
    }
  }
  const labels: number[][] = Array.from({ length: h }, () => new Array(w).fill(-1));
  if (rawPoints.length === 0) return { labels, legend: [] };

  const dim = rawPoints[0].length;
  const mins = new Array(dim).fill(Infinity);
  const maxs = new Array(dim).fill(-Infinity);
  for (const p of rawPoints) for (let d = 0; d < dim; d++) { if (p[d] < mins[d]) mins[d] = p[d]; if (p[d] > maxs[d]) maxs[d] = p[d]; }
  const points = rawPoints.map((p) => p.map((v, d) => (maxs[d] > mins[d] ? (v - mins[d]) / (maxs[d] - mins[d]) : 0)));
  const epsSafe = Math.max(0.001, eps);

  let clusterOf: number[];
  let nextCluster: number;
  if (dim === 1) {
    const order = points.map((_, i) => i).sort((a, b) => points[a][0] - points[b][0]);
    const sortedValues = order.map((i) => points[i][0]);
    const clusterOfSorted = dbscan1D(sortedValues, epsSafe, minPts);
    clusterOf = new Array(points.length).fill(-1);
    order.forEach((origIdx, sortedPos) => { clusterOf[origIdx] = clusterOfSorted[sortedPos]; });
    nextCluster = clusterOfSorted.reduce((m, c) => Math.max(m, c + 1), 0);
  } else {
    clusterOf = dbscanGridND(points, epsSafe, minPts);
    nextCluster = clusterOf.reduce((m, c) => Math.max(m, c + 1), 0);
  }

  if (nextCluster === 0) return { labels, legend: [] };

  // Przemapuj etykiety klastrów wg rosnącej średniej (ta sama konwencja co w
  // pozostałych algorytmach) — szum zostaje -1 (już domyślna wartość w `labels`).
  const sums = Array.from({ length: nextCluster }, () => new Array(dim).fill(0));
  const rawCounts = new Array(nextCluster).fill(0);
  for (let i = 0; i < points.length; i++) {
    if (clusterOf[i] < 0) continue;
    rawCounts[clusterOf[i]]++;
    for (let d = 0; d < dim; d++) sums[clusterOf[i]][d] += points[i][d];
  }
  const order = sums
    .map((s, i) => ({ i, mean: rawCounts[i] > 0 ? s.reduce((a, b) => a + b, 0) / (dim * rawCounts[i]) : 0 }))
    .filter((o) => rawCounts[o.i] > 0)
    .sort((a, b) => a.mean - b.mean)
    .map((o) => o.i);
  const remap = new Map<number, number>();
  order.forEach((origIdx, newIdx) => remap.set(origIdx, newIdx));

  const counts = new Array(order.length).fill(0);
  for (let i = 0; i < points.length; i++) {
    if (clusterOf[i] < 0) continue;
    const [y, x] = pointCoords[i];
    const lbl = remap.get(clusterOf[i])!;
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

// ── Postprocessing: morfologia, gęstość, składowe, dziury ──────────────────
// Cztery nowe, czysto-klienckie węzły (bez wywołań backendu — siatka tkanki
// to ~44k pikseli, ten sam rząd wielkości co k-means/GMM powyżej, więc
// zostają w pełni synchroniczne jak reszta domeny Segmentacja) do czyszczenia
// mocno zaszumionych masek (szum "sól i pieprz" na zewnątrz struktury +
// dziury w jej wnętrzu) — "Usuwanie wysepek" (wyżej) radzi sobie tylko z
// pojedynczymi, małymi (≤20px) izolowanymi skupiskami.

/** Składowe spójne (4-sąsiedztwo, bez przekątnych — ten sam rodzaj sąsiedztwa
 * co `removeIslands`) wartości `target` (0/1) na masce segmentu, z pominięciem
 * pikseli poza `validMask` (jak gdyby nie istniały). Współdzielona przez
 * `segmentacja/keep_largest`. */
function connectedComponents(
  data: number[][], validMask: number[][] | undefined, target: 0 | 1,
): Array<[number, number][]> {
  const h = data.length;
  const w = data[0]?.length ?? 0;
  const visited: boolean[][] = Array.from({ length: h }, () => new Array(w).fill(false));
  const isFg = (y: number, x: number) => {
    if (validMask && validMask[y][x] === 0) return false;
    return (data[y][x] >= 0.5 ? 1 : 0) === target;
  };
  const comps: Array<[number, number][]> = [];
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
      comps.push(comp);
    }
  }
  return comps;
}

export const MORPHOLOGY_MODE_LABELS: Record<string, string> = {
  erode: "erozja (ścieńczenie)",
  dilate: "dylatacja (pogrubienie)",
  open: "otwarcie (erozja → dylatacja, usuwa szum)",
  close: "zamknięcie (dylatacja → erozja, zalatuje dziury)",
};
export const MORPHOLOGY_MODE_LIST: string[] = ["erode", "dilate", "open", "close"];
export const MORPHOLOGY_SHAPE_LABELS: Record<string, string> = {
  diamond: "diament (4-sąsiedztwo)",
  square: "kwadrat (8-sąsiedztwo)",
};
export const MORPHOLOGY_SHAPE_LIST: string[] = ["diamond", "square"];

/** Element strukturalny: lista przesunięć (dy,dx) w promieniu `radius` wokół
 * (0,0) — "diamond" = odległość Manhattan (ten sam rodzaj sąsiedztwa co
 * `removeIslands` przy radius=1), "square" = odległość Czebyszewa (pełny
 * kwadrat (2·radius+1)²). */
function structuringOffsets(radius: number, shape: "diamond" | "square"): Array<[number, number]> {
  const offs: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dy === 0 && dx === 0) continue;
      if (shape === "diamond" && Math.abs(dy) + Math.abs(dx) > radius) continue;
      offs.push([dy, dx]);
    }
  }
  return offs;
}

/** Erozja/dylatacja binarnej maski elementem strukturalnym
 * `structuringOffsets(radius, shape)`. Piksele poza `validMask` są pomijane
 * jako sąsiedzi (dylatacja nigdy nie "wcieka" spoza tkanki, erozja nie liczy
 * braku sąsiada spoza tkanki jako powód do ścieńczenia) i zostają
 * przepisane bez zmian — ta sama konwencja co pozostałe węzły segmentu. */
function erodeDilate(
  data: number[][], validMask: number[][] | undefined, radius: number,
  mode: "erode" | "dilate", shape: "diamond" | "square",
): number[][] {
  const h = data.length;
  const w = data[0]?.length ?? 0;
  const offs = structuringOffsets(Math.max(1, radius), shape);
  const inTissue = (y: number, x: number) => !validMask || validMask[y][x] !== 0;
  const fg = (y: number, x: number) => data[y][x] >= 0.5;
  const out: number[][] = Array.from({ length: h }, () => new Array(w).fill(0));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inTissue(y, x)) { out[y][x] = data[y][x]; continue; }
      if (mode === "dilate") {
        let any = fg(y, x);
        for (let i = 0; !any && i < offs.length; i++) {
          const ny = y + offs[i][0], nx = x + offs[i][1];
          if (ny < 0 || ny >= h || nx < 0 || nx >= w || !inTissue(ny, nx)) continue;
          if (fg(ny, nx)) any = true;
        }
        out[y][x] = any ? 1 : 0;
      } else {
        let all = fg(y, x);
        for (let i = 0; all && i < offs.length; i++) {
          const ny = y + offs[i][0], nx = x + offs[i][1];
          if (ny < 0 || ny >= h || nx < 0 || nx >= w || !inTissue(ny, nx)) continue;
          if (!fg(ny, nx)) all = false;
        }
        out[y][x] = all ? 1 : 0;
      }
    }
  }
  return out;
}

/** Otwarcie (erozja→dylatacja, usuwa drobne wypustki/szum pierwszego planu
 * bez naruszania ogólnego kształtu) / zamknięcie (dylatacja→erozja, zalatuje
 * drobne dziury/wcięcia) — złożenie dwóch przebiegów `erodeDilate`. */
function morphologyOp(
  data: number[][], validMask: number[][] | undefined, radius: number,
  mode: "erode" | "dilate" | "open" | "close", shape: "diamond" | "square",
): number[][] {
  if (mode === "erode") return erodeDilate(data, validMask, radius, "erode", shape);
  if (mode === "dilate") return erodeDilate(data, validMask, radius, "dilate", shape);
  if (mode === "open") return erodeDilate(erodeDilate(data, validMask, radius, "erode", shape), validMask, radius, "dilate", shape);
  return erodeDilate(erodeDilate(data, validMask, radius, "dilate", shape), validMask, radius, "erode", shape);
}

/** Lokalna gęstość pierwszego planu w oknie (2·radius+1)² wokół każdego
 * piksela, liczona przez obraz całkowy (prefix sums) — koszt O(1) per piksel
 * niezależnie od promienia. Piksele poza `validMask` są wykluczone zarówno z
 * sumy, jak i z mianownika (liczby pikseli faktycznie w oknie), żeby brzeg
 * tkanki nie "rozcieńczał" gęstości zerami zza granicy skanu. */
function boxDensity(data: number[][], validMask: number[][] | undefined, radius: number): number[][] {
  const h = data.length;
  const w = data[0]?.length ?? 0;
  const sumFg: number[][] = Array.from({ length: h + 1 }, () => new Array(w + 1).fill(0));
  const sumValid: number[][] = Array.from({ length: h + 1 }, () => new Array(w + 1).fill(0));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const valid = !validMask || validMask[y][x] !== 0;
      const fg = valid && data[y][x] >= 0.5 ? 1 : 0;
      sumFg[y + 1][x + 1] = sumFg[y][x + 1] + sumFg[y + 1][x] - sumFg[y][x] + fg;
      sumValid[y + 1][x + 1] = sumValid[y][x + 1] + sumValid[y + 1][x] - sumValid[y][x] + (valid ? 1 : 0);
    }
  }
  const rangeSum = (sum: number[][], y0: number, x0: number, y1: number, x1: number) =>
    sum[y1 + 1][x1 + 1] - sum[y0][x1 + 1] - sum[y1 + 1][x0] + sum[y0][x0];
  const out: number[][] = Array.from({ length: h }, () => new Array(w).fill(0));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (validMask && validMask[y][x] === 0) { out[y][x] = data[y][x]; continue; }
      const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
      const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
      const validCount = rangeSum(sumValid, y0, x0, y1, x1);
      out[y][x] = validCount > 0 ? rangeSum(sumFg, y0, x0, y1, x1) / validCount : 0;
    }
  }
  return out;
}

/** Wypełnia WSZYSTKIE dziury wewnątrz segmentu — flood-fill tła startujący od
 * brzegu SIATKI (nie tylko brzegu `validMask`, żeby wcięcie tkanki stykające
 * się z krawędzią obrazu nadal liczyło się jako "na zewnątrz", nie jako
 * zamknięta dziura), bez limitu rozmiaru — uzupełnienie `removeIslands`
 * (+ invert), które ma twardy limit `maxSize`. Piksele poza `validMask` są
 * pomijane jak gdzie indziej (nie traktowane jako tło). */
function fillHolesFull(data: number[][], validMask: number[][] | undefined): number[][] {
  const h = data.length;
  const w = data[0]?.length ?? 0;
  const inTissue = (y: number, x: number) => !validMask || validMask[y][x] !== 0;
  const isBg = (y: number, x: number) => inTissue(y, x) && data[y][x] < 0.5;
  const reachable: boolean[][] = Array.from({ length: h }, () => new Array(w).fill(false));
  const stack: [number, number][] = [];
  const seed = (y: number, x: number) => {
    if (isBg(y, x) && !reachable[y][x]) { reachable[y][x] = true; stack.push([y, x]); }
  };
  for (let y = 0; y < h; y++) { seed(y, 0); seed(y, w - 1); }
  for (let x = 0; x < w; x++) { seed(0, x); seed(h - 1, x); }
  while (stack.length) {
    const [cy, cx] = stack.pop()!;
    const neighbors: [number, number][] = [[cy - 1, cx], [cy + 1, cx], [cy, cx - 1], [cy, cx + 1]];
    for (const [ny, nx] of neighbors) {
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      if (reachable[ny][nx] || !isBg(ny, nx)) continue;
      reachable[ny][nx] = true;
      stack.push([ny, nx]);
    }
  }
  const out = data.map((row) => [...row]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isBg(y, x) && !reachable[y][x]) out[y][x] = 1;
    }
  }
  return out;
}

const SEGMENTACJA_NODE_TYPES: NodeTypeDef[] = [
  {
    id: "segmentacja/kmeans",
    label: "Segmentacja",
    detail: "k-means / hierarchiczne / GMM / DBSCAN / kwantyle",
    description: "Segmentuje piksele na grupy na podstawie podłączonej mapy/map m/z (intensywności) — wybór algorytmu w dropboxie (k-means, hierarchiczne aglomeracyjne, GMM, DBSCAN, kwantyle). Warto najpierw znormalizować/przekształcić mapę w domenie Mapa (krzywa, zakres intensywności), żeby segmentacja lepiej rozróżniała klasy. Przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa", multi: true }],
    outputs: [{ id: "out", label: "segmentacja", kind: "segmentacja" }],
    params: [
      { key: "algorithm", label: "Algorytm", default: "kmeans", options: KMEANS_ALGORITHM_LIST },
      { key: "k", label: "k (liczba grup)", min: 2, max: 10, step: 1, default: 3 },
      { key: "eps", label: "eps (promień sąsiedztwa, 0–1)", min: 0.01, max: 1, step: 0.01, default: 0.1 },
      { key: "minPts", label: "minPts (min. liczba sąsiadów)", min: 2, max: 50, step: 1, default: 4 },
    ],
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
      if (!src) return { ok: false, error: "podłącz wejście (wynik segmentacji)" };
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
    description: "Łączy wiele segmentów w jeden wynik segmentacji, nadając każdemu podłączonemu segmentowi osobną klasę/kolor (jak wynik segmentacji) — przydatne, żeby zobaczyć kilka niezależnie zbudowanych/przetworzonych segmentów naraz na jednej mapie klas. Działa jak warstwy — mogą na siebie nachodzić, a piksel należący do kilku podłączonych segmentów naraz dostaje klasę tego podłączonego NAJPÓŹNIEJ (niżej na liście połączeń = wyżej w stosie warstw, tak jak w Tablicy).",
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
    id: "segmentacja/local_density",
    label: "Wygładzanie gęstością",
    detail: "lokalne głosowanie większościowe",
    description: "Liczy lokalną gęstość segmentu w oknie wokół każdego piksela i przywraca piksel do 1, jeśli gęstość przekracza próg — jeden operator, który JEDNOCZEŚNIE tłumi rozproszony szum NA ZEWNĄTRZ struktury (niska lokalna gęstość) i zalatuje dziury W ŚRODKU (wysoka lokalna gęstość wokół). Dobry pierwszy krok postprocessingu mocno zaszumionej segmentacji, przed dalszym czyszczeniem.",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segment", kind: "segment" }],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [
      { key: "radius", label: "Promień okna (px)", min: 1, max: 15, step: 1, default: 3 },
      { key: "threshold", label: "Próg gęstości (0–1)", min: 0.05, max: 0.95, step: 0.05, default: 0.5 },
    ],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście (segment)" };
      const radius = Math.max(1, Math.round(Number(node.params.radius ?? 3)));
      const threshold = Math.min(0.95, Math.max(0.05, Number(node.params.threshold ?? 0.5)));
      const density = boxDensity(src.data, src.mask, radius);
      const data = density.map((row, y) =>
        row.map((v, x) => (src.mask && src.mask[y][x] === 0 ? src.data[y][x] : (v >= threshold ? 1 : 0))),
      );
      return { ok: true, value: { ...src, data } };
    },
  },
  {
    id: "segmentacja/morphology",
    label: "Operacja morfologiczna",
    detail: "erozja / dylatacja / otwarcie / zamknięcie",
    description: "Klasyczna morfologia matematyczna na masce segmentu — otwarcie (erozja→dylatacja) usuwa drobny szum pierwszego planu bez naruszania ogólnego kształtu, zamknięcie (dylatacja→erozja) zalatuje drobne dziury/wcięcia. Promień i kształt sąsiedztwa (diament/kwadrat) sterują siłą i charakterem operacji.",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segment", kind: "segment" }],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [
      { key: "mode", label: "Operacja", default: "close", options: MORPHOLOGY_MODE_LIST },
      { key: "shape", label: "Kształt sąsiedztwa", default: "diamond", options: MORPHOLOGY_SHAPE_LIST },
      { key: "radius", label: "Promień (px)", min: 1, max: 10, step: 1, default: 1 },
    ],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście (segment)" };
      const mode = (["erode", "dilate", "open", "close"].includes(node.params.mode as string) ? node.params.mode : "close") as "erode" | "dilate" | "open" | "close";
      const shape = (node.params.shape as string) === "square" ? "square" : "diamond";
      const radius = Math.max(1, Math.round(Number(node.params.radius ?? 1)));
      const data = morphologyOp(src.data, src.mask, radius, mode, shape);
      return { ok: true, value: { ...src, data } };
    },
  },
  {
    id: "segmentacja/keep_largest",
    label: "Największe składowe",
    description: "Zostawia tylko K największych (wg liczby pikseli) składowych spójnych segmentu, zerując resztę — przydatne, żeby odrzucić przypadkowe skupiska szumu i zostawić dominujący kształt, niezależnie od jego rozmiaru (w odróżnieniu od \"Usuwania wysepek\", które odcina wg progu bezwzględnego, nie wg rangi).",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segment", kind: "segment" }],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [{ key: "keepK", label: "Liczba zachowanych składowych (K)", min: 1, max: 10, step: 1, default: 1 }],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście (segment)" };
      const keepK = Math.max(1, Math.round(Number(node.params.keepK ?? 1)));
      const comps = connectedComponents(src.data, src.mask, 1);
      const top = [...comps].sort((a, b) => b.length - a.length).slice(0, keepK);
      const keep = new Set<string>();
      for (const comp of top) for (const [y, x] of comp) keep.add(`${y},${x}`);
      const data = src.data.map((row, y) => row.map((_, x) => (keep.has(`${y},${x}`) ? 1 : 0)));
      return { ok: true, value: { ...src, data } };
    },
  },
  {
    id: "segmentacja/fill_holes",
    label: "Wypełnij wszystkie dziury",
    description: "Wypełnia KAŻDĄ dziurę w pełni otoczoną segmentem, niezależnie od rozmiaru (flood-fill tła od brzegu siatki) — uzupełnienie \"Usuwania wysepek\" (+ \"Odwróć kolory\"), które ma twardy limit 20 px i nie poradzi sobie z rozległym, gęsto podziurawionym wnętrzem struktury.",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segment", kind: "segment" }],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście (segment)" };
      const data = fillHolesFull(src.data, src.mask);
      return { ok: true, value: { ...src, data } };
    },
  },
  {
    id: "segmentacja/active_contour",
    label: "Aktywny kontur",
    detail: "morphological Chan-Vese",
    description: "Dopasowuje gładki, zamknięty kontur do zaszumionej maski segmentu — energia REGIONALNA (wariancja wewnątrz/na zewnątrz konturu), nie próg piksel-po-pikselu, więc odporne na pojedyncze piksele szumu i dziury: kontur \"osiada\" na dominującym kształcie widocznym makroskopowo. Liczone na backendzie (scikit-image) — przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segment", kind: "segment" }],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [
      { key: "iterations", label: "Iteracje", min: 5, max: 50, step: 1, default: 20 },
      { key: "smoothing", label: "Wygładzanie", min: 1, max: 4, step: 1, default: 2 },
    ],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście (segment)" };
      if (!node.morphSnakesCache) return { ok: false, error: "kliknij \"Przetwórz\", żeby dopasować kontur" };
      const sig = segMaskInputSignature(src.tissueId, src.width, src.height, src.data, node.params);
      if (node.morphSnakesCache.inputSignature !== sig) return { ok: false, error: "wejście zmieniło się od ostatniego przetworzenia — kliknij \"Przetwórz\" ponownie" };
      return { ok: true, value: { ...src, data: node.morphSnakesCache.data } };
    },
  },
  {
    id: "segmentacja/spectral_refine",
    label: "Dopasowanie do widm",
    detail: "rafinacja na podstawie podobieństwa widm",
    description: "Traktuje obecny segment jako wstępną etykietę: wyznacza widmo referencyjne \"rdzenia\" (erodowane wnętrze) i \"tła\" (erodowana odwrotność) i przelicza segment na podstawie faktycznego podobieństwa kosinusowego widma KAŻDEGO piksela tkanki do obu referencji — jedyny węzeł postprocessingu, który wraca do oryginalnych widm, zamiast zostać czysto geometryczną operacją na masce 0/1. \"Iteracje\" > 1 powtarza cykl rdzeń/tło → wynik → nowy rdzeń/tło (prosty self-training). Liczone na backendzie — przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "segmentacja", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segment", kind: "segment" }],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [
      { key: "erosionRadius", label: "Promień erozji referencji (px)", min: 0, max: 10, step: 1, default: 2 },
      { key: "iterations", label: "Iteracje (self-training)", min: 1, max: 5, step: 1, default: 1 },
    ],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście (segment)" };
      if (!node.spectralRefineCache) return { ok: false, error: "kliknij \"Przetwórz\", żeby dopasować do widm" };
      const sig = segMaskInputSignature(src.tissueId, src.width, src.height, src.data, node.params);
      if (node.spectralRefineCache.inputSignature !== sig) return { ok: false, error: "wejście zmieniło się od ostatniego przetworzenia — kliknij \"Przetwórz\" ponownie" };
      return { ok: true, value: { ...src, data: node.spectralRefineCache.data } };
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
