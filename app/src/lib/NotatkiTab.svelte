<script lang="ts">
  // Zakładka "Notatki" — swobodne notatki tekstowe, globalne (nie
  // per-workspace, ten sam duch co Tablica — patrz notes.svelte.ts).
  // Lista + wyszukiwarka z nawigacją strzałkami po lewej/górze, szczegółowy
  // widok notatki (pełny edytor) po kliknięciu wiersza. Przypięcie (📌)
  // otwiera małą pływającą notatkę w prawym górnym rogu całej appki —
  // patrz FloatingNotePad.svelte (montowany globalnie w +page.svelte) i
  // copyBridge.svelte.ts (most do Cmd+click na wykresach).
  import { onMount, tick } from "svelte";
  import {
    notes, notesLoaded, loadNotes, createNote, deleteNote,
    getNote, scheduleSaveNote, flushSaveNote, type NoteMeta,
  } from "$lib/notes.svelte";
  import { pinnedNoteId, setPinnedNote, setWidgetState } from "$lib/copyBridge.svelte";
  import ConfirmModal from "$lib/ConfirmModal.svelte";

  let ready = $state(false);
  let search = $state("");
  let activeIndex = $state(-1);
  let selectedNoteId = $state<string | null>(null);
  let detailText = $state("");
  let detailLoading = $state(false);
  let deleteTarget = $state<NoteMeta | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const all = [...notes()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    if (!q) return all;
    return all.filter((n) => n.title.toLowerCase().includes(q));
  });

  // Indeks aktywny (nawigacja strzałkami) musi zostać wyzerowany/przycięty,
  // gdy wyniki wyszukiwania się zmieniają — inaczej po przefiltrowaniu mógłby
  // wskazywać na nieistniejący/inny wiersz niż ten faktycznie podświetlony.
  $effect(() => {
    filtered.length;
    if (activeIndex >= filtered.length) activeIndex = filtered.length - 1;
  });

  onMount(async () => {
    if (!notesLoaded()) await loadNotes();
    ready = true;
  });

  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      activeIndex = Math.min(filtered.length - 1, activeIndex + 1);
      scrollActiveIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      activeIndex = Math.max(0, activeIndex - 1);
      scrollActiveIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const n = filtered[activeIndex];
      if (n) openNote(n.id);
    } else if (e.key === "Escape") {
      search = "";
      activeIndex = -1;
    }
  }

  async function scrollActiveIntoView() {
    await tick();
    listEl?.querySelector(".note-row.active")?.scrollIntoView({ block: "nearest" });
  }

  async function openNote(id: string) {
    flushSaveNote();
    selectedNoteId = id;
    detailLoading = true;
    const data = await getNote(id);
    detailText = data.text;
    detailLoading = false;
  }

  function closeDetail() {
    flushSaveNote();
    selectedNoteId = null;
  }

  function onDetailInput() {
    if (!selectedNoteId) return;
    scheduleSaveNote(selectedNoteId, { text: detailText });
  }

  async function handleCreate() {
    const n = await createNote();
    await openNote(n.id);
  }

  function requestDelete(n: NoteMeta, e: MouseEvent) {
    e.stopPropagation();
    deleteTarget = n;
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    deleteTarget = null;
    if (pinnedNoteId() === id) setPinnedNote(null);
    if (selectedNoteId === id) selectedNoteId = null;
    await deleteNote(id);
  }

  function togglePinId(id: string) {
    if (pinnedNoteId() === id) {
      setPinnedNote(null);
    } else {
      setPinnedNote(id);
      setWidgetState("medium");
    }
  }

  function togglePinRow(n: NoteMeta, e: MouseEvent) {
    e.stopPropagation();
    togglePinId(n.id);
  }

  function fmtDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" });
    } catch {
      return "";
    }
  }
</script>

{#if ready}
  <div class="notatki-layout">
    {#if selectedNoteId === null}
      <div class="notatki-toolbar">
        <input
          class="notatki-search"
          type="text"
          placeholder="Szukaj notatek…"
          bind:value={search}
          onkeydown={onSearchKeydown}
        />
        <button class="notatki-new-btn" onclick={handleCreate}>+ Nowa notatka</button>
      </div>
      <div class="notatki-list" bind:this={listEl}>
        {#if filtered.length === 0}
          <div class="notatki-empty">
            {notes().length === 0 ? "Brak notatek — utwórz pierwszą." : "Brak wyników."}
          </div>
        {:else}
          {#each filtered as n, i (n.id)}
            <div
              class="note-row"
              class:active={i === activeIndex}
              onclick={() => openNote(n.id)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openNote(n.id); } }}
              onmouseenter={() => { activeIndex = i; }}
              role="button"
              tabindex="0"
            >
              <div class="note-row-head">
                <span class="note-row-title">{n.title || "(bez tytułu)"}</span>
                <span class="note-row-date">{fmtDate(n.createdAt)}</span>
              </div>
              {#if n.preview}
                <div class="note-row-preview">{n.preview}</div>
              {/if}
              <div class="note-row-actions">
                <button
                  class="note-pin-btn"
                  class:active={pinnedNoteId() === n.id}
                  onclick={(e) => togglePinRow(n, e)}
                  title={pinnedNoteId() === n.id ? "Odepnij" : "Przypnij"}
                >📌</button>
                <button class="note-delete-btn" onclick={(e) => requestDelete(n, e)} title="Usuń">×</button>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="note-detail">
        <div class="note-detail-head">
          <button class="note-back-btn" onclick={closeDetail}>← Wróć</button>
          <button
            class="note-pin-btn-detail"
            class:active={pinnedNoteId() === selectedNoteId}
            onclick={() => selectedNoteId && togglePinId(selectedNoteId)}
          >
            {pinnedNoteId() === selectedNoteId ? "📌 Przypięta" : "📌 Przypnij"}
          </button>
        </div>
        {#if detailLoading}
          <div class="notatki-empty">Wczytuję…</div>
        {:else}
          <textarea
            class="note-detail-text"
            bind:value={detailText}
            oninput={onDetailInput}
            placeholder="Zacznij pisać…"
          ></textarea>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<ConfirmModal
  open={deleteTarget !== null}
  title="Usunąć notatkę?"
  message={deleteTarget ? `Usunąć notatkę "${deleteTarget.title}"? Tej operacji nie można cofnąć.` : ""}
  confirmLabel="Usuń"
  danger={true}
  onconfirm={confirmDelete}
  oncancel={() => { deleteTarget = null; }}
/>

<style>
  .notatki-layout {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 16px;
    box-sizing: border-box;
  }

  .notatki-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 80%;
    margin: 0 auto 12px;
  }

  .notatki-search {
    flex: 1;
    background: #1c1c1c;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    padding: 8px 12px;
    color: #eee;
    font-size: 0.78rem;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
  }
  .notatki-search:focus { border-color: #ffc951; }

  .notatki-new-btn {
    flex-shrink: 0;
    padding: 8px 14px;
    background: rgba(255,201,81,0.15);
    border: 1px solid rgba(255,201,81,0.35);
    border-radius: 8px;
    color: #ffc951;
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s;
    white-space: nowrap;
  }
  .notatki-new-btn:hover { background: rgba(255,201,81,0.26); }

  .notatki-list {
    width: 80%;
    margin: 0 auto;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .notatki-empty {
    text-align: center;
    color: rgba(255,255,255,0.3);
    font-size: 0.78rem;
    padding: 40px 0;
  }

  .note-row {
    position: relative;
    background: #212121;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
    padding: 10px 70px 10px 14px;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
  }
  .note-row:hover, .note-row.active {
    border-color: rgba(255,201,81,0.4);
    background: #262626;
  }

  .note-row-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }

  .note-row-title {
    font-size: 0.82rem;
    font-weight: 600;
    color: #f0f0f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .note-row-date {
    flex-shrink: 0;
    font-size: 0.62rem;
    color: rgba(255,255,255,0.35);
  }

  .note-row-preview {
    margin-top: 4px;
    font-size: 0.7rem;
    line-height: 1.4;
    color: rgba(255,255,255,0.5);
    max-height: calc(0.7rem * 1.4 * 3);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }

  .note-row-actions {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 2px;
  }

  .note-pin-btn, .note-pin-btn-detail, .note-delete-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    line-height: 1;
  }
  .note-pin-btn {
    font-size: 0.78rem;
    opacity: 0.35;
    padding: 3px;
    border-radius: 5px;
    transition: opacity 0.15s, background 0.15s;
  }
  .note-pin-btn:hover { opacity: 0.8; }
  .note-pin-btn.active { opacity: 1; background: rgba(255,201,81,0.15); }

  .note-delete-btn {
    color: rgba(255,255,255,0.3);
    font-size: 0.95rem;
    padding: 2px 5px;
    transition: color 0.15s;
  }
  .note-delete-btn:hover { color: #ff6b6b; }

  .note-detail {
    width: 80%;
    margin: 0 auto;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .note-detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .note-back-btn {
    background: none;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px;
    color: rgba(255,255,255,0.6);
    font-size: 0.72rem;
    padding: 6px 12px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, color 0.15s;
  }
  .note-back-btn:hover { border-color: rgba(255,255,255,0.3); color: #f0f0f0; }

  .note-pin-btn-detail {
    font-size: 0.72rem;
    padding: 6px 12px;
    border-radius: 7px;
    border: 1px solid rgba(255,255,255,0.1);
    color: rgba(255,255,255,0.5);
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .note-pin-btn-detail:hover { border-color: rgba(255,201,81,0.4); color: #ffc951; }
  .note-pin-btn-detail.active {
    border-color: rgba(255,201,81,0.4);
    color: #ffc951;
    background: rgba(255,201,81,0.1);
  }

  .note-detail-text {
    flex: 1;
    min-height: 0;
    resize: none;
    background: #1c1c1c;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
    padding: 14px;
    color: #eee;
    font-size: 0.8rem;
    line-height: 1.6;
    font-family: "JetBrains Mono", monospace;
    outline: none;
  }
  .note-detail-text:focus { border-color: rgba(255,201,81,0.3); }
</style>
