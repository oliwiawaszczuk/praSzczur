// Domena "Analiza obrazu" — operacje na POJEDYNCZEJ mapie m/z (intensywność = "kolor"):
// przygotowanie (hotspoty, stabilizacja wariancji), odszumianie z zachowaniem krawędzi
// (mediana, Gauss, bilateral, non-local means, total variation), mapy cech (lokalny CV,
// skupiska Gi*/LISA, krawędzie), progowanie → segment, obiekty, kontrast (CLAHE) i ocena
// (karta jakości, szum metody). Opis i źródła: docs/node-graph.md, "Domena Analiza obrazu".
//
// Liczone w przeglądarce (mapy mają ~4–7 tys. pikseli tkanki, nawet NLM to dziesiątki ms) —
// suwaki działają na żywo, bez "Przetwórz". Żeby evalMemo (przeliczane przy KAŻDEJ zmianie
// grafu) nie liczyło filtrów od nowa, wynik każdej operacji jest zapamiętany po (tablica danych
// wejścia, parametry) — te same dane wejściowe dają TEN SAM obiekt wyniku, więc łańcuch
// kolejnych node'ów też trafia w cache, a podglądy (IonCanvas) się nie przerysowują.

import {
  registerNodeTypes, type NodeTypeDef, type NodeValue, type EvalOutcome, type MapaValue,
  type SegmentValue, type SegmentacjaValue,
} from "./nodegraph";
import * as I from "./imageOps";

// ── Cache ────────────────────────────────────────────────────────────────────
const memo = new WeakMap<object, Map<string, unknown>>();
function cached<T>(key: object, sub: string, f: () => T): T {
  let m = memo.get(key);
  if (!m) { m = new Map(); memo.set(key, m); }
  if (m.has(sub)) return m.get(sub) as T;
  const v = f();
  if (m.size > 30) m.delete(m.keys().next().value as string);
  m.set(sub, v);
  return v;
}
const objIds = new WeakMap<object, number>();
let nextObjId = 1;
function objId(o: object): number {
  let id = objIds.get(o);
  if (!id) { id = nextObjId++; objIds.set(o, id); }
  return id;
}

/** Informacje dodatkowe do podglądu węzła (próg, σ szumu, tabela obiektów…), klucz = wartość wyjścia. */
export const OBRAZ_INFO = new WeakMap<object, Record<string, unknown>>();
/** Wartości dodatkowych gniazd wyjściowych (np. segment obok mapy), klucz = wartość głównego wyjścia. */
const SECONDARY = new WeakMap<object, Record<string, NodeValue>>();

export function gridOf(v: MapaValue | SegmentValue): I.Grid {
  return cached(v.data, `grid|${v.mask ? objId(v.mask) : 0}`, () => I.gridFromRows(v.data, v.mask, v.width, v.height));
}

function mapaFrom(src: MapaValue, g: I.Grid): MapaValue {
  return { ...src, data: I.gridToRows(g), mask: src.mask ?? I.maskToRows(g) };
}

function segmentFrom(src: MapaValue | SegmentValue, bin: Uint8Array, g: I.Grid): SegmentValue {
  const data: number[][] = [];
  for (let y = 0; y < g.h; y++) data.push(Array.from(bin.subarray(y * g.w, (y + 1) * g.w), (b, x) => (g.m[y * g.w + x] && b ? 1 : 0)));
  return { kind: "segment", tissueId: src.tissueId, tissueLabel: src.tissueLabel, width: src.width, height: src.height, data, mask: src.mask ?? I.maskToRows(g), sources: src.sources };
}

function asMapa(v: NodeValue | undefined): MapaValue | null {
  return v && v.kind === "mapa" ? v : null;
}

const NEED_MAP = "podłącz mapę m/z";
const num = (p: Record<string, number | string>, k: string, d: number) => {
  const x = Number(p[k]);
  return Number.isFinite(x) ? x : d;
};
const pkey = (p: Record<string, number | string>) => JSON.stringify(p);

/** Wspólny wzorzec node'a mapa → mapa (z zapamiętaniem wyniku i opcjonalnym info). */
function mapOp(
  inputs: Record<string, NodeValue[]>, params: Record<string, number | string>, tag: string,
  op: (g: I.Grid) => { grid: I.Grid; info?: Record<string, unknown> },
): EvalOutcome {
  const src = asMapa(inputs.in[0]);
  if (!src) return { ok: false, error: NEED_MAP };
  const value = cached(src.data, `${tag}|${src.mask ? objId(src.mask) : 0}|${pkey(params)}`, () => {
    const r = op(gridOf(src));
    const out = mapaFrom(src, r.grid);
    if (r.info) OBRAZ_INFO.set(out, r.info);
    return out;
  });
  return { ok: true, value };
}

/** σ szumu do filtrów: z danych wejścia (estimateNoise), a gdy się nie da — 5% zakresu. */
function sigmaFor(g: I.Grid): number {
  const s = I.estimateNoise(g);
  if (s > 0) return s;
  const vals = I.maskedValues(g);
  let mx = 0;
  for (const x of vals) if (x > mx) mx = x;
  return 0.05 * (mx || 1);
}

export const HOTSPOT_LABELS: Record<string, string> = { pct: "percentyl", mad: "mediana + k·MAD" };
export const VST_LABELS: Record<string, string> = { sqrt: "pierwiastek (sqrt)", log1p: "logarytm log(1+s·x)" };
export const DIRECTION_LABELS: Record<string, string> = { forward: "w przód", inverse: "odwrotna" };
export const YESNO_LABELS_OBRAZ: Record<string, string> = { yes: "tak", no: "nie" };
export const CLUSTER_STAT_LABELS: Record<string, string> = { gi: "Getis-Ord Gi* (z-score)", lisa: "Local Moran (LISA)" };
export const SIDE_LABELS: Record<string, string> = { hot: "wysokie (hot)", cold: "niskie (cold)" };
export const THRESH_LABELS: Record<string, string> = {
  otsu: "Otsu", triangle: "trójkątny (Triangle)", percentile: "percentyl", multiotsu: "multi-Otsu (k klas)",
};
export const ABOVE_LABELS: Record<string, string> = { above: "powyżej progu", below: "poniżej progu" };
export const CONN_LABELS: Record<string, string> = { "4": "4-spójność", "8": "8-spójność" };

export const OBRAZ_PARAM_LABELS: Record<string, string> = {
  ...HOTSPOT_LABELS, ...VST_LABELS, ...DIRECTION_LABELS, ...YESNO_LABELS_OBRAZ, ...CLUSTER_STAT_LABELS,
  ...SIDE_LABELS, ...THRESH_LABELS, ...ABOVE_LABELS, ...CONN_LABELS,
};

const FILTER_NOTE = " Wynik nadaje się do oglądania, segmentacji i progowania — statystyki/rankingi licz dalej na mapie NIEFILTROWANEJ (filtr zmienia intensywności). Parametry dobierzesz węzłem \"Szum metody\".";

const OBRAZ_NODE_TYPES: NodeTypeDef[] = [
  // ── Przygotowanie ──
  {
    id: "obraz/hotspot",
    label: "Usuwanie hotspotów",
    description: "Przycina pojedyncze bardzo jasne piksele (hotspoty), które inaczej \"zjadają\" skalę kolorów i psują progi oraz filtry: do percentyla (domyślnie P99 — standard w METASPACE/Cardinal/SCiLS) albo do mediana + k·MAD (z pikseli z sygnałem). Opcjonalnie przeskalowuje wynik tak, by próg = 1 (pełna skala kolorów). Zwykle pierwszy krok przed innymi node'ami tej grupy.",
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [
      { key: "mode", label: "Metoda", default: "pct", options: ["pct", "mad"] },
      { key: "p", label: "percentyl", min: 90, max: 100, step: 0.1, default: 99 },
      { key: "k", label: "k (dla MAD)", min: 1, max: 20, step: 0.5, default: 5 },
      { key: "rescale", label: "Przeskaluj do 1", default: "yes", options: ["yes", "no"] },
    ],
    evaluate(node, inputs) {
      return mapOp(inputs, node.params, "hotspot", (g) => {
        const r = I.clipHotspots(g, String(node.params.mode ?? "pct"), num(node.params, "p", 99), num(node.params, "k", 5));
        const grid = node.params.rescale === "no" ? r.grid : I.normalizeMax(r.grid).grid;
        return { grid, info: { text: `próg ${r.limit.toPrecision(3)} · przycięto ${r.clipped} px` } };
      });
    },
  },
  {
    id: "obraz/vst",
    label: "Stabilizacja wariancji",
    detail: "sqrt / log",
    description: "Pierwiastek albo log(1+s·x)/log(1+s). Szum w MSI rośnie z intensywnością (bliżej Poissona niż stałego), a filtry NLM/bilateral zakładają szum o STAŁEJ wariancji — stąd zalecany schemat: Stabilizacja (w przód) → filtr → Stabilizacja (odwrotna). Uwaga: to nie jest dokładna transformacja Anscombe'a, bo intensywności po normalizacji TIC nie są zliczeniami; na Twoich danych zależność szumu od intensywności jest różna dla różnych m/z, więc to opcja, a nie obowiązek.",
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [
      { key: "mode", label: "Funkcja", default: "sqrt", options: ["sqrt", "log1p"] },
      { key: "scale", label: "s (dla log)", min: 1, max: 1000, step: 1, default: 100 },
      { key: "direction", label: "Kierunek", default: "forward", options: ["forward", "inverse"] },
    ],
    evaluate(node, inputs) {
      return mapOp(inputs, node.params, "vst", (g) => ({
        grid: I.vst(g, String(node.params.mode ?? "sqrt"), num(node.params, "scale", 100), node.params.direction === "inverse"),
      }));
    },
  },
  {
    id: "obraz/median",
    label: "Filtr medianowy",
    description: "Mediana w oknie (2r+1)² (tylko piksele tkanki). Usuwa pojedyncze gorące/puste piksele (szum typu sól-pieprz) bez rozmywania szerokich krawędzi; przy r ≥ 2 zaokrągla narożniki i usuwa struktury węższe niż okno." + FILTER_NOTE,
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [{ key: "r", label: "promień okna [px]", min: 1, max: 3, step: 1, default: 1 }],
    evaluate(node, inputs) {
      return mapOp(inputs, node.params, "median", (g) => ({ grid: I.medianFilter(g, Math.round(num(node.params, "r", 1))) }));
    },
  },
  // ── Odszumianie ──
  {
    id: "obraz/gaussian",
    label: "Rozmycie Gaussa",
    description: "Zwykłe rozmycie Gaussa (σ w pikselach) — punkt odniesienia dla filtrów z zachowaniem krawędzi: rozmywa też granice struktur. Liczone z normalizacją po pikselach tkanki (\"normalized convolution\"), więc brzeg tkanki nie ciemnieje od zer spoza skanu." + FILTER_NOTE,
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [{ key: "sigma", label: "σ [px]", min: 0.3, max: 5, step: 0.1, default: 1 }],
    evaluate(node, inputs) {
      return mapOp(inputs, node.params, "gauss", (g) => ({ grid: I.gaussianFilter(g, num(node.params, "sigma", 1)) }));
    },
  },
  {
    id: "obraz/bilateral",
    label: "Filtr bilateralny",
    description: "Uśrednia piksel z sąsiadami ważąc jednocześnie bliskość (σ przestrzenne) i podobieństwo intensywności (σ intensywności) — wygładza wnętrza struktur, nie rozmywając ich granic (wagi \"adaptive\" w Cardinal; Alexandrov i in. 2010: odszumianie z zachowaniem krawędzi poprawia segmentację map MSI). σ intensywności podajesz jako wielokrotność szumu mapy (szacowanego automatycznie z różnic sąsiednich pikseli z sygnałem): ~1–2 = ostrożnie, >3 = zbliża się do zwykłego Gaussa." + FILTER_NOTE,
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [
      { key: "sigma_s", label: "σ przestrzenne [px]", min: 0.5, max: 5, step: 0.1, default: 1.5 },
      { key: "sigma_r_k", label: "σ intensywności [× szum]", min: 0.5, max: 10, step: 0.1, default: 2 },
    ],
    evaluate(node, inputs) {
      return mapOp(inputs, node.params, "bilateral", (g) => {
        const s = sigmaFor(g);
        const sr = num(node.params, "sigma_r_k", 2) * s;
        return { grid: I.bilateralFilter(g, num(node.params, "sigma_s", 1.5), sr), info: { text: `szum σ ≈ ${s.toPrecision(3)} → σ intensywności ${sr.toPrecision(3)}` } };
      });
    },
  },
  {
    id: "obraz/nlm",
    label: "Non-local means",
    description: "Uśrednia piksele o podobnym OTOCZENIU (łatce), także odległe w oknie wyszukiwania — zachowuje drobne i powtarzalne struktury lepiej niż filtry lokalne (Buades 2005). Waga = exp(−max(d² − 2σ², 0)/h²), jak w scikit-image. h = k·σ szumu (σ szacowane automatycznie): ~0.6–1 typowo; za duże h rozmywa. Przy szumie zależnym od intensywności użyj schematu Stabilizacja → NLM → Stabilizacja (odwrotna)." + FILTER_NOTE,
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [
      { key: "patch_r", label: "promień łatki [px]", min: 1, max: 3, step: 1, default: 1 },
      { key: "search_r", label: "promień wyszukiwania [px]", min: 2, max: 7, step: 1, default: 5 },
      { key: "h_k", label: "h [× szum]", min: 0.2, max: 3, step: 0.05, default: 0.8 },
    ],
    evaluate(node, inputs) {
      return mapOp(inputs, node.params, "nlm", (g) => {
        const s = sigmaFor(g);
        const h = num(node.params, "h_k", 0.8) * s;
        return {
          grid: I.nlMeans(g, Math.round(num(node.params, "patch_r", 1)), Math.round(num(node.params, "search_r", 5)), h, s),
          info: { text: `szum σ ≈ ${s.toPrecision(3)} → h ${h.toPrecision(3)}` },
        };
      });
    },
  },
  {
    id: "obraz/tv",
    label: "Total variation (ROF)",
    description: "Odszumianie przez minimalizację całkowitej zmienności (Rudin-Osher-Fatemi, algorytm Chambolle'a — jak denoise_tv_chambolle w scikit-image). Zakłada obraz \"kawałkami stały\", co dobrze pasuje do struktur anatomicznych: spłaszcza szum we wnętrzach, zostawia ostre granice. Jeden parametr: waga = k·σ szumu (większa = gładszy wynik, przy dużej znikają małe struktury i powstaje efekt \"schodków\")." + FILTER_NOTE,
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [{ key: "weight_k", label: "waga [× szum]", min: 0.1, max: 10, step: 0.1, default: 1 }],
    evaluate(node, inputs) {
      return mapOp(inputs, node.params, "tv", (g) => {
        const s = sigmaFor(g);
        const wgt = num(node.params, "weight_k", 1) * s;
        return { grid: I.tvChambolle(g, wgt), info: { text: `szum σ ≈ ${s.toPrecision(3)} → waga ${wgt.toPrecision(3)}` } };
      });
    },
  },
  {
    id: "obraz/clahe",
    label: "Kontrast lokalny (CLAHE)",
    description: "Lokalne wyrównanie histogramu z ograniczeniem kontrastu (kafle × kafle, \"clip\" ogranicza wzmocnienie szumu w jednorodnych obszarach). Wyciąga słabe struktury widoczne obok bardzo jasnych. TYLKO do oglądania i segmentacji — całkowicie zmienia proporcje intensywności (wynik to lokalny ranking jasności, 0–1).",
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [
      { key: "tiles", label: "kafle (na bok)", min: 2, max: 8, step: 1, default: 4 },
      { key: "clip", label: "clip (× średnia liczność)", min: 1, max: 10, step: 0.5, default: 2 },
    ],
    evaluate(node, inputs) {
      const t = Math.round(num(node.params, "tiles", 4));
      return mapOp(inputs, node.params, "clahe", (g) => ({ grid: I.clahe(g, t, t, num(node.params, "clip", 2)) }));
    },
  },
  // ── Mapy cech ──
  {
    id: "obraz/local_cv",
    label: "Lokalny CV",
    detail: "σ/μ w oknie",
    description: "Współczynnik zmienności σ/μ w oknie (2r+1)² — mapa niejednorodności: wysoki na granicach struktur i w \"ziarnistych\" obszarach, niski we wnętrzach jednorodnych regionów. Uwaga: w ciemnych obszarach CV rośnie też od samego szumu (σ szumu / mała μ) — dla czytelnej mapy granic licz go na mapie po odszumieniu. Piksele bez sygnału (μ < 5% średniej) dostają 0. Wynik przeskalowany do maks. = 1; globalny CV całej mapy jest w \"Karcie jakości\".",
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [{ key: "r", label: "promień okna [px]", min: 1, max: 5, step: 1, default: 2 }],
    evaluate(node, inputs) {
      return mapOp(inputs, node.params, "localcv", (g) => {
        const n = I.normalizeMax(I.localCV(g, Math.round(num(node.params, "r", 2))));
        return { grid: n.grid, info: { text: `maks. CV ${n.max.toPrecision(3)} (= 1 na mapie)` } };
      });
    },
  },
  {
    id: "obraz/clusters",
    label: "Skupiska (Gi* / LISA)",
    description: "Lokalne statystyki przestrzenne. Getis-Ord Gi*: z-score — gdzie skupiają się wysokie (z > 0, hot) i niskie (z < 0, cold) wartości w oknie (2r+1)². Local Moran (LISA): > 0 gdy piksel jest podobny do otoczenia (skupisko), < 0 gdy odstaje od niego (pojedyncze odstające piksele). Mapa: 0.5 = zero, jaśniej = hot/skupisko, ciemniej = cold/odstający. Wyjście \"segment\": piksele skupisk wybranej strony (Gi*: |z| ≥ próg; LISA: skupiska HH albo LL). P-wartości per piksel są tu tylko orientacyjne — piksele nie są niezależne i testów jest tysiące.",
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [
      { id: "out", label: "mapa", kind: "mapa" },
      { id: "seg", label: "segment", kind: "segment" },
    ],
    params: [
      { key: "stat", label: "Statystyka", default: "gi", options: ["gi", "lisa"] },
      { key: "r", label: "promień okna [px]", min: 1, max: 5, step: 1, default: 2 },
      { key: "z_thr", label: "próg z (Gi*)", min: 1, max: 6, step: 0.1, default: 2.58 },
      { key: "side", label: "Segment", default: "hot", options: ["hot", "cold"] },
    ],
    selectOutput: (v, socketId) => (socketId === "seg" ? SECONDARY.get(v)?.seg ?? v : v),
    evaluate(node, inputs) {
      const src = asMapa(inputs.in[0]);
      if (!src) return { ok: false, error: NEED_MAP };
      const value = cached(src.data, `clusters|${src.mask ? objId(src.mask) : 0}|${pkey(node.params)}`, () => {
        const g = gridOf(src);
        const r = Math.round(num(node.params, "r", 2));
        const hot = node.params.side !== "cold";
        const bin = new Uint8Array(g.v.length);
        let shown: I.Grid;
        let text: string;
        if (node.params.stat === "lisa") {
          const L = I.localMoran(g, r);
          const vals = I.maskedValues(g);
          const mean = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1);
          const absI = I.maskedValues(L).map(Math.abs).sort((a, b) => a - b);
          const lim = I.quantile(absI, 0.99) || 1;
          for (let i = 0; i < bin.length; i++) if (g.m[i] && L.v[i] > 0 && (hot ? g.v[i] > mean : g.v[i] < mean)) bin[i] = 1;
          shown = I.signedToUnit(L, lim);
          text = `LISA, skala ±${lim.toPrecision(3)}`;
        } else {
          const z = I.getisOrdGi(g, r);
          const thr = num(node.params, "z_thr", 2.58);
          for (let i = 0; i < bin.length; i++) if (g.m[i] && (hot ? z.v[i] >= thr : z.v[i] <= -thr)) bin[i] = 1;
          shown = I.signedToUnit(z, 2 * thr);
          text = `Gi*, skala z ±${(2 * thr).toFixed(1)}`;
        }
        const out = mapaFrom(src, shown);
        const seg = segmentFrom(src, bin, g);
        SECONDARY.set(out, { seg });
        OBRAZ_INFO.set(out, { text: `${text} · segment: ${bin.reduce((a, b) => a + b, 0)} px` });
        return out;
      });
      return { ok: true, value };
    },
  },
  {
    id: "obraz/edges",
    label: "Krawędzie",
    detail: "Sobel · Canny",
    description: "Granice struktur. Wyjście \"mapa\": moduł gradientu Sobela po wygładzeniu Gaussem σ (przeskalowany do maks. = 1). Wyjście \"segment\": cienkie krawędzie Canny'ego (tłumienie niemaksymalne + histereza; progi dolny/górny jako ułamek maks. gradientu). Brzeg tkanki NIE jest traktowany jako krawędź (brakujący sąsiad = wartość piksela środkowego).",
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [
      { id: "out", label: "mapa", kind: "mapa" },
      { id: "seg", label: "krawędzie (segment)", kind: "segment" },
    ],
    params: [
      { key: "sigma", label: "σ wygładzenia [px]", min: 0.3, max: 3, step: 0.1, default: 1 },
      { key: "low", label: "próg dolny (Canny)", min: 0.02, max: 0.6, step: 0.01, default: 0.1 },
      { key: "high", label: "próg górny (Canny)", min: 0.05, max: 0.95, step: 0.01, default: 0.3 },
    ],
    selectOutput: (v, socketId) => (socketId === "seg" ? SECONDARY.get(v)?.seg ?? v : v),
    evaluate(node, inputs) {
      const src = asMapa(inputs.in[0]);
      if (!src) return { ok: false, error: NEED_MAP };
      const value = cached(src.data, `edges|${src.mask ? objId(src.mask) : 0}|${pkey(node.params)}`, () => {
        const g = gridOf(src);
        const sigma = num(node.params, "sigma", 1);
        const s = I.sobel(I.gaussianFilter(g, sigma));
        const mag = I.normalizeMax({ ...g, v: s.mag }).grid;
        const out = mapaFrom(src, mag);
        const bin = I.canny(g, sigma, num(node.params, "low", 0.1), num(node.params, "high", 0.3));
        SECONDARY.set(out, { seg: segmentFrom(src, bin, g) });
        OBRAZ_INFO.set(out, { text: `Canny: ${bin.reduce((a, b) => a + b, 0)} px krawędzi` });
        return out;
      });
      return { ok: true, value };
    },
  },
  // ── Progowanie / obiekty ──
  {
    id: "obraz/threshold",
    label: "Progowanie",
    detail: "Otsu · Triangle · multi-Otsu",
    description: "Zamienia mapę na segment (piksele powyżej/poniżej progu). Metody: Otsu (maks. wariancja międzyklasowa — dobra, gdy histogram ma 2 wyraźne garby), Triangle (dobra dla histogramów skośnych z dużym pikiem tła — typowe dla map MSI), percentyl, multi-Otsu (k klas; wyjście \"segmentacja\" = k poziomów, segment = klasa najwyższa/najniższa). \"Pomiń zera\" liczy próg tylko z pikseli z sygnałem — w Twoich mapach ~44% pikseli tkanki to 0 i bez tego próg ląduje przy zerze. Najlepiej na mapie po usunięciu hotspotów i odszumieniu.",
    domain: "obraz", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [
      { id: "out", label: "segment", kind: "segment" },
      { id: "levels", label: "poziomy (segmentacja)", kind: "segmentacja" },
    ],
    params: [
      { key: "method", label: "Metoda", default: "otsu", options: ["otsu", "triangle", "percentile", "multiotsu"] },
      { key: "pct", label: "percentyl", min: 1, max: 99, step: 1, default: 75 },
      { key: "classes", label: "klasy (multi-Otsu)", min: 2, max: 5, step: 1, default: 3 },
      { key: "side", label: "Segment", default: "above", options: ["above", "below"] },
      { key: "ignore_zeros", label: "Pomiń zera przy liczeniu progu", default: "yes", options: ["yes", "no"] },
    ],
    selectOutput: (v, socketId) => (socketId === "levels" ? SECONDARY.get(v)?.levels ?? v : v),
    evaluate(node, inputs) {
      const src = asMapa(inputs.in[0]);
      if (!src) return { ok: false, error: NEED_MAP };
      const value = cached(src.data, `thr|${src.mask ? objId(src.mask) : 0}|${pkey(node.params)}`, () => {
        const g = gridOf(src);
        let vals = I.maskedValues(g);
        if (node.params.ignore_zeros !== "no") vals = vals.filter((x) => x > 0);
        const method = String(node.params.method ?? "otsu");
        let thr: number[];
        if (method === "triangle") thr = [I.triangle(vals)];
        else if (method === "percentile") thr = [I.quantile([...vals].sort((a, b) => a - b), num(node.params, "pct", 75) / 100)];
        else if (method === "multiotsu") thr = I.multiOtsu(vals, Math.round(num(node.params, "classes", 3)));
        else thr = [I.otsu(vals)];
        if (thr.length === 0) thr = [0];
        const above = node.params.side !== "below";
        const top = thr[thr.length - 1];
        const bottom = thr[0];
        const bin = new Uint8Array(g.v.length);
        const labels: number[][] = [];
        const counts = new Array<number>(thr.length + 1).fill(0);
        for (let y = 0; y < g.h; y++) {
          const row = new Array<number>(g.w).fill(-1);
          for (let x = 0; x < g.w; x++) {
            const i = y * g.w + x;
            if (!g.m[i]) continue;
            const val = g.v[i];
            if (above ? val > top : val <= bottom) bin[i] = 1;
            let k = 0;
            while (k < thr.length && val > thr[k]) k++;
            row[x] = k;
            counts[k]++;
          }
          labels.push(row);
        }
        const seg = segmentFrom(src, bin, g);
        const levels: SegmentacjaValue = {
          kind: "segmentacja", tissueId: src.tissueId, tissueLabel: src.tissueLabel, width: src.width, height: src.height,
          k: thr.length + 1, labels, legend: counts.map((count, label) => ({ label, count })), mask: seg.mask, sources: src.sources,
        };
        SECONDARY.set(seg, { levels });
        OBRAZ_INFO.set(seg, { text: `próg: ${thr.map((t) => t.toPrecision(3)).join(", ")} · segment ${bin.reduce((a, b) => a + b, 0)} px` });
        return seg;
      });
      return { ok: true, value };
    },
  },
  {
    id: "obraz/objects",
    label: "Obiekty",
    description: "Spójne obszary segmentu (4- albo 8-spójność): odrzuca obiekty mniejsze niż min. pole i opcjonalnie zostawia tylko N największych. Tabela pokazuje dla każdego obiektu pole [px], środek oraz — jeśli podłączysz mapę intensywności — średnią i maksimum intensywności w obiekcie.",
    domain: "obraz", stage: "przetwarzanie",
    inputs: [
      { id: "in", label: "segment", kind: "segment" },
      { id: "map", label: "mapa (opcjonalna)", kind: "mapa" },
    ],
    outputs: [{ id: "out", label: "segment", kind: "segment" }],
    params: [
      { key: "conn", label: "Spójność", default: "8", options: ["4", "8"] },
      { key: "min_area", label: "min. pole [px]", min: 1, max: 500, step: 1, default: 10 },
      { key: "top_n", label: "zostaw N największych (0 = wszystkie)", min: 0, max: 50, step: 1, default: 0 },
    ],
    evaluate(node, inputs) {
      const seg = inputs.in[0];
      if (!seg || seg.kind !== "segment") return { ok: false, error: "podłącz segment" };
      const mp = asMapa(inputs.map[0]);
      const key = `obj|${seg.mask ? objId(seg.mask) : 0}|${mp ? objId(mp.data) : 0}|${pkey(node.params)}`;
      const value = cached(seg.data, key, () => {
        const g = gridOf(seg);
        const bin = new Uint8Array(g.v.length);
        for (let i = 0; i < bin.length; i++) bin[i] = g.m[i] && g.v[i] >= 0.5 ? 1 : 0;
        const { labels, n } = I.connectedComponents(bin, g.w, g.h, node.params.conn !== "4");
        const ig = mp && mp.width === seg.width && mp.height === seg.height ? gridOf(mp) : undefined;
        let st = I.objectStats(labels, n, g.w, ig).filter((o) => o.area >= num(node.params, "min_area", 10));
        st.sort((a, b) => b.area - a.area);
        const topN = Math.round(num(node.params, "top_n", 0));
        if (topN > 0) st = st.slice(0, topN);
        const keep = new Set(st.map((o) => o.label));
        const outBin = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) if (labels[i] >= 0 && keep.has(labels[i])) outBin[i] = 1;
        const out = segmentFrom(seg, outBin, g);
        OBRAZ_INFO.set(out, { objects: st, total: n, withIntensity: !!ig });
        return out;
      });
      return { ok: true, value };
    },
  },
  // ── Ocena ──
  {
    id: "obraz/quality",
    label: "Karta jakości mapy",
    description: "Liczby opisujące mapę: Moran I (spójność przestrzenna; ~0 = szum), spatial chaos (Alexandrov & Bartels, jak w METASPACE — bliżej 1 = więcej struktury; wartości są blisko 1 i znaczenie mają różnice w 3. miejscu po przecinku), Gini (skupienie sygnału w części tkanki), globalny CV (σ/μ), % pikseli z sygnałem, szacowany szum σ i SNR = (P95 − mediana)/σ, oraz histogram intensywności. Podłącz tę samą mapę przed i po filtrze do dwóch kart, żeby porównać. Węzeł czysto podglądowy.",
    domain: "obraz", stage: "wynik",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [],
    params: [],
    evaluate(_node, inputs) {
      if (!asMapa(inputs.in[0])) return { ok: false, error: NEED_MAP };
      return { ok: false, error: "węzeł podglądowy — brak wyniku liczbowego" };
    },
  },
  {
    id: "obraz/method_noise",
    label: "Szum metody",
    detail: "przed − po",
    description: "Narzędzie do doboru parametrów filtra (pojęcie z pracy o non-local means): residuum = mapa PRZED filtrem − mapa PO filtrze. Jeśli filtr usunął tylko szum, residuum nie ma struktury (Moran I ≈ 0) i jego σ jest zbliżone do szumu wejścia; jeśli w residuum widać anatomię (Moran I wyraźnie > 0), filtr zjadł sygnał — zmniejsz siłę. Mapa: 0.5 = brak różnicy.",
    domain: "obraz", stage: "wynik",
    inputs: [
      { id: "a", label: "przed filtrem", kind: "mapa" },
      { id: "b", label: "po filtrze", kind: "mapa" },
    ],
    outputs: [{ id: "out", label: "residuum", kind: "mapa" }],
    params: [],
    evaluate(_node, inputs) {
      const a = asMapa(inputs.a[0]);
      const b = asMapa(inputs.b[0]);
      if (!a || !b) return { ok: false, error: "podłącz mapę przed i po filtrze" };
      if (a.width !== b.width || a.height !== b.height) return { ok: false, error: "mapy mają różne wymiary (inna tkanka?)" };
      const value = cached(a.data, `mn|${objId(b.data)}`, () => {
        const r = I.methodNoise(gridOf(a), gridOf(b));
        const out = mapaFrom(a, I.signedToUnit(r.residual, 3 * (r.resSd || 1)));
        const verdict = !Number.isFinite(r.moran) ? "brak różnicy"
          : r.moran < 0.1 ? "usunięto głównie szum ✓"
            : r.moran < 0.3 ? "usunięto trochę struktury — rozważ słabszy filtr"
              : "usunięto strukturę — filtr za mocny";
        OBRAZ_INFO.set(out, {
          text: `Moran I residuum ${Number.isFinite(r.moran) ? r.moran.toFixed(3) : "–"} · σ residuum ${r.resSd.toPrecision(3)} vs szum wejścia ${r.noiseIn.toPrecision(3)} → ${verdict}`,
          bad: r.moran >= 0.3,
        });
        return out;
      });
      return { ok: true, value };
    },
  },
];

registerNodeTypes(OBRAZ_NODE_TYPES);

/** Karta jakości dla mapy (memo po danych) — podgląd węzła obraz/quality. */
export function qualityOf(v: MapaValue): I.QualityCard {
  return cached(v.data, `quality|${v.mask ? objId(v.mask) : 0}`, () => I.qualityCard(gridOf(v)));
}
