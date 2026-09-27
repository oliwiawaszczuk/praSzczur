<script module lang="ts">
  // Typ trace'a jest w bloku `module`, żeby dało się go importować jako
  // named export z tego pliku (`import { type SpectrumTrace } from
  // "./SpectrumTracesPlot.svelte"`) — instance <script> w Svelte nie eksportuje nic
  // poza propsami komponentu.
  export interface SpectrumTrace {
    mz: number[];
    intensity: number[];
    label: string;
    color: string;
  }
</script>

<script lang="ts">
  // Wspólny komponent wykresu WIELU widm nałożonych na siebie (Plotly) — dla
  // domeny Widmo w Node Graph (mini podgląd w ciele node'a + powiększenie na
  // cały ekran w SpectrumZoomModal.svelte) i dla zakładki Widma (Widma.svelte).
  // Celowo NIE to samo co SpectrumPlot.svelte (już istniejący komponent
  // preWidma/PreNodesEditor — pojedyncze widmo + jego wersja "po
  // przetworzeniu" jako overlay, z synchronizacją osi między dwoma wykresami)
  // — inny przypadek użycia, inny kształt propsów, stąd osobny plik zamiast
  // przeciążania tamtego.
  import Plotly from "plotly.js-dist-min";
  import { normalizeVector, type WidmoNormalizeMode } from "$lib/nodegraph.widmo";

  interface Props {
    traces: SpectrumTrace[];
    normMode?: WidmoNormalizeMode;
    /** Mini-podgląd w ciele node'a: brak tytułów osi/legendy/modebara, minimalne marginesy. */
    compact?: boolean;
  }
  let { traces, normMode = "none", compact = false }: Props = $props();

  let plotDiv = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!plotDiv) return;
    traces; normMode; compact;

    const existingLayout = (plotDiv as any).layout as Plotly.Layout | undefined;
    const savedXRange = existingLayout?.xaxis?.range;
    const savedYRange = existingLayout?.yaxis?.range;
    const userZoomedX = savedXRange && existingLayout?.xaxis?.autorange !== true;
    const userZoomedY = savedYRange && existingLayout?.yaxis?.autorange !== true;

    const data: Plotly.Data[] = [...traces].reverse().map((t) => ({
      x: t.mz,
      y: normalizeVector(t.intensity, normMode),
      type: "scatter" as const,
      mode: "lines" as const,
      name: t.label,
      line: { color: t.color, width: 1.2 },
      hovertemplate: "<b>%{x:.4f} Da</b><br>Int: %{y:.0f}<extra></extra>",
    }));

    const layout: Partial<Plotly.Layout> = {
      paper_bgcolor: "#1a1a1a",
      plot_bgcolor: "#1a1a1a",
      font: { color: "#ccc", family: "JetBrains Mono, monospace", size: compact ? 9 : 11 },
      margin: compact ? { t: 4, r: 4, b: 18, l: 28 } : { t: 10, r: 10, b: 40, l: 60 },
      xaxis: {
        title: compact ? undefined : { text: "m/z [Da]", standoff: 6 },
        color: "#888",
        gridcolor: "#2a2a2a",
        zerolinecolor: "#333",
        showticklabels: !compact,
        ...(userZoomedX ? { range: savedXRange, autorange: false } : {}),
      },
      yaxis: {
        title: compact ? undefined : { text: normMode === "max" ? "Intensywność (max=1)" : normMode === "tic" ? "Intensywność (TIC=1)" : "Intensywność", standoff: 6 },
        color: "#888",
        gridcolor: "#2a2a2a",
        zerolinecolor: "#333",
        rangemode: "tozero",
        showticklabels: !compact,
        ...(userZoomedY ? { range: savedYRange, autorange: false } : {}),
      },
      legend: compact ? undefined : {
        bgcolor: "rgba(30,30,30,0.9)",
        bordercolor: "#333",
        borderwidth: 1,
        font: { size: 10 },
      },
      showlegend: !compact && traces.length > 1,
    };

    const config: Partial<Plotly.Config> = {
      responsive: true,
      displayModeBar: !compact,
      displaylogo: false,
      modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"] as any,
      toImageButtonOptions: { format: "png", scale: 2 },
    };

    Plotly.react(plotDiv, data, layout, config).then(() => {
      Plotly.Plots.resize(plotDiv!);
    });
  });

  $effect(() => {
    if (!plotDiv) return;
    const ro = new ResizeObserver(() => { Plotly.Plots.resize(plotDiv!); });
    ro.observe(plotDiv);
    return () => ro.disconnect();
  });
</script>

<div class="spectrum-plot-wrap" bind:this={plotDiv}></div>

<style>
  .spectrum-plot-wrap {
    width: 100%;
    height: 100%;
  }
</style>
