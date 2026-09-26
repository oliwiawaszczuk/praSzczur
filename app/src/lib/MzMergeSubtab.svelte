<script lang="ts">
  import IonCanvas from "./IonCanvas.svelte";
  import PixelMapZoomModal from "./PixelMapZoomModal.svelte";
  import { mergedResults, currentCombineMode, setCombineMode, type MergedTissueResult } from "./mzGroups.svelte";
  import { datasetLabel } from "$lib/datasets.svelte";
  import { savePixelMap } from "./savedPixelMaps.svelte";
  import type { CombineMode } from "./tissueMerge";

  interface Props {
    tissueLabels?: Record<string, string>;
  }
  let { tissueLabels = {} }: Props = $props();

  const MODES: { key: CombineMode; label: string }[] = [
    { key: "mean",     label: "Średnia" },
    { key: "sum",      label: "Suma" },
    { key: "max",      label: "Maksimum" },
    { key: "multiply", label: "Iloczyn" },
  ];

  const results = $derived(mergedResults());

  function labelFor(tissueId: string): string {
    return tissueLabels[tissueId] ?? tissueId;
  }

  let nameDrafts = $state<Record<string, string>>({});
  function nameFor(r: MergedTissueResult): string {
    return nameDrafts[r.tissueId] ?? labelFor(r.tissueId);
  }

  let savedFlash = $state<Set<string>>(new Set());

  async function onSave(r: MergedTissueResult) {
    try {
      await savePixelMap({
        name: nameFor(r),
        tissueId: r.tissueId,
        tissueLabel: labelFor(r.tissueId),
        width: r.width,
        height: r.height,
        vmax: r.vmax,
        mode: r.mode,
        sources: r.sources.map((s) => ({ groupIndex: s.groupIndex, mz: s.mz, tol: s.tol, datasetId: s.dataset, datasetLabel: datasetLabel(s.dataset) })),
        data: r.data,
      });
      savedFlash = new Set(savedFlash).add(r.tissueId);
      setTimeout(() => { const next = new Set(savedFlash); next.delete(r.tissueId); savedFlash = next; }, 1000);
    } catch {
      // cichy błąd — przycisk po prostu nie pokaże ✓
    }
  }

  let zoomedId = $state<string | null>(null);
  const zoomedResult = $derived(results.find((r) => r.tissueId === zoomedId) ?? null);
</script>

<div class="merge-wrap">
  <div class="merge-toolbar">
    <div class="mode-field">
      <label class="field-label" for="combine-mode-select">Sposób łączenia</label>
      <select id="combine-mode-select" class="ds-select" value={currentCombineMode()} onchange={(e) => setCombineMode((e.target as HTMLSelectElement).value as CombineMode)}>
        {#each MODES as m}
          <option value={m.key}>{m.label}</option>
        {/each}
      </select>
    </div>
  </div>

  {#if results.length === 0}
    <div class="merge-empty">
      <div class="me-icon">⬡</div>
      <div class="me-msg">Zaznacz tkanki w grupach, aby je tu połączyć.</div>
    </div>
  {:else}
    <div class="merge-grid">
      {#each results as r (r.tissueId)}
        <div class="merge-card">
          <div class="merge-card-head">
            <input
              class="merge-name-input"
              value={nameFor(r)}
              oninput={(e) => (nameDrafts = { ...nameDrafts, [r.tissueId]: (e.target as HTMLInputElement).value })}
            />
            <div class="merge-card-head-right">
              {#if r.sources.length === 1}
                <span class="merge-single-badge">pojedyncza, niepołączona</span>
              {:else}
                <span class="merge-count-badge">{r.sources.length} źródła</span>
              {/if}
              <button class="card-icon-btn" onclick={() => (zoomedId = r.tissueId)} title="Powiększ">⤢</button>
              <button class="card-icon-btn" onclick={() => onSave(r)} title="Zapisz tę mapę pikseli">
                {savedFlash.has(r.tissueId) ? "✓" : "💾"}
              </button>
            </div>
          </div>
          <div class="merge-sources">
            {#each r.sources as s, i (i)}
              <span class="source-tag">m/z {s.mz.toFixed(2)} ±{s.tol} · {datasetLabel(s.dataset)}</span>
            {/each}
          </div>
          <div class="merge-canvas">
            <IonCanvas
              tissue={{ label: labelFor(r.tissueId), data: r.data, width: r.width, height: r.height, vmax: r.vmax }}
              dispMin={0}
              dispMax={1}
              invertColors={false}
              showColorbar={false}
              showVmax={false}
              compact
            />
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if zoomedResult}
  <PixelMapZoomModal
    tissue={{ label: labelFor(zoomedResult.tissueId), data: zoomedResult.data, width: zoomedResult.width, height: zoomedResult.height, vmax: zoomedResult.vmax }}
    dispMin={0}
    dispMax={1}
    invertColors={false}
    onclose={() => (zoomedId = null)}
  />
{/if}

<style>
  .merge-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 16px;
    box-sizing: border-box;
    overflow-y: auto;
  }

  .merge-toolbar {
    display: flex;
    align-items: flex-end;
    gap: 20px;
    flex-shrink: 0;
    margin-bottom: 16px;
  }

  .mode-field { width: 200px; }

  .field-label {
    display: block; font-size: 0.62rem; font-weight: 600;
    letter-spacing: 0.09em; text-transform: uppercase;
    color: rgba(255,255,255,0.38); margin-bottom: 5px;
  }

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
    font-size: 0.74rem;
    padding: 6px 24px 6px 9px;
    font-family: inherit;
    cursor: pointer;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s, color 0.15s;
  }
  .ds-select:hover  { border-color: rgba(255,201,81,0.3); color: #ffc951; }
  .ds-select option { background: #1a1a1a; color: #e0e0e0; }

  .merge-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: rgba(255,255,255,0.3);
    text-align: center;
  }
  .me-icon { font-size: 2.2rem; opacity: 0.4; }
  .me-msg  { font-size: 0.82rem; line-height: 1.6; max-width: 340px; }

  .merge-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-content: flex-start;
  }

  .merge-card {
    width: 320px;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.35);
    padding: 12px;
    box-sizing: border-box;
  }

  .merge-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .merge-card-head-right {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .card-icon-btn {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    color: #f0f0f0;
    font-size: 0.72rem;
    line-height: 1;
    padding: 4px 6px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, background 0.15s;
  }
  .card-icon-btn:hover { border-color: rgba(255,201,81,0.5); background: rgba(255,201,81,0.1); }

  .merge-name-input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: #ffc951;
    text-transform: uppercase;
    font-family: inherit;
    padding: 4px 6px;
    margin: -4px 0 -4px -6px;
    outline: none;
    transition: border-color 0.15s, background 0.15s;
  }
  .merge-name-input:hover, .merge-name-input:focus { border-color: rgba(255,201,81,0.3); background: rgba(255,255,255,0.03); }

  .merge-single-badge, .merge-count-badge {
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: 5px;
    white-space: nowrap;
  }
  .merge-single-badge { color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.06); }
  .merge-count-badge  { color: #ffc951; background: rgba(255,201,81,0.12); }

  .merge-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 8px;
  }

  .source-tag {
    font-size: 0.6rem;
    color: rgba(255,255,255,0.45);
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 5px;
    padding: 3px 7px;
  }

  .merge-canvas {
    height: 260px;
    margin-top: 10px;
    display: flex;
    flex-direction: column;
  }
  .merge-canvas :global(.card) { flex: 1; min-height: 0; }
</style>
