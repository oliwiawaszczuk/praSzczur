// Czysta logika łączenia wielu tkanek (ten sam "slot" tkanki, różne m/z) w
// jedną tkankę wynikową — używana przez podzakładkę "Łączenie" w "Wiele m/z"
// i (w przyszłości) przez Segmentację. Bez zależności od Svelte.

export type CombineMode = "mean" | "sum" | "max" | "multiply";

/** Ten sam transform co $effect renderujący ionCanvas w IonCanvas.svelte —
 * mapuje surową wartość piksela na okno [dispMin, dispMax] -> [0, 1],
 * z opcjonalnym odwróceniem. */
export function windowValue(v: number, lo: number, hi: number, invert: boolean): number {
  const span = hi - lo;
  if (span <= 0) return invert ? 1 : 0;
  const t = Math.min(1, Math.max(0, (v - lo) / span));
  return invert ? 1 - t : t;
}

export interface MergeSource {
  data: number[][];
  dispMin: number;
  dispMax: number;
  invert: boolean;
  /** Maska "prawdziwych" pikseli (0/1) — patrz TissueImage.mask w api.ts.
   * Opcjonalna: źródło bez maski jest traktowane jak "wszędzie ważne". */
  mask?: number[][];
}

/** AND masek wielu źródeł — piksel jest ważny tylko, jeśli jest ważny we
 * WSZYSTKICH źródłach, które w ogóle mają maskę (źródło bez maski nie psuje
 * wyniku — traktowane jako "wszędzie ważne", dla wstecznej kompatybilności ze
 * starymi zapisanymi mapami sprzed wprowadzenia maski). Zwraca `undefined`,
 * jeśli ŻADNE źródło nie niesie informacji o tle. */
export function combineMasks(masks: (number[][] | undefined)[], h: number, w: number): number[][] | undefined {
  if (masks.every((m) => !m)) return undefined;
  const out: number[][] = Array.from({ length: h }, () => new Array(w).fill(1));
  for (const m of masks) {
    if (!m) continue;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (m[y]?.[x] === 0) out[y][x] = 0;
      }
    }
  }
  return out;
}

/** Łączy N źródeł (ten sam slot tkanki, różne m/z) per piksel, na
 * znormalizowanych (windowValue) wartościach. Zwraca null przy niezgodnych
 * wymiarach (nie powinno się zdarzyć w obrębie jednego workspace/imzML, ale
 * zabezpieczamy się zamiast crashować). */
export function mergeTissueMaps(sources: MergeSource[], mode: CombineMode): { data: number[][]; mask?: number[][] } | null {
  if (sources.length === 0) return null;
  const h = sources[0].data.length;
  const w = sources[0].data[0]?.length ?? 0;
  if (sources.some((s) => s.data.length !== h || (s.data[0]?.length ?? 0) !== w)) return null;

  const out: number[][] = Array.from({ length: h }, () => new Array(w).fill(0));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const vals = sources.map((s) => windowValue(s.data[y][x], s.dispMin, s.dispMax, s.invert));
      let v: number;
      if (mode === "sum") v = vals.reduce((a, b) => a + b, 0);
      else if (mode === "max") v = Math.max(...vals);
      else if (mode === "multiply") v = vals.reduce((a, b) => a * b, 1);
      else v = vals.reduce((a, b) => a + b, 0) / vals.length; // mean
      out[y][x] = v;
    }
  }
  return { data: out, mask: combineMasks(sources.map((s) => s.mask), h, w) };
}

export function maxOf(data: number[][]): number {
  let m = 0;
  for (const row of data) for (const v of row) if (v > m) m = v;
  return m;
}
