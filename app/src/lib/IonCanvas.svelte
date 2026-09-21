<script lang="ts">
  import { renderToCanvas, BRUKER_LUT } from "./colormap.js";
  import type { TissueImage } from "./api.js";

  interface Props {
    tissue?: TissueImage | null;
    loading?: boolean;
    dispMin?: number;
    dispMax?: number;
    accentColor?: string;
    invertColors?: boolean;
  }
  let { tissue = null, loading = false, dispMin = 0, dispMax = 1, accentColor = "", invertColors = false }: Props = $props();

  let ionCanvas: HTMLCanvasElement | undefined = $state();
  let barCanvas:  HTMLCanvasElement | undefined = $state();

  // Renderuje obraz z window/level remapowaniem
  $effect(() => {
    if (!ionCanvas || !tissue) return;
    const ctx = ionCanvas.getContext("2d");
    if (!ctx) return;

    const lo = dispMin;
    const hi = dispMax;
    const span = hi - lo;

    const remapped = tissue.data.map(row =>
      row.map(v => {
        if (span <= 0 || v <= 0) return 0;
        let t = Math.min(1, Math.max(0, (v - lo) / span));
        return invertColors ? 1 - t : t;
      })
    );
    renderToCanvas(ctx, remapped);
  });

  // Renderuje pionowy colorbar z zaznaczonym oknem zakresu
  $effect(() => {
    if (!barCanvas) return;
    const ctx = barCanvas.getContext("2d");
    if (!ctx) return;
    const h = barCanvas.height;
    const w = barCanvas.width;
    const imgData = ctx.createImageData(w, h);

    for (let y = 0; y < h; y++) {
      const t = 1 - y / (h - 1);  // 1 na górze (100%), 0 na dole (0%)
      const lutI = Math.round(t * 255) * 4;
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        // Obszar poza oknem przyciemniony
        const inWindow = t >= dispMin && t <= dispMax;
        const alpha = inWindow ? 255 : 80;
        imgData.data[idx]     = BRUKER_LUT[lutI];
        imgData.data[idx + 1] = BRUKER_LUT[lutI + 1];
        imgData.data[idx + 2] = BRUKER_LUT[lutI + 2];
        imgData.data[idx + 3] = alpha;
      }
    }
    ctx.clearRect(0, 0, w, h);
    ctx.putImageData(imgData, 0, 0);
  });
</script>

<div class="card" style={accentColor ? `border-left:3px solid ${accentColor};box-shadow:0 4px 24px rgba(0,0,0,0.5),inset 0 0 0 1px ${accentColor}22` : ""}>
  <div class="tissue-label" style={accentColor ? `color:${accentColor}` : ""}>{tissue?.label ?? "—"}</div>

  {#if loading}
    <div class="shimmer"></div>
  {:else if tissue}
    <div class="image-area">
      <canvas bind:this={ionCanvas} class="ion-canvas"></canvas>

      <div class="colorbar-wrap">
        <span class="cb-tick" style="top:0">100%</span>
        <span class="cb-tick" style="top:25%">75%</span>
        <span class="cb-tick" style="top:50%">50%</span>
        <span class="cb-tick" style="top:75%">25%</span>
        <span class="cb-tick" style="bottom:0">0%</span>
        <canvas bind:this={barCanvas} class="colorbar" width="14" height="200"></canvas>
      </div>
    </div>
    <div class="vmax-badge">max: {tissue.vmax.toExponential(2)}</div>
  {:else}
    <div class="placeholder">Wpisz m/z i kliknij Wczytaj</div>
  {/if}
</div>

<style>
  .card {
    position: relative;
    background: #1a1a1a;
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 180px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    transition: box-shadow 0.2s;
  }

  .card:hover {
    box-shadow: 0 6px 32px rgba(255,201,81,0.18);
  }

  .tissue-label {
    position: absolute;
    top: 8px;
    left: 12px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #ffc951;
    text-shadow: 0 1px 4px rgba(0,0,0,0.8);
    z-index: 2;
    text-transform: uppercase;
  }

  .image-area {
    flex: 1;
    display: flex;
    flex-direction: row;
    align-items: stretch;
    overflow: hidden;
    padding: 28px 6px 22px 6px;
  }

  .ion-canvas {
    flex: 1;
    min-width: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    image-rendering: pixelated;
    display: block;
  }

  .colorbar-wrap {
    position: relative;
    width: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: stretch;
    margin-left: 6px;
  }

  .colorbar {
    width: 14px;
    height: 100%;
    display: block;
    border-radius: 3px;
    image-rendering: auto;
    min-height: 80px;
  }

  .cb-tick {
    position: absolute;
    right: 0;
    font-size: 0.55rem;
    color: rgba(255,255,255,0.45);
    line-height: 1;
    white-space: nowrap;
    transform: translateY(-50%);
  }

  .cb-tick:first-of-type  { transform: translateY(0); }
  .cb-tick:last-of-type   { transform: translateY(0); bottom: 0; top: auto; }

  .vmax-badge {
    position: absolute;
    bottom: 5px;
    left: 10px;
    font-size: 0.6rem;
    color: rgba(255,255,255,0.28);
    z-index: 2;
  }

  .placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255,255,255,0.18);
    font-size: 0.8rem;
  }

  .shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, #1a1a1a 25%, #2a2a2a 50%, #1a1a1a 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite;
  }

  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
