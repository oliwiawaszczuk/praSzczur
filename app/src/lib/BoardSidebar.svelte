<script lang="ts">
  import ConfirmModal from "$lib/ConfirmModal.svelte";
  import type {
    BoardMeta, BoardObject, BoardImageObject, BoardTextObject, BoardDrawObject, BoardShapeObject,
    BoardTool, ShapeKind,
  } from "$lib/board.svelte";

  interface Props {
    boardList: BoardMeta[];
    activeBoardId: string;
    selected: BoardObject[];
    tool: BoardTool;
    drawColor: string;
    drawStrokeWidth: number;
    shapeKind: ShapeKind;
    shapeFillColor: string;
    shapeFillTransparent: boolean;
    shapeStrokeColor: string;
    shapeStrokeWidth: number;
    shapeStrokeTransparent: boolean;
    shapeCornerRadius: number;
    zoomSensitivity: number;
    panSensitivity: number;
    onselectboard?: (id: string) => void;
    oncreateboard?: (name: string) => void;
    onrenameboard?: (id: string, name: string) => void;
    ondeleteboard?: (id: string) => void;
    onpropchange?: (id: string, patch: Partial<BoardObject>) => void;
    onaddimagefiles?: (files: File[]) => void;
    onsettool?: (tool: BoardTool) => void;
    ondrawcolor?: (color: string) => void;
    ondrawwidth?: (width: number) => void;
    onshapekind?: (kind: ShapeKind) => void;
    onshapefillcolor?: (color: string) => void;
    onshapefilltransparent?: (v: boolean) => void;
    onshapestrokecolor?: (color: string) => void;
    onshapestrokewidth?: (w: number) => void;
    onshapestroketransparent?: (v: boolean) => void;
    onshapecornerradius?: (r: number) => void;
    onexportpng?: () => void;
    onzoomsens?: (v: number) => void;
    onpansens?: (v: number) => void;
    onshowshortcuts?: () => void;
  }

  let {
    boardList, activeBoardId, selected, tool, drawColor, drawStrokeWidth,
    shapeKind, shapeFillColor, shapeFillTransparent, shapeStrokeColor, shapeStrokeWidth, shapeStrokeTransparent,
    shapeCornerRadius,
    zoomSensitivity, panSensitivity,
    onselectboard, oncreateboard, onrenameboard, ondeleteboard, onpropchange,
    onaddimagefiles, onsettool, ondrawcolor, ondrawwidth,
    onshapekind, onshapefillcolor, onshapefilltransparent, onshapestrokecolor, onshapestrokewidth, onshapestroketransparent,
    onshapecornerradius,
    onexportpng, onzoomsens, onpansens, onshowshortcuts,
  }: Props = $props();

  let creating = $state(false);
  let newName = $state("");
  let renamingId = $state<string | null>(null);
  let renameVal = $state("");
  let deleteTarget = $state<{ id: string; name: string } | null>(null);

  function fmtDate(iso: string): string {
    try { return new Date(iso).toLocaleString("pl-PL"); } catch { return iso; }
  }

  function doCreate() {
    if (!newName.trim()) return;
    oncreateboard?.(newName.trim());
    newName = ""; creating = false;
  }

  function startRename(id: string, current: string) {
    renamingId = id; renameVal = current;
  }
  function commitRename() {
    if (renamingId && renameVal.trim()) onrenameboard?.(renamingId, renameVal.trim());
    renamingId = null;
  }

  const single = $derived(selected.length === 1 ? selected[0] : null);
  const allText = $derived(selected.length > 0 && selected.every((o) => o.type === "text"));
  const allImage = $derived(selected.length > 0 && selected.every((o) => o.type === "image"));
  const allDraw = $derived(selected.length > 0 && selected.every((o) => o.type === "draw"));
  const allShape = $derived(selected.length > 0 && selected.every((o) => o.type === "shape"));

  function selTitle(): string {
    if (selected.length === 0) return "";
    if (selected.length > 1) return `Zaznaczono: ${selected.length}`;
    switch (single?.type) {
      case "text": return "Tekst";
      case "draw": return "Rysunek";
      case "shape": return "Kształt";
      default: return "Obraz";
    }
  }

  function patchAll(patch: Partial<BoardObject>) {
    for (const o of selected) onpropchange?.(o.id, patch);
  }

  // Lista tablic jest posortowana od najświeższej — gdy aktywna tablica
  // przeskoczy na górę (np. po zapisie), przewiń widok tam, żeby było widać.
  let boardListEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (boardList[0]?.id === activeBoardId) boardListEl?.scrollTo({ top: 0 });
  });
</script>

<aside class="board-sidebar">
  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Dodaj</span>
    </div>
    <div class="tool-row">
      <button class="tool-btn" class:active={tool === "select"} title="Zaznaczanie (W)"
              onclick={() => onsettool?.("select")}>
        <span class="tool-icon">↖</span><span class="tool-label">Kursor</span>
      </button>
      <button class="tool-btn" class:active={tool === "text"} title="Kliknij na mapie, aby dodać tekst (T)"
              onclick={() => onsettool?.(tool === "text" ? "select" : "text")}>
        <span class="tool-icon">A</span><span class="tool-label">Tekst</span>
      </button>
      <label class="tool-btn" title="Dodaj obraz">
        <span class="tool-icon icon-swatch"></span><span class="tool-label">Obraz</span>
        <input type="file" accept="image/*" multiple hidden
               onchange={(e) => {
                 const files = [...((e.target as HTMLInputElement).files ?? [])];
                 if (files.length) onaddimagefiles?.(files);
                 (e.target as HTMLInputElement).value = "";
               }} />
      </label>
      <button class="tool-btn" class:active={tool === "shape"} title="Kształt"
              onclick={() => onsettool?.(tool === "shape" ? "select" : "shape")}>
        <span class="tool-icon icon-swatch icon-shape"></span><span class="tool-label">Kształt</span>
      </button>
      <button class="tool-btn" class:active={tool === "draw"} title="Pędzel (P)"
              onclick={() => onsettool?.(tool === "draw" ? "select" : "draw")}>
        <span class="tool-icon">✎</span><span class="tool-label">Pędzel</span>
      </button>
    </div>

    {#if tool === "draw"}
      <div class="tool-settings">
        <input class="field-color" type="color" value={drawColor}
               oninput={(e) => ondrawcolor?.((e.target as HTMLInputElement).value)} />
        <input class="range-flex" type="range" min="1" max="24" step="1" value={drawStrokeWidth}
               oninput={(e) => ondrawwidth?.(Number((e.target as HTMLInputElement).value))} />
        <span class="draw-width-val">{drawStrokeWidth}px</span>
      </div>
    {/if}

    {#if tool === "shape"}
      <div class="tool-settings shape-settings">
        <div class="align-row">
          <button class="align-btn" class:active={shapeKind === "rect"}
                  onclick={() => onshapekind?.("rect")}>Prostokąt</button>
          <button class="align-btn" class:active={shapeKind === "ellipse"}
                  onclick={() => onshapekind?.("ellipse")}>Elipsa</button>
        </div>
        <div class="hint-line">Shift podczas rysowania = kwadrat / koło</div>
        <div class="fill-row">
          <input class="field-color" type="color" value={shapeFillColor}
                 disabled={shapeFillTransparent}
                 oninput={(e) => onshapefillcolor?.((e.target as HTMLInputElement).value)} />
          <label class="checkbox-row compact">
            <input type="checkbox" class="cb-input" checked={shapeFillTransparent}
                   onchange={(e) => onshapefilltransparent?.((e.target as HTMLInputElement).checked)} />
            <span class="cb-label">Bez wypełnienia</span>
          </label>
        </div>
        <div class="fill-row">
          <input class="field-color" type="color" value={shapeStrokeColor}
                 disabled={shapeStrokeTransparent}
                 oninput={(e) => onshapestrokecolor?.((e.target as HTMLInputElement).value)} />
          <label class="checkbox-row compact">
            <input type="checkbox" class="cb-input" checked={shapeStrokeTransparent}
                   onchange={(e) => onshapestroketransparent?.((e.target as HTMLInputElement).checked)} />
            <span class="cb-label">Bez obramowania</span>
          </label>
        </div>
        {#if !shapeStrokeTransparent}
          <input type="range" min="1" max="20" step="1" value={shapeStrokeWidth}
                 oninput={(e) => onshapestrokewidth?.(Number((e.target as HTMLInputElement).value))} />
        {/if}
        {#if shapeKind === "rect"}
          <div class="field-group no-margin">
            <label class="field-label" for="shape-radius">Zaokrąglenie rogów</label>
            <input id="shape-radius" type="range" min="0" max="60" step="1" value={shapeCornerRadius}
                   oninput={(e) => onshapecornerradius?.(Number((e.target as HTMLInputElement).value))} />
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if selected.length > 0}
    <div class="divider"></div>

    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">{selTitle()}</span>
      </div>

      {#if allText}
        {@const t = single as BoardTextObject | null}
        <div class="field-group">
          <label class="field-label" for="txt-color">Kolor</label>
          <input id="txt-color" class="field-color" type="color"
                 value={t?.color ?? "#f0f0f0"}
                 oninput={(e) => patchAll({ color: (e.target as HTMLInputElement).value })} />
        </div>
        <div class="field-group">
          <label class="field-label" for="txt-size">Rozmiar czcionki</label>
          <input id="txt-size" class="field-input" type="number" min="6" max="200"
                 value={t?.fontSize ?? 20}
                 oninput={(e) => patchAll({ fontSize: Number((e.target as HTMLInputElement).value) })} />
        </div>
        <label class="checkbox-row">
          <input type="checkbox" class="cb-input" checked={t?.bold ?? false}
                 onchange={(e) => patchAll({ bold: (e.target as HTMLInputElement).checked })} />
          <span class="cb-label">Pogrubienie</span>
        </label>
        <div class="field-group align-group">
          <span class="field-label">Wyrównanie</span>
          <div class="align-row">
            <button class="align-btn" class:active={(t?.align ?? "left") === "left"}
                    onclick={() => patchAll({ align: "left" })}>Lewo</button>
            <button class="align-btn" class:active={(t?.align ?? "left") === "center"}
                    onclick={() => patchAll({ align: "center" })}>Środek</button>
            <button class="align-btn" class:active={(t?.align ?? "left") === "right"}
                    onclick={() => patchAll({ align: "right" })}>Prawo</button>
          </div>
        </div>
        <div class="field-group align-group">
          <label class="checkbox-row">
            <input type="checkbox" class="cb-input" checked={t?.borderEnabled ?? false}
                   onchange={(e) => patchAll({ borderEnabled: (e.target as HTMLInputElement).checked })} />
            <span class="cb-label">Obrys tekstu (outline)</span>
          </label>
          {#if t?.borderEnabled}
            <div class="fill-row">
              <input class="field-color" type="color" value={t?.borderColor ?? "#000000"}
                     oninput={(e) => patchAll({ borderColor: (e.target as HTMLInputElement).value })} />
              <input class="range-flex" type="range" min="0.5" max="6" step="0.5"
                     value={t?.borderWidth ?? 1.5}
                     oninput={(e) => patchAll({ borderWidth: Number((e.target as HTMLInputElement).value) })} />
            </div>
          {/if}
        </div>
      {/if}

      {#if allDraw}
        {@const d = single as BoardDrawObject | null}
        <div class="field-group">
          <label class="field-label" for="draw-color">Kolor</label>
          <input id="draw-color" class="field-color" type="color"
                 value={d?.color ?? "#ffc951"}
                 oninput={(e) => patchAll({ color: (e.target as HTMLInputElement).value })} />
        </div>
        <div class="field-group">
          <label class="field-label" for="draw-w">Grubość</label>
          <input id="draw-w" type="range" min="1" max="24" step="1"
                 value={d?.strokeWidth ?? 4}
                 oninput={(e) => patchAll({ strokeWidth: Number((e.target as HTMLInputElement).value) })} />
        </div>
      {/if}

      {#if allShape}
        {@const s = single as BoardShapeObject | null}
        <div class="field-group">
          <span class="field-label">Wypełnienie</span>
          <div class="fill-row">
            <input class="field-color" type="color" value={s?.fillColor ?? "#ffc951"}
                   disabled={s?.fillTransparent ?? false}
                   oninput={(e) => patchAll({ fillColor: (e.target as HTMLInputElement).value })} />
            <label class="checkbox-row compact">
              <input type="checkbox" class="cb-input" checked={s?.fillTransparent ?? false}
                     onchange={(e) => patchAll({ fillTransparent: (e.target as HTMLInputElement).checked })} />
              <span class="cb-label">Przezroczyste</span>
            </label>
          </div>
        </div>
        <div class="field-group">
          <span class="field-label">Obramowanie</span>
          <div class="fill-row">
            <input class="field-color" type="color" value={s?.strokeColor ?? "#ffc951"}
                   disabled={s?.strokeTransparent ?? false}
                   oninput={(e) => patchAll({ strokeColor: (e.target as HTMLInputElement).value })} />
            <label class="checkbox-row compact">
              <input type="checkbox" class="cb-input" checked={s?.strokeTransparent ?? false}
                     onchange={(e) => patchAll({ strokeTransparent: (e.target as HTMLInputElement).checked })} />
              <span class="cb-label">Przezroczyste</span>
            </label>
          </div>
          {#if !(s?.strokeTransparent ?? false)}
            <input type="range" min="1" max="20" step="1" value={s?.strokeWidth ?? 2}
                   oninput={(e) => patchAll({ strokeWidth: Number((e.target as HTMLInputElement).value) })} />
          {/if}
        </div>
        {#if s?.shape === "rect"}
          <div class="field-group">
            <label class="field-label" for="shape-sel-radius">Zaokrąglenie rogów</label>
            <input id="shape-sel-radius" type="range" min="0" max="60" step="1" value={s?.cornerRadius ?? 0}
                   oninput={(e) => patchAll({ cornerRadius: Number((e.target as HTMLInputElement).value) })} />
          </div>
        {/if}
      {/if}

      {#if allImage}
        <div class="field-group">
          <label class="field-label" for="img-opacity">Przezroczystość</label>
          <input id="img-opacity" type="range" min="0" max="1" step="0.02"
                 value={(single as BoardImageObject | null)?.opacity ?? 1}
                 oninput={(e) => patchAll({ opacity: Number((e.target as HTMLInputElement).value) })} />
        </div>
      {/if}

      {#if single}
        <div class="field-group">
          <label class="field-label" for="obj-rotation">Obrót [°]</label>
          <input id="obj-rotation" class="field-input" type="number" step="1"
                 value={Math.round(single.rotation)}
                 oninput={(e) => onpropchange?.(single.id, { rotation: Number((e.target as HTMLInputElement).value) })} />
        </div>
        {#if single.type !== "draw"}
          <div class="field-row">
            <div class="field-group half">
              <label class="field-label" for="obj-w">Szerokość</label>
              <input id="obj-w" class="field-input" type="number" min="4"
                     value={Math.round(single.width)}
                     oninput={(e) => onpropchange?.(single.id, { width: Number((e.target as HTMLInputElement).value) })} />
            </div>
            <div class="field-group half">
              <label class="field-label" for="obj-h">Wysokość</label>
              <input id="obj-h" class="field-input" type="number" min="4"
                     value={Math.round(single.height)}
                     oninput={(e) => onpropchange?.(single.id, { height: Number((e.target as HTMLInputElement).value) })} />
            </div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  <div class="divider"></div>

  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Eksport</span>
    </div>
    <button class="btn-export" onclick={() => onexportpng?.()}>⬇ Eksportuj jako PNG</button>
  </div>

  <div class="divider"></div>

  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Tablice</span>
      <button class="btn-primary-sm" onclick={() => (creating = !creating)}>+ Nowa</button>
    </div>

    {#if creating}
      <div class="create-row">
        <input class="field-input" type="text" placeholder="nazwa tablicy" bind:value={newName}
               onkeydown={(e) => e.key === "Enter" && doCreate()} />
        <button class="btn-primary-sm" onclick={doCreate} disabled={!newName.trim()}>Utwórz</button>
      </div>
    {/if}

    <div class="board-list" bind:this={boardListEl}>
      {#each boardList as b}
        {@const isActive = b.id === activeBoardId}
        <div class="board-row" class:active={isActive}>
          <span class="board-dot" class:on={isActive}></span>
          {#if renamingId === b.id}
            <input class="field-input rename-input" type="text" bind:value={renameVal}
                   onkeydown={(e) => e.key === "Enter" && commitRename()}
                   onblur={commitRename} />
          {:else}
            <button class="board-name" onclick={() => onselectboard?.(b.id)} disabled={isActive}>
              {b.name}
            </button>
          {/if}
          <div class="board-actions">
            <button class="icon-btn" title="Zmień nazwę" onclick={() => startRename(b.id, b.name)}>✎</button>
            <button class="icon-btn del" title="Usuń" onclick={() => (deleteTarget = { id: b.id, name: b.name })} disabled={boardList.length <= 1}>×</button>
          </div>
        </div>
        <div class="board-meta">zmieniona {fmtDate(b.updatedAt)}</div>
      {/each}
    </div>
  </div>

  <div class="divider"></div>

  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Ustawienia</span>
    </div>
    <div class="field-group">
      <label class="field-label" for="zoom-sens">Czułość zoomu</label>
      <input id="zoom-sens" type="range" min="0.3" max="3" step="0.1" value={zoomSensitivity}
             oninput={(e) => onzoomsens?.(Number((e.target as HTMLInputElement).value))} />
    </div>
    <div class="field-group">
      <label class="field-label" for="pan-sens">Czułość przesuwania</label>
      <input id="pan-sens" type="range" min="0.3" max="3" step="0.1" value={panSensitivity}
             oninput={(e) => onpansens?.(Number((e.target as HTMLInputElement).value))} />
    </div>
    <button class="btn-export" onclick={() => onshowshortcuts?.()}>⌘ Wyświetl skróty</button>
  </div>
</aside>

<ConfirmModal
  open={deleteTarget !== null}
  title="Usunąć tablicę?"
  message={deleteTarget ? `Usunąć tablicę "${deleteTarget.name}"? Tej operacji nie można cofnąć.` : ""}
  confirmLabel="Usuń"
  danger={true}
  onconfirm={() => { if (deleteTarget) ondeleteboard?.(deleteTarget.id); deleteTarget = null; }}
  oncancel={() => (deleteTarget = null)}
/>

<style>
  .board-sidebar {
    width: 100%; height: 100%; background: #2a2a2a;
    border-left: 1px solid rgba(255,255,255,0.06);
    border-radius: 14px 0 0 14px;
    display: flex; flex-direction: column; gap: 12px;
    padding: 16px 14px; box-sizing: border-box; overflow-y: auto;
  }

  .panel {
    background: #222; border: 1px solid rgba(255,255,255,0.07);
    border-radius: 12px; padding: 12px 13px;
  }
  .panel-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .panel-title {
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: rgba(255,255,255,0.5); flex: 1;
  }

  .divider {
    height: 1px;
    flex-shrink: 0;
    background: linear-gradient(90deg, transparent, rgba(255,201,81,0.35), transparent);
    margin: 2px 4px;
  }

  .panel { flex-shrink: 0; }

  /* ── Toolbar "Dodaj" ──────────────────────────────────────────────── */
  .tool-row { display: flex; gap: 5px; }
  .tool-btn {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
    padding: 8px 2px; background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.09); border-radius: 9px;
    color: rgba(255,255,255,0.6); cursor: pointer; font-family: inherit;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .tool-btn:hover { border-color: rgba(255,201,81,0.4); color: #ffc951; }
  .tool-btn.active {
    background: rgba(255,201,81,0.14); border-color: #ffc951; color: #ffc951;
    box-shadow: 0 0 0 1px rgba(255,201,81,0.25);
  }
  .tool-icon { font-size: 0.92rem; line-height: 1; height: 13px; display: flex; align-items: center; justify-content: center; }
  .tool-label { font-size: 0.55rem; font-weight: 600; letter-spacing: 0.01em; }

  /* Zaokrąglony "swatch" zamiast ostrego glifu tekstowego dla Obrazu/Kształtu */
  .icon-swatch {
    width: 13px; height: 13px; border-radius: 4px;
    border: 1.5px solid currentColor; box-sizing: border-box;
  }
  .icon-shape { border-radius: 50%; }

  .tool-settings {
    display: flex; align-items: center; gap: 8px; margin-top: 10px;
    padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06);
  }
  .shape-settings { flex-direction: column; align-items: stretch; gap: 8px; }
  .hint-line { font-size: 0.6rem; color: rgba(255,255,255,0.28); text-align: center; }
  .fill-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .range-flex { flex: 1; }
  .draw-width-val { font-size: 0.66rem; color: rgba(255,255,255,0.4); width: 32px; text-align: right; }

  .btn-export {
    width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 9px; background: rgba(255,201,81,0.1);
    border: 1px solid rgba(255,201,81,0.3); border-radius: 8px;
    color: #ffc951; font-size: 0.73rem; font-weight: 700;
    cursor: pointer; font-family: inherit; transition: background 0.15s;
  }
  .btn-export:hover { background: rgba(255,201,81,0.2); }

  .btn-primary-sm {
    padding: 5px 11px; background: rgba(255,201,81,0.15);
    border: 1px solid rgba(255,201,81,0.3); border-radius: 7px;
    color: #ffc951; font-size: 0.68rem; font-weight: 600; cursor: pointer; font-family: inherit;
  }
  .btn-primary-sm:hover:not(:disabled) { background: rgba(255,201,81,0.25); }
  .btn-primary-sm:disabled { opacity: 0.4; cursor: not-allowed; }

  .create-row { display: flex; gap: 6px; margin-bottom: 10px; }
  .field-input, .field-color {
    flex: 1; background: #1a1a1a; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px; color: #f0f0f0; font-size: 0.75rem; padding: 6px 9px;
    outline: none; font-family: inherit; width: 100%; box-sizing: border-box;
  }
  .field-color { padding: 2px; height: 30px; cursor: pointer; flex: none; width: 40px; }
  .field-color:disabled { opacity: 0.3; cursor: not-allowed; }
  .field-input:focus { border-color: #ffc951; }

  .board-list {
    display: flex; flex-direction: column; gap: 2px;
    max-height: calc(3 * (48px)); overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: rgba(255,201,81,0.25) transparent;
  }
  .board-row {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 9px; background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07); border-radius: 8px;
  }
  .board-row.active { border-color: rgba(255,201,81,0.3); background: rgba(255,201,81,0.05); }
  .board-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.15); flex-shrink: 0; }
  .board-dot.on { background: #ffc951; box-shadow: 0 0 6px rgba(255,201,81,0.6); }
  .board-name {
    flex: 1; background: none; border: none; color: #e0e0e0; font-size: 0.76rem;
    font-weight: 600; font-family: inherit; cursor: pointer; text-align: left; padding: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .board-name:disabled { cursor: default; color: #ffc951; }
  .rename-input { max-width: 160px; }
  .board-meta { font-size: 0.58rem; color: rgba(255,255,255,0.2); margin: 0 0 6px 14px; }

  .board-actions { display: flex; gap: 2px; flex-shrink: 0; }
  .icon-btn {
    background: none; border: none; color: rgba(255,255,255,0.3);
    cursor: pointer; font-size: 0.78rem; padding: 3px 6px; border-radius: 5px; font-family: inherit;
  }
  .icon-btn:hover:not(:disabled) { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.8); }
  .icon-btn.del:hover:not(:disabled) { color: #ff6b6b; }
  .icon-btn:disabled { opacity: 0.2; cursor: not-allowed; }

  .field-group { margin-bottom: 12px; }
  .field-group.half { flex: 1; margin-bottom: 0; }
  .field-row { display: flex; gap: 8px; margin-bottom: 12px; }
  .field-label {
    display: block; font-size: 0.62rem; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: rgba(255,255,255,0.35); margin-bottom: 5px;
  }

  .align-group { margin-top: 8px; }
  .field-group.no-margin { margin-bottom: 0; }
  .align-row { display: flex; gap: 6px; }
  .align-btn {
    flex: 1; padding: 7px 4px; background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.09); border-radius: 7px;
    color: rgba(255,255,255,0.55); font-size: 0.68rem; cursor: pointer;
    font-family: inherit; transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .align-btn:hover { border-color: rgba(255,201,81,0.4); color: #ffc951; }
  .align-btn.active {
    background: rgba(255,201,81,0.14); border-color: #ffc951; color: #ffc951;
  }

  .checkbox-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; cursor: pointer; user-select: none; }
  .checkbox-row.compact { padding: 0; flex: 1; }
  .cb-input {
    appearance: none; width: 15px; height: 15px; flex-shrink: 0;
    border: 1.5px solid rgba(255,255,255,0.2); border-radius: 4px;
    background: #1a1a1a; cursor: pointer; position: relative;
  }
  .cb-input:checked { background: #ffc951; border-color: #ffc951; }
  .cb-input:checked::after {
    content: ""; position: absolute; left: 50%; top: 50%;
    width: 4px; height: 7px; border-right: 1.5px solid #1a1a1a; border-bottom: 1.5px solid #1a1a1a;
    transform: translate(-50%, -62%) rotate(45deg);
  }
  .cb-label { font-size: 0.72rem; color: rgba(255,255,255,0.55); }

  /* ── Suwaki — ten sam cienki track + okrągły uchwyt co w zakładce m/z
     (DualRange.svelte), zamiast grubego natywnego "bara" (accent-color
     bywa rysowany przez przeglądarkę jako gruby wypełniony pasek). ── */
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 16px;
    background: transparent;
    outline: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
  }
  input[type="range"]::-webkit-slider-runnable-track {
    background: rgba(255,255,255,0.1);
    border-radius: 3px;
    height: 6px;
  }
  input[type="range"]::-moz-range-track {
    background: rgba(255,255,255,0.1);
    border-radius: 3px;
    height: 6px;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px; height: 16px;
    border-radius: 50%;
    background: #ffc951;
    border: 2px solid #1a1a1a;
    box-shadow: 0 1px 6px rgba(0,0,0,0.5);
    cursor: pointer;
    margin-top: -5px;
    transition: transform 0.1s, box-shadow 0.1s;
  }
  input[type="range"]::-webkit-slider-thumb:hover {
    transform: scale(1.15);
    box-shadow: 0 0 0 4px rgba(255,201,81,0.2);
  }
  input[type="range"]::-moz-range-thumb {
    width: 16px; height: 16px;
    border-radius: 50%;
    background: #ffc951;
    border: 2px solid #1a1a1a;
    cursor: pointer;
  }
  input[type="range"]:disabled { opacity: 0.35; cursor: not-allowed; }

  input[type="color"] { accent-color: #ffc951; }
</style>
