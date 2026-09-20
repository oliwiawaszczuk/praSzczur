<script lang="ts">
  /**
   * Dwu-uchwytowy suwak zakresu.
   * Emituje ondisprange(min, max) — obie wartości 0–1.
   */
  interface Props {
    min?: number;  // 0–1
    max?: number;  // 0–1
    ondisprange?: (min: number, max: number) => void;
  }
  let { min = 0, max = 1, ondisprange }: Props = $props();

  // Procenty 0–100 jako lokalny stan suwaków
  let lo = $state(Math.round(min * 100));
  let hi = $state(Math.round(max * 100));

  function onLo(e: Event) {
    const v = parseInt((e.target as HTMLInputElement).value);
    lo = Math.min(v, hi - 1);
    ondisprange?.(lo / 100, hi / 100);
  }

  function onHi(e: Event) {
    const v = parseInt((e.target as HTMLInputElement).value);
    hi = Math.max(v, lo + 1);
    ondisprange?.(lo / 100, hi / 100);
  }

  // Fill: od lo% do hi% na pasku
  const fillLeft  = $derived(`${lo}%`);
  const fillRight = $derived(`${100 - hi}%`);
</script>

<div class="dual-wrap">
  <!-- Etykiety wartości nad suwakiem -->
  <div class="labels">
    <span class="label-val">{lo}%</span>
    <span class="label-range">zakres: {hi - lo}%</span>
    <span class="label-val">{hi}%</span>
  </div>

  <!-- Track z wypełnieniem -->
  <div class="track-wrap">
    <div
      class="track-fill"
      style="left: {fillLeft}; right: {fillRight}"
    ></div>
    <!-- Dolny uchwyt -->
    <input
      class="thumb thumb-lo"
      type="range" min="0" max="100" step="1"
      value={lo}
      oninput={onLo}
    />
    <!-- Górny uchwyt -->
    <input
      class="thumb thumb-hi"
      type="range" min="0" max="100" step="1"
      value={hi}
      oninput={onHi}
    />
  </div>

  <!-- Oś procentowa -->
  <div class="axis">
    <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
  </div>
</div>

<style>
  .dual-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
    user-select: none;
  }

  .labels {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .label-val {
    font-size: 0.78rem;
    font-weight: 600;
    color: #ffc951;
    min-width: 30px;
  }

  .label-val:last-child { text-align: right; }

  .label-range {
    font-size: 0.65rem;
    color: rgba(255,255,255,0.3);
  }

  /* Track */
  .track-wrap {
    position: relative;
    height: 20px;
    display: flex;
    align-items: center;
  }

  /* Szary track bazowy */
  .track-wrap::before {
    content: "";
    position: absolute;
    left: 0; right: 0;
    height: 6px;
    background: rgba(255,255,255,0.1);
    border-radius: 3px;
    pointer-events: none;
  }

  /* Żółte wypełnienie między uchwytami */
  .track-fill {
    position: absolute;
    height: 6px;
    background: #ffc951;
    border-radius: 3px;
    pointer-events: none;
    box-shadow: 0 0 8px rgba(255,201,81,0.4);
    transition: left 0.05s, right 0.05s;
  }

  /* Wspólne style dla obu range inputów */
  .thumb {
    position: absolute;
    width: 100%;
    height: 100%;
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    pointer-events: none;
    outline: none;
  }

  /* Kciuk (thumb) */
  .thumb::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #ffc951;
    border: 2px solid #1a1a1a;
    box-shadow: 0 1px 6px rgba(0,0,0,0.5);
    cursor: pointer;
    pointer-events: all;
    transition: transform 0.1s, box-shadow 0.1s;
  }

  .thumb::-webkit-slider-thumb:hover {
    transform: scale(1.2);
    box-shadow: 0 0 0 4px rgba(255,201,81,0.2);
  }

  /* z-index: hi thumb na wierzchu gdy lo > 90, inaczej lo na wierzchu */
  .thumb-lo { z-index: 3; }
  .thumb-hi { z-index: 4; }

  /* Track: ukryty, renderujemy własny */
  .thumb::-webkit-slider-runnable-track {
    background: transparent;
    border: none;
  }

  .axis {
    display: flex;
    justify-content: space-between;
    font-size: 0.58rem;
    color: rgba(255,255,255,0.18);
  }
</style>
