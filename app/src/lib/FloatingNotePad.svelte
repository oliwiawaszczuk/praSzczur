<script lang="ts">
  // Mały pływający notatnik, montowany RAZ, globalnie, w +page.svelte (poza
  // zakładkami) — patrz komentarz w +page.svelte przy jego użyciu. Widoczny
  // tylko gdy jakaś notatka jest przypięta (copyBridge.svelte.ts:pinnedNoteId).
  // Trzy stany (copyBridge.svelte.ts:widgetState):
  //  - "min"    — mała ikona w rogu, klik otwiera stan "medium".
  //  - "medium" — widoczne okienko, przeciągalne za nagłówek, bez fokusu;
  //               najechanie myszką przechodzi w stan "focus".
  //  - "focus"  — powiększone, edytowalne; klik poza oknem wraca do "medium".
  // Pozycja (przeciąganie w stanie medium/focus) to globalny UI-chrome, nie
  // dane notatki ani nic per-workspace → appSettings (getSetting/setSetting),
  // zgodnie z zasadą w CLAUDE.md.
  import { onMount, onDestroy, tick } from "svelte";
  import { fly } from "svelte/transition";
  import { getSetting, setSetting } from "$lib/appSettings.svelte";
  import { pinnedNoteId, setPinnedNote, widgetState, setWidgetState, registerAppendTarget } from "$lib/copyBridge.svelte";
  import { notes, getNote, scheduleSaveNote, flushSaveNote } from "$lib/notes.svelte";

  const MEDIUM_W = 260, MEDIUM_H = 150;
  const FOCUS_W = 380, FOCUS_H = 440;
  const MARGIN = 16;

  let posTop = $state(getSetting<number>("notatki_widgetTop", 56));
  let posLeft = $state<number | null>(getSetting<number | null>("notatki_widgetLeft", null));
  let dragging = $state(false);
  let dragStart = { x: 0, y: 0, top: 0, left: 0 };
  let rootEl = $state<HTMLDivElement | null>(null);

  let text = $state("");
  let loadedFor = $state<string | null>(null);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  // Ostatnia znana pozycja kursora w TEJ notatce — tam, gdzie Cmd/Ctrl+click
  // na wykresie dopisze skopiowaną wartość (nie zawsze na końcu). Domyślnie
  // koniec tekstu (świeżo wczytana notatka / nigdy nie kliknięta w środku).
  let cursorPos = $state(0);

  const noteTitle = $derived.by(() => notes().find((n) => n.id === pinnedNoteId())?.title ?? "");
  const boxW = $derived(widgetState() === "focus" ? FOCUS_W : MEDIUM_W);
  const boxH = $derived(widgetState() === "focus" ? FOCUS_H : MEDIUM_H);

  // Przeładuj treść notatki za każdym razem, gdy zmieni się przypięta notatka
  // (nie przy każdym jej zapisie — stąd `loadedFor`, pilnujące, by nie
  // nadpisać tego, co użytkowniczka właśnie pisze, kolejnym fetchem) — tak,
  // żeby notatnik ZAWSZE pokazywał rzeczywistą, aktualną treść i tytuł
  // przypiętej notatki, nie jakiś przybliżony/przeterminowany podgląd.
  $effect(() => {
    const id = pinnedNoteId();
    if (!id) { loadedFor = null; text = ""; cursorPos = 0; return; }
    if (loadedFor === id) return;
    loadedFor = id;
    getNote(id).then((d) => { text = d.text; cursorPos = d.text.length; });
  });

  function syncCursorPos() {
    if (textareaEl) cursorPos = textareaEl.selectionStart ?? text.length;
  }

  /** Dopisuje skopiowaną wartość DOKŁADNIE w miejscu ostatniego kursora w
   * tekście (nie zawsze na końcu) — i przesuwa stan "focus", żeby wynik był
   * od razu widoczny (bez kradzieży fokusu klawiatury spod wykresu, na który
   * użytkowniczka właśnie kliknęła — stąd setSelectionRange bez .focus()). */
  function appendCopiedText(copied: string) {
    const pos = Math.min(cursorPos, text.length);
    text = text.slice(0, pos) + copied + text.slice(pos);
    const newPos = pos + copied.length;
    cursorPos = newPos;
    onTextInput();
    if (widgetState() === "medium") setWidgetState("focus");
    tick().then(() => {
      textareaEl?.setSelectionRange(newPos, newPos);
    });
  }

  onMount(() => { registerAppendTarget(appendCopiedText); });
  onDestroy(() => { registerAppendTarget(null); });

  function effectiveLeft(): number {
    if (posLeft !== null) return posLeft;
    if (typeof window === "undefined") return 0;
    return window.innerWidth - MEDIUM_W - MARGIN;
  }

  function clampTop(v: number): number {
    if (typeof window === "undefined") return Math.max(4, v);
    return Math.min(Math.max(4, v), window.innerHeight - 40);
  }
  function clampLeft(v: number): number {
    if (typeof window === "undefined") return Math.max(4, v);
    return Math.min(Math.max(4, v), window.innerWidth - 60);
  }

  function onHeaderPointerDown(e: PointerEvent) {
    e.preventDefault();
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, top: posTop, left: effectiveLeft() };
    window.addEventListener("pointermove", onHeaderPointerMove);
    window.addEventListener("pointerup", onHeaderPointerUp);
  }
  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    posTop = clampTop(dragStart.top + (e.clientY - dragStart.y));
    posLeft = clampLeft(dragStart.left + (e.clientX - dragStart.x));
  }
  function onHeaderPointerUp() {
    dragging = false;
    window.removeEventListener("pointermove", onHeaderPointerMove);
    window.removeEventListener("pointerup", onHeaderPointerUp);
    setSetting("notatki_widgetTop", posTop);
    setSetting("notatki_widgetLeft", posLeft);
  }

  function onBoxMouseEnter() {
    if (dragging) return;
    if (widgetState() === "medium") setWidgetState("focus");
  }

  function onWindowClick(e: MouseEvent) {
    if (widgetState() !== "focus") return;
    if (rootEl && !rootEl.contains(e.target as Node)) setWidgetState("medium");
  }

  function minimize() {
    flushSaveNote();
    setWidgetState("min");
  }
  function openMedium() {
    setWidgetState("medium");
  }
  function unpin() {
    flushSaveNote();
    setPinnedNote(null);
  }

  function onTextInput() {
    const id = pinnedNoteId();
    if (!id) return;
    scheduleSaveNote(id, { text });
  }
</script>

<svelte:window onclick={onWindowClick} />

{#if pinnedNoteId()}
  {#if widgetState() === "min"}
    <div class="note-pad-mini-wrap" transition:fly={{ y: -16, duration: 180 }}>
      <button
        class="note-pad-mini"
        onclick={openMedium}
        title={noteTitle || "Przypięta notatka"}
      >📌</button>
      <button class="note-pad-mini-unpin" onclick={unpin} title="Odepnij">×</button>
    </div>
  {:else}
    <div
      bind:this={rootEl}
      class="note-pad"
      class:focus={widgetState() === "focus"}
      style="top:{posTop}px; left:{effectiveLeft()}px; width:{boxW}px; height:{boxH}px;"
      transition:fly={{ y: -16, duration: 180 }}
      onmouseenter={onBoxMouseEnter}
      role="dialog"
      aria-label="Przypięta notatka"
      tabindex="-1"
    >
      <div class="note-pad-header" onpointerdown={onHeaderPointerDown}>
        <span class="note-pad-title">{noteTitle || "Notatka"}</span>
        <div class="note-pad-actions">
          <button class="note-pad-btn" onpointerdown={(e) => e.stopPropagation()} onclick={minimize} title="Minimalizuj">—</button>
          <button class="note-pad-btn" onpointerdown={(e) => e.stopPropagation()} onclick={unpin} title="Odepnij">×</button>
        </div>
      </div>
      <textarea
        bind:this={textareaEl}
        class="note-pad-text"
        bind:value={text}
        oninput={() => { onTextInput(); syncCursorPos(); }}
        onclick={syncCursorPos}
        onkeyup={syncCursorPos}
        onselect={syncCursorPos}
        readonly={widgetState() !== "focus"}
        placeholder="Cmd/Ctrl+click na wykresie dopisze tu wartość…"
      ></textarea>
    </div>
  {/if}
{/if}

<style>
  .note-pad-mini-wrap {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 900;
  }
  .note-pad-mini-wrap:hover .note-pad-mini-unpin { opacity: 1; transform: scale(1); }

  .note-pad-mini {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: #262626;
    border: 1px solid rgba(255,201,81,0.4);
    color: #ffc951;
    font-size: 1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 6px 18px rgba(0,0,0,0.4);
  }

  .note-pad-mini-unpin {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #3a3a3a;
    border: 1px solid rgba(255,255,255,0.2);
    color: rgba(255,255,255,0.7);
    font-size: 0.6rem;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transform: scale(0.7);
    transition: opacity 0.12s, transform 0.12s, color 0.12s, background 0.12s;
  }
  .note-pad-mini-unpin:hover { background: rgba(255,107,107,0.25); border-color: rgba(255,107,107,0.4); color: #ff8080; }

  .note-pad {
    position: fixed;
    z-index: 900;
    display: flex;
    flex-direction: column;
    background: #202020;
    border: 1px solid rgba(255,201,81,0.3);
    border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.45);
    overflow: hidden;
    transition: width 0.16s ease, height 0.16s ease;
  }
  .note-pad.focus { border-color: rgba(255,201,81,0.55); }

  .note-pad-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 6px 8px;
    background: rgba(255,255,255,0.04);
    border-bottom: 1px solid rgba(255,255,255,0.06);
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .note-pad-title {
    font-size: 0.68rem;
    font-weight: 600;
    color: #ddd;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .note-pad-actions { display: flex; gap: 2px; flex-shrink: 0; }

  .note-pad-btn {
    background: none;
    border: none;
    color: rgba(255,255,255,0.4);
    font-size: 0.78rem;
    width: 18px;
    height: 18px;
    line-height: 1;
    cursor: pointer;
    border-radius: 4px;
    font-family: inherit;
    transition: color 0.15s, background 0.15s;
  }
  .note-pad-btn:hover { color: #f0f0f0; background: rgba(255,255,255,0.08); }

  .note-pad-text {
    flex: 1;
    min-height: 0;
    resize: none;
    background: transparent;
    border: none;
    outline: none;
    padding: 8px 10px;
    color: #eee;
    font-size: 0.72rem;
    line-height: 1.5;
    font-family: "JetBrains Mono", monospace;
  }
</style>
