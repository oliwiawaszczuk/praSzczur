<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import BoardCanvas from "$lib/BoardCanvas.svelte";
  import BoardSidebar from "$lib/BoardSidebar.svelte";
  import ShortcutsModal from "$lib/ShortcutsModal.svelte";
  import { wsGet, wsSet } from "$lib/workspace.svelte";
  import {
    boards, loadBoards, createBoard, renameBoard, deleteBoard,
    getBoard, scheduleSaveBoard, flushSaveBoard,
  } from "$lib/board.svelte";
  import type { BoardObject, BoardData, BoardViewport, BoardTool, ShapeKind } from "$lib/board.svelte";

  let ready = $state(false);
  let activeBoardId = $state("");
  let objects = $state<BoardObject[]>([]);
  let viewport = $state<BoardViewport>({ x: 0, y: 0, zoom: 1 });
  let selectedIds = $state<string[]>([]);
  let canvasApi: any = $state();
  let clipboard: BoardObject[] = [];
  let loadKey = $state(0); // wymusza remount BoardCanvas przy zmianie tablicy / cofnięciu

  let tool = $state<BoardTool>("select");
  let drawColor = $state(wsGet("tablica_drawColor", "#ffc951"));
  let drawStrokeWidth = $state(wsGet("tablica_drawStrokeWidth", 4));
  let shapeKind = $state<ShapeKind>(wsGet("tablica_shapeKind", "rect"));
  let shapeFillColor = $state(wsGet("tablica_shapeFillColor", "#ffc951"));
  let shapeFillTransparent = $state(wsGet("tablica_shapeFillTransparent", false));
  let shapeStrokeColor = $state(wsGet("tablica_shapeStrokeColor", "#ffc951"));
  let shapeStrokeWidth = $state(wsGet("tablica_shapeStrokeWidth", 2));
  let shapeStrokeTransparent = $state(wsGet("tablica_shapeStrokeTransparent", true));
  let shapeCornerRadius = $state(wsGet("tablica_shapeCornerRadius", 4));
  let zoomSensitivity = $state(wsGet("tablica_zoomSensitivity", 1));
  let panSensitivity = $state(wsGet("tablica_panSensitivity", 1));
  let shortcutsOpen = $state(false);

  // ── Historia (Ctrl+Z / Ctrl+Shift+Z) ──────────────────────────────────
  let history: BoardData[] = [];
  let historyIndex = -1;
  let historyTimer: ReturnType<typeof setTimeout> | null = null;

  const selectedObjects = $derived(objects.filter((o) => selectedIds.includes(o.id)));
  const sortedBoardList = $derived(
    [...boards()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  );

  onMount(async () => {
    await loadBoards();
    let list = boards();
    if (list.length === 0) {
      const b = await createBoard("Tablica 1");
      list = boards();
      activeBoardId = b.id;
    } else {
      const saved = wsGet<string>("tablica_activeBoardId", "");
      activeBoardId = list.some((b) => b.id === saved) ? saved : list[0].id;
    }
    await openBoard(activeBoardId);
    ready = true;

    window.addEventListener("keydown", onKeydown);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("blur", onWindowBlur);
  });

  onDestroy(() => {
    canvasApi?.flushTextEdit();
    flushSaveBoard();
    if (historyTimer) clearTimeout(historyTimer);
    window.removeEventListener("keydown", onKeydown);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("blur", onWindowBlur);
  });

  function onBeforeUnload() {
    canvasApi?.flushTextEdit();
    flushSaveBoard();
  }
  function onWindowBlur() {
    canvasApi?.flushTextEdit();
  }

  function snapshot(): BoardData {
    return JSON.parse(JSON.stringify({ objects, viewport }));
  }

  async function openBoard(id: string): Promise<void> {
    canvasApi?.flushTextEdit();
    flushSaveBoard();
    const data: BoardData = await getBoard(id);
    objects = data.objects;
    viewport = data.viewport ?? { x: 0, y: 0, zoom: 1 };
    selectedIds = [];
    tool = "select";
    activeBoardId = id;
    wsSet("tablica_activeBoardId", id);
    history = [JSON.parse(JSON.stringify(data))];
    historyIndex = 0;
    loadKey += 1;
  }

  function persist(newObjects: BoardObject[], newViewport: BoardViewport): void {
    objects = newObjects;
    viewport = newViewport;
    scheduleSaveBoard(activeBoardId, { objects: newObjects, viewport: newViewport });
  }

  function pushHistory(): void {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      history = history.slice(0, historyIndex + 1);
      history.push(snapshot());
      if (history.length > 100) history.shift();
      historyIndex = history.length - 1;
    }, 400);
  }

  function applyHistorySnapshot(snap: BoardData): void {
    objects = JSON.parse(JSON.stringify(snap.objects));
    viewport = JSON.parse(JSON.stringify(snap.viewport));
    selectedIds = [];
    loadKey += 1;
    scheduleSaveBoard(activeBoardId, snapshot());
  }

  function undo(): void {
    canvasApi?.flushTextEdit();
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    applyHistorySnapshot(history[historyIndex]);
  }

  function redo(): void {
    canvasApi?.flushTextEdit();
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    applyHistorySnapshot(history[historyIndex]);
  }

  async function handleCreateBoard(name: string): Promise<void> {
    const b = await createBoard(name);
    await openBoard(b.id);
  }

  async function handleDeleteBoard(id: string): Promise<void> {
    const wasActive = id === activeBoardId;
    await deleteBoard(id);
    if (wasActive) {
      const list = boards();
      if (list.length > 0) await openBoard(list[0].id);
      else await handleCreateBoard("Tablica 1");
    }
  }

  function handlePropChange(id: string, patch: Partial<BoardObject>): void {
    canvasApi?.updateObject(id, patch);
  }

  function setTool(t: BoardTool): void {
    tool = t;
  }

  function setDrawColor(c: string): void {
    drawColor = c;
    wsSet("tablica_drawColor", c);
  }
  function setDrawWidth(w: number): void {
    drawStrokeWidth = w;
    wsSet("tablica_drawStrokeWidth", w);
  }
  function setShapeKind(k: ShapeKind): void {
    shapeKind = k;
    wsSet("tablica_shapeKind", k);
  }
  function setShapeFillColor(c: string): void {
    shapeFillColor = c;
    wsSet("tablica_shapeFillColor", c);
  }
  function setShapeFillTransparent(v: boolean): void {
    shapeFillTransparent = v;
    wsSet("tablica_shapeFillTransparent", v);
  }
  function setShapeStrokeColor(c: string): void {
    shapeStrokeColor = c;
    wsSet("tablica_shapeStrokeColor", c);
  }
  function setShapeStrokeWidth(w: number): void {
    shapeStrokeWidth = w;
    wsSet("tablica_shapeStrokeWidth", w);
  }
  function setShapeStrokeTransparent(v: boolean): void {
    shapeStrokeTransparent = v;
    wsSet("tablica_shapeStrokeTransparent", v);
  }
  function setShapeCornerRadius(r: number): void {
    shapeCornerRadius = r;
    wsSet("tablica_shapeCornerRadius", r);
  }
  function setZoomSens(v: number): void {
    zoomSensitivity = v;
    wsSet("tablica_zoomSensitivity", v);
  }
  function setPanSens(v: number): void {
    panSensitivity = v;
    wsSet("tablica_panSensitivity", v);
  }

  function onKeydown(e: KeyboardEvent) {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (e.key === "Escape") {
      canvasApi?.clearSelection();
      if (tool !== "select") tool = "select";
      if (shortcutsOpen) shortcutsOpen = false;
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace")) {
      canvasApi?.deleteSelected();
      return;
    }
    if (e.key === "ArrowUp") { e.preventDefault(); canvasApi?.raiseSelected(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); canvasApi?.lowerSelected(); return; }

    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const key = e.key.toLowerCase();
      if (key === "c") { clipboard = canvasApi?.copySelected() ?? []; }
      else if (key === "v") { canvasApi?.pasteClipboard(clipboard); }
      else if (key === "z" && e.shiftKey) { e.preventDefault(); redo(); }
      else if (key === "z") { e.preventDefault(); undo(); }
      else if (key === "y") { e.preventDefault(); redo(); }
      return;
    }

    const key = e.key.toLowerCase();
    if (key === "t") { canvasApi?.addTextAtCursorOrCenter(); }
    else if (key === "p") { tool = tool === "draw" ? "select" : "draw"; }
    else if (key === "w") { tool = "select"; }
    else if (key === "f") { canvasApi?.fitToContent(); }
  }

  async function handleDropFiles(files: File[]): Promise<void> {
    for (const f of files) await canvasApi?.addImageFromFile(f, activeBoardId);
  }

  async function handlePasteImage(e: ClipboardEvent) {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) await canvasApi?.addImageFromFile(file, activeBoardId);
      }
    }
  }
</script>

<svelte:window onpaste={handlePasteImage} />

{#if ready}
  <div class="tablica">
    <div class="canvas-area">
      {#key loadKey}
        <BoardCanvas
          bind:this={canvasApi}
          {objects}
          {viewport}
          {tool}
          {drawColor}
          {drawStrokeWidth}
          {shapeKind}
          {shapeFillColor}
          {shapeFillTransparent}
          {shapeStrokeColor}
          {shapeStrokeWidth}
          {shapeStrokeTransparent}
          {shapeCornerRadius}
          {zoomSensitivity}
          {panSensitivity}
          onchange={persist}
          oncommit={pushHistory}
          onselect={(ids) => (selectedIds = ids)}
          ondropfiles={handleDropFiles}
          ontextplaced={() => (tool = "select")}
        />
      {/key}
      <div class="zoom-controls">
        <button class="zoom-btn" onclick={() => canvasApi?.fitToContent()} title="Dopasuj widok do wszystkich obiektów (F)">⛶</button>
        <span class="zoom-sep"></span>
        <button class="zoom-btn" onclick={() => canvasApi?.zoomBy(-1)} title="Pomniejsz">−</button>
        <span class="zoom-pct">{Math.round(viewport.zoom * 100)}%</span>
        <button class="zoom-btn" onclick={() => canvasApi?.zoomBy(1)} title="Powiększ">+</button>
      </div>
    </div>
    <div class="sidebar-panel">
      <BoardSidebar
        boardList={sortedBoardList}
        {activeBoardId}
        selected={selectedObjects}
        {tool}
        {drawColor}
        {drawStrokeWidth}
        {shapeKind}
        {shapeFillColor}
        {shapeFillTransparent}
        {shapeStrokeColor}
        {shapeStrokeWidth}
        {shapeStrokeTransparent}
        {shapeCornerRadius}
        {zoomSensitivity}
        {panSensitivity}
        onselectboard={openBoard}
        oncreateboard={handleCreateBoard}
        onrenameboard={(id, name) => renameBoard(id, name)}
        ondeleteboard={handleDeleteBoard}
        onpropchange={handlePropChange}
        onaddimagefiles={handleDropFiles}
        onsettool={setTool}
        ondrawcolor={setDrawColor}
        ondrawwidth={setDrawWidth}
        onshapekind={setShapeKind}
        onshapefillcolor={setShapeFillColor}
        onshapefilltransparent={setShapeFillTransparent}
        onshapestrokecolor={setShapeStrokeColor}
        onshapestrokewidth={setShapeStrokeWidth}
        onshapestroketransparent={setShapeStrokeTransparent}
        onshapecornerradius={setShapeCornerRadius}
        onexportpng={() => canvasApi?.exportPNG()}
        onzoomsens={setZoomSens}
        onpansens={setPanSens}
        onshowshortcuts={() => (shortcutsOpen = true)}
      />
    </div>
  </div>
{:else}
  <div class="loading">Wczytywanie tablicy…</div>
{/if}

<ShortcutsModal open={shortcutsOpen} onclose={() => (shortcutsOpen = false)} />

<style>
  .tablica {
    display: flex;
    flex-direction: row;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }
  .canvas-area {
    flex: 1;
    min-width: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .zoom-controls {
    position: absolute;
    bottom: 14px; right: 14px;
    display: flex; align-items: center; gap: 2px;
    background: rgba(30,30,30,0.85);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 9px;
    padding: 3px;
    backdrop-filter: blur(4px);
    z-index: 10;
  }
  .zoom-btn {
    width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: none; border-radius: 6px;
    color: rgba(255,255,255,0.6); font-size: 0.95rem; font-weight: 700;
    cursor: pointer; font-family: inherit; line-height: 1;
    transition: background 0.15s, color 0.15s;
  }
  .zoom-btn:hover { background: rgba(255,201,81,0.15); color: #ffc951; }
  .zoom-pct {
    min-width: 40px; text-align: center;
    font-size: 0.68rem; font-weight: 600; color: rgba(255,255,255,0.5);
  }
  .zoom-sep {
    width: 1px; height: 16px; background: rgba(255,255,255,0.12); margin: 0 2px;
  }

  .sidebar-panel {
    width: 280px; min-width: 280px; max-width: 280px;
    flex-shrink: 0; height: 100%; overflow: hidden;
  }

  .loading {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: rgba(255,255,255,0.3); font-size: 0.85rem;
  }
</style>
