<script lang="ts">
  // Edytor krzywej intensywności (jak "Krzywe"/"Poziomy" w GIMP) — histogram
  // wartości w tle + kawałkowo-liniowa krzywa z przesuwalnymi punktami.
  // Oś X: intensywność wejściowa 0–100%, oś Y: intensywność wyjściowa 0–100%.
  // Dwuklik na tle: dodaj punkt. Przeciągnij punkt: przesuń go (krańce mają
  // zablokowane X — da się przesuwać tylko ich Y). Prawy klik na punkcie
  // (poza krańcami): usuń go.
  import { DEFAULT_CURVE_POINTS, type MzCurvePoint } from "$lib/mzgraphnodes";

  interface Props {
    points?: MzCurvePoint[];
    histogram?: number[];
    onchange?: (points: MzCurvePoint[]) => void;
  }
  let { points = DEFAULT_CURVE_POINTS, histogram = [], onchange }: Props = $props();

  let localPoints = $state<MzCurvePoint[]>(points.map((p) => ({ ...p })));
  let wrapEl = $state<HTMLDivElement | null>(null);
  let draggingIdx = $state<number | null>(null);

  const maxCount = $derived(Math.max(1, ...histogram));

  function clientToDomain(clientX: number, clientY: number): { x: number; y: number } {
    const rect = wrapEl!.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, 100 - ((clientY - rect.top) / rect.height) * 100));
    return { x, y };
  }

  function emit() {
    onchange?.(localPoints.map((p) => ({ ...p })));
  }

  function onPointDown(e: PointerEvent, idx: number) {
    e.stopPropagation();
    e.preventDefault();
    draggingIdx = idx;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointMove(e: PointerEvent) {
    if (draggingIdx === null || !wrapEl) return;
    const { x, y } = clientToDomain(e.clientX, e.clientY);
    const isLeftEnd = draggingIdx === 0;
    const isRightEnd = draggingIdx === localPoints.length - 1;
    const next = [...localPoints];
    const p: MzCurvePoint = { ...next[draggingIdx] };
    p.y = Math.round(y);
    if (isLeftEnd) p.x = 0;
    else if (isRightEnd) p.x = 100;
    else p.x = Math.round(Math.max(1, Math.min(99, x)));
    next[draggingIdx] = p;
    next.sort((a, b) => a.x - b.x);
    localPoints = next;
    draggingIdx = next.indexOf(p);
    emit();
  }

  function onPointUp(e: PointerEvent) {
    if (draggingIdx !== null) (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    draggingIdx = null;
  }

  function onBackgroundDblClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest(".curve-point")) return;
    const { x, y } = clientToDomain(e.clientX, e.clientY);
    const nx = Math.round(Math.max(1, Math.min(99, x)));
    const ny = Math.round(y);
    localPoints = [...localPoints, { x: nx, y: ny }].sort((a, b) => a.x - b.x);
    emit();
  }

  function removePoint(e: MouseEvent, idx: number) {
    e.preventDefault();
    e.stopPropagation();
    if (idx === 0 || idx === localPoints.length - 1) return; // krańców nie da się usunąć
    localPoints = localPoints.filter((_, i) => i !== idx);
    emit();
  }

  function resetCurve() {
    localPoints = DEFAULT_CURVE_POINTS.map((p) => ({ ...p }));
    emit();
  }

  const curvePath = $derived(localPoints.map((p) => `${p.x},${100 - p.y}`).join(" "));
</script>

<div class="curve-wrap">
  <div class="curve-plot" bind:this={wrapEl} ondblclick={onBackgroundDblClick} role="img" aria-label="Edytor krzywej intensywności">
    <svg class="curve-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
      <line x1="0" y1="25" x2="100" y2="25" class="grid-line" />
      <line x1="0" y1="50" x2="100" y2="50" class="grid-line" />
      <line x1="0" y1="75" x2="100" y2="75" class="grid-line" />
      <line x1="25" y1="0" x2="25" y2="100" class="grid-line" />
      <line x1="50" y1="0" x2="50" y2="100" class="grid-line" />
      <line x1="75" y1="0" x2="75" y2="100" class="grid-line" />
      {#each histogram as count, i}
        {@const barW = 100 / histogram.length}
        {@const barH = (count / maxCount) * 96}
        <rect x={i * barW} y={100 - barH} width={Math.max(0, barW - 0.4)} height={barH} class="hist-bar" />
      {/each}
      <polyline points={curvePath} class="curve-line" />
    </svg>
    {#each localPoints as p, i (i)}
      <div
        class="curve-point"
        class:endpoint={i === 0 || i === localPoints.length - 1}
        style="left:{p.x}%; top:{100 - p.y}%"
        onpointerdown={(e) => onPointDown(e, i)}
        onpointermove={onPointMove}
        onpointerup={onPointUp}
        oncontextmenu={(e) => removePoint(e, i)}
        role="slider"
        aria-valuenow={p.y}
        aria-valuemin={0}
        aria-valuemax={100}
        tabindex="0"
      ></div>
    {/each}
  </div>
  <div class="curve-footer">
    <span class="curve-hint">dwuklik: dodaj · prawy klik: usuń · przeciągnij: przesuń</span>
    <button class="curve-reset" onclick={resetCurve} title="Zresetuj do liniowej">reset</button>
  </div>
</div>

<style>
  .curve-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .curve-plot {
    position: relative;
    height: 110px;
    background: #141414;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    overflow: hidden;
    touch-action: none;
    cursor: crosshair;
  }

  .curve-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  .grid-line {
    stroke: rgba(255,255,255,0.08);
    stroke-width: 0.5;
    vector-effect: non-scaling-stroke;
  }

  .hist-bar {
    fill: rgba(126,200,227,0.35);
  }

  .curve-line {
    fill: none;
    stroke: #ffc951;
    stroke-width: 1.6;
    vector-effect: non-scaling-stroke;
  }

  .curve-point {
    position: absolute;
    width: 10px;
    height: 10px;
    margin: -5px 0 0 -5px;
    border-radius: 50%;
    background: #ffc951;
    border: 2px solid #1a1a1a;
    box-shadow: 0 1px 4px rgba(0,0,0,0.5);
    cursor: grab;
    touch-action: none;
  }
  .curve-point:hover { transform: scale(1.2); }
  .curve-point.endpoint { background: #7ec8e3; }
  .curve-point:active { cursor: grabbing; }

  .curve-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .curve-hint {
    font-size: 0.56rem;
    color: rgba(255,255,255,0.3);
    line-height: 1.3;
  }

  .curve-reset {
    flex-shrink: 0;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 5px;
    color: rgba(255,255,255,0.55);
    font-size: 0.6rem;
    padding: 2px 7px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, color 0.15s;
  }
  .curve-reset:hover { border-color: rgba(255,201,81,0.5); color: #ffc951; }
</style>
