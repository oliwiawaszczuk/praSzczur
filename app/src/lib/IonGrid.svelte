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

  function withLabel(tid: string, t: TissueImage | null): TissueImage | null {
    if (!t) return null;
    const custom = tissueLabels[tid];
    return custom ? { ...t, label: custom } : t;
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
  {:else}
    <div class="grid">
      {#each keys as key}
        <IonCanvas tissue={withLabel(key, tissues?.[key] ?? null)} {loading} {dispMin} {dispMax} />
      {/each}
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

  /* Wrapper bierze całą wysokość flexa rodzica */
  .grid-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .grid {
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
</style>
