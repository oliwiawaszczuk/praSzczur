// Domena "Analiza grup" dla ujednoliconego node graphu (patrz nodegraph.ts) —
// odpowiednik workflow z skryptów MATLAB (skrypt_ostateczny_*_KM_5dni_neg.m):
//
//   wczytaj widma grupy A i B  →  zakres m/z + wygładzanie + linia bazowa + TIC
//   →  średnie widmo  →  PLS-DA (LV, K-fold CV)  →  beta  →  top-k m/z
//
// Jednostką PRÓBKI jest widmo (uśredniona tkanka albo segment), nie piksel — tak
// jak w MATLAB-ie, gdzie jeden plik .txt = jedna próbka. Dlatego wprowadzono
// rodzaj portu "zestaw" (ZestawValue: N widm na wspólnej osi m/z). Wyjście PLS-DA
// to zwykłe "widmo" (współczynniki beta w funkcji m/z), więc dalej działają
// wszystkie węzły domeny Widmo (Lista m/z, Wykrywanie pików, Zapis, Porównanie).
//
// Węzły z backendem (set_tissues, set_segments, preprocess, pls_da) idą tym samym
// wzorcem co "widmo/smooth" i "segmentacja/kmeans": ręczny przycisk "Przetwórz"
// w NodeGraphTab.svelte woła sidecar i cache'uje wynik na węźle, a evaluate()
// tylko czyta cache (błąd, gdy pusty albo `inputSignature` nieaktualny).

import {
  registerNodeTypes, type NodeTypeDef, type NodeValue, type EvalOutcome,
  type ZestawValue, type WidmoValue, type SegmentValue,
} from "./nodegraph";

// ── Czyste funkcje pomocnicze (współdzielone z NodeGraphTab.svelte) ────────

/** Odcisk zestawu (do `inputSignature` węzłów zależnych): liczba próbek, długość osi,
 * oba końce osi i suma wszystkich intensywności — tania, ale czuła na zmianę danych. */
export function zestawSignature(z: Pick<ZestawValue, "mz" | "samples">): string {
  let sum = 0;
  for (const s of z.samples) for (const v of s.intensity) sum += v;
  const last = z.mz.length - 1;
  return `${z.samples.length}|${z.mz.length}|${z.mz[0]}|${z.mz[last]}|${sum.toPrecision(10)}`;
}

function countOnes(grid: number[][]): number {
  let c = 0;
  for (const row of grid) for (const v of row) if (v >= 0.5) c++;
  return c;
}

/** Odcisk wejść węzła "Zestaw z segmentów": tkanka, wymiary i liczba pikseli każdego segmentu. */
export function segmentsSetSignature(segments: SegmentValue[], dataset: string, mode: string): string {
  const parts = segments.map((s) => `${s.tissueId}:${s.width}x${s.height}:${countOnes(s.data)}`);
  return `${dataset}|${mode}|${parts.join(",")}`;
}

export function tissuesSetSignature(dataset: string, ids: string[], mode: string): string {
  return `${dataset}|${mode}|${ids.join(",")}`;
}

export function preprocessSignature(z: ZestawValue, params: Record<string, number | string>): string {
  return `${zestawSignature(z)}|${JSON.stringify(params)}`;
}

export function plsSignature(a: ZestawValue, b: ZestawValue, params: Record<string, number | string>): string {
  const p = { lv: params.lv, folds: params.folds, seed: params.seed, n_perm: params.n_perm };
  return `${zestawSignature(a)}#${zestawSignature(b)}|${JSON.stringify(p)}`;
}

/** Zestaw ma jedną, wspólną oś m/z (warunek konieczny PLS i uśredniania). */
export function sameGrid(a: Pick<ZestawValue, "mz">, b: Pick<ZestawValue, "mz">): boolean {
  const n = a.mz.length;
  return n === b.mz.length && n > 0 && a.mz[0] === b.mz[0] && a.mz[n - 1] === b.mz[n - 1];
}

export type TopMzSign = "abs" | "pos" | "neg";
export const TOP_MZ_SIGN_LABELS: Record<TopMzSign, string> = {
  abs: "|beta| (oba kierunki)",
  pos: "tylko dodatnie (wyższe w A)",
  neg: "tylko ujemne (wyższe w B)",
};
export const TOP_MZ_SIGN_LIST: TopMzSign[] = ["abs", "pos", "neg"];

export interface TopMzEntry { rank: number; mz: number; index: number; value: number; }

/** Odpowiednik `maxk(abs(beta), k)` z MATLAB-a, z jedną różnicą: `minGap` (Da) — kolejny
 * wybrany punkt musi leżeć co najmniej tyle od już wybranych, inaczej top-k to zwykle k
 * sąsiednich binów JEDNEGO piku. `minGap = 0` daje dokładnie zachowanie MATLAB-a. */
export function topMzPeaks(mz: number[], values: number[], k: number, minGap: number, sign: TopMzSign): TopMzEntry[] {
  const score = (v: number) => (sign === "abs" ? Math.abs(v) : sign === "pos" ? v : -v);
  const order: number[] = [];
  for (let i = 0; i < values.length; i++) if (score(values[i]) > 0) order.push(i);
  order.sort((i, j) => score(values[j]) - score(values[i]));
  const out: TopMzEntry[] = [];
  for (const i of order) {
    if (out.length >= k) break;
    if (minGap > 0 && out.some((e) => Math.abs(e.mz - mz[i]) < minGap)) continue;
    out.push({ rank: out.length + 1, mz: mz[i], index: i, value: values[i] });
  }
  return out;
}

export const SET_MODE_LIST = ["mean", "sum"] as const;
export const SET_MODE_LABELS: Record<string, string> = { mean: "średnia", sum: "suma", max: "maksimum" };
export const SEGMENT_SET_MODE_LIST = ["mean", "sum", "max"] as const;
export const PRE_NORMALIZE_LIST = ["tic", "max", "none"] as const;
export const PRE_NORMALIZE_LABELS: Record<string, string> = { tic: "TIC (suma = 1)", max: "max = 1", none: "brak" };
export const MEAN_MODE_LIST = ["mean", "median"] as const;
export const MEAN_MODE_LABELS: Record<string, string> = { mean: "średnia", median: "mediana" };
export const PLS_OUTPUT_LIST = ["beta", "abs"] as const;
export const PLS_OUTPUT_LABELS: Record<string, string> = { beta: "beta (ze znakiem)", abs: "|beta|" };

function noPreview(): EvalOutcome {
  return { ok: false, error: "węzeł podglądowy — brak wyniku liczbowego" };
}

function asZestaw(v: NodeValue | undefined): ZestawValue | null {
  return v && v.kind === "zestaw" ? v : null;
}

const NEED_RUN = "wejście zmieniło się od ostatniego przetworzenia — kliknij \"Przetwórz\" ponownie";

const ANALIZA_NODE_TYPES: NodeTypeDef[] = [
  {
    id: "analiza/set_tissues",
    label: "Zestaw z tkanek",
    description: "Buduje zestaw próbek z CAŁYCH tkanek wybranego zestawu danych: jedna tkanka = jedno widmo (średnia albo suma po jej pikselach). Odpowiednik wczytania folderu plików .txt z MATLAB-a (jeden plik = jedna próbka), np. 5 skrawków kontrolnych. Zaznacz tkanki, które należą do grupy. Liczone na backendzie — przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "analiza", stage: "dane",
    inputs: [],
    outputs: [{ id: "out", label: "zestaw", kind: "zestaw" }],
    params: [{ key: "mode", label: "Agregacja po pikselach", default: "mean", options: [...SET_MODE_LIST] }],
    evaluate(node, _inputs, ctx): EvalOutcome {
      const ids = node.tissueIds ?? [];
      if (ids.length === 0) return { ok: false, error: "zaznacz przynajmniej jedną tkankę" };
      const cache = node.zestawCache;
      if (!cache) return { ok: false, error: "kliknij \"Przetwórz\", żeby policzyć widma tkanek" };
      const sig = tissuesSetSignature(String(node.params.dataset ?? ""), ids, String(node.params.mode ?? "mean"));
      if (cache.inputSignature !== sig) return { ok: false, error: NEED_RUN };
      return {
        ok: true,
        value: {
          kind: "zestaw", label: `Zestaw z tkanek (${cache.samples.length})`, mz: cache.mz,
          samples: cache.samples.map((s) => ({ ...s, label: ctx.tissueLabels?.[s.tissueId] || s.label })),
        },
      };
    },
  },
  {
    id: "analiza/set_segments",
    label: "Zestaw z segmentów",
    description: "Buduje zestaw próbek z SEGMENTÓW (np. istota biała / szara z różnych tkanek): jeden podłączony segment = jedno widmo (średnia/suma/maksimum po pikselach segmentu). Podłącz tyle segmentów, ile próbek ma grupa. Liczone na backendzie — przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "analiza", stage: "dane",
    inputs: [{ id: "in", label: "segmenty", kind: "segment", multi: true }],
    outputs: [{ id: "out", label: "zestaw", kind: "zestaw" }],
    params: [{ key: "mode", label: "Agregacja po pikselach", default: "mean", options: [...SEGMENT_SET_MODE_LIST] }],
    evaluate(node, inputs): EvalOutcome {
      const segs = inputs.in as SegmentValue[];
      if (segs.length === 0) return { ok: false, error: "podłącz przynajmniej jeden segment" };
      const cache = node.zestawCache;
      if (!cache) return { ok: false, error: "kliknij \"Przetwórz\", żeby policzyć widma segmentów" };
      const sig = segmentsSetSignature(segs, String(node.params.dataset ?? ""), String(node.params.mode ?? "mean"));
      if (cache.inputSignature !== sig) return { ok: false, error: NEED_RUN };
      return {
        ok: true,
        value: { kind: "zestaw", label: `Zestaw z segmentów (${cache.samples.length})`, mz: cache.mz, samples: cache.samples },
      };
    },
  },
  {
    id: "analiza/set_spectra",
    label: "Zestaw z widm",
    description: "Składa zestaw próbek z gotowych widm (Zapisane widmo, Widmo z segmentu, wynik Łączenia itd.) — jedno podłączone widmo = jedna próbka. Wszystkie widma muszą mieć tę samą siatkę m/z.",
    domain: "analiza", stage: "dane",
    inputs: [{ id: "in", label: "widma", kind: "widmo", multi: true }],
    outputs: [{ id: "out", label: "zestaw", kind: "zestaw" }],
    params: [],
    evaluate(_node, inputs): EvalOutcome {
      const specs = inputs.in as WidmoValue[];
      if (specs.length === 0) return { ok: false, error: "podłącz przynajmniej jedno widmo" };
      const ref = specs[0];
      for (const s of specs) {
        if (s.mz.length !== ref.mz.length || s.mz[0] !== ref.mz[0] || s.mz[s.mz.length - 1] !== ref.mz[ref.mz.length - 1]) {
          return { ok: false, error: "widma mają różne siatki m/z — ujednolić (np. ten sam zestaw danych i bin size)" };
        }
      }
      return {
        ok: true,
        value: {
          kind: "zestaw", label: `Zestaw z widm (${specs.length})`, mz: ref.mz,
          samples: specs.map((s) => ({ label: s.label, tissueId: s.tissueId, intensity: s.intensity })),
        },
      };
    },
  },
  {
    id: "analiza/preprocess",
    label: "Preprocessing zestawu",
    detail: "zakres · Savitzky-Golay · SNIP · TIC",
    description: "Kroki 7–8 skryptu MATLAB na CAŁYM zestawie naraz: ograniczenie zakresu m/z → wygładzanie Savitzky-Golay (odpowiednik mssgolay) → korekcja linii bazowej SNIP (odpowiednik msbackadj) → normalizacja do sumy (TIC = 1). Każdy krok można wyłączyć (okno = 0, iteracje = 0, normalizacja = brak). Jeśli zestaw danych był już przetworzony w zakładce \"Zestaw danych\", wyłącz powtarzane kroki. Liczone na backendzie — przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "analiza", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "zestaw", kind: "zestaw" }],
    outputs: [{ id: "out", label: "zestaw", kind: "zestaw" }],
    params: [
      { key: "mz_min", label: "m/z od", min: 0, max: 4000, step: 10, default: 300 },
      { key: "mz_max", label: "m/z do", min: 0, max: 4000, step: 10, default: 1500 },
      { key: "smooth_window", label: "okno wygładzania [pkt] (0 = wył.)", min: 0, max: 31, step: 1, default: 3 },
      { key: "baseline_iterations", label: "iteracje SNIP (0 = wył.)", min: 0, max: 100, step: 5, default: 40 },
      { key: "normalize", label: "Normalizacja", default: "tic", options: [...PRE_NORMALIZE_LIST] },
    ],
    evaluate(node, inputs): EvalOutcome {
      const src = asZestaw(inputs.in[0]);
      if (!src) return { ok: false, error: "podłącz zestaw" };
      const cache = node.zestawCache;
      if (!cache) return { ok: false, error: "kliknij \"Przetwórz\", żeby przetworzyć zestaw" };
      if (cache.inputSignature !== preprocessSignature(src, node.params)) return { ok: false, error: NEED_RUN };
      return {
        ok: true,
        value: { kind: "zestaw", label: `${src.label} · przetworzony`, mz: cache.mz, samples: cache.samples.map((s, i) => ({ ...s, label: src.samples[i]?.label ?? s.label })) },
      };
    },
  },
  {
    id: "analiza/mean_spectrum",
    label: "Średnie widmo zestawu",
    description: "Uśrednia próbki zestawu w jedno widmo (średnia albo mediana) — krok \"średnie widmo\" z MATLAB-a. Wynik to zwykłe widmo, więc można je porównać (Porównanie widm), zapisać albo podać jako tło węzłowi \"Top m/z\".",
    domain: "analiza", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "zestaw", kind: "zestaw" }],
    outputs: [{ id: "out", label: "widmo", kind: "widmo" }],
    params: [{ key: "mode", label: "Statystyka", default: "mean", options: [...MEAN_MODE_LIST] }],
    evaluate(node, inputs): EvalOutcome {
      const src = asZestaw(inputs.in[0]);
      if (!src) return { ok: false, error: "podłącz zestaw" };
      const n = src.mz.length;
      const m = src.samples.length;
      const median = node.params.mode === "median";
      const intensity = new Array<number>(n).fill(0);
      const col = new Array<number>(m);
      for (let i = 0; i < n; i++) {
        if (median) {
          for (let j = 0; j < m; j++) col[j] = src.samples[j].intensity[i];
          col.sort((a, b) => a - b);
          intensity[i] = m % 2 ? col[(m - 1) / 2] : (col[m / 2 - 1] + col[m / 2]) / 2;
        } else {
          let s = 0;
          for (let j = 0; j < m; j++) s += src.samples[j].intensity[i];
          intensity[i] = s / m;
        }
      }
      return {
        ok: true,
        value: {
          kind: "widmo", tissueId: "zestaw", tissueLabel: "zestaw", label: `${median ? "Mediana" : "Średnia"} (${src.label})`,
          mz: src.mz, intensity, mode: "mean",
          sources: [{ note: `${median ? "mediana" : "średnia"} z ${m} próbek` }],
        },
      };
    },
  },
  {
    id: "analiza/pls_da",
    label: "PLS-DA",
    detail: "plsregress + K-fold CV",
    description: "Regresja PLS rozdzielająca dwie grupy próbek (A = +1, B = −1), z K-krotną walidacją krzyżową — odpowiednik plsregress z MATLAB-a (centrowanie bez skalowania). Wyjście \"beta\" to widmo współczynników: im większa |beta|, tym bardziej dany m/z różnicuje grupy (znak dodatni = wyżej w grupie A). Wykresy diagnostyczne (predicted vs input, błąd CV vs LV, wariancja Y) otwiera przycisk \"Diagnostyka\". Uwaga: próbką jest widmo, nie piksel — przy kilku próbkach i tysiącach m/z model łatwo się przeucza, dlatego patrz na Q² (CV), a opcjonalny test permutacyjny daje p-wartość. Liczone na backendzie — przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "analiza", stage: "przetwarzanie",
    inputs: [
      { id: "a", label: "grupa A (+1)", kind: "zestaw" },
      { id: "b", label: "grupa B (−1)", kind: "zestaw" },
    ],
    outputs: [{ id: "out", label: "beta", kind: "widmo" }],
    params: [
      { key: "lv", label: "zmienne latentne (LV)", min: 1, max: 20, step: 1, default: 8 },
      { key: "folds", label: "foldy CV (K)", min: 2, max: 10, step: 1, default: 5 },
      { key: "seed", label: "ziarno losowania foldów", min: 0, max: 99, step: 1, default: 0 },
      { key: "n_perm", label: "permutacje (0 = bez testu)", min: 0, max: 500, step: 10, default: 0 },
      { key: "output", label: "Wyjście", default: "beta", options: [...PLS_OUTPUT_LIST] },
    ],
    evaluate(node, inputs): EvalOutcome {
      const a = asZestaw(inputs.a[0]);
      const b = asZestaw(inputs.b[0]);
      if (!a || !b) return { ok: false, error: "podłącz oba zestawy (A i B)" };
      if (!sameGrid(a, b)) return { ok: false, error: "zestawy A i B mają różne siatki m/z — przepuść oba przez ten sam \"Preprocessing zestawu\" lub wybierz ten sam zestaw danych" };
      const cache = node.plsCache;
      if (!cache) return { ok: false, error: "kliknij \"Przetwórz\", żeby dopasować model PLS-DA" };
      if (cache.inputSignature !== plsSignature(a, b, node.params)) return { ok: false, error: NEED_RUN };
      const r = cache.result;
      const abs = node.params.output === "abs";
      return {
        ok: true,
        value: {
          kind: "widmo", tissueId: "zestaw", tissueLabel: "PLS-DA",
          label: `${abs ? "|beta|" : "beta"} PLS-DA (LV=${r.lv}, Q²=${r.q2.toFixed(2)})`,
          mz: cache.mz, intensity: abs ? r.beta.map(Math.abs) : r.beta, mode: "diff",
          sources: [{ note: `PLS-DA ${r.n_a} vs ${r.n_b} próbek, LV=${r.lv}, ${r.n_folds}-fold CV` }],
        },
      };
    },
  },
  {
    id: "analiza/top_mz",
    label: "Top m/z",
    detail: "maxk(|beta|)",
    description: "Wybiera k najważniejszych m/z wg |beta| (jak maxk(abs(beta), k) w MATLAB-ie) i pokazuje je jako znaczniki na wykresie, tabelę rankingu oraz listę \"[m1;m2;...]\" gotową do wklejenia w zakładce m/z → Grupy → \"Lista m/z\". Parametr \"min. odstęp\" zapobiega wybraniu k sąsiednich binów jednego piku (0 = zachowanie MATLAB-a). Opcjonalne wejście \"tło\" (np. Średnie widmo zestawu) rysuje się pod markerami. Węzeł czysto podglądowy, bez wyniku do dalszego łączenia.",
    domain: "analiza", stage: "wynik",
    inputs: [
      { id: "in", label: "beta (widmo)", kind: "widmo" },
      { id: "bg", label: "tło (opcjonalne)", kind: "widmo" },
    ],
    outputs: [],
    params: [
      { key: "k", label: "k (liczba m/z)", min: 1, max: 50, step: 1, default: 10 },
      { key: "min_gap", label: "min. odstęp m/z [Da]", min: 0, max: 20, step: 0.1, default: 0.5 },
      { key: "sign", label: "Kierunek", default: "abs", options: [...TOP_MZ_SIGN_LIST] },
    ],
    evaluate(_node, inputs): EvalOutcome {
      if (!inputs.in[0]) return { ok: false, error: "podłącz widmo beta (wyjście PLS-DA)" };
      return noPreview();
    },
  },
];

registerNodeTypes(ANALIZA_NODE_TYPES);
