/**
 * Tablice kolorów (lookup table, LUT) dla map m/z. Domyślna to "bruker" (black → dark blue →
 * blue → cyan → green → yellow → orange → red → white), zgodna z paletą FlexImaging / SCiLS.
 *
 * Wybrana tablica to ustawienie GLOBALNE ("Personalizacja" w Ustawieniach, klucz "colormap" w
 * app_settings.json) — `activeLut()` czyta je reaktywnie, więc każdy $effect, który woła
 * `activeLut()`/`renderToCanvas()`, sam przerysowuje się po zmianie wyboru.
 */

import { getSetting } from "./appSettings.svelte";

type Stops = Array<[number, [number, number, number]]>;

export interface ColormapDef {
  id: string;
  label: string;
  stops: Stops;
}

export const DEFAULT_COLORMAP = "bruker";
export const COLORMAP_SETTING_KEY = "colormap";

export const COLORMAPS: ColormapDef[] = [
  {
    id: "bruker", label: "Bruker (domyślna)",
    stops: [
      [0.00, [0, 0, 0]], [0.15, [0, 0, 120]], [0.30, [0, 0, 255]], [0.45, [0, 230, 255]],
      [0.55, [0, 255, 80]], [0.68, [255, 255, 0]], [0.80, [255, 140, 0]], [0.92, [255, 0, 0]],
      [1.00, [255, 255, 255]],
    ],
  },
  {
    id: "viridis", label: "Viridis",
    stops: [
      [0, [68, 1, 84]], [0.13, [71, 44, 122]], [0.25, [59, 81, 139]], [0.38, [44, 113, 142]],
      [0.5, [33, 144, 141]], [0.63, [39, 173, 129]], [0.75, [92, 200, 99]], [0.88, [170, 220, 50]],
      [1, [253, 231, 37]],
    ],
  },
  {
    id: "magma", label: "Magma",
    stops: [
      [0, [0, 0, 4]], [0.13, [28, 16, 68]], [0.25, [79, 18, 123]], [0.38, [129, 37, 129]],
      [0.5, [181, 54, 122]], [0.63, [229, 80, 100]], [0.75, [251, 135, 97]], [0.88, [254, 194, 135]],
      [1, [252, 253, 191]],
    ],
  },
  {
    id: "inferno", label: "Inferno",
    stops: [
      [0, [0, 0, 4]], [0.13, [31, 12, 72]], [0.25, [85, 15, 109]], [0.38, [136, 34, 106]],
      [0.5, [186, 54, 85]], [0.63, [227, 89, 51]], [0.75, [249, 140, 10]], [0.88, [249, 201, 50]],
      [1, [252, 255, 164]],
    ],
  },
  {
    id: "plasma", label: "Plasma",
    stops: [
      [0, [13, 8, 135]], [0.13, [75, 3, 161]], [0.25, [125, 3, 168]], [0.38, [168, 34, 150]],
      [0.5, [203, 70, 121]], [0.63, [229, 107, 93]], [0.75, [248, 148, 65]], [0.88, [253, 195, 40]],
      [1, [240, 249, 33]],
    ],
  },
  {
    id: "jet", label: "Jet",
    stops: [
      [0, [0, 0, 143]], [0.125, [0, 0, 255]], [0.375, [0, 255, 255]], [0.625, [255, 255, 0]],
      [0.875, [255, 0, 0]], [1, [128, 0, 0]],
    ],
  },
  {
    id: "hot", label: "Hot",
    stops: [[0, [0, 0, 0]], [0.35, [230, 0, 0]], [0.7, [255, 210, 0]], [1, [255, 255, 255]]],
  },
  {
    id: "grayscale", label: "Skala szarości",
    stops: [[0, [0, 0, 0]], [1, [255, 255, 255]]],
  },
];

/** Interpolacja liniowa między przystankami. t ∈ [0, 1] → [r, g, b] ∈ [0, 255]. */
function interpolate(stops: Stops, t: number): [number, number, number] {
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + f * (c1[0] - c0[0])),
        Math.round(c0[1] + f * (c1[1] - c0[1])),
        Math.round(c0[2] + f * (c1[2] - c0[2])),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

const lutCache = new Map<string, Uint8ClampedArray>();

/** Wstępnie obliczona LUT (256 wpisów RGBA) wybranej tablicy; nieznane id → domyślna. */
export function lutFor(id: string): Uint8ClampedArray {
  const def = COLORMAPS.find((c) => c.id === id) ?? COLORMAPS[0];
  let lut = lutCache.get(def.id);
  if (!lut) {
    lut = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = interpolate(def.stops, i / 255);
      lut[i * 4 + 0] = r;
      lut[i * 4 + 1] = g;
      lut[i * 4 + 2] = b;
      lut[i * 4 + 3] = 255;
    }
    lutCache.set(def.id, lut);
  }
  return lut;
}

export const BRUKER_LUT: Uint8ClampedArray = lutFor("bruker");

/** Id aktualnie wybranej tablicy kolorów (ustawienie globalne, reaktywne). */
export function activeColormapId(): string {
  const id = getSetting<string>(COLORMAP_SETTING_KEY, DEFAULT_COLORMAP);
  return COLORMAPS.some((c) => c.id === id) ? id : DEFAULT_COLORMAP;
}

/** LUT aktualnie wybranej tablicy — używaj WEWNĄTRZ $effect/$derived, żeby zmiana wyboru
 * w Ustawieniach przerysowała mapę. */
export function activeLut(): Uint8ClampedArray {
  return lutFor(activeColormapId());
}

/** CSS `linear-gradient` podglądu tablicy (do paska w Ustawieniach). */
export function colormapGradientCss(id: string): string {
  const lut = lutFor(id);
  const parts: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const k = Math.round((i / 10) * 255) * 4;
    parts.push(`rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]}) ${i * 10}%`);
  }
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

/**
 * Renderuje macierz 2D (wartości 0–1) na canvas używając aktywnej tablicy kolorów.
 * @param ctx     Kontekst 2D canvasu
 * @param matrix  Wiersze × kolumny, wartości 0–1
 * @param mask    Opcjonalna maska "prawdziwych" pikseli (0/1, ten sam kształt co
 *                `matrix`) — piksele z mask[y][x] === 0 (tło poza faktycznym
 *                skanem tkanki, patrz mask w /ion_image) są w pełni przezroczyste
 *                zamiast czarne, żeby tło nie wyglądało jak dane o zerowej
 *                intensywności. Brak maski = wszystkie piksele nieprzezroczyste
 *                (zachowanie sprzed wprowadzenia maski).
 * @param lut     Tablica kolorów; domyślnie aktywna z ustawień (czytana tu, więc
 *                $effect wołający renderToCanvas śledzi zmianę wyboru).
 */
export function renderToCanvas(
  ctx: CanvasRenderingContext2D,
  matrix: number[][],
  mask?: number[][] | null,
  lut: Uint8ClampedArray = activeLut(),
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
    const maskRow = mask?.[y];
    for (let x = 0; x < w; x++) {
      const idx  = (y * w + x) * 4;
      const lutI = Math.round(Math.min(Math.max(row[x], 0), 1) * 255) * 4;
      px[idx]     = lut[lutI];
      px[idx + 1] = lut[lutI + 1];
      px[idx + 2] = lut[lutI + 2];
      px[idx + 3] = maskRow && maskRow[x] === 0 ? 0 : 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}
