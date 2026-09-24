<script lang="ts">
  import { onMount, tick } from "svelte";
  import Plotly from "plotly.js-dist-min";
  import { fetchPixelSpectrum, fetchPixelSpectrumRaw } from "./api.js";
  import type { PixelSpectrum } from "./api.js";
  import { wsGet, wsSet } from "$lib/workspace.svelte";
  import { datasets, loadDatasets, datasetsLoaded, activeDatasetId, RAW_DATASET_ID } from "$lib/datasets.svelte";
  import PixelMapPanel from "$lib/PixelMapPanel.svelte";

  const LS_LAYERS    = "widma_layers";
  const LS_NORM      = "widma_norm";
  const LS_TISSUE    = "widma_tissue";
  const LS_NEW_DS    = "widma_newLayerDataset";

  interface SavedLayer { tissue: string; x: number; y: number; label: string; color: string; visible: boolean; locked: boolean; datasetId: string; }

  interface Props {
    tissues?: string[];
    activeMz?: number | null;
    activeTol?: number;
    tissueLabels?: Record<string, string>;
    dispMin?: number;
    dispMax?: number;
    invertColors?: boolean;
    filekey?: number;  // inkrementowany przy każdym nowym pliku → czyści warstwy
    tissueVmax?: Record<string, number>;  // globalny vmax per tkanka z ion_image
    mapDataset?: string;  // zestaw, z którego liczona jest mapa jonowa w zakładce m/z — mapa pikseli MUSI używać tego samego, inaczej pokazuje inne dane
  }

  let { tissues = [], activeMz = null, activeTol = 0.3, tissueLabels = {}, dispMin = 0, dispMax = 1, invertColors = false, filekey = 0, tissueVmax = {}, mapDataset = undefined }: Props = $props();

  function tLabel(id: string): string { return tissueLabels[id] || id; }

  // ── Stan ─────────────────────────────────────────────────────────────────
  interface Layer {
    id: string;
    label: string;
    color: string;
    visible: boolean;
    locked: boolean;
    spectrum: PixelSpectrum;
    datasetId: string; // zestaw danych źródłowy tej warstwy (lub RAW_DATASET_ID)
    // Zbinowana intensywność tego piksela (ta sama siatka co binMz), niezależna
    // od wybranego zestawu — używana do słupków binów.
    binIntensity: number[];
  }

  const COLORS = ["#ffc951","#7ec8e3","#a8e6cf","#ff8b94","#c9b1ff","#ffcba4","#b5ead7","#ffdac1"];

  let selectedTissue  = $state(wsGet<string>(LS_TISSUE, tissues[0] ?? ""));
  let layers          = $state<Layer[]>([]);
  let mapMarkers = $derived(layers.filter(l => l.visible).map(l => ({ x: l.spectrum.x, y: l.spectrum.y, color: l.color })));
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
  // Zestaw danych domyślnie proponowany dla NOWEJ warstwy (każda warstwa ma
  // też własny dropdown, patrz `changeLayerDataset`).
  let newLayerDataset = $state(wsGet<string>(LS_NEW_DS, ""));
  let originalError   = $state("");
  let binMz           = $state<number[]>([]);   // centra binów (z binnowanego widma)
  let binIntensity    = $state<number[]>([]);   // intensywności binów (z pierwszej warstwy binnowanej)
  let binLevel        = $state(0);              // Y poziom kreski binów na wykresie
  let plotDiv         = $state<HTMLDivElement | null>(null);

  // drag-to-reorder — oparte na Pointer Events (natywny HTML5 DnD jest niestabilny w webview Tauri)
  let draggingIdx     = $state<number | null>(null);
  let dragOverIdx     = $state<number | null>(null);
  let layersListEl: HTMLDivElement | undefined = $state();

  // Persist (write-only effects — safe in browser)
  $effect(() => { wsSet(LS_TISSUE, selectedTissue); });
  $effect(() => { wsSet(LS_NORM, normMode); });
  $effect(() => { wsSet(LS_NEW_DS, newLayerDataset); });
  $effect(() => {
    if (layers.length === 0) return;
    const saved: SavedLayer[] = layers.map(l => ({
      tissue: l.spectrum.tissue, x: l.spectrum.x, y: l.spectrum.y,
      label: l.label, color: l.color, visible: l.visible, locked: l.locked,
      datasetId: l.datasetId,
    }));
    wsSet(LS_LAYERS, saved);
  });

  onMount(async () => {
    if (!datasetsLoaded()) await loadDatasets();
    if (!newLayerDataset) newLayerDataset = activeDatasetId();

    const saved = wsGet<SavedLayer[]>(LS_LAYERS, []);
    if (saved.length === 0) return;
    layerLoading = true;
    try {
      const restored: Layer[] = [];
      for (const s of saved) {
        const dsId = s.datasetId ?? activeDatasetId();
        try {
          const spec = await fetchSpec(s.tissue, s.x, s.y, dsId);
          // binIntensity to zawsze zbinowana intensywność (aktywny zestaw) —
          // niezależna od zestawu warstwy, potrzebna do słupków binów.
          const binnedSpec = dsId === RAW_DATASET_ID ? await fetchPixelSpectrum(s.tissue, s.x, s.y) : spec;
          if (binMz.length === 0) { binMz = binnedSpec.mz; binIntensity = binnedSpec.intensity; }
          restored.push({ id: `${s.tissue}_${s.x}_${s.y}`, label: s.label, color: s.color, visible: s.visible, locked: s.locked, spectrum: spec, datasetId: dsId, binIntensity: binnedSpec.intensity });
        } catch {}
      }
      layers = restored;
    } finally { layerLoading = false; }
  });

  $effect(() => {
    if (tissues.length > 0 && !selectedTissue) selectedTissue = tissues[0];
  });

  // ── Warstwy ───────────────────────────────────────────────────────────────
  async function fetchSpec(tissue: string, x: number, y: number, datasetId: string) {
    return datasetId === RAW_DATASET_ID
      ? fetchPixelSpectrumRaw(tissue, x, y)
      : fetchPixelSpectrum(tissue, x, y, datasetId);
  }

  async function addLayer(x: number, y: number) {
    if (!selectedTissue) return;
    if (layers.some(l => l.spectrum.x === x && l.spectrum.y === y && l.spectrum.tissue === selectedTissue)) return;
    layerLoading = true;
    try {
      const dsId = newLayerDataset || activeDatasetId();
      const spec = await fetchSpec(selectedTissue, x, y, dsId);
      // binIntensity to zawsze zbinowana intensywność (aktywny zestaw) —
      // niezależna od zestawu tej warstwy, potrzebna do słupków binów.
      const binnedSpec = dsId === RAW_DATASET_ID ? await fetchPixelSpectrum(selectedTissue, x, y) : spec;
      if (binMz.length === 0) { binMz = binnedSpec.mz; binIntensity = binnedSpec.intensity; }
      const color = COLORS[layers.length % COLORS.length];
      layers = [...layers, {
        id:      `${selectedTissue}_${x}_${y}`,
        label:   `${tLabel(selectedTissue)} (${x},${y})`,
        color,
        visible: true,
        locked:  false,
        datasetId: dsId,
        binIntensity: binnedSpec.intensity,
        spectrum: spec,
      }];
    } catch { /* pixel not found */ }
    finally { layerLoading = false; }
  }

  // Zmiana zestawu danych dla JEDNEJ warstwy (dropdown przy warstwie).
  async function changeLayerDataset(id: string, datasetId: string) {
    const l = layers.find(l => l.id === id);
    if (!l) return;
    originalError = "";
    layerLoading = true;
    try {
      const spec = await fetchSpec(l.spectrum.tissue, l.spectrum.x, l.spectrum.y, datasetId);
      layers = layers.map(x => x.id === id ? { ...x, datasetId, spectrum: spec } : x);
    } catch (e) {
      originalError = (e as Error).message.includes("503")
        ? "Brak ścieżki do pliku imzML. Uruchom preprocessing raz aby zapamiętać ścieżkę."
        : `Błąd przy pobieraniu widma zestawu: ${(e as Error).message}`;
    } finally { layerLoading = false; }
  }

  function removeLayer(id: string) {
    const l = layers.find(l => l.id === id);
    if (l?.locked) return;
    layers = layers.filter(l => l.id !== id);
  }

  // ── Drag-to-reorder (Pointer Events) ─────────────────────────────────────
  function startDrag(e: PointerEvent, i: number) {
    if (layers[i]?.locked) return;
    e.preventDefault();
    draggingIdx = i;
    dragOverIdx = i;
    window.addEventListener("pointermove", onDragPointerMove);
    window.addEventListener("pointerup", onDragPointerUp);
  }

  function onDragPointerMove(e: PointerEvent) {
    if (draggingIdx === null || !layersListEl) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = (el as HTMLElement | null)?.closest(".layer-row") as HTMLElement | null;
    if (!row || !layersListEl.contains(row)) return;
    const idx = Number(row.dataset.idx);
    if (!isNaN(idx)) dragOverIdx = idx;
  }

  function onDragPointerUp() {
    if (draggingIdx !== null && dragOverIdx !== null && dragOverIdx !== draggingIdx) {
      const arr = [...layers];
      const [moved] = arr.splice(draggingIdx, 1);
      arr.splice(dragOverIdx, 0, moved);
      layers = arr;
    }
    draggingIdx = null;
    dragOverIdx = null;
    window.removeEventListener("pointermove", onDragPointerMove);
    window.removeEventListener("pointerup", onDragPointerUp);
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

  // Czy jakaś widoczna warstwa pokazuje surowe widmo (raw imzML) — wtedy jej
  // oś m/z różni się od siatki binów, więc rysujemy referencyjne kreski binów.
  const anyRaw = $derived(layers.some(l => l.datasetId === RAW_DATASET_ID));

  // ── Wykres Plotly ─────────────────────────────────────────────────────────
  $effect(() => {
    if (!plotDiv) return;
    layers; normMode; activeMz; dispMin; dispMax; anyRaw; binMz; binIntensity; binLevel;

    // Zachowaj aktualny zakres osi (żeby zoom nie ginął po update)
    const existingLayout = (plotDiv as any).layout as Plotly.Layout | undefined;
    const savedXRange = existingLayout?.xaxis?.range;
    const savedYRange = existingLayout?.yaxis?.range;
    const xAutoRange  = existingLayout?.xaxis?.autorange;
    const yAutoRange  = existingLayout?.yaxis?.autorange;
    const userZoomedX = savedXRange && xAutoRange !== true;
    const userZoomedY = savedYRange && yAutoRange !== true;

    // Kreska binów — pionowe ticki + linia pozioma na poziomie binLevel gdy showOriginal
    const binTrace: Plotly.Data[] = (anyRaw && binMz.length > 0) ? [{
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
    // Wysokość słupka bina = dokładnie ta sama wartość, jaką pokazuje przetworzone
    // (zbinowane) widmo w tym binie — nie średnia surowych punktów w oknie.
    // Przy wielu widocznych warstwach: średnia znormalizowanej intensywności binu
    // po wszystkich widocznych warstwach (dla tego samego bina).
    const binBarTrace: Plotly.Data[] = (anyRaw && binMz.length > 0) ? (() => {
      const visLayers = layers.filter(l => l.visible && l.binIntensity?.length === binMz.length);
      if (visLayers.length === 0) return [];

      const halfBin = binMz.length > 1 ? (binMz[1] - binMz[0]) / 2 : 0.5;
      const normed = visLayers.map(l => normalize(l.binIntensity));
      const avgInts = binMz.map((_, i) => {
        let total = 0;
        for (const arr of normed) total += arr[i];
        return total / normed.length;
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

    // Plotly rysuje późniejsze trace na wierzchu — odwracamy kolejność, żeby
    // warstwa na GÓRZE listy była rzeczywiście na wierzchu wykresu.
    const traces: Plotly.Data[] = [...binTrace, ...binBarTrace, ...[...layers]
      .reverse()
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
      ...(anyRaw && binMz.length > 0 ? [{
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
        rangemode:  "tozero",
        // dispMin/dispMax to suwak jasności obrazu jonowego (zakładka m/z) —
        // nie ma nic wspólnego z widokiem widma, więc tu go nie stosujemy.
        // Priorytet: zachowaj zoom użytkownika na tym wykresie, inaczej autorange od 0.
        ...(userZoomedY ? { range: savedYRange, autorange: false } : {}),
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
    <PixelMapPanel
      {tissues}
      {tissueLabels}
      {selectedTissue}
      {activeMz}
      {activeTol}
      {dispMin}
      {dispMax}
      {invertColors}
      {tissueVmax}
      dataset={mapDataset}
      markers={mapMarkers}
      loading={layerLoading}
      onselecttissue={(t) => selectedTissue = t}
      onpixelclick={addLayer}
    />

    <!-- Warstwy -->
    <div class="layers-panel card">
      <div class="panel-header">
        <span class="panel-title">Warstwy</span>
      </div>

      {#if layers.length === 0}
        <div class="layers-empty">Kliknij piksel na mapie aby dodać widmo</div>
      {:else}
        <div class="layers-list" bind:this={layersListEl}>
          {#each layers as layer, i (layer.id)}
            <div
              class="layer-row"
              class:hidden-layer={!layer.visible}
              class:drag-target={dragOverIdx === i && draggingIdx !== null}
              class:dragging={draggingIdx === i}
              class:is-locked={layer.locked}
              data-idx={i}
            >
              <span
                class="drag-handle"
                class:drag-disabled={layer.locked}
                onpointerdown={(e) => startDrag(e, i)}
              >⠿</span>
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
              <select
                class="ds-select"
                value={layer.datasetId}
                onchange={(e) => changeLayerDataset(layer.id, (e.target as HTMLSelectElement).value)}
                title="Zestaw danych tej warstwy"
              >
                <option value={RAW_DATASET_ID}>Oryginalne (raw)</option>
                {#each datasets() as d}
                  <option value={d.id}>{d.name}</option>
                {/each}
              </select>
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

      <div class="orig-row">
        <span class="new-layer-label">Nowa warstwa z zestawu:</span>
        <select class="ds-select" bind:value={newLayerDataset} title="Zestaw danych dla nowo dodawanych warstw">
          <option value={RAW_DATASET_ID}>Oryginalne (raw)</option>
          {#each datasets() as d}
            <option value={d.id}>{d.name}</option>
          {/each}
        </select>
        {#if anyRaw && binMz.length > 1}
          <span class="orig-label" style="opacity:.6">(bin size = {(binMz[1] - binMz[0]).toFixed(3)} Da)</span>
        {/if}
      </div>
      {#if anyRaw}
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

  .layer-row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px 3px 6px;
    background: #1a1a1a;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.06);
    user-select: none;
    transition: border-color 0.15s, background 0.15s, opacity 0.15s;
    min-height: 30px;
  }
  .layer-row.dragging { opacity: 0.35; border-style: dashed; }
  .layer-row.drag-target { border-color: rgba(255,201,81,0.5); background: rgba(255,201,81,0.05); }
  .layer-row.hidden-layer { opacity: 0.38; }
  .layer-row.is-locked {
    border-color: rgba(255,160,50,0.2);
    background: rgba(255,160,50,0.04);
  }

  .drag-handle {
    font-size: 0.9rem;
    color: rgba(255,255,255,0.18);
    cursor: grab;
    flex-shrink: 0;
    line-height: 1;
    touch-action: none;
  }
  .drag-handle:active { cursor: grabbing; }
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

  /* Jednolity styl dropdownów zestawów danych — jak .tissue-select w PixelMapPanel. */
  .ds-select {
    flex-shrink: 0;
    max-width: 130px;
    appearance: none; -webkit-appearance: none; -moz-appearance: none;
    background: #1a1a1a
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23ffc951' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>")
      no-repeat right 6px center;
    background-size: 8px 5px;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.68rem;
    padding: 3px 18px 3px 6px;
    font-family: inherit;
    cursor: pointer;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s, color 0.15s;
  }
  .ds-select:hover  { border-color: rgba(255,201,81,0.3); color: #ffc951; }
  .ds-select option { background: #1a1a1a; color: #e0e0e0; }

  .new-layer-label {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.4);
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
