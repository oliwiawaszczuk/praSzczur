<script lang="ts">
  import { onMount, tick } from "svelte";
  import Plotly from "plotly.js-dist-min";
  import { fetchTissuePixelMap, fetchPixelSpectrum } from "./api.js";
  import type { TissuePixelMap, PixelSpectrum } from "./api.js";

  interface Props {
    tissues?: string[];       // lista dostępnych tkanek (id)
    activeMz?: number | null; // aktualnie wybrane m/z z zakładki m/z
    activeTol?: number;
  }

  let { tissues = [], activeMz = null, activeTol = 0.3 }: Props = $props();

  // ── Stan ─────────────────────────────────────────────────────────────────
  interface Layer {
    id: string;
    label: string;
    color: string;
    visible: boolean;
    locked: boolean;
    spectrum: PixelSpectrum;
  }

  const COLORS = ["#ffc951","#7ec8e3","#a8e6cf","#ff8b94","#c9b1ff","#ffcba4","#b5ead7","#ffdac1"];

  let selectedTissue  = $state(tissues[0] ?? "");
  let pixelMap        = $state<TissuePixelMap | null>(null);
  let mapLoading      = $state(false);
  let layers          = $state<Layer[]>([]);
  let layerLoading    = $state(false);
  let normMode        = $state<"none" | "max" | "tic">("none");
  let plotDiv         = $state<HTMLDivElement | null>(null);
  let mapCanvas       = $state<HTMLCanvasElement | null>(null);
  let hoverPixel      = $state<{x:number;y:number}|null>(null);

  // drag-to-reorder
  let dragIdx         = $state<number | null>(null);

  // ── Ładowanie mapy pikseli ────────────────────────────────────────────────
  async function loadMap() {
    if (!selectedTissue) return;
    mapLoading = true;
    try {
      pixelMap = await fetchTissuePixelMap(
        selectedTissue,
        activeMz ?? undefined,
        activeTol,
      );
    } catch { pixelMap = null; }
    finally { mapLoading = false; }
  }

  $effect(() => {
    selectedTissue; activeMz; activeTol;
    loadMap();
  });

  $effect(() => {
    if (tissues.length > 0 && !selectedTissue) selectedTissue = tissues[0];
  });

  // ── Rysowanie mapy pikseli na canvas ──────────────────────────────────────
  const BRUKER_LUT: [number,number,number][] = [
    [0,0,131],[0,0,255],[0,125,255],[0,255,255],
    [125,255,125],[255,255,0],[255,125,0],[255,0,0],[131,0,0],
  ];

  function lut(v: number): [number,number,number] {
    const t = Math.max(0, Math.min(1, v)) * (BRUKER_LUT.length - 1);
    const lo = Math.floor(t), hi = Math.min(lo + 1, BRUKER_LUT.length - 1);
    const f  = t - lo;
    return [
      Math.round(BRUKER_LUT[lo][0] * (1-f) + BRUKER_LUT[hi][0] * f),
      Math.round(BRUKER_LUT[lo][1] * (1-f) + BRUKER_LUT[hi][1] * f),
      Math.round(BRUKER_LUT[lo][2] * (1-f) + BRUKER_LUT[hi][2] * f),
    ];
  }

  $effect(() => {
    if (!mapCanvas || !pixelMap) return;
    const { xs, ys, values } = pixelMap;
    if (xs.length === 0) return;

    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const W = xMax - xMin + 1, H = yMax - yMin + 1;

    const SCALE = Math.min(Math.floor(280 / W), Math.floor(300 / H), 6) || 1;
    mapCanvas.width  = W * SCALE;
    mapCanvas.height = H * SCALE;

    const ctx = mapCanvas.getContext("2d")!;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

    for (let i = 0; i < xs.length; i++) {
      const [r,g,b] = lut(values[i]);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect((xs[i]-xMin)*SCALE, (ys[i]-yMin)*SCALE, SCALE, SCALE);
    }

    // Store scale/offset for click mapping
    (mapCanvas as any)._mapMeta = { xMin, yMin, SCALE };
  });

  function onMapClick(e: MouseEvent) {
    if (!mapCanvas || !pixelMap) return;
    const rect = mapCanvas.getBoundingClientRect();
    const { xMin, yMin, SCALE } = (mapCanvas as any)._mapMeta ?? {};
    if (SCALE === undefined) return;
    const px = xMin + Math.floor((e.clientX - rect.left) / SCALE);
    const py = yMin + Math.floor((e.clientY - rect.top)  / SCALE);
    addLayer(px, py);
  }

  function onMapMouseMove(e: MouseEvent) {
    if (!mapCanvas || !pixelMap) return;
    const rect = mapCanvas.getBoundingClientRect();
    const { xMin, yMin, SCALE } = (mapCanvas as any)._mapMeta ?? {};
    if (SCALE === undefined) return;
    const px = xMin + Math.floor((e.clientX - rect.left) / SCALE);
    const py = yMin + Math.floor((e.clientY - rect.top)  / SCALE);
    const idx = pixelMap.xs.findIndex((x, i) => x === px && pixelMap!.ys[i] === py);
    hoverPixel = idx >= 0 ? { x: px, y: py } : null;
  }

  // ── Warstwy ───────────────────────────────────────────────────────────────
  async function addLayer(x: number, y: number) {
    if (!selectedTissue) return;
    if (layers.some(l => l.spectrum.x === x && l.spectrum.y === y && l.spectrum.tissue === selectedTissue)) return;
    layerLoading = true;
    try {
      const spec = await fetchPixelSpectrum(selectedTissue, x, y);
      const color = COLORS[layers.length % COLORS.length];
      layers = [...layers, {
        id:      `${selectedTissue}_${x}_${y}`,
        label:   `${selectedTissue} (${x},${y})`,
        color,
        visible: true,
        locked:  false,
        spectrum: spec,
      }];
    } catch { /* pixel not found */ }
    finally { layerLoading = false; }
  }

  function removeLayer(id: string) {
    const l = layers.find(l => l.id === id);
    if (l?.locked) return;
    layers = layers.filter(l => l.id !== id);
  }

  // ── Drag-to-reorder ───────────────────────────────────────────────────────
  function onDragStart(i: number) { dragIdx = i; }

  function onDragOver(e: DragEvent, i: number) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === i) return;
    const arr = [...layers];
    const [moved] = arr.splice(dragIdx, 1);
    arr.splice(i, 0, moved);
    layers = arr;
    dragIdx = i;
  }

  function onDragEnd() { dragIdx = null; }

  function toggleVisible(id: string) {
    layers = layers.map(l => l.id === id ? { ...l, visible: !l.visible } : l);
  }

  function toggleLocked(id: string) {
    layers = layers.map(l => l.id === id ? { ...l, locked: !l.locked } : l);
  }

  function setColor(id: string, color: string) {
    layers = layers.map(l => l.id === id ? { ...l, color } : l);
  }

  function setLabel(id: string, label: string) {
    layers = layers.map(l => l.id === id ? { ...l, label } : l);
  }

  // ── Normalizacja ──────────────────────────────────────────────────────────
  function normalize(intensity: number[]): number[] {
    if (normMode === "none") return intensity;
    const ref = normMode === "max"
      ? Math.max(...intensity)
      : intensity.reduce((a, b) => a + b, 0);
    if (ref === 0) return intensity;
    return intensity.map(v => v / ref);
  }

  // ── Wykres Plotly ─────────────────────────────────────────────────────────
  $effect(() => {
    if (!plotDiv) return;
    layers; normMode; activeMz;

    const traces: Plotly.Data[] = layers
      .filter(l => l.visible)
      .map(l => ({
        x: l.spectrum.mz,
        y: normalize(l.spectrum.intensity),
        type:  "scatter" as const,
        mode:  "lines" as const,
        name:  l.label,
        line:  { color: l.color, width: 1.2 },
        hovertemplate: "<b>%{x:.4f} Da</b><br>Int: %{y:.0f}<extra></extra>",
      }));

    const shapes: Partial<Plotly.Shape>[] = activeMz != null ? [{
      type:      "line" as const,
      x0: activeMz, x1: activeMz,
      y0: 0,         y1: 1,
      yref:      "paper" as const,
      line:      { color: "#ffc951", width: 1, dash: "dot" as const },
    }] : [];

    const layout: Partial<Plotly.Layout> = {
      paper_bgcolor: "#1a1a1a",
      plot_bgcolor:  "#1a1a1a",
      font:          { color: "#ccc", family: "JetBrains Mono, monospace", size: 11 },
      margin:        { t: 10, r: 10, b: 40, l: 60 },
      xaxis: {
        title:      { text: "m/z [Da]", standoff: 6 },
        color:      "#888",
        gridcolor:  "#2a2a2a",
        zerolinecolor: "#333",
      },
      yaxis: {
        title: { text: normMode === "max" ? "Intensywność (max=1)" : normMode === "tic" ? "Intensywność (TIC=1)" : "Intensywność", standoff: 6 },
        color:      "#888",
        gridcolor:  "#2a2a2a",
        zerolinecolor: "#333",
      },
      legend: {
        bgcolor:     "rgba(30,30,30,0.9)",
        bordercolor: "#333",
        borderwidth: 1,
        font:        { size: 10 },
      },
      shapes,
      showlegend: layers.length > 1,
    };

    const config: Partial<Plotly.Config> = {
      responsive:   true,
      displaylogo:  false,
      modeBarButtonsToRemove: ["select2d","lasso2d","autoScale2d"] as any,
      toImageButtonOptions: { format: "png", scale: 2 },
    };

    if (traces.length === 0) {
      Plotly.react(plotDiv, [], layout, config);
    } else {
      Plotly.react(plotDiv, traces, layout, config);
    }
  });

  // Export CSV aktualnych widm
  function exportCsv() {
    const visible = layers.filter(l => l.visible);
    if (visible.length === 0) return;
    const mz = visible[0].spectrum.mz;
    const header = ["mz", ...visible.map(l => l.label)].join(",");
    const rows = mz.map((m, i) =>
      [m.toFixed(6), ...visible.map(l => normalize(l.spectrum.intensity)[i].toFixed(4))].join(",")
    );
    const blob = new Blob([header + "\n" + rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "widma.csv"; a.click();
  }
</script>

<div class="widma-layout">

  <!-- ── GÓRNY RZĄD: mapa + warstwy ─────────────────────────── -->
  <div class="top-row">

    <!-- Mapa pikseli -->
    <div class="map-panel card">
      <div class="panel-header">
        <span class="panel-title">Mapa pikseli</span>
        <select class="tissue-select" bind:value={selectedTissue}>
          {#each tissues as t}
            <option value={t}>{t}</option>
          {/each}
        </select>
        {#if mapLoading}<span class="loading-dot">●</span>{/if}
      </div>

      <div class="map-wrap">
        {#if !pixelMap && !mapLoading}
          <div class="map-hint">Brak danych — uruchom preprocessing</div>
        {:else}
          <canvas
            bind:this={mapCanvas}
            class="map-canvas"
            class:map-loading={layerLoading}
            onclick={onMapClick}
            onmousemove={onMapMouseMove}
            onmouseleave={() => hoverPixel = null}
            title="Kliknij piksel aby dodać widmo"
          ></canvas>
        {/if}
      </div>

      <div class="map-footer">
        {#if layerLoading}
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

    <!-- Warstwy -->
    <div class="layers-panel card">
      <div class="panel-header">
        <span class="panel-title">Warstwy</span>
      </div>

      {#if layers.length === 0}
        <div class="layers-empty">Kliknij piksel na mapie aby dodać widmo</div>
      {:else}
        <div class="layers-list">
          {#each layers as layer, i (layer.id)}
            <div
              class="layer-row"
              class:hidden-layer={!layer.visible}
              class:dragging={dragIdx === i}
              draggable="true"
              ondragstart={() => onDragStart(i)}
              ondragover={(e) => onDragOver(e, i)}
              ondragend={onDragEnd}
            >
              <span class="drag-handle" title="Przeciągnij aby zmienić kolejność">⠿</span>
              <input
                type="color"
                class="layer-color"
                value={layer.color}
                onchange={(e) => setColor(layer.id, (e.target as HTMLInputElement).value)}
              />
              <input
                class="layer-name"
                type="text"
                value={layer.label}
                onchange={(e) => setLabel(layer.id, (e.target as HTMLInputElement).value)}
              />
              <button
                class="layer-btn"
                class:active={layer.visible}
                onclick={() => toggleVisible(layer.id)}
                title={layer.visible ? "Ukryj" : "Pokaż"}
              >👁</button>
              <button
                class="layer-btn"
                class:active={layer.locked}
                onclick={() => toggleLocked(layer.id)}
                title={layer.locked ? "Odblokuj" : "Zablokuj"}
              >🔒</button>
              <button
                class="layer-btn del"
                onclick={() => removeLayer(layer.id)}
                disabled={layer.locked}
                title="Usuń"
              >×</button>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Normalizacja -->
      <div class="divider"></div>
      <div class="norm-row">
        <span class="norm-label">Norm:</span>
        {#each (["none","max","tic"] as const) as m}
          <button
            class="norm-btn"
            class:active={normMode === m}
            onclick={() => normMode = m}
          >{{ none:"brak", max:"max", tic:"TIC" }[m]}</button>
        {/each}
      </div>

      <div class="export-row">
        <button class="btn-sm" onclick={exportCsv}>↓ CSV</button>
      </div>
    </div>

  </div>

  <!-- ── WIDMO ───────────────────────────────────────────────── -->
  <div class="plot-panel card">
    {#if layers.length === 0}
      <div class="plot-hint">
        <div class="hint-icon">〜</div>
        <div>Kliknij piksel na mapie aby wyświetlić widmo</div>
      </div>
    {:else}
      <div class="plot-wrap" bind:this={plotDiv}></div>
    {/if}
  </div>

</div>

<style>
  .widma-layout {
    display: flex;
    flex-direction: column;
    height: 100%;
    gap: 10px;
    padding: 12px;
    box-sizing: border-box;
    overflow: hidden;
  }

  .top-row {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }

  .card {
    background: #222;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;
    padding: 10px 12px;
    box-sizing: border-box;
  }

  /* ── Mapa ────── */
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

  /* ── Warstwy ────── */
  .layers-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
  }

  .layers-empty {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.2);
    padding: 12px 0;
    text-align: center;
  }

  .layers-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .layer-row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 6px;
    background: #1a1a1a;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.06);
    cursor: grab;
    user-select: none;
  }
  .layer-row:active { cursor: grabbing; }
  .layer-row.dragging { opacity: 0.4; border-style: dashed; }
  .layer-row.hidden-layer { opacity: 0.35; }

  .drag-handle {
    font-size: 0.9rem;
    color: rgba(255,255,255,0.2);
    cursor: grab;
    flex-shrink: 0;
    line-height: 1;
  }

  .layer-color {
    width: 22px; height: 22px;
    border: none; background: none;
    cursor: pointer; padding: 0; border-radius: 4px;
    flex-shrink: 0;
  }

  .layer-name {
    flex: 1;
    background: transparent;
    border: none;
    color: #e0e0e0;
    font-size: 0.75rem;
    font-family: inherit;
    outline: none;
    min-width: 0;
  }

  .layer-btn {
    background: none;
    border: none;
    color: rgba(255,255,255,0.3);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 2px 4px;
    border-radius: 4px;
    line-height: 1;
    transition: color 0.15s, background 0.15s;
    flex-shrink: 0;
  }
  .layer-btn:hover { background: rgba(255,255,255,0.07); color: #e0e0e0; }
  .layer-btn.active { color: #ffc951; }
  .layer-btn.del:not(:disabled):hover { color: #ff6b6b; }
  .layer-btn:disabled { opacity: 0.2; cursor: not-allowed; }

  /* ── Normalizacja ────── */
  .norm-row {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .norm-label {
    font-size: 0.66rem;
    color: rgba(255,255,255,0.35);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    flex-shrink: 0;
  }

  .norm-btn {
    padding: 3px 8px;
    background: transparent;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 5px;
    color: rgba(255,255,255,0.35);
    font-size: 0.68rem;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, color 0.15s;
  }
  .norm-btn.active { border-color: #ffc951; color: #ffc951; }

  .export-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-top: 4px;
  }

  /* ── Widmo ────── */
  .plot-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 6px 8px;
  }

  .plot-wrap {
    flex: 1;
    min-height: 0;
  }

  .plot-hint {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: rgba(255,255,255,0.2);
    font-size: 0.8rem;
  }
  .hint-icon { font-size: 2rem; opacity: 0.3; }

  /* ── Wspólne ────── */
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
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.75rem;
    padding: 3px 6px;
    font-family: inherit;
    cursor: pointer;
  }

  .btn-sm {
    padding: 3px 8px;
    background: transparent;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    color: rgba(255,255,255,0.45);
    font-size: 0.68rem;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, color 0.15s;
    flex-shrink: 0;
  }
  .btn-sm:hover { border-color: rgba(255,201,81,0.4); color: #ffc951; }

  .divider {
    height: 1px;
    background: rgba(255,255,255,0.06);
    margin: 4px 0;
  }

  .loading-dot {
    font-size: 0.6rem;
    color: #ffc951;
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100%{opacity:0.3} 50%{opacity:1} }
</style>
