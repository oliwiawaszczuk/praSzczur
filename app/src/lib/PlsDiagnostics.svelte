<script lang="ts">
  // Okno diagnostyczne węzła "analiza/pls_da" — odpowiednik figure(1)–(4) ze skryptów
  // MATLAB: predicted vs input, błąd modelu (CV) vs LV, skumulowana wariancja Y;
  // dodatkowo histogram Q² z permutacji (gdy test był włączony).
  import Plotly from "plotly.js-dist-min";
  import type { PlsResult } from "$lib/api";

  interface Props {
    result: PlsResult;
    onclose: () => void;
  }
  let { result, onclose }: Props = $props();

  const GREEN = "#7bc47f";
  const ORANGE = "#f2994a";
  const BLUE = "#5b9bd5";

  const baseLayout = (xTitle: string, yTitle: string): Partial<Plotly.Layout> => ({
    paper_bgcolor: "#1a1a1a",
    plot_bgcolor: "#1a1a1a",
    font: { color: "#ccc", family: "JetBrains Mono, monospace", size: 11 },
    margin: { t: 34, r: 14, b: 44, l: 54 },
    xaxis: { title: { text: xTitle, standoff: 6 }, color: "#888", gridcolor: "#2a2a2a", zerolinecolor: "#444" },
    yaxis: { title: { text: yTitle, standoff: 6 }, color: "#888", gridcolor: "#2a2a2a", zerolinecolor: "#444" },
    legend: { bgcolor: "rgba(30,30,30,0.9)", font: { size: 10 }, x: 0, y: 1 },
  });
  const config: Partial<Plotly.Config> = { responsive: true, displaylogo: false, displayModeBar: false };

  function draw(div: HTMLDivElement, data: Plotly.Data[], layout: Partial<Plotly.Layout>) {
    Plotly.react(div, data, layout, config);
  }

  let predDiv = $state<HTMLDivElement | null>(null);
  let msepDiv = $state<HTMLDivElement | null>(null);
  let varDiv = $state<HTMLDivElement | null>(null);
  let permDiv = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!predDiv) return;
    draw(predDiv, [
      { x: result.yfit, y: result.y, mode: "markers", type: "scatter", name: "dopasowanie (fit)",
        marker: { color: GREEN, size: 9 } },
      { x: result.ycv, y: result.y, mode: "markers", type: "scatter", name: "walidacja krzyżowa (CV)",
        marker: { color: ORANGE, size: 9, symbol: "diamond-open", line: { width: 2, color: ORANGE } } },
    ], {
      ...baseLayout("Predicted", "Input (A = +1, B = −1)"),
      title: { text: "Predicted vs input", font: { size: 12 } },
      shapes: [{ type: "line", x0: 0, x1: 0, y0: -1.4, y1: 1.4, line: { color: "#666", dash: "dot", width: 1 } }],
      yaxis: { ...baseLayout("", "").yaxis, title: { text: "Input (A = +1, B = −1)" }, range: [-1.4, 1.4], tickvals: [-1, 1] },
    });
  });

  $effect(() => {
    if (!msepDiv) return;
    const lvs = result.msep_cv.map((_, i) => i);
    draw(msepDiv, [
      { x: lvs, y: result.msep_cv, mode: "lines+markers", type: "scatter", name: "MSEP (CV)",
        line: { color: GREEN, width: 3 }, marker: { size: 8 } },
      { x: [result.best_lv], y: [result.msep_cv[result.best_lv]], mode: "markers", type: "scatter",
        name: `min. błąd CV: LV=${result.best_lv}`, marker: { color: ORANGE, size: 13, symbol: "star" } },
    ], { ...baseLayout("LV", "Błąd modelu (MSEP, CV)"), title: { text: "Błąd modelu vs liczba LV", font: { size: 12 } } });
  });

  $effect(() => {
    if (!varDiv) return;
    const lvs = result.pct_var_y.map((_, i) => i + 1);
    draw(varDiv, [
      { x: lvs, y: result.pct_var_y, mode: "lines+markers", type: "scatter", name: "wariancja Y",
        line: { color: BLUE, width: 3 }, marker: { size: 8 } },
    ], {
      ...baseLayout("LV", "Skumulowana wariancja Y [%]"),
      title: { text: "Wariancja Y wyjaśniona przez model", font: { size: 12 } },
      showlegend: false,
    });
  });

  $effect(() => {
    if (!permDiv || result.perm_q2.length === 0) return;
    draw(permDiv, [
      { x: result.perm_q2, type: "histogram", name: "Q² (etykiety przemieszane)", marker: { color: "#888" }, nbinsx: 20 },
    ], {
      ...baseLayout("Q²", "liczba permutacji"),
      title: { text: `Test permutacyjny (p = ${result.perm_p?.toFixed(3)})`, font: { size: 12 } },
      shapes: [{ type: "line", x0: result.q2, x1: result.q2, y0: 0, y1: 1, yref: "paper", line: { color: ORANGE, width: 3 } }],
      annotations: [{ x: result.q2, y: 1, yref: "paper", text: "model", showarrow: false, font: { color: ORANGE }, yanchor: "bottom" }],
      showlegend: false,
    });
  });

  const hasPerm = $derived(result.perm_q2.length > 0);
  const verdict = $derived(
    result.perm_p !== null && result.perm_p <= 0.05 ? "model istotny statystycznie (test permutacyjny)"
      : result.q2 >= 0.5 ? "dobra zdolność przewidywania w CV"
      : result.q2 >= 0.2 ? "umiarkowana zdolność przewidywania — ostrożnie"
      : "słaby model — różnice mogą być przypadkowe",
  );

  function onKey(e: KeyboardEvent) { if (e.key === "Escape") onclose(); }
</script>

<svelte:window onkeydown={onKey} />

<div class="pd-backdrop" onclick={onclose} onkeydown={onKey} role="presentation">
  <div class="pd-box" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
    <button class="pd-close" onclick={onclose} title="Zamknij (Esc)">✕</button>
    <div class="pd-stats">
      <span><b>PLS-DA</b> {result.n_a} vs {result.n_b} próbek</span>
      <span>LV = <b>{result.lv}</b>{result.lv !== result.lv_requested ? ` (zażądano ${result.lv_requested})` : ""}</span>
      <span>CV: <b>{result.n_folds}</b>-fold</span>
      <span>R² = <b>{result.r2.toFixed(3)}</b></span>
      <span>Q² = <b>{result.q2.toFixed(3)}</b></span>
      <span>RMSECV = <b>{result.rmsecv.toFixed(3)}</b></span>
      <span>trafność CV = <b>{(result.cv_accuracy * 100).toFixed(0)}%</b></span>
      {#if result.perm_p !== null}<span>p (perm.) = <b>{result.perm_p.toFixed(3)}</b></span>{/if}
    </div>
    <div class="pd-verdict">{verdict}</div>
    <div class="pd-grid" class:pd-grid-3={!hasPerm}>
      <div class="pd-plot" bind:this={predDiv}></div>
      <div class="pd-plot" bind:this={msepDiv}></div>
      <div class="pd-plot" bind:this={varDiv}></div>
      {#if hasPerm}<div class="pd-plot" bind:this={permDiv}></div>{/if}
    </div>
  </div>
</div>

<style>
  .pd-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px);
    z-index: 1000; display: flex; align-items: center; justify-content: center;
  }
  .pd-box {
    position: relative; background: #1a1a1a; border-radius: 14px;
    width: min(94vw, 1300px); height: min(90vh, 900px);
    box-shadow: 0 20px 60px rgba(0,0,0,0.6); padding: 20px 24px 24px;
    box-sizing: border-box; display: flex; flex-direction: column; gap: 8px;
  }
  .pd-close {
    position: absolute; top: 10px; right: 12px; background: none; border: none;
    color: rgba(255,255,255,0.6); font-size: 1rem; cursor: pointer;
  }
  .pd-close:hover { color: #fff; }
  .pd-stats {
    display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 0.75rem;
    color: rgba(255,255,255,0.7); padding-right: 28px;
  }
  .pd-stats b { color: #ffc951; font-weight: 600; }
  .pd-verdict { font-size: 0.72rem; color: rgba(255,255,255,0.5); }
  .pd-grid {
    flex: 1; min-height: 0; display: grid; gap: 10px;
    grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
  }
  .pd-grid-3 { grid-template-rows: 1fr 1fr; }
  .pd-grid-3 .pd-plot:first-child { grid-row: 1 / span 2; }
  .pd-plot { min-height: 0; min-width: 0; }
</style>
