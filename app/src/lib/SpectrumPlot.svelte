<script lang="ts">
  import Plotly from "plotly.js-dist-min";
  import type { PixelSpectrum } from "./api.js";

  interface Props {
    spectrum: PixelSpectrum | null;
    color?: string;
    label?: string;
    emptyHint?: string;
    /** Widmo po preprocessingu — rysowane jako ciągła linia na tym samym wykresie. */
    overlaySpectrum?: PixelSpectrum | null;
    overlayColor?: string;
    overlayLabel?: string;
    xRange?: [number, number] | null;
    /** Gdy podane — skala Y jest przypięta do tej wartości (np. przy synchronizacji
     * dwóch widm, żeby obie skale odpowiadały wspólnemu maksimum widocznego okna).
     * Gdy null — Y wraca do natywnego autorange Plotly (niezależne skalowanie). */
    yRange?: [number, number] | null;
    loading?: boolean;
    /** Wywoływane, gdy UŻYTKOWNIK zmieni oś X bezpośrednio na wykresie
     * (przeciągnięcie zoomu, przycisk "home") — nie przy zmianach `xRange`
     * przychodzących z zewnątrz. Pozwala rodzicowi zsynchronizować drugi wykres. */
    onXRangeChange?: (range: [number, number] | null) => void;
  }

  let {
    spectrum, color = "#ffc951", label = "oryginał",
    emptyHint = "Kliknij piksel na mapie aby wyświetlić widmo",
    overlaySpectrum = null, overlayColor = "#7ee787", overlayLabel = "po przetworzeniu",
    xRange = null, yRange = null, loading = false, onXRangeChange,
  }: Props = $props();

  let plotDiv = $state<HTMLDivElement | null>(null);

  // scattergl (WebGL) w webview Tauri (WebKit/macOS) potrafi dać pusty/biały
  // canvas przy pierwszym renderze — niestabilne w tym środowisku. Zostajemy
  // przy zwykłym SVG ("scatter"); wydajność zapewnia to, że pełne przebudowanie
  // (Plotly.react) robimy tylko przy zmianie danych, a pan/zoom to tani relayout.
  function buildTraces(): Plotly.Data[] {
    if (!spectrum) return [];
    const traces: Plotly.Data[] = [{
      x: spectrum.mz, y: spectrum.intensity,
      type: "scatter" as const,
      mode: "lines" as const,
      name: label,
      line: { color, width: 1, dash: "dot" as const },
      hoverinfo: "skip" as const,
    }];
    if (overlaySpectrum) {
      traces.push({
        x: overlaySpectrum.mz, y: overlaySpectrum.intensity,
        type: "scatter" as const,
        mode: "lines" as const,
        name: overlayLabel,
        line: { color: overlayColor, width: 1.3 },
        hoverinfo: "skip" as const,
      });
    }
    return traces;
  }

  // Skala Y NIE jest ustawiana ręcznie — zostawiamy to natywnemu autorange
  // Plotly (dokładnie jak w zakładce Widma). Dzięki temu Plotly samo przelicza
  // Y do danych widocznych w bieżącym oknie X przy każdym zoomie/panie/home,
  // bez żadnej naszej logiki i bez ryzyka rozjazdu.
  let settingXFromProp = false;
  let listenerAttached = false;

  function onRelayout(evt: Record<string, unknown>) {
    if (settingXFromProp || !onXRangeChange) return;
    if (typeof evt["xaxis.range[0]"] === "number" && typeof evt["xaxis.range[1]"] === "number") {
      onXRangeChange([evt["xaxis.range[0]"] as number, evt["xaxis.range[1]"] as number]);
    } else if (Array.isArray(evt["xaxis.range"])) {
      onXRangeChange(evt["xaxis.range"] as [number, number]);
    } else if (evt["xaxis.autorange"]) {
      onXRangeChange(null);
    }
  }

  function attachRelayoutListener() {
    if (!plotDiv || listenerAttached) return;
    (plotDiv as any).on("plotly_relayout", onRelayout);
    listenerAttached = true;
  }

  let plottedFor = $state<PixelSpectrum | null>(null);
  let plottedOverlayFor = $state<PixelSpectrum | null>(null);

  function tryPlot() {
    if (!plotDiv || !spectrum) return;
    if (spectrum === plottedFor && overlaySpectrum === plottedOverlayFor) return;
    if (plotDiv.clientWidth === 0 || plotDiv.clientHeight === 0) return;

    const layout: Partial<Plotly.Layout> = {
      paper_bgcolor: "#1a1a1a",
      plot_bgcolor:  "#1a1a1a",
      font:          { color: "#ccc", family: "JetBrains Mono, monospace", size: 11 },
      margin:        { t: 10, r: 10, b: 32, l: 55 },
      xaxis: {
        title: { text: "m/z [Da]", standoff: 4 },
        color: "#888",
        gridcolor: "#2a2a2a",
        zerolinecolor: "#333",
        range: xRange ?? undefined,
        autorange: xRange ? false : true,
      },
      yaxis: {
        title: { text: "Intensywność", standoff: 4 },
        color: "#888",
        gridcolor: "#2a2a2a",
        zerolinecolor: "#333",
        rangemode: "tozero",
        range: yRange ?? undefined,
        autorange: yRange ? false : true,
      },
      showlegend: !!overlaySpectrum,
      legend: { orientation: "h", x: 0, y: 1.12, font: { size: 10 } },
      transition: { duration: 0 },
    };

    const config: Partial<Plotly.Config> = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"] as any,
      toImageButtonOptions: { format: "png", scale: 2 },
    };

    Plotly.react(plotDiv, buildTraces(), layout, config).then(() => {
      Plotly.Plots.resize(plotDiv!);
      attachRelayoutListener();
    });
    plottedFor = spectrum;
    plottedOverlayFor = overlaySpectrum;
  }

  // Pełne przebudowanie wykresu tylko gdy zmienią się dane widma.
  $effect(() => {
    spectrum; overlaySpectrum;
    tryPlot();
  });

  // Sama zmiana zakresu m/z (suwak lub sync z drugiego wykresu) — tylko
  // relayout osi X; Y dobiera się samo (patrz wyżej).
  $effect(() => {
    if (!plotDiv || !plottedFor) return;
    xRange;
    settingXFromProp = true;
    const done = () => { settingXFromProp = false; };
    if (xRange) {
      Plotly.relayout(plotDiv, { "xaxis.range": xRange, "xaxis.autorange": false } as any).finally(done);
    } else {
      Plotly.relayout(plotDiv, { "xaxis.autorange": true } as any).finally(done);
    }
  });

  // Zmiana wspólnej skali Y narzuconej z zewnątrz (np. drugi zsynchronizowany
  // wykres przeliczył wspólne maksimum dla bieżącego okna m/z).
  $effect(() => {
    if (!plotDiv || !plottedFor) return;
    if (yRange) {
      Plotly.relayout(plotDiv, { "yaxis.range": yRange, "yaxis.autorange": false } as any);
    } else {
      Plotly.relayout(plotDiv, { "yaxis.autorange": true } as any);
    }
  });

  $effect(() => {
    if (!plotDiv) return;
    const ro = new ResizeObserver(() => {
      Plotly.Plots.resize(plotDiv!);
      tryPlot(); // jeśli pierwszy render czekał na niezerowy rozmiar
    });
    ro.observe(plotDiv);
    return () => ro.disconnect();
  });
</script>

<div class="spectrum-panel card">
  {#if !spectrum}
    <div class="plot-hint">
      <div class="hint-icon">〜</div>
      <div>{emptyHint}</div>
    </div>
  {:else}
    <div class="plot-wrap" bind:this={plotDiv}></div>
  {/if}
  {#if loading}
    <div class="loading-overlay">
      <span class="spinner"></span>
      <span>Wczytuję…</span>
    </div>
  {/if}
</div>

<style>
  .card {
    background: #222;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;
    padding: 6px 8px;
    box-sizing: border-box;
  }

  .spectrum-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }

  .plot-wrap {
    flex: 1;
    min-height: 0;
    width: 100%;
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

  .loading-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: rgba(17,17,17,0.55);
    color: rgba(255,255,255,0.7);
    font-size: 0.75rem;
    backdrop-filter: blur(1px);
  }

  .spinner {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.2);
    border-top-color: #ffc951;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
