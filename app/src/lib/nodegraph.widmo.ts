// Domena "Widmo" dla ujednoliconego node graphu (patrz nodegraph.ts) — nowa,
// niezależna od starszego, liniowego edytora preprocessingu "preWidma"
// (prenodes.ts/PreNodesEditor.svelte, patrz docs/node-graph.md "świadomie poza
// zakresem"). Te dwa grafy NIE dzielą kodu: preWidma projektuje ZESTAW DANYCH
// (łańcuch bez gałęzi, źródło→wynik dla całej tkanki), Widmo w Node Graph
// operuje na POJEDYNCZYCH, już wyliczonych widmach płynących przez ogólny DAG
// (mogą łączyć się z domenami Mapa/Segmentacja — np. "Widmo z segmentu").
//
// Węzły wymagające wywołania backendu (smooth/baseline/peakpick — algorytmy
// scipy w src/msi/preprocessing.py — oraz from_segment — agregacja tysięcy
// pikseli, zbyt kosztowna żeby ciągnąć do przeglądarki pojedynczo) NIE robią
// tego automatycznie przy każdym evaluate() — silnik grafu jest dziś zawsze
// synchroniczny (patrz komentarz przy NodeTypeDef.evaluate w nodegraph.ts).
// Zamiast przepisywać silnik na async (ryzykowne — evalNode() jest dziś
// wołane wprost w renderze Svelte w wielu miejscach NodeGraphTab.svelte),
// te węzły idą dokładnie tym samym wzorcem co już istniejące
// "segmentacja/kmeans": ręczny przycisk "Przetwórz" w NodeGraphTab.svelte woła
// backend i zapisuje wynik w node.widmoProcessCache, a evaluate() tylko czyta
// ten cache (błąd "kliknij Przetwórz…", jeśli pusty/nieaktualny).

import {
  registerNodeTypes, type NodeTypeDef, type NodeValue, type WidmoValue, type SegmentValue, type EvalOutcome,
} from "./nodegraph";

/** Te same 4 tryby co user chciał dla "łączenia" i "widma z segmentu" —
 * spójne z konwencją mapa/combine (subtract = pierwsze wejście minus suma
 * reszty), tylko na wektorach 1D (intensywność wzdłuż wspólnej osi m/z)
 * zamiast na macierzach 2D (piksele). */
export type WidmoCombineMode = "sum" | "mean" | "max" | "diff";
export const WIDMO_COMBINE_MODE_LABELS: Record<WidmoCombineMode, string> = {
  sum: "suma",
  mean: "średnia",
  max: "maksimum",
  diff: "różnica (pierwsze − reszta)",
};
export const WIDMO_COMBINE_MODE_LIST: WidmoCombineMode[] = ["sum", "mean", "max", "diff"];

export type WidmoNormalizeMode = "none" | "max" | "tic";
export const WIDMO_NORMALIZE_MODE_LABELS: Record<WidmoNormalizeMode, string> = {
  none: "brak", max: "max", tic: "TIC",
};
export const WIDMO_NORMALIZE_MODE_LIST: WidmoNormalizeMode[] = ["none", "max", "tic"];

/** Łączy wiele wektorów intensywności (ta sama oś m/z) wybraną operacją —
 * odpowiednik combineArrays z nodegraph.mapa.ts, ale na 1D. */
export function combineVectors(vectors: number[][], mode: WidmoCombineMode): number[] {
  const n = vectors[0].length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const vals = vectors.map((v) => v[i]);
    if (mode === "sum") out[i] = vals.reduce((a, b) => a + b, 0);
    else if (mode === "max") out[i] = Math.max(...vals);
    else if (mode === "diff") out[i] = Math.max(0, vals[0] - vals.slice(1).reduce((a, b) => a + b, 0));
    else out[i] = vals.reduce((a, b) => a + b, 0) / vals.length; // mean
  }
  return out;
}

/** Ta sama logika co normalize() w Widma.svelte (celowo po stronie klienta,
 * bez wywołania backendu — normalize_tic w Pythonie liczy do MEDIANY TIC
 * całej tkanki, sensownej tylko dla widma pojedynczego piksela; tu widmo
 * płynące przez graf może być już połączeniem/agregacją wielu pikseli, więc
 * jedyna spójna opcja to normalizacja do WŁASNEGO maksimum/sumy). */
export function normalizeVector(intensity: number[], mode: WidmoNormalizeMode): number[] {
  if (mode === "none") return intensity;
  const ref = mode === "max" ? Math.max(...intensity) : intensity.reduce((a, b) => a + b, 0);
  if (ref === 0) return intensity;
  return intensity.map((v) => v / ref);
}

/** Odcisk wejścia dla "widmo/from_segment" (patrz WidmoProcessCache) — musi
 * być identycznie liczony tu (evaluate) i w NodeGraphTab.svelte
 * (runFromSegmentNode, po faktycznym wywołaniu backendu), inaczej cache
 * nigdy by się nie zgadzał. Nie porównuje zawartości maski piksel-po-pikselu
 * (jak KmeansResult też tego nie robi) — tylko tissueId/wymiary/tryb/zestaw. */
export function segmentInputSignature(
  tissueId: string, width: number, height: number, mode: string, dataset: string,
): string {
  return `${tissueId}|${width}x${height}|${mode}|${dataset}`;
}

/** Odcisk wejścia dla węzłów z ręcznym "Przetwórz" (patrz WidmoProcessCache) —
 * NIE porównuje wartości widma piksel-po-pikselu (jak KmeansResult też tego
 * nie robi dla map), tylko wystarczające sygnały zmiany: długość + suma
 * intensywności (tania, ale czuła na zmianę kształtu) + parametry węzła. */
export function widmoInputSignature(mz: number[], intensity: number[], params: Record<string, number | string>): string {
  const sum = intensity.reduce((a, b) => a + b, 0);
  return `${mz.length}|${intensity.length}|${sum.toFixed(3)}|${JSON.stringify(params)}`;
}

function asWidmo(v: NodeValue, socketLabel: string): WidmoValue | { error: string } {
  if (v.kind !== "widmo") return { error: `wejście "${socketLabel}" musi być widmem` };
  return v;
}

function sameMzGrid(a: WidmoValue, b: WidmoValue): boolean {
  return a.mz.length === b.mz.length;
}

const WIDMO_NODE_TYPES: NodeTypeDef[] = [
  {
    id: "widmo/spectrum_source",
    label: "Zapisane widmo",
    description: "Widmo zapisane w bibliotece \"Zapisane widma\" — z zakładki Widma (pojedynczy piksel) albo obliczone wcześniej w Node Graph.",
    domain: "widmo", stage: "dane",
    inputs: [],
    outputs: [{ id: "out", label: "widmo", kind: "widmo" }],
    params: [],
    evaluate(node, _inputs, ctx): EvalOutcome {
      const id = node.savedSpectrumId;
      if (!id) return { ok: false, error: "wybierz zapisane widmo" };
      if (!ctx.savedSpectrumExists(id)) return { ok: false, error: "wybrane widmo zostało usunięte" };
      const full = ctx.spectrumCache[id];
      if (!full) return { ok: false, error: "wczytywanie…" };
      return {
        ok: true,
        value: {
          kind: "widmo", tissueId: full.tissueId, tissueLabel: full.tissueLabel, label: full.name,
          mz: full.mz, intensity: full.intensity, mode: full.mode, sources: full.sources,
        },
      };
    },
  },
  {
    id: "widmo/from_segment",
    label: "Widmo z segmentu",
    description: "Agreguje widma WSZYSTKICH pikseli segmentu w jedno widmo (suma/średnia/maksimum/różnica). Liczone na backendzie (potencjalnie tysiące pikseli) — przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "widmo", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "segment", kind: "segment" }],
    outputs: [{ id: "out", label: "widmo", kind: "widmo" }],
    params: [{ key: "mode", label: "Sposób agregacji", default: "mean", options: WIDMO_COMBINE_MODE_LIST }],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0] as SegmentValue | undefined;
      if (!src) return { ok: false, error: "podłącz wejście (segment)" };
      if (!node.widmoProcessCache) return { ok: false, error: "kliknij \"Przetwórz\", żeby policzyć widmo segmentu" };
      const cache = node.widmoProcessCache;
      const sig = segmentInputSignature(src.tissueId, src.width, src.height, String(node.params.mode ?? "mean"), String(node.params.dataset ?? ""));
      if (cache.inputSignature !== sig) return { ok: false, error: "wejście zmieniło się od ostatniego przetworzenia — kliknij \"Przetwórz\" ponownie" };
      return {
        ok: true,
        value: {
          kind: "widmo", tissueId: src.tissueId, tissueLabel: src.tissueLabel,
          label: `Widmo z segmentu (${WIDMO_COMBINE_MODE_LABELS[(node.params.mode as WidmoCombineMode) ?? "mean"]})`,
          mz: cache.mz, intensity: cache.intensity,
          mode: (node.params.mode as WidmoCombineMode) === "diff" ? "diff" : (node.params.mode as WidmoCombineMode) ?? "mean",
          sources: [{ note: `segment (${WIDMO_COMBINE_MODE_LABELS[(node.params.mode as WidmoCombineMode) ?? "mean"]}, tkanka ${src.tissueLabel})` }],
        },
      };
    },
  },
  {
    id: "widmo/combine",
    label: "Łączenie",
    description: "Łączy wiele widm (tej samej tkanki, tej samej siatki m/z) w jedno: suma/średnia/maksimum/różnica (pierwsze podłączone wejście minus wszystkie pozostałe).",
    domain: "widmo", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "widma", kind: "widmo", multi: true }],
    outputs: [{ id: "out", label: "widmo", kind: "widmo" }],
    params: [{ key: "mode", label: "Sposób łączenia", default: "sum", options: WIDMO_COMBINE_MODE_LIST }],
    evaluate(node, inputs): EvalOutcome {
      const results = inputs.in as WidmoValue[];
      if (results.length === 0) return { ok: false, error: "podłącz przynajmniej jedno widmo" };
      if (results.some((r) => !sameMzGrid(results[0], r))) {
        return { ok: false, error: "podłączone widma mają różne siatki m/z — ujednolić (np. ten sam bin size) przed łączeniem" };
      }
      const tissueId = results[0].tissueId;
      if (results.some((r) => r.tissueId !== tissueId)) {
        return { ok: false, error: "podłączone widma pochodzą z różnych tkanek" };
      }
      const mode = (node.params.mode as WidmoCombineMode) ?? "sum";
      const intensity = results.length === 1 ? results[0].intensity : combineVectors(results.map((r) => r.intensity), mode);
      return {
        ok: true,
        value: {
          kind: "widmo", tissueId, tissueLabel: results[0].tissueLabel,
          label: `Łączenie (${WIDMO_COMBINE_MODE_LABELS[mode]})`,
          mz: results[0].mz, intensity,
          mode: results.length === 1 ? results[0].mode : mode,
          sources: results.flatMap((r) => r.sources),
        },
      };
    },
  },
  {
    id: "widmo/normalize",
    label: "Normalizacja",
    description: "Normalizuje widmo do własnego maksimum albo do własnej sumy (całkowitego prądu jonowego, TIC).",
    domain: "widmo", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "widmo", kind: "widmo" }],
    outputs: [{ id: "out", label: "widmo", kind: "widmo" }],
    params: [{ key: "mode", label: "Tryb", default: "tic", options: WIDMO_NORMALIZE_MODE_LIST }],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0];
      if (!src) return { ok: false, error: "podłącz wejście" };
      const checked = asWidmo(src, "widmo");
      if ("error" in checked) return { ok: false, error: checked.error };
      const mode = (node.params.mode as WidmoNormalizeMode) ?? "tic";
      return { ok: true, value: { ...checked, intensity: normalizeVector(checked.intensity, mode) } };
    },
  },
  {
    id: "widmo/smooth",
    label: "Wygładzanie",
    detail: "Savitzky-Golay",
    description: "Wygładza widmo filtrem Savitzky-Golay redukując szum. Liczone na backendzie — przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "widmo", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "widmo", kind: "widmo" }],
    outputs: [{ id: "out", label: "widmo", kind: "widmo" }],
    params: [{ key: "window", label: "okno [pkt]", min: 5, max: 51, step: 2, default: 15 }],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0];
      if (!src) return { ok: false, error: "podłącz wejście" };
      const checked = asWidmo(src, "widmo");
      if ("error" in checked) return { ok: false, error: checked.error };
      if (!node.widmoProcessCache) return { ok: false, error: "kliknij \"Przetwórz\", żeby wygładzić widmo" };
      const sig = widmoInputSignature(checked.mz, checked.intensity, node.params);
      if (node.widmoProcessCache.inputSignature !== sig) return { ok: false, error: "wejście zmieniło się od ostatniego przetworzenia — kliknij \"Przetwórz\" ponownie" };
      return { ok: true, value: { ...checked, mz: node.widmoProcessCache.mz, intensity: node.widmoProcessCache.intensity } };
    },
  },
  {
    id: "widmo/baseline",
    label: "Korekcja linii bazowej",
    detail: "SNIP",
    description: "Usuwa tło (linię bazową) metodą SNIP. Liczone na backendzie — przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "widmo", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "widmo", kind: "widmo" }],
    outputs: [{ id: "out", label: "widmo", kind: "widmo" }],
    params: [{ key: "iterations", label: "iteracje", min: 5, max: 100, step: 5, default: 40 }],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0];
      if (!src) return { ok: false, error: "podłącz wejście" };
      const checked = asWidmo(src, "widmo");
      if ("error" in checked) return { ok: false, error: checked.error };
      if (!node.widmoProcessCache) return { ok: false, error: "kliknij \"Przetwórz\", żeby skorygować linię bazową" };
      const sig = widmoInputSignature(checked.mz, checked.intensity, node.params);
      if (node.widmoProcessCache.inputSignature !== sig) return { ok: false, error: "wejście zmieniło się od ostatniego przetworzenia — kliknij \"Przetwórz\" ponownie" };
      return { ok: true, value: { ...checked, mz: node.widmoProcessCache.mz, intensity: node.widmoProcessCache.intensity } };
    },
  },
  {
    id: "widmo/peakpick",
    label: "Wykrywanie pików",
    description: "Zeruje wszystko poza wykrytymi pikami (na podstawie prominence). Liczone na backendzie — przeliczane ręcznie przyciskiem \"Przetwórz\".",
    domain: "widmo", stage: "przetwarzanie",
    inputs: [{ id: "in", label: "widmo", kind: "widmo" }],
    outputs: [{ id: "out", label: "widmo", kind: "widmo" }],
    params: [{ key: "prominence_frac", label: "próg (ułamek max)", min: 0.001, max: 0.2, step: 0.001, default: 0.02 }],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0];
      if (!src) return { ok: false, error: "podłącz wejście" };
      const checked = asWidmo(src, "widmo");
      if ("error" in checked) return { ok: false, error: checked.error };
      if (!node.widmoProcessCache) return { ok: false, error: "kliknij \"Przetwórz\", żeby wykryć piki" };
      const sig = widmoInputSignature(checked.mz, checked.intensity, node.params);
      if (node.widmoProcessCache.inputSignature !== sig) return { ok: false, error: "wejście zmieniło się od ostatniego przetworzenia — kliknij \"Przetwórz\" ponownie" };
      return { ok: true, value: { ...checked, mz: node.widmoProcessCache.mz, intensity: node.widmoProcessCache.intensity } };
    },
  },
  {
    id: "widmo/compare",
    label: "Porównanie widm",
    description: "Pokazuje dwa widma nałożone na jednym wykresie (opcjonalnie też ich różnicę a−b) — węzeł czysto podglądowy, bez wyniku liczbowego. Żeby użyć różnicy jako danych dalej w grafie, użyj \"Łączenie\" z trybem \"różnica\" na dwóch wejściach.",
    domain: "widmo", stage: "wynik",
    inputs: [{ id: "a", label: "widmo A", kind: "widmo" }, { id: "b", label: "widmo B", kind: "widmo" }],
    outputs: [],
    params: [],
    evaluate(_node, inputs): EvalOutcome {
      const a = inputs.a[0];
      const b = inputs.b[0];
      if (!a || !b) return { ok: false, error: "podłącz oba widma (A i B)" };
      return { ok: false, error: "węzeł podglądowy — brak wyniku liczbowego" };
    },
  },
  {
    id: "widmo/save_spectrum",
    label: "Zapis",
    description: "Zapisuje widmo wynikowe w bibliotece \"Zapisane widma\".",
    domain: "widmo", stage: "wynik",
    inputs: [{ id: "in", label: "widmo", kind: "widmo" }],
    outputs: [],
    params: [],
    evaluate(node, inputs): EvalOutcome {
      const src = inputs.in[0];
      if (!src) return { ok: false, error: "podłącz wejście" };
      const checked = asWidmo(src, "widmo");
      if ("error" in checked) return { ok: false, error: checked.error };
      return { ok: true, value: checked };
    },
  },
];

registerNodeTypes(WIDMO_NODE_TYPES);
