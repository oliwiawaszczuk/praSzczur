<script lang="ts">
  import IonCanvas from "./IonCanvas.svelte";
  import type { TissueImage } from "./api.js";

  interface Props {
    tissues?: Record<string, TissueImage> | null;
    loading?: boolean;
    dispMin?: number;
    dispMax?: number;
  }
  let { tissues = null, loading = false, dispMin = 0, dispMax = 1 }: Props = $props();

  const keys = $derived(tissues ? Object.keys(tissues) : ["", "", "", ""]);
</script>

<div class="grid-wrap"><div class="grid">
  {#each keys as key}
    <IonCanvas tissue={tissues?.[key] ?? null} {loading} {dispMin} {dispMax} />
  {/each}
</div></div>

<style>
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
