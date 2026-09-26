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
}

/** Łączy N źródeł (ten sam slot tkanki, różne m/z) per piksel, na
 * znormalizowanych (windowValue) wartościach. Zwraca null przy niezgodnych
 * wymiarach (nie powinno się zdarzyć w obrębie jednego workspace/imzML, ale
 * zabezpieczamy się zamiast crashować). */
export function mergeTissueMaps(sources: MergeSource[], mode: CombineMode): number[][] | null {
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
  return out;
}

export function maxOf(data: number[][]): number {
  let m = 0;
  for (const row of data) for (const v of row) if (v > m) m = v;
  return m;
}
