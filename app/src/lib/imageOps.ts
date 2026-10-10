// Operacje na pojedynczym obrazie (mapie m/z) dla domeny "Analiza obrazu" w Node Graph
// (nodegraph.obraz.ts). Czysto obliczeniowe, BEZ importów — testowane wprost Node'em i porównane
// ze scikit-image (opis: docs/node-graph.md, sekcja "Domena Analiza obrazu").
//
// Wszystkie operacje respektują MASKĘ tkanki: piksel z m=0 (poza skanem) nie wchodzi do żadnego
// okna/statystyki i na wyjściu ma wartość 0. Zero WEWNĄTRZ maski to prawdziwa wartość (brak
// sygnału) — w tych danych to ~44% pikseli typowej mapy, więc rozróżnienie ma znaczenie.

export interface Grid {
  w: number;
  h: number;
  /** Wartości, indeks y*w + x. */
  v: Float64Array;
  /** 1 = piksel tkanki, 0 = poza skanem. */
  m: Uint8Array;
}

export function gridFromRows(data: number[][], mask: number[][] | undefined, w: number, h: number): Grid {
  const v = new Float64Array(w * h);
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = data[y];
    const mr = mask?.[y];
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const inside = mr ? mr[x] > 0 : true;
      const val = row ? Number(row[x]) : NaN;
      if (inside && Number.isFinite(val)) { m[i] = 1; v[i] = val; }
    }
  }
  return { w, h, v, m };
}

export function gridToRows(g: Grid): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < g.h; y++) {
    const row = new Array<number>(g.w);
    for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x;
      row[x] = g.m[i] ? g.v[i] : 0;
    }
    out.push(row);
  }
  return out;
}

export function maskToRows(g: Grid): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < g.h; y++) out.push(Array.from(g.m.subarray(y * g.w, (y + 1) * g.w)));
  return out;
}

function withValues(g: Grid, v: Float64Array): Grid {
  return { w: g.w, h: g.h, v, m: g.m };
}

export function maskedValues(g: Grid): number[] {
  const out: number[] = [];
  for (let i = 0; i < g.v.length; i++) if (g.m[i]) out.push(g.v[i]);
  return out;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = Math.min(Math.max(q, 0), 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return quantile(s, 0.5);
}

/** Skalowanie do [0,1] (maks. w masce = 1) — wyjście map cech/filtrów do podglądu i dalszych node'ów. */
export function normalizeMax(g: Grid): { grid: Grid; max: number } {
  let mx = 0;
  for (let i = 0; i < g.v.length; i++) if (g.m[i] && g.v[i] > mx) mx = g.v[i];
  if (mx <= 0) return { grid: g, max: mx };
  const v = new Float64Array(g.v.length);
  for (let i = 0; i < v.length; i++) v[i] = g.m[i] ? g.v[i] / mx : 0;
  return { grid: withValues(g, v), max: mx };
}

/** Mapa ze znakiem (z-score, residuum) → [0,1], 0.5 = zero; |wartość| >= lim → 0 albo 1. */
export function signedToUnit(g: Grid, lim: number): Grid {
  const v = new Float64Array(g.v.length);
  const L = lim > 0 ? lim : 1;
  for (let i = 0; i < v.length; i++) v[i] = g.m[i] ? Math.min(1, Math.max(0, 0.5 + g.v[i] / (2 * L))) : 0;
  return withValues(g, v);
}

// ── Szum ────────────────────────────────────────────────────────────────────

/** σ szumu z różnic sąsiednich pikseli (poziomych i pionowych), tylko pary w masce, w których
 * oba piksele mają sygnał > 0: 1.4826·MAD(różnic)/√2. Odporne na krawędzie struktur (MAD) i na
 * dużą liczbę zer (te są pomijane — przy nich zwykły MAD wychodzi 0). */
export function estimateNoise(g: Grid): number {
  const d: number[] = [];
  const { w, h, v, m } = g;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i] || v[i] <= 0) continue;
      if (x + 1 < w && m[i + 1] && v[i + 1] > 0) d.push(v[i + 1] - v[i]);
      if (y + 1 < h && m[i + w] && v[i + w] > 0) d.push(v[i + w] - v[i]);
    }
  }
  if (d.length < 10) return 0;
  const med = median(d);
  return (1.4826 * median(d.map((x) => Math.abs(x - med)))) / Math.SQRT2;
}

// ── Przygotowanie ───────────────────────────────────────────────────────────

/** Przycięcie hotspotów: do percentyla p (0–100) albo do mediana + k·MAD (wartości > 0). */
export function clipHotspots(g: Grid, mode: string, p: number, k: number): { grid: Grid; limit: number; clipped: number } {
  const vals = maskedValues(g).sort((a, b) => a - b);
  let limit: number;
  if (mode === "mad") {
    const pos = vals.filter((x) => x > 0);
    const med = quantile(pos, 0.5);
    const mad = 1.4826 * median(pos.map((x) => Math.abs(x - med)));
    limit = med + k * mad;
  } else {
    limit = quantile(vals, p / 100);
  }
  const v = new Float64Array(g.v.length);
  let clipped = 0;
  for (let i = 0; i < v.length; i++) {
    if (!g.m[i]) continue;
    if (g.v[i] > limit) { v[i] = limit; clipped++; } else v[i] = g.v[i];
  }
  return { grid: withValues(g, v), limit, clipped };
}

/** Stabilizacja wariancji: sqrt albo log1p(s·x)/log1p(s); `inverse` cofa transformację. */
export function vst(g: Grid, mode: string, scale: number, inverse: boolean): Grid {
  const v = new Float64Array(g.v.length);
  const s = Math.max(scale, 1e-9);
  const L = Math.log1p(s);
  for (let i = 0; i < v.length; i++) {
    if (!g.m[i]) continue;
    const x = g.v[i];
    if (mode === "log1p") v[i] = inverse ? Math.expm1(Math.max(x, 0) * L) / s : Math.log1p(s * Math.max(x, 0)) / L;
    else v[i] = inverse ? Math.max(x, 0) ** 2 : Math.sqrt(Math.max(x, 0));
  }
  return withValues(g, v);
}

// ── Filtry ──────────────────────────────────────────────────────────────────

export function medianFilter(g: Grid, r: number): Grid {
  const { w, h, m } = g;
  const v = new Float64Array(g.v.length);
  const buf: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      buf.length = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (m[j]) buf.push(g.v[j]);
        }
      }
      buf.sort((a, b) => a - b);
      v[i] = quantile(buf, 0.5);
    }
  }
  return withValues(g, v);
}

/** Splot z jądrem wag `weight(dx,dy,center,neighbor)` znormalizowany po pikselach maski
 * ("normalized convolution") — brzeg tkanki nie ciemnieje od zer spoza skanu. */
function weightedFilter(g: Grid, r: number, weight: (dx: number, dy: number, a: number, b: number) => number): Grid {
  const { w, h, m } = g;
  const v = new Float64Array(g.v.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const c = g.v[i];
      let sw = 0;
      let s = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!m[j]) continue;
          const wt = weight(dx, dy, c, g.v[j]);
          sw += wt;
          s += wt * g.v[j];
        }
      }
      v[i] = sw > 0 ? s / sw : c;
    }
  }
  return withValues(g, v);
}

export function gaussianFilter(g: Grid, sigma: number): Grid {
  if (sigma <= 0) return g;
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = -1 / (2 * sigma * sigma);
  return weightedFilter(g, r, (dx, dy) => Math.exp(k * (dx * dx + dy * dy)));
}

/** Filtr bilateralny: waga = exp(−d²/2σs²)·exp(−Δ²/2σr²). σr w jednostkach intensywności. */
export function bilateralFilter(g: Grid, sigmaS: number, sigmaR: number): Grid {
  if (sigmaS <= 0 || sigmaR <= 0) return g;
  const r = Math.max(1, Math.ceil(2 * sigmaS));
  const ks = -1 / (2 * sigmaS * sigmaS);
  const kr = -1 / (2 * sigmaR * sigmaR);
  return weightedFilter(g, r, (dx, dy, a, b) => Math.exp(ks * (dx * dx + dy * dy) + kr * (a - b) * (a - b)));
}

/** Non-local means (Buades) — waga piksela j dla i: exp(−max(d² − 2σ², 0)/h²), d² = średni kwadrat
 * różnicy łatek (tylko piksele obecne w obu łatkach), jak `denoise_nl_means(fast_mode=False, sigma)`
 * w scikit-image. */
export function nlMeans(g: Grid, patchR: number, searchR: number, hParam: number, sigma: number): Grid {
  const { w, h, m } = g;
  const v = new Float64Array(g.v.length);
  const h2 = Math.max(hParam * hParam, 1e-12);
  const s2 = 2 * sigma * sigma;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      let sw = 0;
      let s = 0;
      for (let sy = -searchR; sy <= searchR; sy++) {
        const y2 = y + sy;
        if (y2 < 0 || y2 >= h) continue;
        for (let sx = -searchR; sx <= searchR; sx++) {
          const x2 = x + sx;
          if (x2 < 0 || x2 >= w) continue;
          const j = y2 * w + x2;
          if (!m[j]) continue;
          let d2 = 0;
          let n = 0;
          for (let py = -patchR; py <= patchR; py++) {
            const ya = y + py;
            const yb = y2 + py;
            if (ya < 0 || ya >= h || yb < 0 || yb >= h) continue;
            for (let px = -patchR; px <= patchR; px++) {
              const xa = x + px;
              const xb = x2 + px;
              if (xa < 0 || xa >= w || xb < 0 || xb >= w) continue;
              const a = ya * w + xa;
              const b = yb * w + xb;
              if (!m[a] || !m[b]) continue;
              const d = g.v[a] - g.v[b];
              d2 += d * d;
              n++;
            }
          }
          if (n === 0) continue;
          const wt = Math.exp(-Math.max(d2 / n - s2, 0) / h2);
          sw += wt;
          s += wt * g.v[j];
        }
      }
      v[i] = sw > 0 ? s / sw : g.v[i];
    }
  }
  return withValues(g, v);
}

/** Total variation (ROF) — algorytm rzutowania Chambolle'a (2004), jak `denoise_tv_chambolle`
 * w scikit-image: min ‖u − f‖²/2 + weight·TV(u). Gradient tylko między pikselami maski (brzeg
 * tkanki = warunek Neumanna). */
export function tvChambolle(g: Grid, weight: number, nIter = 200, eps = 2e-4): Grid {
  const { w, h, m } = g;
  const n = w * h;
  if (weight <= 0) return g;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const div = new Float64Array(n);
  const u = new Float64Array(n);
  const tau = 0.125;
  let prevE = Infinity;
  for (let it = 0; it < nIter; it++) {
    // div p
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!m[i]) { div[i] = 0; continue; }
        let d = 0;
        d += px[i];
        if (x > 0 && m[i - 1]) d -= px[i - 1];
        d += py[i];
        if (y > 0 && m[i - w]) d -= py[i - w];
        div[i] = d;
        u[i] = g.v[i] - weight * div[i];
      }
    }
    // p ← (p + τ∇u/λ) / (1 + τ|∇u|/λ)
    let e = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!m[i]) continue;
        const gx = x + 1 < w && m[i + 1] ? u[i + 1] - u[i] : 0;
        const gy = y + 1 < h && m[i + w] ? u[i + w] - u[i] : 0;
        const norm = Math.sqrt(gx * gx + gy * gy);
        e += norm;
        const den = 1 + (tau / weight) * norm;
        px[i] = (px[i] - (tau / weight) * gx) / den;
        py[i] = (py[i] - (tau / weight) * gy) / den;
      }
    }
    if (it > 0 && Math.abs(prevE - e) < eps * (e || 1)) break;
    prevE = e;
  }
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) if (m[i]) v[i] = u[i];
  return withValues(g, v);
}

// ── Mapy cech ───────────────────────────────────────────────────────────────

/** Lokalna średnia i odchylenie w oknie (2r+1)² (piksele maski). */
export function localStats(g: Grid, r: number): { mean: Float64Array; std: Float64Array } {
  const { w, h, m } = g;
  const mean = new Float64Array(w * h);
  const std = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      let s = 0;
      let s2 = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!m[j]) continue;
          s += g.v[j];
          s2 += g.v[j] * g.v[j];
          n++;
        }
      }
      const mu = s / n;
      mean[i] = mu;
      std[i] = n > 1 ? Math.sqrt(Math.max(s2 / n - mu * mu, 0) * (n / (n - 1))) : 0;
    }
  }
  return { mean, std };
}

/** Lokalny CV = σ/μ w oknie; gdzie μ ≈ 0 (brak sygnału) → 0, nie nieskończoność. */
export function localCV(g: Grid, r: number): Grid {
  const { mean, std } = localStats(g, r);
  const vals = maskedValues(g);
  const gmean = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1);
  const eps = Math.max(gmean * 0.05, 1e-12);
  const v = new Float64Array(g.v.length);
  for (let i = 0; i < v.length; i++) if (g.m[i]) v[i] = mean[i] > eps ? std[i] / mean[i] : 0;
  return withValues(g, v);
}

/** Getis-Ord Gi* (wagi binarne: okno (2r+1)² z pikselem środkowym) — z-score skupisk wysokich (>0)
 * i niskich (<0) wartości. */
export function getisOrdGi(g: Grid, r: number): Grid {
  const vals = maskedValues(g);
  const n = vals.length;
  const xbar = vals.reduce((a, b) => a + b, 0) / Math.max(n, 1);
  const S = Math.sqrt(Math.max(vals.reduce((a, b) => a + b * b, 0) / Math.max(n, 1) - xbar * xbar, 0));
  const { w, h, m } = g;
  const v = new Float64Array(g.v.length);
  if (S === 0 || n < 3) return withValues(g, v);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      let s = 0;
      let W = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!m[j]) continue;
          s += g.v[j];
          W++;
        }
      }
      const den = S * Math.sqrt((n * W - W * W) / (n - 1));
      v[i] = den > 0 ? (s - xbar * W) / den : 0;
    }
  }
  return withValues(g, v);
}

/** Local Moran I_i = z_i·Σ_{j≠i} z_j / m2 (z = x − x̄, m2 = Σz²/n), okno (2r+1)² bez środka,
 * wagi wierszowo-standaryzowane. >0: piksel podobny do otoczenia (HH/LL), <0: odstający (HL/LH). */
export function localMoran(g: Grid, r: number): Grid {
  const vals = maskedValues(g);
  const n = vals.length;
  const xbar = vals.reduce((a, b) => a + b, 0) / Math.max(n, 1);
  const m2 = vals.reduce((a, b) => a + (b - xbar) ** 2, 0) / Math.max(n, 1);
  const { w, h, m } = g;
  const v = new Float64Array(g.v.length);
  if (m2 === 0) return withValues(g, v);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      let s = 0;
      let W = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!m[j]) continue;
          s += g.v[j] - xbar;
          W++;
        }
      }
      v[i] = W > 0 ? ((g.v[i] - xbar) * (s / W)) / m2 : 0;
    }
  }
  return withValues(g, v);
}

function px(g: Grid, x: number, y: number, fallback: number): number {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return fallback;
  const j = y * g.w + x;
  return g.m[j] ? g.v[j] : fallback;
}

/** Gradient Sobela: moduł i kierunek. Brakujący sąsiad (poza maską/obrazem) = wartość środka. */
export function sobel(g: Grid): { mag: Float64Array; ang: Float64Array } {
  const { w, h, m } = g;
  const mag = new Float64Array(w * h);
  const ang = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const c = g.v[i];
      const p = (dx: number, dy: number) => px(g, x + dx, y + dy, c);
      const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
      const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
      mag[i] = Math.hypot(gx, gy);
      ang[i] = Math.atan2(gy, gx);
    }
  }
  return { mag, ang };
}

/** Canny: Gauss(σ) → Sobel → tłumienie niemaksymalne → histereza (progi jako ułamek maks. gradientu). */
export function canny(g: Grid, sigma: number, low: number, high: number): Uint8Array {
  const s = sobel(gaussianFilter(g, sigma));
  const { w, h, m } = g;
  const nms = new Float64Array(w * h);
  let mx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const a = ((s.ang[i] * 180) / Math.PI + 180) % 180;
      const [dx, dy] = a < 22.5 || a >= 157.5 ? [1, 0] : a < 67.5 ? [1, 1] : a < 112.5 ? [0, 1] : [-1, 1];
      const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : s.mag[yy * w + xx]);
      const c = s.mag[i];
      if (c >= at(x + dx, y + dy) && c >= at(x - dx, y - dy)) { nms[i] = c; if (c > mx) mx = c; }
    }
  }
  const out = new Uint8Array(w * h);
  if (mx === 0) return out;
  const hi = high * mx;
  const lo = low * mx;
  const stack: number[] = [];
  for (let i = 0; i < nms.length; i++) if (nms[i] >= hi) { out[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (!out[j] && nms[j] >= lo) { out[j] = 1; stack.push(j); }
      }
    }
  }
  return out;
}

// ── Progowanie ──────────────────────────────────────────────────────────────

function histogram(vals: number[], bins: number): { counts: number[]; lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of vals) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const counts = new Array<number>(bins).fill(0);
  if (!(hi > lo)) return { counts, lo, hi };
  for (const x of vals) counts[Math.min(bins - 1, Math.floor(((x - lo) / (hi - lo)) * bins))]++;
  return { counts, lo, hi };
}

export function histogramOf(g: Grid, bins: number) {
  return histogram(maskedValues(g), bins);
}

/** Próg Otsu (256 binów; próg = górna krawędź binu, jak skimage). */
export function otsu(vals: number[]): number {
  const { counts, lo, hi } = histogram(vals, 256);
  if (!(hi > lo)) return lo;
  const total = vals.length;
  const width = (hi - lo) / 256;
  let sumAll = 0;
  for (let k = 0; k < 256; k++) sumAll += counts[k] * (lo + (k + 0.5) * width);
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let thr = lo;
  for (let k = 0; k < 255; k++) {
    wB += counts[k];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += counts[k] * (lo + (k + 0.5) * width);
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = lo + (k + 1) * width; }
  }
  return thr;
}

/** Próg trójkątny (Zack) — dobry dla histogramów skośnych z dużym pikiem przy zerze/tle. */
export function triangle(vals: number[]): number {
  const bins = 256;
  const { counts, lo, hi } = histogram(vals, bins);
  if (!(hi > lo)) return lo;
  let peak = 0;
  for (let k = 1; k < bins; k++) if (counts[k] > counts[peak]) peak = k;
  let first = 0;
  while (first < bins && counts[first] === 0) first++;
  let last = bins - 1;
  while (last > 0 && counts[last] === 0) last--;
  // linia od piku do dalszego końca histogramu
  const end = peak - first > last - peak ? first : last;
  const x1 = peak;
  const y1 = counts[peak];
  const x2 = end;
  const y2 = counts[end];
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  let best = -1;
  let bestK = peak;
  const [a, b] = end > peak ? [peak, end] : [end, peak];
  for (let k = a; k <= b; k++) {
    const d = Math.abs((y2 - y1) * k - (x2 - x1) * counts[k] + x2 * y1 - y2 * x1) / len;
    if (d > best) { best = d; bestK = k; }
  }
  const width = (hi - lo) / bins;
  return lo + (bestK + (end > peak ? 1 : 0)) * width;
}

/** Multi-Otsu: k klas (2–5) przez pełne przeszukanie na histogramie 64 binów (maks. międzyklasowa wariancja). */
export function multiOtsu(vals: number[], k: number): number[] {
  const bins = 64;
  const { counts, lo, hi } = histogram(vals, bins);
  if (!(hi > lo) || k < 2) return [];
  const width = (hi - lo) / bins;
  const P = new Float64Array(bins + 1);
  const S = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) {
    P[i + 1] = P[i] + counts[i];
    S[i + 1] = S[i] + counts[i] * (lo + (i + 0.5) * width);
  }
  const cls = (a: number, b: number) => { const p = P[b] - P[a]; return p > 0 ? ((S[b] - S[a]) ** 2) / p : 0; };
  let best = -1;
  let bestT: number[] = [];
  const t = new Array<number>(k - 1);
  const rec = (d: number, start: number) => {
    if (d === k - 1) {
      let s = 0;
      let prev = 0;
      for (const ti of t) { s += cls(prev, ti); prev = ti; }
      s += cls(prev, bins);
      if (s > best) { best = s; bestT = [...t]; }
      return;
    }
    for (let i = start; i <= bins - (k - 1 - d); i++) { t[d] = i; rec(d + 1, i + 1); }
  };
  rec(0, 1);
  return bestT.map((i) => lo + i * width);
}

// ── Obiekty ─────────────────────────────────────────────────────────────────

export interface ObjectStats { label: number; area: number; mean: number; max: number; cx: number; cy: number; }

/** Spójne składowe binarnego obrazu (1 = obiekt), 4- albo 8-spójność. */
export function connectedComponents(bin: Uint8Array, w: number, h: number, conn8: boolean): { labels: Int32Array; n: number } {
  const labels = new Int32Array(w * h).fill(-1);
  let n = 0;
  const stack: number[] = [];
  for (let s = 0; s < bin.length; s++) {
    if (!bin[s] || labels[s] >= 0) continue;
    labels[s] = n;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (!conn8 && dx !== 0 && dy !== 0)) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (bin[j] && labels[j] < 0) { labels[j] = n; stack.push(j); }
        }
      }
    }
    n++;
  }
  return { labels, n };
}

export function objectStats(labels: Int32Array, n: number, w: number, intensity?: Grid): ObjectStats[] {
  const st: ObjectStats[] = Array.from({ length: n }, (_, k) => ({ label: k, area: 0, mean: 0, max: 0, cx: 0, cy: 0 }));
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i];
    if (k < 0) continue;
    const o = st[k];
    o.area++;
    o.cx += i % w;
    o.cy += Math.floor(i / w);
    if (intensity) {
      const val = intensity.v[i];
      o.mean += val;
      if (val > o.max) o.max = val;
    }
  }
  for (const o of st) {
    if (o.area) { o.cx /= o.area; o.cy /= o.area; o.mean /= o.area; }
  }
  return st;
}

// ── Kontrast ────────────────────────────────────────────────────────────────

/** CLAHE z maską: kafle tx×ty, histogram 256 binów z przycięciem (clip = wielokrotność średniej
 * liczności binu), dystrybuanty kafli interpolowane dwuliniowo. Wynik w [0,1]. */
export function clahe(g: Grid, tilesX: number, tilesY: number, clip: number): Grid {
  const { w, h, m } = g;
  const bins = 256;
  const vals = maskedValues(g);
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of vals) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const out = new Float64Array(w * h);
  if (!(hi > lo)) return withValues(g, out);
  const bin = (x: number) => Math.min(bins - 1, Math.floor(((x - lo) / (hi - lo)) * bins));
  const tw = w / tilesX;
  const th = h / tilesY;
  const cdfs: Float64Array[] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const hist = new Float64Array(bins);
      let n = 0;
      for (let y = Math.floor(ty * th); y < Math.min(h, Math.floor((ty + 1) * th)); y++) {
        for (let x = Math.floor(tx * tw); x < Math.min(w, Math.floor((tx + 1) * tw)); x++) {
          const i = y * w + x;
          if (!m[i]) continue;
          hist[bin(g.v[i])]++;
          n++;
        }
      }
      const cdf = new Float64Array(bins);
      if (n > 0) {
        const limit = Math.max(1, (clip * n) / bins);
        let excess = 0;
        for (let k = 0; k < bins; k++) if (hist[k] > limit) { excess += hist[k] - limit; hist[k] = limit; }
        const add = excess / bins;
        let acc = 0;
        for (let k = 0; k < bins; k++) { acc += hist[k] + add; cdf[k] = acc / n; }
      } else {
        for (let k = 0; k < bins; k++) cdf[k] = k / (bins - 1);
      }
      cdfs.push(cdf);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const b = bin(g.v[i]);
      const fx = Math.min(Math.max((x + 0.5) / tw - 0.5, 0), tilesX - 1);
      const fy = Math.min(Math.max((y + 0.5) / th - 0.5, 0), tilesY - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, tilesX - 1);
      const y1 = Math.min(y0 + 1, tilesY - 1);
      const ax = fx - x0;
      const ay = fy - y0;
      const c = (tx: number, ty: number) => cdfs[ty * tilesX + tx][b];
      out[i] = (1 - ay) * ((1 - ax) * c(x0, y0) + ax * c(x1, y0)) + ay * ((1 - ax) * c(x0, y1) + ax * c(x1, y1));
    }
  }
  return withValues(g, out);
}

// ── Miary jakości ───────────────────────────────────────────────────────────

export function moransI(g: Grid): number {
  const vals = maskedValues(g);
  const n = vals.length;
  if (n < 3) return NaN;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const { w, h, m, v } = g;
  let num = 0;
  let W = 0;
  let den = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const zi = v[i] - mean;
      den += zi * zi;
      if (x + 1 < w && m[i + 1]) { num += zi * (v[i + 1] - mean); W++; }
      if (y + 1 < h && m[i + w]) { num += zi * (v[i + w] - mean); W++; }
    }
  }
  return den > 0 && W > 0 ? ((n / W) * num) / den : NaN;
}

export function gini(vals: number[]): number {
  const s = vals.map((x) => Math.max(x, 0)).sort((a, b) => a - b);
  const tot = s.reduce((a, b) => a + b, 0);
  if (tot === 0) return NaN;
  const n = s.length;
  let acc = 0;
  for (let k = 0; k < n; k++) acc += (2 * (k + 1) - n - 1) * s[k];
  return acc / (n * tot);
}

function dilateCross(b: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(b.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      o[i] = b[i] || (x > 0 && b[i - 1]) || (x + 1 < w && b[i + 1]) || (y > 0 && b[i - w]) || (y + 1 < h && b[i + w]) ? 1 : 0;
    }
  }
  return o;
}

function erodeSquare(b: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(b.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ok = 1;
      for (let dy = -1; dy <= 1 && ok; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          // OpenCV erode: piksele poza obrazem nie zerują wyniku (border = +∞)
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (!b[yy * w + xx]) { ok = 0; break; }
        }
      }
      o[y * w + x] = ok;
    }
  }
  return o;
}

/** Spatial chaos (Alexandrov & Bartels; implementacja jak pyImagingMSpec.measure_of_chaos, z której
 * korzysta METASPACE): obraz/max, poziomy linspace(0,1,n+1)[:-1], na każdym: binaryzacja > poziom,
 * dylatacja (krzyż 3×3), erozja (kwadrat 3×3), liczba obiektów (4-spójność);
 * wynik = 1 − Σobiektów / (pikseli>0 · n). Bliżej 1 = mniej chaosu (więcej struktury). NaN, gdy
 * liczby obiektów na wszystkich poziomach są równe. */
export function spatialChaos(g: Grid, nLevels = 30): number {
  const { w, h, m, v } = g;
  let mx = 0;
  let notnull = 0;
  for (let i = 0; i < v.length; i++) if (m[i] && v[i] > 0) { notnull++; if (v[i] > mx) mx = v[i]; }
  if (mx <= 0 || notnull === 0) return NaN;
  const counts: number[] = [];
  for (let k = 0; k < nLevels; k++) {
    const lev = k / nLevels;
    const b = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) b[i] = m[i] && v[i] / mx > lev ? 1 : 0;
    const prep = erodeSquare(dilateCross(b, w, h), w, h);
    counts.push(connectedComponents(prep, w, h, false).n);
  }
  if (new Set(counts).size <= 1) return NaN;
  return 1 - counts.reduce((a, b) => a + b, 0) / (notnull * nLevels);
}

export interface QualityCard {
  n: number; moran: number; chaos: number; gini: number; cv: number; fracSignal: number;
  noise: number; snr: number; p50: number; p95: number; max: number;
  hist: number[]; histLo: number; histHi: number;
}

export function qualityCard(g: Grid): QualityCard {
  const vals = maskedValues(g);
  const sorted = [...vals].sort((a, b) => a - b);
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / Math.max(n, 1);
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(n - 1, 1));
  const noise = estimateNoise(g);
  const p50 = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  const hg = histogram(vals, 32);
  return {
    n, moran: moransI(g), chaos: spatialChaos(g), gini: gini(vals), cv: mean > 0 ? sd / mean : NaN,
    fracSignal: vals.filter((x) => x > 0).length / Math.max(n, 1), noise,
    snr: noise > 0 ? (p95 - p50) / noise : NaN, p50, p95, max: sorted[n - 1] ?? 0,
    hist: hg.counts, histLo: hg.lo, histHi: hg.hi,
  };
}

/** Szum metody (Buades): residuum = przed − po. Jeśli filtr usunął tylko szum, residuum nie ma
 * struktury (Moran I ≈ 0) i jego σ jest bliska σ szumu wejścia. */
export function methodNoise(before: Grid, after: Grid): { residual: Grid; moran: number; resSd: number; noiseIn: number } {
  const v = new Float64Array(before.v.length);
  const m = new Uint8Array(before.v.length);
  const vals: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (before.m[i] && after.m[i]) { m[i] = 1; v[i] = before.v[i] - after.v[i]; vals.push(v[i]); }
  }
  const residual: Grid = { w: before.w, h: before.h, v, m };
  const mean = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1);
  const resSd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(vals.length - 1, 1));
  return { residual, moran: moransI(residual), resSd, noiseIn: estimateNoise(before) };
}
