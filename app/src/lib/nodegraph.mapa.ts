// Domena "Mapa pikseli" dla ujednoliconego node graphu (patrz nodegraph.ts).
// Przeniesione bez zmian logiki z dawnego mzgraphnodes.ts — tylko rejestr i
// evaluate() dopasowane do generycznego silnika (gniazda zamiast pojedynczego
// in/out, evaluate zamiast rekurencyjnego evaluateMzNode).

import type { CombineMode } from "./tissueMerge";
import { windowValue, combineMasks } from "./tissueMerge";
import {
  registerNodeTypes, dedupeSources, DEFAULT_CURVE_POINTS,
  type NodeTypeDef, type NodeValue, type MapaValue, type EvalOutcome, type CurvePoint,
} from "./nodegraph";

/** CombineMode (tissueMerge.ts) rozszerzony o tryby specyficzne dla węzła
 * "Łączenie": arytmetyczne odejmowanie oraz maskowanie binarne (0/1, próg
 * 0.5) — pierwsze podłączone wejście to baza, reszta to maska/odejmowana
 * wartość (przydatne np. do odjęcia segmentu z domeny Segmentacja). */
export type CombineModeExt = CombineMode | "subtract" | "mask_exclude" | "mask_keep";

export const COMBINE_MODE_LABELS: Record<CombineModeExt, string> = {
  mean: "średnia",
  sum: "suma",
  max: "maksimum",
  multiply: "iloczyn",
  subtract: "różnica (baza − reszta)",
  mask_exclude: "maska — wytnij",
  mask_keep: "maska — zachowaj tylko",
};
export const COMBINE_MODE_LIST: CombineModeExt[] = ["mean", "sum", "max", "multiply", "subtract", "mask_exclude", "mask_keep"];

function combineArrays(arrays: number[][][], mode: CombineModeExt): number[][] {
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
      else if (mode === "subtract") v = Math.max(0, vals[0] - vals.slice(1).reduce((a, b) => a + b, 0));
      else if (mode === "mask_exclude") v = vals.slice(1).some((m) => m >= 0.5) ? 0 : vals[0];
      else if (mode === "mask_keep") v = vals.slice(1).every((m) => m >= 0.5) ? vals[0] : 0;
      else v = vals.reduce((a, b) => a + b, 0) / vals.length; // mean
      out[y][x] = v;
    }
  }
  return out;
}

// Kawałkowo-liniowa interpolacja krzywej (jak "Curves"/"Levels" w GIMP): v w
// skali 0–1 (konwencja aplikacji: 1.0 = 100%), punkty w procentach 0–100.
export function applyCurve(v: number, points: CurvePoint[]): number {
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

/** Histogram wartości mapy (do podglądu w edytorze krzywej), pomijając
 * piksele tła (mask[y][x] === 0). */
export function computeHistogram(data: number[][], bins = 40, mask?: number[][]): number[] {
  const counts = new Array(bins).fill(0);
  for (let y = 0; y < data.length; y++) {
    const row = data[y];
    const maskRow = mask?.[y];
    for (let x = 0; x < row.length; x++) {
      if (maskRow && maskRow[x] === 0) continue;
      const pct = row[x] * 100;
      let idx = Math.floor((pct / 100) * bins);
      if (idx < 0) idx = 0;
      if (idx >= bins) idx = bins - 1;
      counts[idx]++;
    }
  }
  return counts;
}

function asMapa(v: NodeValue, socketLabel: string): MapaValue | { error: string } {
  if (v.kind !== "mapa") return { error: `wejście "${socketLabel}" musi być mapą` };
  return v;
}

const MAPA_NODE_TYPES: NodeTypeDef[] = [
  {
    id: "mapa/map_source",
    label: "Mapa m/z",
    description: "Zapisana mapa pikseli m/z z podzakładki \"Zapisane\".",
    domain: "mapa", stage: "dane",
    inputs: [],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [],
    evaluate(node, _inputs, ctx): EvalOutcome {
      const id = node.savedMapId;
      if (!id) return { ok: false, error: "wybierz zapisaną mapę" };
      if (!ctx.savedMapExists(id)) return { ok: false, error: "wybrana mapa została usunięta" };
      const full = ctx.mapCache[id];
      if (!full) return { ok: false, error: "wczytywanie…" };
      return {
        ok: true,
        value: {
          kind: "mapa", tissueId: full.tissueId, tissueLabel: full.tissueLabel,
          width: full.width, height: full.height, data: full.data, mask: full.mask,
          mode: full.mode, sources: full.sources,
        },
      };
    },
  },
  {
    id: "mapa/intensity_range",
    label: "Zakres intensywności",
    description: "Przycina/rozciąga intensywność mapy do zadanego okna 0–100%.",
    domain: "mapa", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0];
      if (!src) return { ok: false, error: "podłącz wejście" };
      const checked = asMapa(src, "mapa");
      if ("error" in checked) return { ok: false, error: checked.error };
      const minPct = Number(node.params.min ?? 0);
      const maxPct = Number(node.params.max ?? 100);
      const data = checked.data.map((row) => row.map((v) => windowValue(v, minPct / 100, maxPct / 100, false)));
      return { ok: true, value: { ...checked, data } };
    },
  },
  {
    id: "mapa/curve",
    label: "Krzywa intensywności",
    description: "Nieliniowe przekształcenie intensywności krzywą (jak Poziomy/Krzywe w GIMP) — z histogramem, pomaga np. przygasić piksele bliskie 100%.",
    domain: "mapa", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0];
      if (!src) return { ok: false, error: "podłącz wejście" };
      const checked = asMapa(src, "mapa");
      if ("error" in checked) return { ok: false, error: checked.error };
      const points = node.curvePoints && node.curvePoints.length >= 2 ? node.curvePoints : DEFAULT_CURVE_POINTS;
      const sorted = [...points].sort((a, b) => a.x - b.x);
      const data = checked.data.map((row) => row.map((v) => applyCurve(v, sorted)));
      return { ok: true, value: { ...checked, data } };
    },
  },
  {
    id: "mapa/combine",
    label: "Łączenie",
    description: "Łączy wiele map pikseli (tej samej tkanki) w jedną: średnia/suma/maksimum/iloczyn, albo odejmowanie/maskowanie — w tych dwóch ostatnich pierwsze podłączone wejście to baza, kolejne to maska/odejmowana wartość (przydatne np. do odjęcia segmentu z domeny Segmentacja).",
    domain: "mapa", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapy", kind: "mapa", multi: true }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const results = inputs.in as MapaValue[];
      if (results.length === 0) return { ok: false, error: "podłącz przynajmniej jedną mapę" };
      const { width, height } = results[0];
      if (results.some((r) => r.width !== width || r.height !== height)) {
        return { ok: false, error: "podłączone mapy mają różne wymiary — nie można połączyć" };
      }
      const tissueId = results[0].tissueId;
      if (results.some((r) => r.tissueId !== tissueId)) {
        return { ok: false, error: "podłączone mapy pochodzą z różnych tkanek" };
      }
      const mode = (node.params.mode as CombineModeExt) ?? "mean";
      const data = results.length === 1 ? results[0].data : combineArrays(results.map((r) => r.data), mode);
      const mask = results.length === 1 ? results[0].mask : combineMasks(results.map((r) => r.mask), height, width);
      return {
        ok: true,
        value: {
          kind: "mapa", tissueId, tissueLabel: results[0].tissueLabel, width, height, data, mask,
          mode: results.length === 1 ? results[0].mode : mode,
          sources: dedupeSources(results.flatMap((r) => r.sources)),
        },
      };
    },
  },
  {
    id: "mapa/invert",
    label: "Odwrócenie kolorów",
    description: "Odwraca intensywność mapy pikseli (v → 1 − v) — jasne miejsca stają się ciemnymi i odwrotnie.",
    domain: "mapa", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [{ id: "out", label: "mapa", kind: "mapa" }],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0];
      if (!src) return { ok: false, error: "podłącz wejście" };
      const checked = asMapa(src, "mapa");
      if ("error" in checked) return { ok: false, error: checked.error };
      const data = checked.data.map((row) => row.map((v) => 1 - v));
      return { ok: true, value: { ...checked, data } };
    },
  },
  {
    id: "mapa/save_output",
    label: "Zapis",
    description: "Zapisuje mapę wynikową jako nową mapę pikseli w podzakładce \"Zapisane\". Działa wyłącznie dla map domeny Mapa (ciągła intensywność) — do zapisu segmentu (maska 0/1) służy osobny węzeł \"Zapis segmentu\" (domena Segmentacja), bo to inny rodzaj danych.",
    domain: "mapa", stage: "wynik",
    inputs: [{ id: "in", label: "mapa", kind: "mapa" }],
    outputs: [],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0];
      if (!src) return { ok: false, error: "podłącz wejście" };
      const checked = asMapa(src, "mapa");
      if ("error" in checked) return { ok: false, error: checked.error };
      return { ok: true, value: checked };
    },
  },
];

registerNodeTypes(MAPA_NODE_TYPES);
