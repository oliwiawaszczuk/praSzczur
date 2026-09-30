<script lang="ts">
  import IonCanvas from "./IonCanvas.svelte";
  import type { TissueImage } from "./api.js";
  import { savePixelMap } from "./savedPixelMaps.svelte";
  import { requestGraphInsert } from "./graphInsert.svelte";
  import { windowValue, maxOf } from "./tissueMerge";
  import { datasetLabel, sanitizeDatasetId, RAW_DATASET_ID } from "$lib/datasets.svelte";

  interface Props {
    tissues?: Record<string, TissueImage> | null;
    loading?: boolean;
    dispMin?: number;
    dispMax?: number;
    error?: string;
    tissueLabels?: Record<string, string>;
    tissueColors?: Record<string, string>;
    invertColors?: boolean;
    /** Bieżące zapytanie (m/z pojedyncze, nie grupa) — potrzebne do zapisu
     * mapy / wysłania do Node Graph (pkt 14: "tkanka (jeden)"). */
    mz?: number | null;
    tol?: number;
    dataset?: string;
  }
  let {
    tissues = null, loading = false, dispMin = 0, dispMax = 1, error = "",
    tissueLabels = {}, tissueColors = {}, invertColors = false,
    mz = null, tol = 0.3, dataset = RAW_DATASET_ID,
  }: Props = $props();

  const keys = $derived(tissues ? Object.keys(tissues) : ["", "", "", ""]);

  // Oblicz liczbę kolumn: 2 dla ≤4, 3 dla ≤9, 4 dla ≤16 itd.
  const cols = $derived(Math.ceil(Math.sqrt(keys.length)));
  const gridStyle = $derived(`grid-template-columns: repeat(${cols}, 1fr);`);

  let focusedKey = $state<string | null>(null);
  $effect(() => { keys; focusedKey = null; });

  const unfocusedKeys = $derived(
    focusedKey !== null ? keys.filter(k => k !== focusedKey) : []
  );

  function withLabel(tid: string, t: TissueImage | null): TissueImage | null {
    if (!t) return null;
    const custom = tissueLabels[tid];
    return custom ? { ...t, label: custom } : t;
  }

  function handleClick(key: string) {
    if (!tissues) return;
    focusedKey = focusedKey === key ? null : key;
  }

  /** Buduje i zapisuje mapę danej tkanki (z bieżącym zakresem wyświetlania i
   * odwróceniem kolorów zastosowanym PRZED zapisem, jak w MzColumn.svelte
   * onSave/saveThisMap — ten sam wzorzec). Współdzielone przez 💾 i
   * "→ Node Graph". */
  async function saveThisTile(key: string): Promise<{ id: string; label: string } | undefined> {
    const img = withLabel(key, tissues?.[key] ?? null);
    if (!img || mz === null) return undefined;
    const data = img.data.map((row) => row.map((v) => windowValue(v, dispMin, dispMax, invertColors)));
    const name = `${img.label} · ${new Date().toLocaleString("pl-PL")}`;
    const ds = sanitizeDatasetId(dataset);
    const meta = await savePixelMap({
      name,
      tissueId: key,
      tissueLabel: img.label,
      width: img.width,
      height: img.height,
      vmax: maxOf(data),
      mode: "single",
      sources: [{ groupIndex: 0, mz, tol, datasetId: ds, datasetLabel: datasetLabel(ds) }],
      data,
      mask: img.mask,
    });
    return { id: meta.id, label: name };
  }

  let savedFlash = $state<Set<string>>(new Set());

  async function onSaveTile(e: MouseEvent, key: string) {
    e.stopPropagation();
    try {
      const saved = await saveThisTile(key);
      if (!saved) return;
      savedFlash = new Set(savedFlash).add(key);
      setTimeout(() => { const next = new Set(savedFlash); next.delete(key); savedFlash = next; }, 1000);
    } catch {
      // cichy błąd — przycisk po prostu nie pokaże ✓
    }
  }

  async function onSendTileToGraph(e: MouseEvent, key: string) {
    e.stopPropagation();
    try {
      const saved = await saveThisTile(key);
      if (!saved) return;
      requestGraphInsert({ kind: "mapa", savedMapId: saved.id, label: saved.label }, "nodegraph");
    } catch {
      // cichy błąd — przycisk po prostu nic nie zrobi
    }
  }
</script>

<div class="grid-wrap">
  {#if error}
    <div class="grid-notice">
      <div class="notice-icon">⚠</div>
      <div class="notice-msg">{error}</div>
    </div>
  {:else if !tissues && !loading}
    <div class="grid-notice">
      <div class="notice-icon">⬡</div>
      <div class="notice-msg">Wpisz wartość m/z i kliknij Wczytaj</div>
    </div>
  {:else if focusedKey === null}
    <div class="grid-normal" style={gridStyle}>
      {#each keys as key}
        <div class="tile" onclick={() => handleClick(key)} role="button" tabindex="0">
          {#if tissues?.[key]}
            <div class="tile-actions">
              <button class="tile-icon-btn" onclick={(e) => onSaveTile(e, key)} title="Zapisz tę mapę pikseli">
                {savedFlash.has(key) ? "✓" : "💾"}
              </button>
              <button class="tile-icon-btn" onclick={(e) => onSendTileToGraph(e, key)} title="Wyślij do Node Graph">→⬡</button>
            </div>
          {/if}
          <IonCanvas tissue={withLabel(key, tissues?.[key] ?? null)} {loading} {dispMin} {dispMax} accentColor={tissueColors[key] ?? ""} {invertColors} />
        </div>
      {/each}
    </div>
  {:else}
    <div class="grid-focused">
      <div class="col-main tile focused" onclick={() => handleClick(focusedKey!)} role="button" tabindex="0">
        {#if tissues?.[focusedKey]}
          <div class="tile-actions">
            <button class="tile-icon-btn" onclick={(e) => onSaveTile(e, focusedKey!)} title="Zapisz tę mapę pikseli">
              {savedFlash.has(focusedKey) ? "✓" : "💾"}
            </button>
            <button class="tile-icon-btn" onclick={(e) => onSendTileToGraph(e, focusedKey!)} title="Wyślij do Node Graph">→⬡</button>
          </div>
        {/if}
        <IonCanvas tissue={withLabel(focusedKey, tissues?.[focusedKey] ?? null)} {loading} {dispMin} {dispMax} accentColor={tissueColors[focusedKey!] ?? ""} {invertColors} />
      </div>
      <div class="col-side">
        {#each unfocusedKeys as key}
          <div class="tile side-tile" onclick={() => handleClick(key)} role="button" tabindex="0">
            {#if tissues?.[key]}
              <div class="tile-actions">
                <button class="tile-icon-btn" onclick={(e) => onSaveTile(e, key)} title="Zapisz tę mapę pikseli">
                  {savedFlash.has(key) ? "✓" : "💾"}
                </button>
                <button class="tile-icon-btn" onclick={(e) => onSendTileToGraph(e, key)} title="Wyślij do Node Graph">→⬡</button>
              </div>
            {/if}
            <IonCanvas tissue={withLabel(key, tissues?.[key] ?? null)} {loading} {dispMin} {dispMax} accentColor={tissueColors[key] ?? ""} {invertColors} />
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .grid-notice {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: rgba(255,255,255,0.3);
    text-align: center;
    padding: 2rem;
  }
  .notice-icon { font-size: 2.2rem; opacity: 0.4; }
  .notice-msg  { font-size: 0.82rem; line-height: 1.6; max-width: 320px; }

  .grid-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .grid-normal {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-auto-rows: 1fr;
    gap: 14px;
    padding: 14px;
    box-sizing: border-box;
    overflow: hidden;
  }

  .grid-focused {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: row;
    gap: 14px;
    padding: 14px;
    box-sizing: border-box;
    overflow: hidden;
  }

  .col-main {
    flex: 3;
    min-width: 0;
  }

  .col-side {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .side-tile {
    flex: 1;
    min-height: 0;
    opacity: 0.7;
  }
  .side-tile:hover { opacity: 1; }

  .tile {
    position: relative;
    min-width: 0; min-height: 0;
    display: flex; flex-direction: column;
    cursor: pointer;
    border-radius: 8px;
    overflow: hidden;
  }

  .tile.focused { cursor: zoom-out; }

  .tile-actions {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 3;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .tile:hover .tile-actions { opacity: 1; }
  .tile-icon-btn {
    background: rgba(0,0,0,0.55);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 6px;
    color: #f0f0f0;
    font-size: 0.72rem;
    line-height: 1;
    padding: 4px 6px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, background 0.15s;
  }
  .tile-icon-btn:hover { border-color: rgba(255,201,81,0.5); background: rgba(255,201,81,0.15); }
</style>
