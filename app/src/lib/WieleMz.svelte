<script lang="ts">
  import { onMount } from "svelte";
  import MzColumn from "./MzColumn.svelte";
  import { allGroups, loadWieleMz, addGroup, removeGroup, reorderGroups, clearSelection, hasAnySelection } from "./mzGroups.svelte";

  interface Props {
    mzMin?: number;
    mzMax?: number;
    tolDefault?: number;
    tissueIds?: string[];
    tissueLabels?: Record<string, string>;
    tissueColors?: Record<string, string>;
  }

  let {
    mzMin = 0,
    mzMax = Infinity,
    tolDefault = 0.3,
    tissueIds = [],
    tissueLabels = {},
    tissueColors = {},
  }: Props = $props();

  onMount(() => { loadWieleMz(tolDefault); });

  const groups = $derived(allGroups());

  // ── Drag-to-reorder (Pointer Events) — natywny HTML5 DnD jest niestabilny
  // w webview Tauri, więc ten sam wzorzec co przy przeciąganiu warstw widma
  // w zakładce Widma (Widma.svelte: startDrag/onDragPointerMove/onDragPointerUp). ─
  let draggingIdx = $state<number | null>(null);
  let dragOverIdx = $state<number | null>(null);
  let colsListEl  = $state<HTMLDivElement | null>(null);

  function startDrag(e: PointerEvent, i: number) {
    e.preventDefault();
    draggingIdx = i;
    dragOverIdx = i;
    window.addEventListener("pointermove", onDragPointerMove);
    window.addEventListener("pointerup", onDragPointerUp);
  }

  function onDragPointerMove(e: PointerEvent) {
    if (draggingIdx === null || !colsListEl) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const col = (el as HTMLElement | null)?.closest(".wmz-col") as HTMLElement | null;
    if (!col || !colsListEl.contains(col)) return;
    const idx = Number(col.dataset.idx);
    if (!isNaN(idx)) dragOverIdx = idx;
  }

  function onDragPointerUp() {
    if (draggingIdx !== null && dragOverIdx !== null && dragOverIdx !== draggingIdx) {
      reorderGroups(draggingIdx, dragOverIdx);
    }
    draggingIdx = null;
    dragOverIdx = null;
    window.removeEventListener("pointermove", onDragPointerMove);
    window.removeEventListener("pointerup", onDragPointerUp);
  }
</script>

<div class="wmz-outer">
  <div class="wmz-toolbar">
    <button class="wmz-clear-btn" onclick={clearSelection} disabled={!hasAnySelection()}>
      Wyczyść zaznaczenia
    </button>
  </div>

  <div class="wmz-wrap" bind:this={colsListEl}>
    {#each groups as group, i (group.id)}
      <div
        class="wmz-col"
        class:drag-over={dragOverIdx === i && draggingIdx !== null && draggingIdx !== i}
        class:dragging={draggingIdx === i}
        data-idx={i}
        role="group"
      >
        <div class="wmz-col-header">
          <span
            class="wmz-handle"
            onpointerdown={(e) => startDrag(e, i)}
            title="Przeciągnij, aby zmienić kolejność"
            role="button"
            tabindex="0"
          >⠿</span>
          <span class="wmz-col-title">Grupa {i + 1}</span>
          <button class="wmz-remove" onclick={() => removeGroup(group.id)} title="Usuń kolumnę">×</button>
        </div>
        <MzColumn
          {group}
          groupIndex={i}
          {mzMin} {mzMax}
          {tissueIds} {tissueLabels} {tissueColors}
        />
      </div>
    {/each}

    <button class="wmz-add" onclick={() => addGroup(tolDefault)}>
      <span class="wmz-add-icon">+</span>
      <span class="wmz-add-label">Dodaj m/z</span>
    </button>
  </div>
</div>

<style>
  .wmz-outer {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .wmz-toolbar {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    padding: 10px 16px 0;
    box-sizing: border-box;
  }

  .wmz-clear-btn {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 7px;
    color: rgba(255,255,255,0.6);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 6px 12px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
  }
  .wmz-clear-btn:hover:not(:disabled) {
    border-color: rgba(255,201,81,0.5);
    background: rgba(255,201,81,0.1);
    color: #ffc951;
  }
  .wmz-clear-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  .wmz-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: row;
    align-items: stretch;
    gap: 16px;
    padding: 16px;
    box-sizing: border-box;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.12) transparent;
  }

  .wmz-col {
    width: 280px;
    min-width: 280px;
    max-width: 280px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.35);
    transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;
  }

  .wmz-col.dragging { opacity: 0.4; }

  .wmz-col.drag-over {
    border-color: rgba(255,201,81,0.6);
    box-shadow: 0 0 0 2px rgba(255,201,81,0.3), 0 4px 20px rgba(0,0,0,0.35);
  }

  .wmz-col-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    flex-shrink: 0;
  }

  .wmz-handle {
    cursor: grab;
    color: rgba(255,255,255,0.3);
    font-size: 0.95rem;
    line-height: 1;
    padding: 2px 4px;
    user-select: none;
    transition: color 0.15s;
  }
  .wmz-handle:hover { color: #ffc951; }
  .wmz-handle:active { cursor: grabbing; }

  .wmz-col-title {
    flex: 1;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.4);
  }

  .wmz-remove {
    background: none; border: none; color: rgba(255,255,255,0.25);
    cursor: pointer; font-size: 1rem; padding: 0 2px; line-height: 1;
    font-family: inherit; transition: color 0.15s;
  }
  .wmz-remove:hover { color: #ff6b6b; }

  .wmz-add {
    width: 90px;
    min-width: 90px;
    height: 210px;
    align-self: flex-start;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: rgba(255,255,255,0.02);
    border: 1.5px dashed rgba(255,255,255,0.15);
    border-radius: 12px;
    color: rgba(255,255,255,0.35);
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.18s, color 0.18s, background 0.18s;
  }
  .wmz-add:hover {
    border-color: rgba(255,201,81,0.5);
    color: #ffc951;
    background: rgba(255,201,81,0.05);
  }
  .wmz-add-icon { font-size: 1.6rem; font-weight: 300; line-height: 1; }
  .wmz-add-label {
    font-size: 0.66rem; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; writing-mode: vertical-rl;
  }
</style>
