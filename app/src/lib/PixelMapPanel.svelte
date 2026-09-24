<script lang="ts">
  import { fetchTissuePixelMap } from "./api.js";
  import type { TissuePixelMap } from "./api.js";
  import { BRUKER_LUT } from "$lib/colormap";

  export interface PixelMarker { x: number; y: number; color: string; }

  interface Props {
    tissues?: string[];
    tissueLabels?: Record<string, string>;
    selectedTissue: string;
    activeMz?: number | null;
    activeTol?: number;
    dispMin?: number;
    dispMax?: number;
    invertColors?: boolean;
    tissueVmax?: Record<string, number>;
    /** Zestaw danych, z którego liczona jest mapa — MUSI być ten sam, co użyty
     * do policzenia `tissueVmax` (mapa jonowa w zakładce m/z), inaczej mapa
     * pikseli pokazuje inne dane niż to, co widać w m/z. */
    dataset?: string;
    markers?: PixelMarker[];
    title?: string;
    loading?: boolean;
    onselecttissue: (t: string) => void;
    onpixelclick: (x: number, y: number) => void;
  }

  let {
    tissues = [],
    tissueLabels = {},
    selectedTissue,
    activeMz = null,
    activeTol = 0.3,
    dispMin = 0,
    dispMax = 1,
    invertColors = false,
    tissueVmax = {},
    dataset = undefined,
    markers = [],
    title = "Mapa pikseli",
    loading = false,
    onselecttissue,
    onpixelclick,
  }: Props = $props();

  function tLabel(id: string): string { return tissueLabels[id] || id; }

  let pixelMap    = $state<TissuePixelMap | null>(null);
  let mapLoading  = $state(false);
  let mapCanvas   = $state<HTMLCanvasElement | null>(null);
  let hoverPixel  = $state<{ x: number; y: number } | null>(null);
  let mapFullscreen  = $state(false);
  let mapCanvasFull  = $state<HTMLCanvasElement | null>(null);

  async function loadMap() {
    if (!selectedTissue) return;
    mapLoading = true;
    try {
      const gVmax = tissueVmax[selectedTissue];
      pixelMap = await fetchTissuePixelMap(selectedTissue, activeMz ?? undefined, activeTol, gVmax, dataset);
    } catch { pixelMap = null; }
    finally { mapLoading = false; }
  }

  $effect(() => {
    selectedTissue; activeMz; activeTol; tissueVmax; dataset;
    loadMap();
  });

  function lut(t: number): [number, number, number] {
    const i = Math.round(Math.min(Math.max(t, 0), 1) * 255) * 4;
    return [BRUKER_LUT[i], BRUKER_LUT[i + 1], BRUKER_LUT[i + 2]];
  }

  function drawMapToCanvas(canvas: HTMLCanvasElement, scale: number, circleScale = 2) {
    if (!pixelMap) return;
    const { xs, ys, values } = pixelMap;
    if (xs.length === 0) return;

    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const W = xMax - xMin + 1, H = yMax - yMin + 1;

    canvas.width  = W * scale;
    canvas.height = H * scale;

    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const lo = dispMin, hi = dispMax, span = hi - lo;
    for (let i = 0; i < xs.length; i++) {
      const v = values[i];
      if (span <= 0) continue;
      let t = Math.min(1, Math.max(0, (v - lo) / span));
      t = invertColors ? 1 - t : t;
      const [r, g, b] = lut(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect((xs[i] - xMin) * scale, (ys[i] - yMin) * scale, scale, scale);
    }

    const circleR = Math.max(scale * circleScale, 4);
    for (const m of markers) {
      const cx = (m.x - xMin) * scale + scale / 2;
      const cy = (m.y - yMin) * scale + scale / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, circleR, 0, Math.PI * 2);
      ctx.fillStyle = m.color + "bb";
      ctx.fill();
      ctx.strokeStyle = "#000000aa";
      ctx.lineWidth = Math.max(1, scale * 0.3);
      ctx.stroke();
    }

    (canvas as any)._mapMeta = { xMin, yMin, SCALE: scale };
  }

  $effect(() => {
    if (!mapCanvas || !pixelMap) return;
    markers; dispMin; dispMax;
    const { xs, ys } = pixelMap;
    const W = Math.max(...xs) - Math.min(...xs) + 1;
    const H = Math.max(...ys) - Math.min(...ys) + 1;
    const SCALE = Math.min(Math.floor(280 / W), Math.floor(300 / H), 6) || 1;
    drawMapToCanvas(mapCanvas, SCALE);
  });

  $effect(() => {
    if (!mapCanvasFull || !pixelMap || !mapFullscreen) return;
    markers; dispMin; dispMax;
    const { xs, ys } = pixelMap;
    const W = Math.max(...xs) - Math.min(...xs) + 1;
    const H = Math.max(...ys) - Math.min(...ys) + 1;
    const availW = window.innerWidth  - 80;
    const availH = window.innerHeight - 80;
    const SCALE = Math.max(Math.min(Math.floor(availW / W), Math.floor(availH / H), 20), 1);
    drawMapToCanvas(mapCanvasFull, SCALE, 0.8);
  });

  function canvasCoords(e: MouseEvent): { px: number; py: number } | null {
    const canvas = e.currentTarget as HTMLCanvasElement;
    const meta = (canvas as any)._mapMeta;
    if (!meta) return null;
    const rect = canvas.getBoundingClientRect();
    const { xMin, yMin, SCALE } = meta;
    return {
      px: xMin + Math.floor((e.clientX - rect.left) / SCALE),
      py: yMin + Math.floor((e.clientY - rect.top)  / SCALE),
    };
  }

  function onMapClick(e: MouseEvent) {
    if (!pixelMap) return;
    const c = canvasCoords(e);
    if (!c) return;
    onpixelclick(c.px, c.py);
  }

  function onMapMouseMove(e: MouseEvent) {
    if (!pixelMap) return;
    const c = canvasCoords(e);
    if (!c) return;
    const idx = pixelMap.xs.findIndex((x, i) => x === c.px && pixelMap!.ys[i] === c.py);
    hoverPixel = idx >= 0 ? { x: c.px, y: c.py } : null;
  }
</script>

<div class="map-panel card">
  <div class="panel-header">
    <span class="panel-title">{title}</span>
    <select class="tissue-select" value={selectedTissue} onchange={(e) => onselecttissue((e.target as HTMLSelectElement).value)}>
      {#each tissues as t}
        <option value={t}>{tLabel(t)}</option>
      {/each}
    </select>
    {#if mapLoading}<span class="loading-dot">●</span>{/if}
    <button class="expand-btn" onclick={() => mapFullscreen = true} title="Powiększ mapę">⤢</button>
  </div>

  <div class="map-wrap">
    {#if !pixelMap && !mapLoading}
      <div class="map-hint">Brak danych — uruchom preprocessing</div>
    {:else}
      <canvas
        bind:this={mapCanvas}
        class="map-canvas"
        class:map-loading={loading}
        onclick={onMapClick}
        onmousemove={onMapMouseMove}
        onmouseleave={() => hoverPixel = null}
        title="Kliknij piksel aby zaznaczyć"
      ></canvas>
    {/if}
  </div>

  <div class="map-footer">
    {#if loading}
      <span class="loading-dot">● Wczytuję widmo…</span>
    {:else if hoverPixel}
      <span class="pixel-hint">x={hoverPixel.x}, y={hoverPixel.y}</span>
    {:else}
      <span class="pixel-hint muted">najedź na piksel</span>
    {/if}
    <span class="mz-badge {activeMz != null ? '' : 'muted'}">
      {activeMz != null ? `m/z ${activeMz.toFixed(3)} Da` : 'TIC'}
    </span>
  </div>
</div>

{#if mapFullscreen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="map-modal-backdrop" onclick={() => mapFullscreen = false}>
    <div class="map-modal-box" onclick={(e) => e.stopPropagation()}>
      <div class="map-modal-header">
        <span class="panel-title">
          {tLabel(selectedTissue)} — {activeMz != null ? `m/z ${activeMz.toFixed(3)} Da` : 'TIC'}
          {#if hoverPixel}<span class="modal-coords"> · x={hoverPixel.x}, y={hoverPixel.y}</span>{/if}
        </span>
        <button class="close-btn" onclick={() => mapFullscreen = false}>✕</button>
      </div>
      <div class="map-modal-body">
        <canvas
          bind:this={mapCanvasFull}
          class="map-canvas"
          onclick={onMapClick}
          onmousemove={onMapMouseMove}
          onmouseleave={() => hoverPixel = null}
          title="Kliknij piksel aby zaznaczyć"
        ></canvas>
      </div>
    </div>
  </div>
{/if}

<style>
  .card {
    background: #222;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;
    padding: 10px 12px;
    box-sizing: border-box;
  }

  .map-panel {
    width: 320px;
    min-width: 320px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .map-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
  }

  .map-canvas {
    cursor: crosshair;
    image-rendering: pixelated;
    max-width: 100%;
  }

  .map-hint {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.2);
    text-align: center;
  }

  .map-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-top: 4px;
    min-height: 16px;
  }

  .pixel-hint {
    font-size: 0.65rem;
    color: rgba(255,255,255,0.45);
  }
  .pixel-hint.muted { color: rgba(255,255,255,0.18); }

  .map-canvas.map-loading { cursor: wait; opacity: 0.6; }

  .mz-badge {
    font-size: 0.65rem;
    color: #ffc951;
    opacity: 0.8;
    white-space: nowrap;
  }
  .mz-badge.muted { color: rgba(255,255,255,0.25); }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    flex-shrink: 0;
  }

  .panel-title {
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.38);
    flex: 1;
  }

  .tissue-select {
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    background: #1a1a1a
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23ffc951' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>")
      no-repeat right 8px center;
    background-size: 9px 6px;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.72rem;
    padding: 4px 22px 4px 8px;
    font-family: inherit;
    cursor: pointer;
    outline: none;
    transition: border-color 0.15s, color 0.15s;
  }
  .tissue-select:hover  { border-color: rgba(255,201,81,0.3); color: #ffc951; }
  .tissue-select option { background: #1a1a1a; color: #e0e0e0; }

  .loading-dot {
    font-size: 0.6rem;
    color: #ffc951;
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100%{opacity:0.3} 50%{opacity:1} }

  .expand-btn {
    background: none;
    border: none;
    color: rgba(255,255,255,0.3);
    font-size: 0.9rem;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    line-height: 1;
    flex-shrink: 0;
    transition: color 0.15s;
  }
  .expand-btn:hover { color: #ffc951; }

  .map-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.75);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
  }

  .map-modal-box {
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: calc(100vw - 60px);
    max-height: calc(100vh - 60px);
    box-shadow: 0 24px 60px rgba(0,0,0,0.6);
    animation: modal-in 0.18s ease;
  }

  @keyframes modal-in {
    from { opacity: 0; transform: scale(0.96); }
    to   { opacity: 1; transform: scale(1); }
  }

  .map-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .close-btn {
    background: none;
    border: none;
    color: rgba(255,255,255,0.35);
    font-size: 1rem;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    transition: color 0.15s;
  }
  .close-btn:hover { color: #ff6b6b; }

  .map-modal-body {
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-coords {
    font-size: 0.65rem;
    color: rgba(255,255,255,0.4);
    font-weight: 400;
    letter-spacing: 0;
  }
</style>
