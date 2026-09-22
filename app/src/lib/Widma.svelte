<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import Plotly from "plotly.js-dist-min";
  import { fetchTissuePixelMap, fetchPixelSpectrum, fetchPixelSpectrumRaw } from "./api.js";
  import type { TissuePixelMap, PixelSpectrum } from "./api.js";
  import { wsGet, wsSet } from "$lib/workspace.svelte";

  const LS_LAYERS    = "widma_layers";
  const LS_NORM      = "widma_norm";
  const LS_TISSUE    = "widma_tissue";
  const LS_ORIGINAL  = "widma_original";

  interface SavedLayer { tissue: string; x: number; y: number; label: string; color: string; visible: boolean; locked: boolean; }

  interface Props {
    tissues?: string[];
    activeMz?: number | null;
    activeTol?: number;
    tissueLabels?: Record<string, string>;
    dispMin?: number;
    dispMax?: number;
    filekey?: number;  // inkrementowany przy każdym nowym pliku → czyści warstwy
    tissueVmax?: Record<string, number>;  // globalny vmax per tkanka z ion_image
  }

  let { tissues = [], activeMz = null, activeTol = 0.3, tissueLabels = {}, dispMin = 0, dispMax = 1, filekey = 0, tissueVmax = {} }: Props = $props();

  function tLabel(id: string): string { return tissueLabels[id] || id; }

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

  let selectedTissue  = $state(wsGet<string>(LS_TISSUE, tissues[0] ?? ""));
  let pixelMap        = $state<TissuePixelMap | null>(null);
  let mapLoading      = $state(false);
  let layers          = $state<Layer[]>([]);
  let _prevTissueKey  = $state("");   // do wykrywania zmiany zestawu tkanek

  $effect(() => {
    const key = tissues.slice().sort().join(",");
    if (_prevTissueKey && key !== _prevTissueKey) {
      layers = [];   // nowy plik — wyczyść stare warstwy
    }
    _prevTissueKey = key;
  });

  // Wyczyść warstwy gdy filekey się zmienia (nowy plik, nawet o tych samych id)
  let _prevFilekey = $state(filekey);
  $effect(() => {
    if (filekey !== _prevFilekey) {
      layers = [];
      _prevFilekey = filekey;
    }
  });
  let layerLoading    = $state(false);
  let normMode        = $state<"none" | "max" | "tic">(wsGet(LS_NORM, "none"));
  let showOriginal    = $state(wsGet(LS_ORIGINAL, false));
  let originalError   = $state("");
  let binMz           = $state<number[]>([]);   // centra binów (z binnowanego widma)
  let binIntensity    = $state<number[]>([]);   // intensywności binów (z pierwszej warstwy binnowanej)
  let binLevel        = $state(0);              // Y poziom kreski binów na wykresie
  let plotDiv         = $state<HTMLDivElement | null>(null);
  let mapCanvas       = $state<HTMLCanvasElement | null>(null);
  let hoverPixel      = $state<{x:number;y:number}|null>(null);

  // drag-to-reorder — dragIdx NIE jest reaktywny (zmiana by przerywała drag przez re-render)
  let dragIdx: number | null = null;
  let dragTarget      = $state<number | null>(null);

  // Persist (write-only effects — safe in browser)
  $effect(() => { wsSet(LS_TISSUE, selectedTissue); });
  $effect(() => { wsSet(LS_NORM, normMode); });
  $effect(() => { wsSet(LS_ORIGINAL, showOriginal); });
  $effect(() => {
    if (layers.length === 0) return;
    const saved: SavedLayer[] = layers.map(l => ({
      tissue: l.spectrum.tissue, x: l.spectrum.x, y: l.spectrum.y,
      label: l.label, color: l.color, visible: l.visible, locked: l.locked,
    }));
    wsSet(LS_LAYERS, saved);
  });

  // Warstwy wymagają fetchu (async) — jedyne co zostaje do zrobienia w onMount.
  // selectedTissue/normMode/showOriginal są już zainicjalizowane z workspace
  // bezpośrednio w deklaracjach $state powyżej.
  onMount(async () => {
    const saved = wsGet<SavedLayer[]>(LS_LAYERS, []);
    if (saved.length === 0) return;
    layerLoading = true;
    try {
      const restored: Layer[] = [];
      for (const s of saved) {
        try {
          const spec = await fetchPixelSpectrum(s.tissue, s.x, s.y);
          if (binMz.length === 0) { binMz = spec.mz; binIntensity = spec.intensity; }
          restored.push({ id: `${s.tissue}_${s.x}_${s.y}`, label: s.label, color: s.color, visible: s.visible, locked: s.locked, spectrum: spec });
        } catch {}
      }
      layers = restored;
    } finally { layerLoading = false; }
  });

  // ── Ładowanie mapy pikseli ────────────────────────────────────────────────
  async function loadMap() {
    if (!selectedTissue) return;
    mapLoading = true;
    try {
      const gVmax = tissueVmax[selectedTissue];
      pixelMap = await fetchTissuePixelMap(
        selectedTissue,
        activeMz ?? undefined,
        activeTol,
        gVmax,  // globalny vmax = identyczna skala jak w zakładce m/z
      );
    } catch { pixelMap = null; }
    finally { mapLoading = false; }
  }

  $effect(() => {
    selectedTissue; activeMz; activeTol; tissueVmax;
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

    const span = dispMax - dispMin;
    for (let i = 0; i < xs.length; i++) {
      const v = values[i];
      if (v <= 0) continue;
      const t = span > 0 ? Math.min(1, Math.max(0, (v - dispMin) / span)) : v;
      if (t <= 0) continue;
      const [r,g,b] = lut(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect((xs[i]-xMin)*scale, (ys[i]-yMin)*scale, scale, scale);
    }

    const circleR = Math.max(scale * circleScale, 4);
    for (const layer of layers) {
      if (!layer.visible) continue;
      const { x, y } = layer.spectrum;
      const cx = (x - xMin) * scale + scale / 2;
      const cy = (y - yMin) * scale + scale / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, circleR, 0, Math.PI * 2);
      ctx.fillStyle = layer.color + "bb";
      ctx.fill();
      ctx.strokeStyle = "#000000aa";
      ctx.lineWidth = Math.max(1, scale * 0.3);
      ctx.stroke();
    }

    (canvas as any)._mapMeta = { xMin, yMin, SCALE: scale };
  }

  let mapFullscreen = $state(false);
  let mapCanvasFull = $state<HTMLCanvasElement | null>(null);

  $effect(() => {
    if (!mapCanvas || !pixelMap) return;
    layers; dispMin; dispMax;
    const { xs, ys } = pixelMap;
    const W = Math.max(...xs) - Math.min(...xs) + 1;
    const H = Math.max(...ys) - Math.min(...ys) + 1;
    const SCALE = Math.min(Math.floor(280 / W), Math.floor(300 / H), 6) || 1;
    drawMapToCanvas(mapCanvas, SCALE);
  });

  $effect(() => {
    if (!mapCanvasFull || !pixelMap || !mapFullscreen) return;
    layers; dispMin; dispMax;
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
    addLayer(c.px, c.py);
  }

  function onMapMouseMove(e: MouseEvent) {
    if (!pixelMap) return;
    const c = canvasCoords(e);
    if (!c) return;
    const idx = pixelMap.xs.findIndex((x, i) => x === c.px && pixelMap!.ys[i] === c.py);
    hoverPixel = idx >= 0 ? { x: c.px, y: c.py } : null;
  }

  // ── Warstwy ───────────────────────────────────────────────────────────────
  async function fetchSpec(tissue: string, x: number, y: number) {
    return showOriginal
      ? fetchPixelSpectrumRaw(tissue, x, y)
      : fetchPixelSpectrum(tissue, x, y);
  }

  async function addLayer(x: number, y: number) {
    if (!selectedTissue) return;
    if (layers.some(l => l.spectrum.x === x && l.spectrum.y === y && l.spectrum.tissue === selectedTissue)) return;
    layerLoading = true;
    try {
      const spec = await fetchSpec(selectedTissue, x, y);
      if (!showOriginal && binMz.length === 0) { binMz = spec.mz; binIntensity = spec.intensity; }
      const color = COLORS[layers.length % COLORS.length];
      layers = [...layers, {
        id:      `${selectedTissue}_${x}_${y}`,
        label:   `${tLabel(selectedTissue)} (${x},${y})`,
        color,
        visible: true,
        locked:  false,
        spectrum: spec,
      }];
    } catch { /* pixel not found */ }
    finally { layerLoading = false; }
  }

  // Przeładuj widma gdy zmienia się tryb binned/original (nie na init)
  $effect(() => {
    const orig = showOriginal; // śledź tylko to
    const current = untrack(() => layers);
    originalError = "";
    if (current.length === 0) return;
    (async () => {
      layerLoading = true;
      try {
        const updated = await Promise.all(current.map(async l => {
          if (orig) {
            const r = await fetch(`http://127.0.0.1:7432/pixel_spectrum_raw?tissue=${l.spectrum.tissue}&x=${l.spectrum.x}&y=${l.spectrum.y}`);
            if (!r.ok) {
              if (r.status === 503) {
                originalError = "Brak ścieżki do pliku imzML. Uruchom preprocessing raz aby zapamiętać ścieżkę.";
              } else {
                originalError = `Błąd ${r.status} przy pobieraniu oryginalnego widma.`;
              }
              return l;
            }
            return { ...l, spectrum: await r.json() };
          } else {
            try {
              return { ...l, spectrum: await fetchPixelSpectrum(l.spectrum.tissue, l.spectrum.x, l.spectrum.y) };
            } catch { return l; }
          }
        }));
        layers = updated;
      } finally { layerLoading = false; }
    })();
  });

  function removeLayer(id: string) {
    const l = layers.find(l => l.id === id);
    if (l?.locked) return;
    layers = layers.filter(l => l.id !== id);
  }

  // ── Drag-to-reorder ───────────────────────────────────────────────────────
  function listEl(e: Event): Element | null {
    return (e.currentTarget as HTMLElement).closest('.layers-list');
  }

  function onDragStart(e: DragEvent, i: number) {
    dragIdx = i;
    e.dataTransfer?.setData("text/plain", String(i));
    // Klasa przez bezpośredni DOM — bez re-renderu Svelte
    listEl(e)?.classList.add('is-dragging');
  }

  function onDragOver(e: DragEvent, i: number) {
    e.preventDefault();
    dragTarget = i;  // reaktywne tylko to → re-render dodaje highlight na row, nie psuje dragged el
  }

  function onDrop(e: DragEvent, i: number) {
    e.preventDefault();
    const from = dragIdx;
    dragIdx = null;
    dragTarget = null;
    listEl(e)?.classList.remove('is-dragging');
    if (from === null || from === i) return;
    const arr = [...layers];
    const [moved] = arr.splice(from, 1);
    arr.splice(i, 0, moved);
    layers = arr;
  }

  function onDragEnd(e: DragEvent) {
    dragIdx = null;
    dragTarget = null;
    listEl(e)?.classList.remove('is-dragging');
  }

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
    layers; normMode; activeMz; dispMin; dispMax; showOriginal; binMz; binIntensity; binLevel;

    // Zachowaj aktualny zakres osi (żeby zoom nie ginął po update)
    const existingLayout = (plotDiv as any).layout as Plotly.Layout | undefined;
    const savedXRange = existingLayout?.xaxis?.range;
    const savedYRange = existingLayout?.yaxis?.range;
    const xAutoRange  = existingLayout?.xaxis?.autorange;
    const yAutoRange  = existingLayout?.yaxis?.autorange;
    const userZoomedX = savedXRange && xAutoRange !== true;
    const userZoomedY = savedYRange && yAutoRange !== true;

    // Kreska binów — pionowe ticki + linia pozioma na poziomie binLevel gdy showOriginal
    const binTrace: Plotly.Data[] = (showOriginal && binMz.length > 0) ? [{
      x: binMz,
      y: Array(binMz.length).fill(binLevel),
      type:  "scatter" as const,
      mode:  "markers" as const,
      name:  "biny",
      marker: { symbol: "line-ns-open" as any, size: 9, color: "rgba(120,220,255,0.7)", line: { width: 1.5, color: "rgba(120,220,255,0.7)" } },
      hovertemplate: "<b>%{x:.4f} Da</b><extra>bin</extra>",
      showlegend: false,
    }] : [];

    // Pionowe przerywane linie — słupki intensywności binów (od binLevel w górę)
    // Wysokość = średnia intensywność widocznych warstw w okolicach centrum binu
    const binBarTrace: Plotly.Data[] = (showOriginal && binMz.length > 0) ? (() => {
      const visLayers = layers.filter(l => l.visible);
      if (visLayers.length === 0) return [];

      // szerokość binu (zakładamy równomierne rozmieszczenie)
      const halfBin = binMz.length > 1 ? (binMz[1] - binMz[0]) / 2 : 0.5;

      // binary search: pierwszy indeks >= value
      function lowerBound(arr: number[], value: number): number {
        let lo = 0, hi = arr.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < value) lo = mid + 1; else hi = mid; }
        return lo;
      }

      const avgInts = binMz.map(bm => {
        const lo = bm - halfBin, hi = bm + halfBin;
        let total = 0, count = 0;
        for (const l of visLayers) {
          const mzArr = l.spectrum.mz;
          const normInt = normalize(l.spectrum.intensity);
          const start = lowerBound(mzArr, lo);
          for (let j = start; j < mzArr.length && mzArr[j] < hi; j++) {
            total += normInt[j];
            count++;
          }
        }
        return count > 0 ? total / count : 0;
      });

      const xs: (number | null)[] = [];
      const ys: (number | null)[] = [];
      for (let i = 0; i < binMz.length; i++) {
        xs.push(binMz[i] - halfBin, binMz[i] - halfBin, null);
        ys.push(binLevel, binLevel + avgInts[i], null);
      }
      return [{
        x: xs, y: ys,
        type:  "scatter" as const,
        mode:  "lines" as const,
        line:  { color: "rgba(120,220,255,0.5)", width: 1, dash: "dot" as const },
        hoverinfo: "none" as const,
        showlegend: false,
      }];
    })() : [];

    const traces: Plotly.Data[] = [...binTrace, ...binBarTrace, ...layers
      .filter(l => l.visible)
      .map(l => ({
        x: l.spectrum.mz,
        y: normalize(l.spectrum.intensity),
        type:  "scatter" as const,
        mode:  "lines" as const,
        name:  l.label,
        line:  { color: l.color, width: 1.2 },
        hovertemplate: "<b>%{x:.4f} Da</b><br>Int: %{y:.0f}<extra></extra>",
      }))
    ];

    const shapes: Partial<Plotly.Shape>[] = [
      ...(activeMz != null ? [{
        type:  "line" as const,
        x0: activeMz, x1: activeMz,
        y0: 0, y1: 1,
        yref: "paper" as const,
        line: { color: "#ffc951", width: 1, dash: "dot" as const },
      }] : []),
      ...(showOriginal && binMz.length > 0 ? [{
        type:  "line" as const,
        x0: 0, x1: 1,
        xref: "paper" as const,
        y0: binLevel, y1: binLevel,
        line: { color: "rgba(120,220,255,0.4)", width: 1, dash: "dot" as const },
      }] : []),
    ];

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
        ...(userZoomedX ? { range: savedXRange, autorange: false } : {}),
      },
      yaxis: {
        title: { text: normMode === "max" ? "Intensywność (max=1)" : normMode === "tic" ? "Intensywność (TIC=1)" : "Intensywność", standoff: 6 },
        color:      "#888",
        gridcolor:  "#2a2a2a",
        zerolinecolor: "#333",
        // Priorytet: zachowaj zoom użytkownika; jeśli brak — zastosuj dispMin/dispMax
        ...(() => {
          if (userZoomedY) return { range: savedYRange, autorange: false };
          if (dispMin === 0 && dispMax === 1) return {};
          const visible = layers.filter(l => l.visible);
          if (visible.length === 0) return {};
          const gmax = Math.max(...visible.flatMap(l => normalize(l.spectrum.intensity)));
          if (!isFinite(gmax) || gmax === 0) return {};
          return { range: [dispMin * gmax, dispMax * gmax], autorange: false };
        })(),
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

    Plotly.react(plotDiv, traces, layout, config).then(() => {
      // Wymuś resize przy pierwszym renderze (Plotly nie zna rozmiaru kontenera przed mount)
      Plotly.Plots.resize(plotDiv!);
    });
  });

  // ResizeObserver — Plotly reaguje na zmianę rozmiaru kontenera
  $effect(() => {
    if (!plotDiv) return;
    const ro = new ResizeObserver(() => { Plotly.Plots.resize(plotDiv!); });
    ro.observe(plotDiv);
    return () => ro.disconnect();
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
              class:drag-target={dragTarget === i}
              class:is-locked={layer.locked}
              draggable={!layer.locked}
              ondragstart={(e) => onDragStart(e, i)}
              ondragover={(e) => onDragOver(e, i)}
              ondrop={(e) => onDrop(e, i)}
              ondragend={(e) => onDragEnd(e)}
              ondragleave={() => { if (dragIdx !== null) dragTarget = null; }}
            >
              <span class="drag-handle" class:drag-disabled={layer.locked}>⠿</span>
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
                readonly={layer.locked}
                onchange={(e) => setLabel(layer.id, (e.target as HTMLInputElement).value)}
              />
              {#if layer.locked}
                <span class="lock-badge" title="Zablokowana">⊘</span>
              {/if}
              <button
                class="layer-btn vis-btn"
                class:vis-off={!layer.visible}
                onclick={() => toggleVisible(layer.id)}
                title={layer.visible ? "Ukryj" : "Pokaż"}
              ></button>
              <button
                class="layer-btn lock-btn"
                class:lock-on={layer.locked}
                onclick={() => toggleLocked(layer.id)}
                title={layer.locked ? "Odblokuj" : "Zablokuj"}
              ></button>
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

      <label class="orig-row">
        <span class="custom-check" class:checked={showOriginal}>
          <input type="checkbox" bind:checked={showOriginal} />
        </span>
        <span class="orig-label">Oryginalne widmo</span>
      </label>
      {#if showOriginal}
        <div class="bin-level-row">
          <span class="orig-label">Poziom kreski</span>
          <input
            class="bin-level-input"
            type="number"
            step="any"
            value={binLevel}
            onchange={(e) => { binLevel = parseFloat((e.target as HTMLInputElement).value) || 0; }}
            onkeydown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
        </div>
      {/if}
      {#if originalError}
        <div class="orig-error">{originalError}</div>
      {/if}

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
      {#if layerLoading}
        <div class="plot-loading">
          <span class="loading-dot">●</span> Wczytuję widmo…
        </div>
      {/if}
    {/if}
  </div>

</div>

<!-- ── FULLSCREEN MAP MODAL ───────────────────────────────── -->
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
          title="Kliknij piksel aby dodać widmo"
        ></canvas>
      </div>
    </div>
  </div>
{/if}

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
    max-height: calc(7 * (30px + 4px));
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.08) transparent;
  }

  /* Podczas drag: children nie przechwytują zdarzeń → drop trafia do .layer-row */
  .layers-list.is-dragging .layer-row > * {
    pointer-events: none;
  }

  .layer-row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px 3px 6px;
    background: #1a1a1a;
    border-radius: 16px;
    border: 1px solid rgba(255,255,255,0.06);
    cursor: grab;
    user-select: none;
    transition: border-color 0.15s, background 0.15s;
    min-height: 30px;
  }
  .layer-row:active { cursor: grabbing; }
  .layer-row.dragging { opacity: 0.35; border-style: dashed; }
  .layer-row.drag-target { border-color: rgba(255,201,81,0.5); background: rgba(255,201,81,0.05); }
  .layer-row.hidden-layer { opacity: 0.38; }
  .layer-row.is-locked {
    cursor: default;
    border-color: rgba(255,160,50,0.2);
    background: rgba(255,160,50,0.04);
  }

  .drag-handle {
    font-size: 0.9rem;
    color: rgba(255,255,255,0.18);
    cursor: grab;
    flex-shrink: 0;
    line-height: 1;
  }
  .drag-handle.drag-disabled {
    color: rgba(255,255,255,0.08);
    cursor: default;
  }

  .lock-badge {
    font-size: 0.65rem;
    color: rgba(255,160,50,0.7);
    flex-shrink: 0;
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
    color: rgba(255,255,255,0.28);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 2px 4px;
    border-radius: 4px;
    line-height: 1;
    transition: color 0.15s, background 0.15s;
    flex-shrink: 0;
  }
  .layer-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.7); }
  .layer-btn.del:not(:disabled):hover { color: #ff6b6b; }
  .layer-btn:disabled { opacity: 0.15; cursor: not-allowed; }

  /* ikona widoczności — mała elipsa */
  .vis-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 18px;
    padding: 0;
  }
  .vis-btn::before {
    content: "";
    display: inline-block;
    width: 14px;
    height: 7px;
    border-radius: 4px;
    background: rgba(255,255,255,0.45);
    transition: background 0.15s, box-shadow 0.15s;
    box-shadow: 0 0 0 0 rgba(255,201,81,0);
  }
  .vis-btn.vis-off::before {
    background: transparent;
    border: 1px solid rgba(255,255,255,0.18);
  }
  .vis-btn:hover::before { background: rgba(255,255,255,0.85); }
  .vis-btn.vis-off:hover::before { border-color: rgba(255,255,255,0.55); }

  /* ikona blokady — małe litery */
  .lock-btn::before {
    content: "—";
    font-size: 0.6rem;
    color: rgba(255,255,255,0.2);
    letter-spacing: -1px;
  }
  .lock-btn.lock-on::before {
    content: "■";
    font-size: 0.5rem;
    color: rgba(255,160,50,0.8);
  }
  .lock-btn:hover::before { color: rgba(255,255,255,0.7); }

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
    overflow: hidden;
    position: relative;
  }

  .plot-wrap {
    flex: 1;
    min-height: 0;
    width: 100%;
  }

  .plot-loading {
    position: absolute;
    bottom: 10px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(26,26,26,0.88);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    padding: 5px 14px;
    font-size: 0.72rem;
    color: rgba(255,255,255,0.55);
    display: flex;
    align-items: center;
    gap: 6px;
    pointer-events: none;
    backdrop-filter: blur(4px);
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

  /* ── Expand button ────── */
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

  /* ── Fullscreen modal ────── */
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

  /* ── Checkbox oryginalne widmo ────── */
  .orig-row {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    cursor: pointer;
    padding: 4px 0;
  }

  .bin-level-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0 4px 22px;
  }

  .bin-level-input {
    width: 72px;
    background: #111;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 5px;
    color: #e0e0e0;
    font-size: 0.72rem;
    font-family: inherit;
    padding: 2px 5px;
    outline: none;
  }
  .bin-level-input:focus { border-color: rgba(255,201,81,0.4); }

  .orig-label {
    font-size: 0.68rem;
    color: rgba(255,255,255,0.38);
  }

  .orig-error {
    font-size: 0.62rem;
    color: #ff8b8b;
    line-height: 1.4;
    padding: 2px 0;
  }

  .custom-check {
    position: relative;
    width: 16px;
    height: 16px;
    border: 1.5px solid rgba(255,255,255,0.2);
    border-radius: 4px;
    background: transparent;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: border-color 0.15s, background 0.15s;
  }
  .custom-check input {
    position: absolute;
    opacity: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    cursor: pointer;
  }
  .custom-check.checked {
    background: #ffc951;
    border-color: #ffc951;
  }
  .custom-check.checked::after {
    content: "";
    display: block;
    width: 4px;
    height: 7px;
    border-right: 1.5px solid #222;
    border-bottom: 1.5px solid #222;
    transform: rotate(45deg) translate(-1px, -1px);
  }
</style>
