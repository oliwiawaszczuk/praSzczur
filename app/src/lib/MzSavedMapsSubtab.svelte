<script lang="ts">
  import { onMount } from "svelte";
  import IonCanvas from "./IonCanvas.svelte";
  import PixelMapZoomModal from "./PixelMapZoomModal.svelte";
  import {
    savedMapsList, loadSavedMaps, renameSavedMap, deleteSavedMap, fetchSavedMapData,
    type SavedPixelMap,
  } from "./savedPixelMaps.svelte";

  let mapData = $state<Record<string, SavedPixelMap>>({});
  let loadingIds = $state<Set<string>>(new Set());
  let renameDrafts = $state<Record<string, string>>({});

  const metas = $derived(savedMapsList());

  onMount(async () => {
    await loadSavedMaps();
    for (const m of savedMapsList()) loadOne(m.id);
  });

  async function loadOne(id: string) {
    if (mapData[id] || loadingIds.has(id)) return;
    loadingIds = new Set(loadingIds).add(id);
    try {
      const full = await fetchSavedMapData(id);
      mapData = { ...mapData, [id]: full };
    } catch {
      // pomiń — karta pokaże placeholder braku danych
    } finally {
      const next = new Set(loadingIds);
      next.delete(id);
      loadingIds = next;
    }
  }

  function draftFor(id: string, fallback: string): string {
    return renameDrafts[id] ?? fallback;
  }

  function commitRename(id: string, fallback: string) {
    const draft = (renameDrafts[id] ?? fallback).trim();
    if (draft && draft !== fallback) renameSavedMap(id, draft);
    const { [id]: _drop, ...rest } = renameDrafts;
    renameDrafts = rest;
  }

  async function onDelete(id: string) {
    await deleteSavedMap(id);
    const { [id]: _drop, ...rest } = mapData;
    mapData = rest;
  }

  const modeLabels: Record<string, string> = { mean: "średnia", sum: "suma", max: "maksimum", multiply: "iloczyn", single: "pojedyncza" };

  let zoomedId = $state<string | null>(null);
  const zoomedMeta = $derived(metas.find((m) => m.id === zoomedId) ?? null);
</script>

<div class="saved-wrap">
  {#if metas.length === 0}
    <div class="saved-empty">
      <div class="se-icon">💾</div>
      <div class="se-msg">Nie zapisano jeszcze żadnej mapy — użyj 💾 przy tkance w grupach albo w Łączeniu.</div>
    </div>
  {:else}
    <div class="saved-grid">
      {#each metas as m (m.id)}
        <div class="saved-card">
          <div class="saved-card-head">
            <input
              class="name-input"
              value={draftFor(m.id, m.name)}
              oninput={(e) => (renameDrafts = { ...renameDrafts, [m.id]: (e.target as HTMLInputElement).value })}
              onblur={() => commitRename(m.id, m.name)}
              onkeydown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
            {#if mapData[m.id]}
              <button class="card-icon-btn" onclick={() => (zoomedId = m.id)} title="Powiększ">⤢</button>
            {/if}
            <button class="saved-remove" onclick={() => onDelete(m.id)} title="Usuń zapisaną mapę">×</button>
          </div>
          <div class="saved-meta-row">
            <span class="tissue-tag">{m.tissueLabel || m.tissueId}</span>
            <span class="mode-tag">{modeLabels[m.mode] ?? m.mode}</span>
          </div>
          <div class="saved-sources">
            {#each m.sources as s, i (i)}
              <span class="source-tag">m/z {s.mz.toFixed(2)} ±{s.tol} · {s.datasetLabel}</span>
            {/each}
          </div>
          <div class="saved-canvas">
            {#if mapData[m.id]}
              <IonCanvas
                tissue={{ label: m.tissueLabel || m.tissueId, data: mapData[m.id].data, width: m.width, height: m.height, vmax: m.vmax }}
                dispMin={0}
                dispMax={1}
                invertColors={false}
                showColorbar={false}
                showVmax={false}
                compact
              />
            {:else}
              <div class="saved-loading">Ładowanie…</div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if zoomedMeta && mapData[zoomedMeta.id]}
  <PixelMapZoomModal
    tissue={{ label: zoomedMeta.tissueLabel || zoomedMeta.tissueId, data: mapData[zoomedMeta.id].data, width: zoomedMeta.width, height: zoomedMeta.height, vmax: zoomedMeta.vmax }}
    dispMin={0}
    dispMax={1}
    invertColors={false}
    onclose={() => (zoomedId = null)}
  />
{/if}

<style>
  .saved-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 16px;
    box-sizing: border-box;
    overflow-y: auto;
  }

  .saved-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: rgba(255,255,255,0.3);
    text-align: center;
  }
  .se-icon { font-size: 2rem; opacity: 0.4; }
  .se-msg  { font-size: 0.82rem; line-height: 1.6; max-width: 360px; }

  .saved-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-content: flex-start;
  }

  .saved-card {
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

  .saved-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .name-input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: #ffc951;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    font-family: inherit;
    padding: 4px 6px;
    outline: none;
    transition: border-color 0.15s, background 0.15s;
  }
  .name-input:hover, .name-input:focus { border-color: rgba(255,201,81,0.3); background: rgba(255,255,255,0.03); }

  .saved-remove {
    background: none; border: none; color: rgba(255,255,255,0.25);
    cursor: pointer; font-size: 1rem; padding: 0 2px; line-height: 1;
    font-family: inherit; transition: color 0.15s;
  }
  .saved-remove:hover { color: #ff6b6b; }

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
    flex-shrink: 0;
    transition: border-color 0.15s, background 0.15s;
  }
  .card-icon-btn:hover { border-color: rgba(255,201,81,0.5); background: rgba(255,201,81,0.1); }

  .saved-meta-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .tissue-tag, .mode-tag {
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: 5px;
  }
  .tissue-tag { color: #ffc951; background: rgba(255,201,81,0.12); }
  .mode-tag   { color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.06); }

  .saved-sources {
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

  .saved-canvas {
    height: 260px;
    margin-top: 10px;
    display: flex;
    flex-direction: column;
  }
  .saved-canvas :global(.card) { flex: 1; min-height: 0; }

  .saved-loading {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255,255,255,0.25);
    font-size: 0.72rem;
    background: #1a1a1a;
    border-radius: 12px;
  }
</style>
