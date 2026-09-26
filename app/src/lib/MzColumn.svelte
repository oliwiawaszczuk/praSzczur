<script lang="ts">
  import IonCanvas from "./IonCanvas.svelte";
  import DualRange from "./DualRange.svelte";
  import type { TissueImage } from "./api.js";
  import { datasets, activeDatasetId, sanitizeDatasetId, RAW_DATASET_ID } from "$lib/datasets.svelte";
  import { type MzGroup, updateGroup, runGroupQuery, resultFor, toggleSelected, isSelected } from "./mzGroups.svelte";

  interface Props {
    group: MzGroup;
    mzMin?: number;
    mzMax?: number;
    tissueIds?: string[];
    tissueLabels?: Record<string, string>;
    tissueColors?: Record<string, string>;
  }

  let {
    group,
    mzMin = 0,
    mzMax = Infinity,
    tissueIds = [],
    tissueLabels = {},
    tissueColors = {},
  }: Props = $props();

  let mzInput = $state(group.mz !== null ? String(group.mz) : "");
  let tol     = $state(group.tol);
  let dataset = $state(sanitizeDatasetId(group.dataset));
  // Zakres wyświetlania i odwrócenie kolorów — WŁASNE per grupa, celowo
  // odizolowane od globalnego stanu zakładki "m/z" (użytkownik chce niezależne
  // ustawienia dla każdej kolumny "Wiele m/z").
  let dispMin = $state(group.dispMin);
  let dispMax = $state(group.dispMax);
  let invert  = $state(group.invert);
  let mzError = $state("");

  const result  = $derived(resultFor(group.id));
  const tissues = $derived(result?.tissues ?? null);
  const loading = $derived(result?.loading ?? false);
  const error   = $derived(result?.error ?? "");

  function validateMz(val: string): number | null {
    const mz = parseFloat(val);
    const lo = mzMin > 0 ? mzMin : 0;
    const hi = isFinite(mzMax) ? mzMax : Infinity;
    if (isNaN(mz) || mz < lo || (isFinite(hi) && mz > hi)) return null;
    return mz;
  }

  function submit() {
    const mz = validateMz(mzInput);
    if (mz === null) {
      const lo = mzMin > 0 ? mzMin : 0;
      const hi = isFinite(mzMax) ? mzMax : Infinity;
      mzError = isFinite(hi) ? `m/z: ${lo.toFixed(0)}–${hi.toFixed(0)} Da` : "Podaj prawidłową wartość m/z";
      return;
    }
    mzError = "";
    updateGroup(group.id, { mz, tol, dataset });
    runGroupQuery(group.id, mz, tol, dataset);
  }

  function onDatasetChange() {
    if (validateMz(mzInput) !== null) submit();
  }

  function onKeydown(e: KeyboardEvent) { if (e.key === "Enter") submit(); }
  function onMzInput() { mzError = ""; }

  function onRange(mn: number, mx: number) {
    dispMin = mn;
    dispMax = mx;
    updateGroup(group.id, { dispMin, dispMax });
  }

  function onInvertChange() {
    updateGroup(group.id, { invert });
  }

  function withLabel(tid: string, t: TissueImage | null): TissueImage | null {
    if (!t) return null;
    const custom = tissueLabels[tid];
    return custom ? { ...t, label: custom } : t;
  }
</script>

<div class="col-body">
  <label class="field-label" for={`ds-${group.id}`}>Zestaw danych</label>
  <select id={`ds-${group.id}`} class="ds-select" bind:value={dataset} onchange={onDatasetChange}>
    <option value={RAW_DATASET_ID}>Dane oryginalne</option>
    {#each datasets() as d}
      <option value={d.id}>{d.name}{d.id === activeDatasetId() ? " (aktywny)" : ""}</option>
    {/each}
  </select>

  <label class="field-label" for={`mz-${group.id}`} style="margin-top:8px">m/z [Da]</label>
  <div class="mz-row">
    <input
      id={`mz-${group.id}`}
      class="field-input"
      class:error={!!mzError}
      type="number"
      min={mzMin > 0 ? mzMin : 0}
      max={isFinite(mzMax) ? mzMax : undefined}
      step="0.01"
      placeholder="np. 569.25"
      bind:value={mzInput}
      onkeydown={onKeydown}
      oninput={onMzInput}
    />
    <input
      class="field-input tol-input"
      type="number"
      min="0.05" max="2" step="0.05"
      title="Tolerancja ± [Da]"
      bind:value={tol}
      onkeydown={onKeydown}
    />
  </div>
  <button class="btn-primary" onclick={submit} disabled={loading || !mzInput}>
    {#if loading}<span class="spinner"></span>{:else}Wczytaj{/if}
  </button>
  {#if mzError}<span class="error-msg">{mzError}</span>{/if}

  <div class="range-block">
    <DualRange min={dispMin} max={dispMax} ondisprange={onRange} />
  </div>
  <label class="checkbox-row">
    <input type="checkbox" class="cb-input" bind:checked={invert} onchange={onInvertChange} />
    <span class="cb-label">Odwróć kolory</span>
  </label>

  <div class="tissue-list">
    {#if error}
      <div class="col-notice">{error}</div>
    {:else if tissueIds.length === 0}
      <div class="col-notice">Brak przetworzonych tkanek.</div>
    {:else}
      {#each tissueIds as tid (tid)}
        <div
          class="tissue-card"
          class:selected={isSelected(group.id, tid)}
          onclick={() => toggleSelected(group.id, tid)}
          role="button" tabindex="0"
          onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSelected(group.id, tid); } }}
          title="Kliknij, aby zaznaczyć/odznaczyć tkankę do łączenia"
        >
          <IonCanvas
            tissue={withLabel(tid, tissues?.[tid] ?? null)}
            {loading}
            {dispMin}
            {dispMax}
            accentColor={tissueColors[tid] ?? ""}
            invertColors={invert}
            showColorbar={false}
            showVmax={false}
          />
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .col-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 12px;
    box-sizing: border-box;
  }

  .field-label {
    display: block; font-size: 0.62rem; font-weight: 600;
    letter-spacing: 0.09em; text-transform: uppercase;
    color: rgba(255,255,255,0.38); margin-bottom: 5px;
  }

  .field-input {
    width: 100%; background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.1); border-radius: 7px;
    color: #f0f0f0; font-size: 0.8rem; padding: 6px 9px;
    outline: none; box-sizing: border-box; font-family: inherit;
    transition: border-color 0.2s, box-shadow 0.2s;
    -moz-appearance: textfield;
  }
  .field-input::-webkit-inner-spin-button,
  .field-input::-webkit-outer-spin-button { opacity: 0.3; }
  .field-input:focus {
    border-color: #ffc951; box-shadow: 0 0 0 2px rgba(255,201,81,0.15);
  }
  .field-input.error { border-color: #ff5555; }
  .error-msg { font-size: 0.64rem; color: #ff7070; }

  .ds-select {
    width: 100%;
    appearance: none; -webkit-appearance: none; -moz-appearance: none;
    background: #1a1a1a
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23ffc951' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>")
      no-repeat right 8px center;
    background-size: 9px 6px;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.7rem;
    padding: 4px 22px 4px 8px;
    font-family: inherit;
    cursor: pointer;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s, color 0.15s;
  }
  .ds-select:hover  { border-color: rgba(255,201,81,0.3); color: #ffc951; }
  .ds-select option { background: #1a1a1a; color: #e0e0e0; }

  .mz-row { display: flex; gap: 6px; align-items: flex-start; margin-top: 2px; }
  .tol-input { flex: 0 0 68px; }
  .mz-row .field-input:first-child { flex: 1; min-width: 0; }

  .btn-primary {
    width: 100%; padding: 8px; margin-top: 8px;
    background: #ffc951; color: #1a1a1a; border: none; border-radius: 8px;
    font-size: 0.78rem; font-weight: 700; letter-spacing: 0.03em;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    gap: 7px; transition: background 0.18s, transform 0.1s, box-shadow 0.18s;
    box-shadow: 0 2px 10px rgba(255,201,81,0.22); font-family: inherit;
  }
  .btn-primary:hover:not(:disabled) {
    background: #ffd57a; box-shadow: 0 4px 18px rgba(255,201,81,0.38);
    transform: translateY(-1px);
  }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .spinner {
    width: 11px; height: 11px;
    border: 2px solid rgba(0,0,0,0.2); border-top-color: #1a1a1a;
    border-radius: 50%; animation: spin 0.7s linear infinite; display: inline-block;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .range-block {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid rgba(255,255,255,0.07);
  }

  .checkbox-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 0 0; cursor: pointer; user-select: none;
  }
  .cb-input {
    appearance: none; width: 14px; height: 14px; flex-shrink: 0;
    border: 1.5px solid rgba(255,255,255,0.2); border-radius: 4px;
    background: #1a1a1a; cursor: pointer; position: relative;
    transition: border-color 0.15s, background 0.15s;
  }
  .cb-input:checked { background: #ffc951; border-color: #ffc951; }
  .cb-input:checked::after {
    content: ""; position: absolute;
    left: 50%; top: 50%;
    width: 3.5px; height: 6px;
    border-right: 1.5px solid #1a1a1a; border-bottom: 1.5px solid #1a1a1a;
    transform: translate(-50%, -62%) rotate(45deg);
  }
  .cb-input:hover { border-color: rgba(255,201,81,0.5); }
  .cb-label { font-size: 0.68rem; color: rgba(255,255,255,0.55); }

  .tissue-list {
    flex: 1;
    min-height: 0;
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.1) transparent;
  }

  .tissue-card {
    height: 230px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    cursor: pointer;
    border-radius: 12px;
    box-shadow: 0 0 0 2px transparent;
    transition: box-shadow 0.15s;
  }
  .tissue-card:hover { box-shadow: 0 0 0 2px rgba(255,201,81,0.25); }
  .tissue-card.selected { box-shadow: 0 0 0 2px #ffc951, 0 0 16px rgba(255,201,81,0.25); }
  .tissue-card :global(.card) { flex: 1; min-height: 0; }

  .col-notice {
    color: rgba(255,255,255,0.28);
    font-size: 0.7rem;
    text-align: center;
    padding: 24px 8px;
    line-height: 1.6;
  }
</style>
