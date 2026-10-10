// Domena "Markery przestrzenne" dla node graphu (patrz nodegraph.ts) — automatyczne
// szukanie m/z, które tworzą strukturę przestrzenną / różnicują regiony tkanki:
//
//   średnie widmo → Wykrywanie pików (lista) → Filtr jakości → Macierz piksel × pik
//   → Ranking przestrzenny / Kontrast regionów → Grupy kolokalizacji → Powtarzalność
//   → Ranking łączony → Mapa z rankingu / Tabela rankingu
//
// Opis i uzasadnienie (w tym co przeniesiono z repo IsotopeakeR, a czego świadomie nie):
// docs/node-graph.md, sekcja "Domena Markery przestrzenne". Algorytmy: src/msi/peaks.py,
// src/msi/markers.py. Węzły z backendem (peaks, matrix, spatial, contrast, coloc) idą
// wzorcem "Przetwórz" + cache na węźle (jak domena Analiza); reszta liczy się w evaluate().
// Macierz piksel × pik NIGDY nie trafia do grafu — tylko jej id (MatrixInfo.matrixId).

import {
  registerNodeTypes, type NodeTypeDef, type NodeValue, type EvalOutcome, type PeakInfo,
  type MacierzValue, type RankingValue, type RankingRow, type SegmentValue,
  type SegmentacjaValue, type WidmoValue,
} from "./nodegraph";
import { widmoInputSignature } from "./nodegraph.widmo";

// ── Adnotacja FMP-10 (z scripts/08_mz_marker_profile.py) ────────────────────
// FMP-10 1A = M + 268.1121; 2A = M + 2·268.1121 − 15.0235 (utrata CH3); 2B = M + 2·268.1121 − 1.0078.
const FMP1 = 268.1121;
const NEURO: Record<string, number> = {
  "dopamina": 153.079, "noradrenalina": 169.0739, "adrenalina": 183.0895, "serotonina": 176.095,
  "3-metoksytyramina": 167.0946, "L-DOPA": 197.0688, "tyrozyna": 181.0739, "tryptofan": 204.0899,
  "5-HTP": 220.0848, "5-HIAA": 191.0582, "DOPAC": 168.0423, "HVA": 182.0579, "GABA": 103.0633,
  "glutaminian": 147.0532, "glutamina": 146.0691, "glicyna": 75.032, "tauryna": 125.0147,
  "histamina": 111.0796, "tyramina": 137.0841, "tryptamina": 160.1, "oktopamina": 153.079,
  "putrescyna": 88.1, "spermidyna": 145.1579, "agmatyna": 130.1218, "alanina": 89.0477,
  "seryna": 105.0426, "asparaginian": 133.0375, "MDMA": 193.1103, "MDA": 179.0946,
  "psylocyna": 204.1263, "norketamina": 223.0764, "ketamina": 237.092,
};
export const FMP10_LOCK_MZ = 555.2231;

/** Kandydaci adnotacji (pochodne FMP-10 neuroprzekaźników/leków) dla danego m/z. */
export function fmpCandidates(mz: number, tol = 0.15): string[] {
  const out: string[] = [];
  if (Math.abs(mz - FMP10_LOCK_MZ) <= tol) out.push("jon matrycy FMP-10");
  for (const [name, m] of Object.entries(NEURO)) {
    const tags: [string, number][] = [
      ["1A", m + FMP1], ["2A", m + 2 * FMP1 - 15.0235], ["2B", m + 2 * FMP1 - 1.0078], ["1A-H2O", m + FMP1 - 18.0106],
    ];
    for (const [tag, v] of tags) if (Math.abs(v - mz) <= tol) out.push(`${name} ${tag}`);
  }
  return out;
}

// ── Etykiety ─────────────────────────────────────────────────────────────────
export const NOISE_LABELS: Record<string, string> = { local: "lokalny (okno 10 Da)", mad: "globalny MAD (IsotopeakeR)" };
export const YESNO_LABELS: Record<string, string> = { yes: "tak", no: "nie" };
export const WINDOW_LABELS: Record<string, string> = {
  fwhm: "apeks ± FWHM·współczynnik", bounds: "granice piku (doliny)", ppm: "apeks ± ppm",
};
export const MATRIX_NORM_LABELS: Record<string, string> = { tic: "TIC (po korekcji tła)", rms: "RMS", none: "brak" };
export const COLOC_MODE_LABELS: Record<string, string> = { dedupe: "zostaw reprezentantów grup", annotate: "tylko oznacz grupy" };
export const CONSISTENCY_LABELS: Record<string, string> = {
  anatomical: "zgodne we wszystkich tkankach (anatomia)",
  specific: "specyficzne dla jednej tkanki (efekt grupy)",
};

/** Nazwy metryk do tabel (klucze z src/msi/markers.py + węzły liczone tu). */
export const METRIC_LABELS: Record<string, string> = {
  moran: "Moran I", gini: "Gini", coverage: "pokrycie", rho_edge: "ρ krawędź", rho_lock: "ρ matryca",
  eps2: "ε² KW", max_cliff: "|Cliff δ|", best_region: "region", auc_best: "AUC", log2fc_best: "log2FC",
  min_pct: "min. percentyl", spec: "specyficzność", group: "grupa", r_rep: "r z repr.",
  wej_a: "pct A", wej_b: "pct B", wej_c: "pct C", fmp: "kandydat FMP-10",
};

// ── Czyste funkcje ───────────────────────────────────────────────────────────
export function peaksSignature(peaks: PeakInfo[]): string {
  let s = 0;
  for (const p of peaks) s += p.mz * 7 + p.lo * 3 + p.hi + p.fwhm;
  return `${peaks.length}|${s.toFixed(4)}`;
}

function countOnes(grid: number[][]): number {
  let c = 0;
  for (const row of grid) for (const v of row) if (v >= 0.5) c++;
  return c;
}

export function roiSignature(rois: SegmentValue[]): string {
  return rois.map((r) => `${r.tissueId}:${countOnes(r.data)}`).join(",");
}

export function matrixSignature(peaks: PeakInfo[], rois: SegmentValue[], params: Record<string, number | string>): string {
  return `${peaksSignature(peaks)}#${roiSignature(rois)}#${JSON.stringify(params)}`;
}

export function segmentacjaSignature(segs: SegmentacjaValue[]): string {
  return segs.map((s) => {
    let sum = 0;
    for (const row of s.labels) for (const v of row) sum += v + 1;
    return `${s.tissueId}:${s.k}:${sum}`;
  }).join(",");
}

export function rankingSignature(r: RankingValue): string {
  return `${r.matrixId}|${r.rows.length}|${r.rows.slice(0, 300).map((x) => x.peak).join(".")}`;
}

/** "555.2231; 268.11, 300" → [555.2231, 268.11, 300]. */
export function parseMzList(text: string): number[] {
  return text.split(/[;,\s\[\]]+/).map((t) => Number(t)).filter((v) => Number.isFinite(v) && v > 0);
}

export function filterPeaks(peaks: PeakInfo[], p: Record<string, number | string>, exclude: number[]): PeakInfo[] {
  const snrMin = Number(p.snr_min ?? 0);
  const fMin = Number(p.fwhm_min ?? 0);
  const fMax = Number(p.fwhm_max ?? Infinity);
  const r2Min = Number(p.r2_min ?? 0);
  const tol = Number(p.exclude_tol ?? 0.05);
  return peaks.filter((pk) =>
    pk.snr >= snrMin && pk.fwhm >= fMin && pk.fwhm <= fMax
    && (r2Min <= 0 || (pk.r2 ?? 0) >= r2Min)
    && !(p.drop_isotopes === "yes" && pk.isotope_of !== undefined)
    && !exclude.some((m) => Math.abs(pk.mz - m) <= tol));
}

/** Percentyl rangi (1 = najlepszy) wartości w kolumnie — 0..1. Brak wartości → 0. */
function percentiles(values: (number | null | undefined)[]): number[] {
  const idx = values.map((v, i) => [v ?? -Infinity, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length).fill(0);
  const n = values.length;
  idx.forEach(([v, i], r) => { out[i] = v === -Infinity || n < 2 ? 0 : r / (n - 1); });
  return out;
}

/** Zgodność rankingu między tkankami (per_tissue). "anatomical": wynik = najgorszy percentyl po
 * tkankach (wysoko tylko, gdy wysoko WSZĘDZIE); "specific": najlepszy percentyl − mediana pozostałych. */
export function consistencyRows(rows: RankingRow[], mode: string): RankingRow[] {
  const tissues = [...new Set(rows.flatMap((r) => Object.keys(r.per_tissue ?? {})))];
  if (tissues.length < 2) return [];
  const pct: Record<string, number[]> = {};
  for (const t of tissues) pct[t] = percentiles(rows.map((r) => r.per_tissue?.[t]));
  const out = rows.map((r, i) => {
    const ps = tissues.map((t) => pct[t][i]);
    let score: number;
    let best = 0;
    for (let k = 1; k < ps.length; k++) if (ps[k] > ps[best]) best = k;
    if (mode === "specific") {
      const others = ps.filter((_, k) => k !== best).sort((a, b) => a - b);
      const med = others.length % 2 ? others[(others.length - 1) / 2] : (others[others.length / 2 - 1] + others[others.length / 2]) / 2;
      score = ps[best] - med;
    } else {
      score = Math.min(...ps);
    }
    const per: Record<string, number | null> = {};
    tissues.forEach((t, k) => { per[t] = Math.round(ps[k] * 1000) / 1000; });
    return {
      ...r, score: Math.round(score * 1000) / 1000,
      metrics: { ...r.metrics, min_pct: Math.round(Math.min(...ps) * 1000) / 1000, spec: Math.round((ps[best] - Math.min(...ps)) * 1000) / 1000 },
      per_tissue: per,
    };
  });
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Ważone łączenie rankingów: wynik = Σ w·percentyl / Σ w. Wiersze łączone po indeksie piku (gdy
 * rankingi pochodzą z tej samej macierzy), inaczej po m/z (±0.02 Da). Pik nieobecny w którymś
 * rankingu dostaje tam percentyl 0. */
export function combineRankings(inputs: { r: RankingValue; w: number; key: string }[]): RankingRow[] {
  const active = inputs.filter((x) => x.w > 0 && x.r.rows.length > 0);
  if (active.length === 0) return [];
  const sameMatrix = active.every((x) => x.r.matrixId === active[0].r.matrixId);
  const keyOf = (row: RankingRow) => (sameMatrix ? `p${row.peak}` : `m${Math.round(row.mz / 0.02)}`);
  const merged = new Map<string, { row: RankingRow; acc: number; parts: Record<string, number | null> }>();
  const wsum = active.reduce((s, x) => s + x.w, 0);
  active.forEach((x) => {
    const pct = percentiles(x.r.rows.map((r) => r.score));
    x.r.rows.forEach((row, i) => {
      const key = keyOf(row);
      let m = merged.get(key);
      if (!m) { m = { row, acc: 0, parts: {} }; merged.set(key, m); }
      m.acc += x.w * pct[i];
      m.parts[`wej_${x.key}`] = Math.round(pct[i] * 1000) / 1000;
    });
  });
  return [...merged.values()]
    .map(({ row, acc, parts }) => ({
      peak: row.peak, mz: row.mz, score: Math.round((acc / wsum) * 1000) / 1000,
      metrics: { ...row.metrics, ...parts }, per_tissue: row.per_tissue, group: row.group, group_size: row.group_size,
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Ranking jako widmo "słupkowe" (wynik w funkcji m/z) — wejście istniejącego węzła "Top m/z". */
export function rankingToWidmo(r: RankingValue): WidmoValue {
  const pts = [...r.rows].sort((a, b) => a.mz - b.mz);
  const mz: number[] = [];
  const intensity: number[] = [];
  for (const p of pts) {
    mz.push(p.mz - 0.001, p.mz, p.mz + 0.001);
    intensity.push(0, Math.max(p.score ?? 0, 0), 0);
  }
  return {
    kind: "widmo", tissueId: "ranking", tissueLabel: "ranking", label: `wynik: ${r.label}`,
    mz, intensity, mode: "diff", sources: [{ note: `ranking ${r.rows.length} m/z` }],
  };
}

/** CSV rankingu (separator ";", jak praOutputs/ranking_pikow.csv). */
export function rankingCsv(rows: RankingRow[]): string {
  const metricKeys = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))];
  const tissues = [...new Set(rows.flatMap((r) => Object.keys(r.per_tissue ?? {})))];
  const head = ["rank", "mz", "score", ...metricKeys, ...tissues.map((t) => `tkanka_${t}`), "grupa", "kandydaci_FMP10"];
  const lines = [head.join(";")];
  rows.forEach((r, i) => {
    lines.push([
      i + 1, r.mz, r.score ?? "", ...metricKeys.map((k) => r.metrics[k] ?? ""),
      ...tissues.map((t) => r.per_tissue?.[t] ?? ""), r.group ?? "", fmpCandidates(r.mz).join(", "),
    ].join(";"));
  });
  return lines.join("\n");
}

/** Klucz cache mapy kolumny macierzy (EvalContext.markerImageCache). */
export function markerImageKey(matrixId: string, peak: number): string {
  return `${matrixId}|${peak}`;
}

// ── Pomocnicze do evaluate ───────────────────────────────────────────────────
const NEED_RUN = "wejście zmieniło się od ostatniego przetworzenia — kliknij \"Przetwórz\" ponownie";

function asKind<K extends NodeValue["kind"]>(v: NodeValue | undefined, kind: K): Extract<NodeValue, { kind: K }> | null {
  return v && v.kind === kind ? (v as Extract<NodeValue, { kind: K }>) : null;
}

function cachedRanking(
  node: Parameters<NodeTypeDef["evaluate"]>[0], m: MacierzValue, sig: string, label: string,
): EvalOutcome {
  const c = node.rankingCache;
  if (!c) return { ok: false, error: "kliknij \"Przetwórz\", żeby policzyć ranking" };
  if (c.inputSignature !== sig) return { ok: false, error: NEED_RUN };
  return { ok: true, value: { kind: "ranking", label, matrixId: m.matrixId, rows: c.rows } };
}

export function spatialSignature(m: MacierzValue, params: Record<string, number | string>): string {
  return `${m.matrixId}|${params.min_coverage}`;
}
export function contrastSignature(m: MacierzValue, segs: SegmentacjaValue[], params: Record<string, number | string>): string {
  return `${m.matrixId}|${segmentacjaSignature(segs)}|${params.min_region}`;
}
export function colocSignature(m: MacierzValue, r: RankingValue, params: Record<string, number | string>): string {
  return `${m.matrixId}|${rankingSignature(r)}|${params.r_threshold}`;
}

const MARKERY_NODE_TYPES: NodeTypeDef[] = [
  {
    id: "markery/peaks",
    label: "Wykrywanie pików (lista)",
    detail: "SNR · granice · FWHM · R²",
    description: "Wykrywa piki na widmie (najlepiej ŚREDNIM widmie tkanki — \"Widmo z segmentu\" albo \"Średnie widmo zestawu\", po wygładzeniu i korekcji tła) i opisuje każdy: m/z apeksu, centroid, granice (doliny), FWHM, wysokość, pole (AUC), SNR i R² dopasowania asymetrycznego Gaussa (miara \"czy to wygląda jak pik\" — z repo IsotopeakeR). Pik = lokalne maksimum w ±półokno, wysokość nad szumem ≥ SNR·σ. Szum \"lokalny\" (okno 10 Da) jest lepszy dla tych danych niż jedna globalna wartość MAD, bo szum spada ~2× między 300 a 1000 Da. Piki wyglądające na izotop M+1/M+2 innego piku dostają oznaczenie (usuwa je \"Filtr jakości pików\"). Wynik to LISTA pików, a nie widmo — wejście węzła \"Macierz piksel × pik\". Liczone na backendzie — przycisk \"Przetwórz\".",
    domain: "markery", stage: "dane",
    inputs: [{ id: "in", label: "widmo", kind: "widmo" }],
    outputs: [{ id: "out", label: "piki", kind: "piki" }],
    params: [
      { key: "snr", label: "SNR (min.)", min: 1, max: 30, step: 0.5, default: 3 },
      { key: "half_window_da", label: "półokno maksimum [Da]", min: 0.01, max: 1, step: 0.01, default: 0.1 },
      { key: "min_distance_da", label: "min. odstęp pików [Da]", min: 0, max: 2, step: 0.01, default: 0 },
      { key: "max_peaks", label: "maks. liczba pików", min: 10, max: 2000, step: 10, default: 400 },
      { key: "noise", label: "Szum", default: "local", options: ["local", "mad"] },
    ],
    evaluate(node, inputs): EvalOutcome {
      const src = asKind(inputs.in[0], "widmo");
      if (!src) return { ok: false, error: "podłącz widmo (np. średnie widmo tkanki)" };
      const c = node.peaksCache;
      if (!c) return { ok: false, error: "kliknij \"Przetwórz\", żeby wykryć piki" };
      if (c.inputSignature !== widmoInputSignature(src.mz, src.intensity, node.params)) return { ok: false, error: NEED_RUN };
      return { ok: true, value: { kind: "piki", label: `${c.peaks.length} pików (${src.label})`, peaks: c.peaks, spectrum: { mz: src.mz, intensity: src.intensity } } };
    },
  },
  {
    id: "markery/peak_filter",
    label: "Filtr jakości pików",
    description: "Zostawia tylko \"prawdziwe\", wyraźne piki: SNR ≥ próg, FWHM w zakresie zgodnym z rozdzielczością aparatu (tu ~0.09 Da @ 375 do ~0.16 Da @ 950 — dużo węższe piki to zwykle szpilki szumu, dużo szersze to zlane piki), R² dopasowania ≥ próg (0 = bez progu). Opcjonalnie usuwa piki oznaczone jako izotop M+1/M+2 (żeby jeden związek nie zajmował kilku miejsc w rankingu) i m/z z listy wykluczeń (domyślnie jon matrycy FMP-10 555.2231 — jego rozkład odzwierciedla nałożenie matrycy, nie biologię).",
    domain: "markery", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "piki", kind: "piki" }],
    outputs: [{ id: "out", label: "piki", kind: "piki" }],
    params: [
      { key: "snr_min", label: "SNR (min.)", min: 0, max: 50, step: 0.5, default: 5 },
      { key: "fwhm_min", label: "FWHM min. [Da]", min: 0, max: 1, step: 0.005, default: 0.03 },
      { key: "fwhm_max", label: "FWHM maks. [Da]", min: 0.01, max: 2, step: 0.01, default: 0.4 },
      { key: "r2_min", label: "R² dopasowania (min.)", min: 0, max: 1, step: 0.01, default: 0.8 },
      { key: "drop_isotopes", label: "Usuń izotopy M+1/M+2", default: "yes", options: ["yes", "no"] },
      { key: "exclude_tol", label: "tolerancja wykluczeń [Da]", min: 0.005, max: 0.5, step: 0.005, default: 0.05 },
    ],
    evaluate(node, inputs): EvalOutcome {
      const src = asKind(inputs.in[0], "piki");
      if (!src) return { ok: false, error: "podłącz listę pików" };
      const peaks = filterPeaks(src.peaks, node.params, parseMzList(node.excludeMz ?? String(FMP10_LOCK_MZ)));
      if (peaks.length === 0) return { ok: false, error: "filtr odrzucił wszystkie piki — poluzuj progi" };
      return { ok: true, value: { ...src, label: `${peaks.length}/${src.peaks.length} pików po filtrze`, peaks } };
    },
  },
  {
    id: "markery/matrix",
    label: "Macierz piksel × pik",
    detail: "rekalibracja · całka okna · normalizacja",
    description: "Mierzy każdy pik z listy w KAŻDYM pikselu tkanek (jedno przejście po danych): opcjonalna korekcja tła piksela, rekalibracja masy do lock mass (domyślnie jon matrycy FMP-10 555.2231 — przesunięcie liczone w ppm per piksel; między skrawkami wynosi tu ~20–60 ppm i bez korekcji ranking wyłapuje artefakt kalibracji zamiast biologii), suma intensywności w oknie piku, normalizacja (TIC po korekcji tła — NIE do maksimum 100%, bo to zaciera różnice całkowitej intensywności). Opcjonalne wejście ROI (segmenty) zawęża piksele (np. tylko mózg bez tła). Rekalibracja działa tylko na surowym imzML. Macierz zostaje w backendzie (marker_cache workspace'u); do grafu trafia jej id. Zwykle 0.5–2 min — przycisk \"Przetwórz\".",
    domain: "markery", stage: "przetwarzanie",
    inputs: [
      { id: "in", label: "piki", kind: "piki" },
      { id: "roi", label: "ROI (opcjonalne)", kind: "segment", multi: true },
    ],
    outputs: [{ id: "out", label: "macierz", kind: "macierz" }],
    params: [
      { key: "dataset", label: "zestaw danych", default: "" },
      { key: "window", label: "Okno całkowania", default: "fwhm", options: ["fwhm", "bounds", "ppm"] },
      { key: "fwhm_factor", label: "współczynnik FWHM (półszerokość okna)", min: 0.25, max: 3, step: 0.05, default: 1 },
      { key: "tol_ppm", label: "tolerancja [ppm] (okno ppm)", min: 5, max: 500, step: 5, default: 50 },
      { key: "normalize", label: "Normalizacja", default: "tic", options: ["tic", "rms", "none"] },
      { key: "baseline", label: "Korekcja tła piksela", default: "yes", options: ["yes", "no"] },
      { key: "recal", label: "Rekalibracja (lock mass)", default: "yes", options: ["yes", "no"] },
      { key: "lock_mz", label: "lock mass m/z", min: 300, max: 1500, step: 0.0001, default: FMP10_LOCK_MZ },
    ],
    evaluate(node, inputs): EvalOutcome {
      const src = asKind(inputs.in[0], "piki");
      if (!src) return { ok: false, error: "podłącz listę pików" };
      const rois = inputs.roi as SegmentValue[];
      const c = node.matrixCache;
      if (!c) return { ok: false, error: "kliknij \"Przetwórz\", żeby zbudować macierz" };
      if (c.inputSignature !== matrixSignature(src.peaks, rois, node.params)) return { ok: false, error: NEED_RUN };
      return {
        ok: true,
        value: { kind: "macierz", label: `${c.info.nPixels} pikseli × ${c.info.nPeaks} pików`, matrixId: c.info.matrixId, peaks: src.peaks, info: c.info },
      };
    },
  },
  {
    id: "markery/spatial",
    label: "Ranking przestrzenny",
    detail: "Moran I · Gini · artefakty",
    description: "Ranking BEZ etykiet — \"które m/z tworzą strukturę\", bez definiowania regionów (więc bez ryzyka double dipping). Osobno w każdej tkance: Moran I (czy sąsiednie piksele mają podobną intensywność — spójny wzór vs szum), Gini (czy sygnał jest skupiony w części tkanki, a nie wszędzie po równo), pokrycie (% pikseli z sygnałem > 3σ) i kary za artefakty: |Spearman| z odległością od krawędzi tkanki (efekt brzegu) i z jonem matrycy (nierówne nałożenie matrycy). Wynik tkanki = max(Moran,0)·(0.5+0.5·Gini)·(1−max|ρ|), 0 gdy pokrycie < próg; wynik = średnia po tkankach. Wyniki per tkanka idą dalej do \"Powtarzalność między tkankami\". Przycisk \"Przetwórz\".",
    domain: "markery", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "macierz", kind: "macierz" }],
    outputs: [{ id: "out", label: "ranking", kind: "ranking" }],
    params: [{ key: "min_coverage", label: "min. pokrycie pikseli", min: 0, max: 1, step: 0.01, default: 0.1 }],
    evaluate(node, inputs): EvalOutcome {
      const m = asKind(inputs.in[0], "macierz");
      if (!m) return { ok: false, error: "podłącz macierz" };
      return cachedRanking(node, m, spatialSignature(m, node.params), "przestrzenny");
    },
  },
  {
    id: "markery/contrast",
    label: "Kontrast regionów",
    detail: "ε² KW · Cliff δ · AUC 1-vs-reszta",
    description: "Ranking m/z różnicujących REGIONY podanej segmentacji (np. k-means albo ręczny podział na struktury). Dla każdego regionu AUC jeden-vs-reszta (= markery konkretnego regionu, nie tylko \"ogólnie różnicujące\"), |Cliff δ| = |2·AUC−1| najlepszego regionu, ε² Kruskala-Wallisa i log2FC median. Każda podłączona segmentacja (jedna tkanka) liczona osobno, potem uśredniana. UWAGA (double dipping): jeśli segmentacja powstała z tych samych m/z, które tu oceniasz, kontrast jest sztucznie zawyżony — węzeł to wykrywa i ostrzega. Lepiej: regiony z innego źródła albo potwierdzenie w \"Powtarzalność między tkankami\". Bez p-wartości — piksele nie są niezależnymi powtórzeniami. Przycisk \"Przetwórz\".",
    domain: "markery", stage: "przetwarzanie",
    inputs: [
      { id: "in", label: "macierz", kind: "macierz" },
      { id: "seg", label: "regiony (segmentacja)", kind: "segmentacja", multi: true },
    ],
    outputs: [{ id: "out", label: "ranking", kind: "ranking" }],
    params: [{ key: "min_region", label: "min. pikseli regionu", min: 5, max: 500, step: 5, default: 20 }],
    evaluate(node, inputs): EvalOutcome {
      const m = asKind(inputs.in[0], "macierz");
      if (!m) return { ok: false, error: "podłącz macierz" };
      const segs = inputs.seg as SegmentacjaValue[];
      if (segs.length === 0) return { ok: false, error: "podłącz segmentację (regiony)" };
      return cachedRanking(node, m, contrastSignature(m, segs, node.params), "kontrast regionów");
    },
  },
  {
    id: "markery/coloc",
    label: "Grupy kolokalizacji",
    detail: "deduplikacja rankingu",
    description: "Łączy w grupy piki o niemal identycznym rozkładzie przestrzennym (Spearman ≥ próg) — zwykle addukty, fragmenty i izotopy JEDNEGO związku. Grupy budowane w kolejności rankingu: pik dołącza do grupy pierwszego wyżej notowanego reprezentanta, z którym jest skorelowany. Tryb \"zostaw reprezentantów\" usuwa z rankingu pozostałych członków grup, żeby top-10 nie było jednym związkiem powtórzonym 3 razy. Przycisk \"Przetwórz\".",
    domain: "markery", stage: "przetwarzanie",
    inputs: [
      { id: "in", label: "ranking", kind: "ranking" },
      { id: "mat", label: "macierz", kind: "macierz" },
    ],
    outputs: [{ id: "out", label: "ranking", kind: "ranking" }],
    params: [
      { key: "r_threshold", label: "próg korelacji (Spearman)", min: 0.5, max: 0.99, step: 0.01, default: 0.8 },
      { key: "mode", label: "Tryb", default: "dedupe", options: ["dedupe", "annotate"] },
    ],
    evaluate(node, inputs): EvalOutcome {
      const r = asKind(inputs.in[0], "ranking");
      const m = asKind(inputs.mat[0], "macierz");
      if (!r || !m) return { ok: false, error: "podłącz ranking i macierz" };
      if (r.matrixId !== m.matrixId) return { ok: false, error: "ranking pochodzi z innej macierzy" };
      const out = cachedRanking(node, m, colocSignature(m, r, node.params), `${r.label} · grupy`);
      if (!out.ok || out.value.kind !== "ranking") return out;
      const rows = node.params.mode === "annotate" ? out.value.rows : out.value.rows.filter((x) => x.metrics.rep !== 0);
      return { ok: true, value: { ...out.value, rows } };
    },
  },
  {
    id: "markery/consistency",
    label: "Powtarzalność między tkankami",
    description: "Porównuje wyniki rankingu między tkankami (skrawkami). Tryb \"zgodne\": wynik = najgorszy percentyl po tkankach — wysoko tylko m/z dobre WE WSZYSTKICH skrawkach, czyli kandydaci na markery ANATOMICZNE (odporne na to, że jeden skrawek ma artefakt). Tryb \"specyficzne\": najlepszy percentyl minus mediana pozostałych — m/z wyróżniające się w JEDNEJ tkance, kandydaci na efekt grupy/leku. Uwaga: skrawki leżą na szkiełku w kolejności REF → KET → MDMA → PSYL, więc efekt \"specyficzny\" może też być gradientem położenia (patrz scripts/11_position_gradient_test.py). Wymaga rankingu z wynikami per tkanka (Ranking przestrzenny, Kontrast regionów z segmentacjami kilku tkanek).",
    domain: "markery", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "ranking", kind: "ranking" }],
    outputs: [{ id: "out", label: "ranking", kind: "ranking" }],
    params: [{ key: "mode", label: "Tryb", default: "anatomical", options: ["anatomical", "specific"] }],
    evaluate(node, inputs): EvalOutcome {
      const r = asKind(inputs.in[0], "ranking");
      if (!r) return { ok: false, error: "podłącz ranking" };
      const rows = consistencyRows(r.rows, String(node.params.mode ?? "anatomical"));
      if (rows.length === 0) return { ok: false, error: "ranking nie ma wyników dla ≥ 2 tkanek" };
      return { ok: true, value: { ...r, label: `${r.label} · ${node.params.mode === "specific" ? "specyficzne" : "zgodne"}`, rows } };
    },
  },
  {
    id: "markery/combine",
    label: "Ranking łączony",
    description: "Łączy do trzech rankingów (np. przestrzenny, kontrast regionów, powtarzalność) w jeden: wynik = średnia ważona percentyli z poszczególnych rankingów (waga 0 = pomiń wejście). Pik nieobecny w którymś rankingu dostaje tam 0. Drugie wyjście \"wynik (widmo)\" to wynik w funkcji m/z jako widmo słupkowe — można je podłączyć do istniejącego węzła \"Top m/z\" albo zapisać jako widmo.",
    domain: "markery", stage: "przetwarzanie",
    inputs: [
      { id: "a", label: "ranking A", kind: "ranking" },
      { id: "b", label: "ranking B", kind: "ranking" },
      { id: "c", label: "ranking C", kind: "ranking" },
    ],
    outputs: [
      { id: "out", label: "ranking", kind: "ranking" },
      { id: "spec", label: "wynik (widmo)", kind: "widmo" },
    ],
    selectOutput: (v, socketId) => (socketId === "spec" && v.kind === "ranking" ? rankingToWidmo(v) : v),
    params: [
      { key: "wa", label: "waga A", min: 0, max: 1, step: 0.05, default: 0.4 },
      { key: "wb", label: "waga B", min: 0, max: 1, step: 0.05, default: 0.4 },
      { key: "wc", label: "waga C", min: 0, max: 1, step: 0.05, default: 0.2 },
    ],
    evaluate(node, inputs): EvalOutcome {
      const parts: { r: RankingValue; w: number; key: string }[] = [];
      for (const [sock, wk] of [["a", "wa"], ["b", "wb"], ["c", "wc"]] as const) {
        const r = asKind(inputs[sock][0], "ranking");
        if (r) parts.push({ r, w: Number(node.params[wk] ?? 0), key: sock });
      }
      if (parts.length === 0) return { ok: false, error: "podłącz przynajmniej jeden ranking" };
      const rows = combineRankings(parts);
      if (rows.length === 0) return { ok: false, error: "wszystkie wagi podłączonych wejść są 0" };
      return { ok: true, value: { kind: "ranking", label: "łączony", matrixId: parts[0].r.matrixId, rows } };
    },
  },
  {
    id: "markery/top_map",
    label: "Mapa z rankingu",
    description: "Mapa pikseli m/z z wybranej pozycji rankingu (1 = najlepszy) — liczona z macierzy, więc z tymi samymi oknami, rekalibracją i normalizacją co ranking. Kliknięcie wiersza tabeli wybiera pozycję. Wyjście to zwykła mapa: można ją zapisać, łączyć z innymi mapami, podać do k-means. Podłącz macierz, z której pochodzi ranking.",
    domain: "markery", stage: "wynik",
    inputs: [
      { id: "in", label: "ranking", kind: "ranking" },
      { id: "mat", label: "macierz", kind: "macierz" },
    ],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [
      { key: "rank", label: "pozycja w rankingu", min: 1, max: 500, step: 1, default: 1 },
      { key: "tissue", label: "tkanka", default: "" },
    ],
    evaluate(node, inputs, ctx): EvalOutcome {
      const r = asKind(inputs.in[0], "ranking");
      const m = asKind(inputs.mat[0], "macierz");
      if (!r || !m) return { ok: false, error: "podłącz ranking i macierz" };
      if (r.matrixId !== m.matrixId) return { ok: false, error: "ranking pochodzi z innej macierzy" };
      const row = r.rows[Math.max(0, Math.round(Number(node.params.rank ?? 1)) - 1)];
      if (!row) return { ok: false, error: "ranking jest krótszy niż wybrana pozycja" };
      const resp = ctx.markerImageCache?.[markerImageKey(m.matrixId, row.peak)];
      if (!resp) return { ok: false, error: "wczytywanie…" };
      const ids = Object.keys(resp.tissues);
      const tid = ids.includes(String(node.params.tissue ?? "")) ? String(node.params.tissue) : ids[0];
      const img = tid ? resp.tissues[tid] : undefined;
      if (!img) return { ok: false, error: "brak tkanek w macierzy" };
      return {
        ok: true,
        value: {
          kind: "mapa", tissueId: tid, tissueLabel: ctx.tissueLabels?.[tid] || img.label,
          width: img.width, height: img.height, data: img.data, mask: img.mask, mode: "single",
          sources: [{ groupIndex: 0, mz: row.mz, tol: 0, datasetId: "", datasetLabel: `ranking #${Number(node.params.rank ?? 1)}` }],
        },
      };
    },
  },
  {
    id: "markery/table",
    label: "Tabela rankingu",
    description: "Pełna tabela rankingu (top N): m/z, wynik, metryki i kandydaci adnotacji FMP-10 (pochodne neuroprzekaźników/leków, ±0.15 Da — tylko podpowiedź, nie identyfikacja). Przyciski kopiują listę m/z w formacie \"[m1;m2;...]\" (zakładka m/z → Grupy → \"Lista m/z\") albo całą tabelę jako CSV (separator \";\"). Węzeł czysto podglądowy.",
    domain: "markery", stage: "wynik",
    inputs: [{ id: "in", label: "ranking", kind: "ranking" }],
    outputs: [],
    params: [{ key: "n", label: "liczba wierszy (N)", min: 5, max: 200, step: 5, default: 25 }],
    evaluate(_node, inputs): EvalOutcome {
      if (!asKind(inputs.in[0], "ranking")) return { ok: false, error: "podłącz ranking" };
      return { ok: false, error: "węzeł podglądowy — brak wyniku liczbowego" };
    },
  },
];

registerNodeTypes(MARKERY_NODE_TYPES);
