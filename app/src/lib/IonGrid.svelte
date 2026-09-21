<script lang="ts">
  import IonCanvas from "./IonCanvas.svelte";
  import type { TissueImage } from "./api.js";

  interface Props {
    tissues?: Record<string, TissueImage> | null;
    loading?: boolean;
    dispMin?: number;
    dispMax?: number;
    error?: string;
    tissueLabels?: Record<string, string>;
  }
  let { tissues = null, loading = false, dispMin = 0, dispMax = 1, error = "", tissueLabels = {} }: Props = $props();

  const keys = $derived(tissues ? Object.keys(tissues) : ["", "", "", ""]);

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
    <div class="grid-normal">
      {#each keys as key}
        <div class="tile" onclick={() => handleClick(key)} role="button" tabindex="0">
          <IonCanvas tissue={withLabel(key, tissues?.[key] ?? null)} {loading} {dispMin} {dispMax} />
        </div>
      {/each}
    </div>
  {:else}
    <div class="grid-focused">
      <div class="col-main tile focused" onclick={() => handleClick(focusedKey!)} role="button" tabindex="0">
        <IonCanvas tissue={withLabel(focusedKey, tissues?.[focusedKey] ?? null)} {loading} {dispMin} {dispMax} />
      </div>
      <div class="col-side">
        {#each unfocusedKeys as key}
          <div class="tile side-tile" onclick={() => handleClick(key)} role="button" tabindex="0">
            <IonCanvas tissue={withLabel(key, tissues?.[key] ?? null)} {loading} {dispMin} {dispMax} />
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
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
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
    min-width: 0; min-height: 0;
    display: flex; flex-direction: column;
    cursor: pointer;
    border-radius: 8px;
    overflow: hidden;
  }

  .tile.focused { cursor: zoom-out; }
</style>
