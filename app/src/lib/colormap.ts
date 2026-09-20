/**
 * Bruker-style colormap: black → dark blue → blue → cyan → green → yellow → orange → red → white
 * Zgodna z paletą FlexImaging / SCiLS.
 */

const STOPS: Array<[number, [number, number, number]]> = [
  [0.00, [0,   0,   0  ]],
  [0.15, [0,   0,   120]],
  [0.30, [0,   0,   255]],
  [0.45, [0,   230, 255]],
  [0.55, [0,   255, 80 ]],
  [0.68, [255, 255, 0  ]],
  [0.80, [255, 140, 0  ]],
  [0.92, [255, 0,   0  ]],
  [1.00, [255, 255, 255]],
];

/** Interpolacja liniowa między przystankami. t ∈ [0, 1] → [r, g, b] ∈ [0, 255]. */
function interpolate(t: number): [number, number, number] {
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, c0] = STOPS[i];
    const [t1, c1] = STOPS[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + f * (c1[0] - c0[0])),
        Math.round(c0[1] + f * (c1[1] - c0[1])),
        Math.round(c0[2] + f * (c1[2] - c0[2])),
      ];
    }
  }
  return [255, 255, 255];
}

/** Wstępnie obliczona LUT (256 wpisów) dla szybkiego renderowania. */
export const BRUKER_LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = interpolate(i / 255);
    lut[i * 4 + 0] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
})();

/**
 * Renderuje macierz 2D (wartości 0–1) na canvas używając BRUKER_LUT.
 * @param ctx     Kontekst 2D canvasu
 * @param matrix  Wiersze × kolumny, wartości 0–1
 */
export function renderToCanvas(
  ctx: CanvasRenderingContext2D,
  matrix: number[][],
): void {
  const h = matrix.length;
  const w = matrix[0]?.length ?? 0;
  if (h === 0 || w === 0) return;

  ctx.canvas.width  = w;
  ctx.canvas.height = h;

  const imgData = ctx.createImageData(w, h);
  const px = imgData.data;

  for (let y = 0; y < h; y++) {
    const row = matrix[y];
    for (let x = 0; x < w; x++) {
      const idx  = (y * w + x) * 4;
      const lutI = Math.round(Math.min(Math.max(row[x], 0), 1) * 255) * 4;
      px[idx]     = BRUKER_LUT[lutI];
      px[idx + 1] = BRUKER_LUT[lutI + 1];
      px[idx + 2] = BRUKER_LUT[lutI + 2];
      px[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}
