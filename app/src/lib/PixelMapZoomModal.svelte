<script lang="ts">
  import IonCanvas from "./IonCanvas.svelte";
  import type { TissueImage } from "./api.js";

  interface Props {
    tissue: TissueImage | null;
    dispMin?: number;
    dispMax?: number;
    invertColors?: boolean;
    onclose: () => void;
  }
  let { tissue, dispMin = 0, dispMax = 1, invertColors = false, onclose }: Props = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="zoom-backdrop" onclick={onclose} onkeydown={handleKeydown} role="presentation">
  <div class="zoom-box" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
    <button class="zoom-close" onclick={onclose} title="Zamknij (Esc)">✕</button>
    <div class="zoom-canvas">
      <IonCanvas {tissue} {dispMin} {dispMax} {invertColors} showColorbar={false} showVmax={false} />
    </div>
  </div>
</div>

<style>
  .zoom-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.75);
    backdrop-filter: blur(4px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: zoom-fade-in 0.15s ease;
  }
  @keyframes zoom-fade-in { from { opacity: 0; } to { opacity: 1; } }

  .zoom-box {
    position: relative;
    background: #1a1a1a;
    border-radius: 14px;
    width: min(90vw, 1100px);
    height: min(85vh, 900px);
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
    animation: zoom-modal-in 0.18s ease;
    display: flex;
    padding: 16px;
    box-sizing: border-box;
  }
  @keyframes zoom-modal-in {
    from { opacity: 0; transform: scale(0.96); }
    to   { opacity: 1; transform: scale(1); }
  }

  .zoom-canvas {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
  }
  .zoom-canvas :global(.card) { flex: 1; min-height: 0; }

  .zoom-close {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 3;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    color: rgba(255,255,255,0.7);
    font-size: 0.9rem;
    width: 30px;
    height: 30px;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .zoom-close:hover { color: #ff6b6b; border-color: rgba(255,107,107,0.4); background: rgba(255,107,107,0.1); }
</style>
