<script lang="ts">
  // Zakładka "Dokumentacja" — poradnik + opis DZIAŁANIA appki (nie kodu).
  // Treść każdej sekcji to MARKDOWN — edytor to zwykła textarea (źródło MD),
  // widok to wyrenderowany HTML (marked). Lewy panel: spis w trzech
  // zwijanych sekcjach (Poradniki / Zakładki aplikacji / Node Graph — typy
  // node'ów), każda z własnym wewnętrznym scrollem (max ~5 pozycji widoczne
  // naraz, reszta pod scrollem). Prawy panel: pełna treść wybranej sekcji,
  // na całą szerokość.
  //
  // Tryb edycji jest GLOBALNY (jeden przełącznik w górnym pasku), nie
  // per-sekcja — gdy włączony, treść KAŻDEJ wybranej sekcji od razu jest
  // polem edycji (autozapis, ten sam duch co Notatki/Tablica), i w lewym
  // panelu pojawiają się kontrolki strukturalne: "+" (nowa strona), uchwyt
  // przeciągania do zmiany kolejności własnych stron, usuwanie strony.
  //
  // Synchronizacja z ikonką "(i)" na node'ach Node Grapha: opisy node'ów NIE
  // są tu duplikowane — czytane/zapisywane przez appdocs.svelte.ts (getNodeDoc/
  // setNodeDoc), DOKŁADNIE to samo źródło, z którego NodeGraphTab.svelte
  // bierze tekst tooltipa "(i)". Nawigacja w drugą stronę (klik "(i)" → tu)
  // idzie przez docsNav.svelte.ts, ten sam duch co "Wyślij do Node Graph"
  // (graphInsert.svelte.ts), tylko odwrotny kierunek.
  import { onMount } from "svelte";
  import { marked } from "marked";
  import {
    NODE_TYPES, nodeTypeList, DOMAIN_ORDER, DOMAIN_LABELS, STAGE_ORDER, STAGE_LABELS,
    PORT_KIND_COLORS, type NodeTypeDef,
  } from "$lib/nodegraph";
  import {
    loadAppDocs, appDocsLoaded, getTabDoc, setTabDoc,
    getNodeDoc, setNodeDoc, hasNodeDocOverride, clearNodeDoc,
    getCustomPages, createCustomPage, setCustomPageTitle, setCustomPageBody,
    deleteCustomPage, reorderCustomPages,
  } from "$lib/appdocs.svelte";
  import { consumePendingDocsSection, type DocSectionRef } from "$lib/docsNav.svelte";
  import { TAB_DOCS } from "$lib/docsSeed";
  import ConfirmModal from "$lib/ConfirmModal.svelte";
  // Rejestrują swoje typy węzłów przy imporcie (side-effect na moduł) — patrz
  // ten sam komentarz w NodeGraphTab.svelte. Niezbędne tu niezależnie od
  // kolejności importów w +page.svelte, żeby lista node'ów w spisie nie była
  // pusta, gdy Dokumentacja wczyta się jako pierwsza.
  import "$lib/nodegraph.mapa";
  import "$lib/nodegraph.segmentacja";
  import "$lib/nodegraph.widmo";
  import "$lib/nodegraph.analiza";
  import "$lib/nodegraph.markery";

  marked.setOptions({ gfm: true, breaks: true });

  type SectionSel = DocSectionRef | { kind: "page"; id: string };
  type NavSectionKey = "pages" | "tabs" | "nodes";

  let ready = $state(false);
  let editMode = $state(false);
  let selected = $state<SectionSel>({ kind: "tab", key: TAB_DOCS[0].key });
  let draftText = $state("");
  let draftTitle = $state("");
  let deletePageTarget = $state<string | null>(null);
  let sectionOpen = $state<Record<NavSectionKey, boolean>>({ pages: true, tabs: true, nodes: true });

  function toggleSection(key: NavSectionKey) {
    sectionOpen[key] = !sectionOpen[key];
  }

  function resetDraftFor(sel: SectionSel) {
    if (sel.kind === "tab") {
      const meta = TAB_DOCS.find((t) => t.key === sel.key);
      draftText = getTabDoc(sel.key) || (meta?.body ?? "");
      draftTitle = "";
    } else if (sel.kind === "node") {
      const def = NODE_TYPES[sel.typeId];
      draftText = getNodeDoc(sel.typeId, def?.description ?? "");
      draftTitle = "";
    } else {
      const p = getCustomPages().find((pg) => pg.id === sel.id);
      draftText = p?.body ?? "";
      draftTitle = p?.title ?? "";
    }
  }

  onMount(async () => {
    if (!appDocsLoaded()) await loadAppDocs();
    resetDraftFor(selected);
    ready = true;
  });

  // Reaguje na klik ikonki "(i)" w Node Graphu (requestDocsSection) — czyta
  // i od razu "konsumuje" żądanie, żeby nie przeskakiwać tu ponownie przy
  // kolejnym renderze.
  $effect(() => {
    const pending = consumePendingDocsSection();
    if (pending) {
      selected = pending;
      resetDraftFor(pending);
      if (pending.kind === "tab") sectionOpen.tabs = true;
      else sectionOpen.nodes = true;
    }
  });

  let groupedNodeTypes = $derived.by(() => {
    const groups: { domain: string; label: string; stages: { label: string; items: NodeTypeDef[] }[] }[] = [];
    for (const dom of DOMAIN_ORDER) {
      const domItems = nodeTypeList().filter((t) => t.domain === dom);
      if (domItems.length === 0) continue;
      const stages = STAGE_ORDER
        .map((st) => ({ label: STAGE_LABELS[st], items: domItems.filter((t) => t.stage === st) }))
        .filter((s) => s.items.length > 0);
      groups.push({ domain: dom, label: DOMAIN_LABELS[dom], stages });
    }
    return groups;
  });

  let customPages = $derived(getCustomPages());

  function nodeDot(t: NodeTypeDef): string {
    const kind = t.inputs[0]?.kind ?? t.outputs[0]?.kind;
    return kind ? PORT_KIND_COLORS[kind] : "rgba(255,255,255,0.3)";
  }

  function select(sel: SectionSel) {
    selected = sel;
    resetDraftFor(sel);
  }

  let currentTabMeta = $derived.by(() => {
    const sel = selected;
    return sel.kind === "tab" ? (TAB_DOCS.find((t) => t.key === sel.key) ?? null) : null;
  });
  let currentNodeDef = $derived.by(() => {
    const sel = selected;
    return sel.kind === "node" ? (NODE_TYPES[sel.typeId] ?? null) : null;
  });
  let currentPage = $derived.by(() => {
    const sel = selected;
    return sel.kind === "page" ? (customPages.find((p) => p.id === sel.id) ?? null) : null;
  });

  let title = $derived(
    selected.kind === "tab" ? (currentTabMeta?.title ?? "")
    : selected.kind === "node" ? (currentNodeDef?.label ?? "")
    : (currentPage?.title ?? "(bez tytułu)")
  );
  let subtitle = $derived(selected.kind === "node" ? (currentNodeDef?.detail ?? "") : "");
  let defaultBody = $derived(
    selected.kind === "tab" ? (currentTabMeta?.body ?? "")
    : selected.kind === "node" ? (currentNodeDef?.description ?? "")
    : ""
  );
  let body = $derived.by(() => {
    const sel = selected;
    if (sel.kind === "tab") return getTabDoc(sel.key) || defaultBody;
    if (sel.kind === "node") return currentNodeDef ? getNodeDoc(sel.typeId, defaultBody) : "";
    return currentPage?.body ?? "";
  });
  let nodeHasOverride = $derived.by(() => {
    const sel = selected;
    return sel.kind === "node" ? hasNodeDocOverride(sel.typeId) : false;
  });

  // Treść sekcji to Markdown — w podglądzie renderujemy go do HTML (marked),
  // w trybie edycji textarea edytuje surowe źródło MD (patrz docs-edit-area).
  let bodyHtml = $derived(body.trim() ? (marked.parse(body) as string) : "");

  function onDraftTextInput() {
    const sel = selected;
    if (sel.kind === "tab") setTabDoc(sel.key, draftText);
    else if (sel.kind === "node") setNodeDoc(sel.typeId, draftText);
    else setCustomPageBody(sel.id, draftText);
  }

  function onDraftTitleInput() {
    const sel = selected;
    if (sel.kind === "page") setCustomPageTitle(sel.id, draftTitle);
  }

  function restoreDefault() {
    const sel = selected;
    if (sel.kind !== "node") return;
    clearNodeDoc(sel.typeId);
    draftText = defaultBody;
  }

  function addPage() {
    sectionOpen.pages = true;
    const p = createCustomPage("Nowa strona");
    select({ kind: "page", id: p.id });
  }

  function requestDeletePage(id: string, e: MouseEvent) {
    e.stopPropagation();
    deletePageTarget = id;
  }

  function confirmDeletePage() {
    if (!deletePageTarget) return;
    const id = deletePageTarget;
    deletePageTarget = null;
    deleteCustomPage(id);
    if (selected.kind === "page" && selected.id === id) {
      select({ kind: "tab", key: TAB_DOCS[0].key });
    }
  }

  // ── Drag-to-reorder własnych stron (Pointer Events) — ten sam wzorzec co
  // przeciąganie kolumn w WieleMz.svelte (natywny HTML5 DnD jest niestabilny
  // w webview Tauri). Aktywne tylko w trybie edycji. ──────────────────────
  let draggingPageIdx = $state<number | null>(null);
  let dragOverPageIdx = $state<number | null>(null);
  let pagesListEl = $state<HTMLDivElement | null>(null);

  function startPageDrag(e: PointerEvent, i: number) {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    draggingPageIdx = i;
    dragOverPageIdx = i;
    window.addEventListener("pointermove", onPageDragMove);
    window.addEventListener("pointerup", onPageDragUp);
  }

  function onPageDragMove(e: PointerEvent) {
    if (draggingPageIdx === null || !pagesListEl) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = (el as HTMLElement | null)?.closest(".docs-nav-page") as HTMLElement | null;
    if (!row || !pagesListEl.contains(row)) return;
    const idx = Number(row.dataset.idx);
    if (!isNaN(idx)) dragOverPageIdx = idx;
  }

  function onPageDragUp() {
    if (draggingPageIdx !== null && dragOverPageIdx !== null && dragOverPageIdx !== draggingPageIdx) {
      reorderCustomPages(draggingPageIdx, dragOverPageIdx);
    }
    draggingPageIdx = null;
    dragOverPageIdx = null;
    window.removeEventListener("pointermove", onPageDragMove);
    window.removeEventListener("pointerup", onPageDragUp);
  }
</script>

<!-- ── Ikony (SVG, bez emoji) — proste, monochromatyczne, currentColor ──── -->
{#snippet iconChevron(open: boolean)}
  <svg class="docs-chevron" class:open viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M5 3l5 5-5 5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
{/snippet}

{#snippet iconGuide()}
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4">
    <path d="M3 2.9c0-.45.42-.78.9-.65 1.5.4 2.8 1.05 3.8 1.95 1-.9 2.3-1.55 3.8-1.95.48-.13.9.2.9.65v9c0 .45-.42.78-.9.65-1.5-.4-2.8-1.05-3.8-1.95-1 .9-2.3 1.55-3.8 1.95-.48.13-.9-.2-.9-.65z" stroke-linejoin="round"/>
    <line x1="7.7" y1="4" x2="7.7" y2="11.9"/>
  </svg>
{/snippet}

{#snippet iconLayout()}
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4">
    <rect x="2" y="2.5" width="12" height="11" rx="1.4"/>
    <line x1="2" y1="6" x2="14" y2="6"/>
    <line x1="6.2" y1="6" x2="6.2" y2="13.5"/>
  </svg>
{/snippet}

{#snippet iconNodes()}
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4">
    <circle cx="3" cy="3.6" r="1.7"/>
    <circle cx="13" cy="3.6" r="1.7"/>
    <circle cx="8" cy="12.6" r="1.7"/>
    <path d="M4.5 4.6 7 11M11.5 4.6 9 11"/>
  </svg>
{/snippet}

{#snippet iconPencil()}
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3">
    <path d="M10.6 2.4l3 3L4.9 14.1l-3.4.5.5-3.4z" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>
{/snippet}

{#snippet iconCheck()}
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M3 8.4l3.2 3.2L13 4.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
{/snippet}

{#snippet iconUndo()}
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4">
    <path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5" stroke-linecap="round"/>
    <path d="M3 3.8V7h3.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
{/snippet}

{#snippet iconGrip()}
  <svg viewBox="0 0 10 16" width="8" height="13" fill="currentColor">
    <circle cx="2.4" cy="3" r="1.1"/><circle cx="7" cy="3" r="1.1"/>
    <circle cx="2.4" cy="8" r="1.1"/><circle cx="7" cy="8" r="1.1"/>
    <circle cx="2.4" cy="13" r="1.1"/><circle cx="7" cy="13" r="1.1"/>
  </svg>
{/snippet}

{#if ready}
  <div class="docs-outer">
    <div class="docs-topbar">
      <span class="docs-topbar-hint">
        {editMode ? "Tryb edycji: treść każdej sekcji jest edytowalnym Markdownem, zmiany zapisują się automatycznie." : "Poradnik i opis działania aplikacji praSzczur."}
      </span>
      <button class="docs-mode-btn" class:on={editMode} onclick={() => (editMode = !editMode)}>
        {#if editMode}{@render iconCheck()}Tryb edycji włączony{:else}{@render iconPencil()}Włącz tryb edycji{/if}
      </button>
    </div>

    <div class="docs-layout">
      <nav class="docs-nav">
        <!-- ── Poradniki (własne strony) ─────────────────────────── -->
        <div class="docs-nav-section">
          <button type="button" class="docs-nav-section-head pages" onclick={() => toggleSection("pages")}>
            {@render iconChevron(sectionOpen.pages)}
            <span class="docs-nav-section-icon">{@render iconGuide()}</span>
            <span class="docs-nav-section-title">Poradniki</span>
            {#if editMode}
              <span
                class="docs-nav-add-btn"
                role="button"
                tabindex="0"
                onclick={(e) => { e.stopPropagation(); addPage(); }}
                onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); addPage(); } }}
                title="Dodaj nową stronę"
              >+</span>
            {/if}
          </button>
          <div class="docs-nav-collapse" class:open={sectionOpen.pages}>
            <div class="docs-nav-collapse-inner">
              <div class="docs-nav-section-body docs-nav-scroll docs-nav-pages" bind:this={pagesListEl}>
                {#each customPages as p, i (p.id)}
                  <div
                    class="docs-nav-page"
                    class:dragging={draggingPageIdx === i}
                    class:drag-over={dragOverPageIdx === i && draggingPageIdx !== null && draggingPageIdx !== i}
                    data-idx={i}
                  >
                    {#if editMode}
                      <span class="docs-drag-handle" onpointerdown={(e) => startPageDrag(e, i)} title="Przeciągnij, aby zmienić kolejność">
                        {@render iconGrip()}
                      </span>
                    {/if}
                    <button
                      class="docs-nav-item page"
                      class:active={selected.kind === "page" && selected.id === p.id}
                      onclick={() => select({ kind: "page", id: p.id })}
                    >
                      {p.title || "(bez tytułu)"}
                    </button>
                    {#if editMode}
                      <button class="docs-nav-page-del" onclick={(e) => requestDeletePage(p.id, e)} title="Usuń stronę">×</button>
                    {/if}
                  </div>
                {/each}
                {#if customPages.length === 0}
                  <div class="docs-nav-empty">{editMode ? "Brak — kliknij „+”, żeby dodać pierwszą." : "Brak poradników."}</div>
                {/if}
              </div>
            </div>
          </div>
        </div>

        <!-- ── Zakładki aplikacji ────────────────────────────────── -->
        <div class="docs-nav-section">
          <button type="button" class="docs-nav-section-head app" onclick={() => toggleSection("tabs")}>
            {@render iconChevron(sectionOpen.tabs)}
            <span class="docs-nav-section-icon">{@render iconLayout()}</span>
            <span class="docs-nav-section-title">Zakładki aplikacji</span>
          </button>
          <div class="docs-nav-collapse" class:open={sectionOpen.tabs}>
            <div class="docs-nav-collapse-inner">
              <div class="docs-nav-section-body docs-nav-scroll">
                {#each TAB_DOCS as t (t.key)}
                  <button
                    class="docs-nav-item"
                    class:active={selected.kind === "tab" && selected.key === t.key}
                    onclick={() => select({ kind: "tab", key: t.key })}
                  >
                    {t.title}
                  </button>
                {/each}
              </div>
            </div>
          </div>
        </div>

        <!-- ── Node Graph — typy node'ów ─────────────────────────── -->
        <div class="docs-nav-section">
          <button type="button" class="docs-nav-section-head nodes" onclick={() => toggleSection("nodes")}>
            {@render iconChevron(sectionOpen.nodes)}
            <span class="docs-nav-section-icon">{@render iconNodes()}</span>
            <span class="docs-nav-section-title">Node Graph — typy node'ów</span>
          </button>
          <div class="docs-nav-collapse" class:open={sectionOpen.nodes}>
            <div class="docs-nav-collapse-inner">
              <div class="docs-nav-section-body docs-nav-scroll">
                {#each groupedNodeTypes as g (g.domain)}
                  <div class="docs-nav-domain">{g.label}</div>
                  {#each g.stages as s (s.label)}
                    <div class="docs-nav-stage">{s.label}</div>
                    {#each s.items as t (t.id)}
                      <button
                        class="docs-nav-item node"
                        class:active={selected.kind === "node" && selected.typeId === t.id}
                        onclick={() => select({ kind: "node", typeId: t.id })}
                      >
                        <span class="docs-nav-dot" style="background:{nodeDot(t)}"></span>
                        {t.label}
                      </button>
                    {/each}
                  {/each}
                {/each}
              </div>
            </div>
          </div>
        </div>
      </nav>

      <div class="docs-main">
        <div class="docs-main-head">
          <div class="docs-main-titlewrap">
            {#if editMode && selected.kind === "page"}
              <input class="docs-title-input" bind:value={draftTitle} oninput={onDraftTitleInput} placeholder="Tytuł strony…" />
            {:else}
              <h2 class="docs-main-title">{title}</h2>
            {/if}
            {#if subtitle}<span class="docs-main-subtitle">{subtitle}</span>{/if}
          </div>
          {#if editMode && selected.kind === "node" && nodeHasOverride}
            <button class="docs-reset-btn" onclick={restoreDefault}>{@render iconUndo()}Przywróć domyślny opis</button>
          {/if}
        </div>

        <div class="docs-main-body">
          {#if editMode}
            <textarea
              class="docs-edit-area"
              bind:value={draftText}
              oninput={onDraftTextInput}
              placeholder="Opisz w Markdown… (# nagłówek, **pogrubienie**, *kursywa*, - lista, `kod`)"
            ></textarea>
          {:else if bodyHtml}
            <div class="docs-markdown">{@html bodyHtml}</div>
          {:else}
            <p class="docs-empty">Brak opisu — włącz tryb edycji, żeby go dodać.</p>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<ConfirmModal
  open={deletePageTarget !== null}
  title="Usunąć stronę?"
  message="Tej operacji nie można cofnąć."
  confirmLabel="Usuń"
  danger={true}
  onconfirm={confirmDeletePage}
  oncancel={() => { deletePageTarget = null; }}
/>

<style>
  .docs-outer {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Górny pasek: globalny przełącznik trybu edycji ──────────── */
  .docs-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 20px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    flex-shrink: 0;
  }

  .docs-topbar-hint {
    font-size: 0.7rem;
    color: rgba(255,255,255,0.35);
  }

  .docs-mode-btn {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 14px;
    font-size: 0.72rem;
    font-weight: 700;
    font-family: inherit;
    border-radius: 7px;
    cursor: pointer;
    white-space: nowrap;
    background: none;
    border: 1px solid rgba(255,255,255,0.15);
    color: rgba(255,255,255,0.6);
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .docs-mode-btn:hover { border-color: rgba(255,255,255,0.35); color: #f0f0f0; }
  .docs-mode-btn.on {
    background: rgba(255,201,81,0.16);
    border-color: rgba(255,201,81,0.45);
    color: #ffc951;
  }

  .docs-layout {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: row;
    overflow: hidden;
  }

  /* ── Lewy panel: spis, w zwijanych sekcjach ───────────────────── */
  .docs-nav {
    width: 270px;
    min-width: 270px;
    flex-shrink: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 12px;
    border-right: 1px solid rgba(255,255,255,0.08);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .docs-nav-section {
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;
    overflow: hidden;
    background: rgba(255,255,255,0.015);
    flex-shrink: 0;
  }

  .docs-nav-section-head {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 9px 10px;
    font-size: 0.68rem;
    font-weight: 700;
    font-family: inherit;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: filter 0.12s;
  }
  .docs-nav-section-head:hover { filter: brightness(1.25); }
  .docs-nav-section-head.app   { background: rgba(91,155,213,0.12);  color: #8fbbe0; }
  .docs-nav-section-head.nodes { background: rgba(242,153,74,0.12);  color: #f2b073; }
  .docs-nav-section-head.pages { background: rgba(123,196,127,0.12); color: #9ed7a1; }

  .docs-chevron { flex-shrink: 0; transition: transform 0.2s ease; }
  .docs-chevron.open { transform: rotate(90deg); }

  .docs-nav-section-icon { display: flex; flex-shrink: 0; }
  .docs-nav-section-title { flex: 1; }

  .docs-nav-add-btn {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: rgba(255,255,255,0.1);
    color: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s;
  }
  .docs-nav-add-btn:hover { background: rgba(255,255,255,0.22); }

  /* Animacja zwijania/rozwijania sekcji — grid 0fr→1fr zamiast max-height
     na sztywno, bo działa poprawnie niezależnie od ilości treści w środku. */
  .docs-nav-collapse {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.22s ease;
  }
  .docs-nav-collapse.open { grid-template-rows: 1fr; }
  .docs-nav-collapse-inner { overflow: hidden; min-height: 0; }

  .docs-nav-section-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
  }

  /* Maks. ok. 5 widocznych pozycji naraz — reszta pod własnym scrollem,
     niezależnym od scrolla całego lewego panelu. */
  .docs-nav-scroll {
    max-height: 168px;
    overflow-y: auto;
  }

  .docs-nav-domain {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.32);
    padding: 8px 6px 2px;
  }
  .docs-nav-domain:first-child { padding-top: 2px; }

  .docs-nav-stage {
    font-size: 0.6rem;
    font-weight: 600;
    color: rgba(255,255,255,0.2);
    padding: 3px 6px 2px 14px;
  }

  .docs-nav-item {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 1;
    min-width: 0;
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-radius: 7px;
    padding: 6px 9px;
    font-size: 0.74rem;
    font-family: inherit;
    color: rgba(255,255,255,0.55);
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .docs-nav-item.node { padding-left: 16px; font-size: 0.7rem; }
  .docs-nav-item.page {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .docs-nav-item:hover { background: rgba(255,255,255,0.06); color: #f0f0f0; }
  .docs-nav-item.active {
    background: rgba(255,201,81,0.14);
    border-color: rgba(255,201,81,0.35);
    color: #ffc951;
  }

  .docs-nav-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .docs-nav-empty {
    font-size: 0.68rem;
    color: rgba(255,255,255,0.28);
    font-style: italic;
    padding: 6px 9px;
  }

  .docs-nav-pages { gap: 1px; }

  .docs-nav-page {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 7px;
    transition: background 0.12s;
  }
  .docs-nav-page.dragging { opacity: 0.4; }
  .docs-nav-page.drag-over { background: rgba(255,201,81,0.1); outline: 1px dashed rgba(255,201,81,0.4); }

  .docs-drag-handle {
    flex-shrink: 0;
    width: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255,255,255,0.3);
    cursor: grab;
    touch-action: none;
  }
  .docs-drag-handle:hover { color: rgba(255,255,255,0.6); }

  .docs-nav-page-del {
    flex-shrink: 0;
    background: none;
    border: none;
    color: rgba(255,255,255,0.3);
    font-size: 0.9rem;
    padding: 2px 6px;
    cursor: pointer;
    transition: color 0.15s;
  }
  .docs-nav-page-del:hover { color: #ff6b6b; }

  /* ── Prawy panel: treść ───────────────────────────────────── */
  .docs-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .docs-main-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 26px 14px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    flex-shrink: 0;
  }

  .docs-main-titlewrap {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  .docs-main-title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #f0f0f0;
  }

  .docs-title-input {
    font-size: 1.15rem;
    font-weight: 700;
    color: #f0f0f0;
    background: #1c1c1c;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px;
    padding: 5px 10px;
    font-family: inherit;
    outline: none;
    max-width: 420px;
  }
  .docs-title-input:focus { border-color: rgba(255,201,81,0.35); }

  .docs-main-subtitle {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.4);
  }

  .docs-reset-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    padding: 7px 14px;
    font-size: 0.72rem;
    font-weight: 600;
    font-family: inherit;
    border-radius: 7px;
    cursor: pointer;
    white-space: nowrap;
    background: none;
    border: 1px solid rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.45);
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .docs-reset-btn:hover { border-color: #ff6b6b; color: #ff6b6b; }

  .docs-main-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 26px 32px;
    width: 100%;
  }

  .docs-empty {
    font-size: 0.78rem;
    color: rgba(255,255,255,0.3);
    font-style: italic;
  }

  .docs-edit-area {
    width: 100%;
    height: 100%;
    min-height: 320px;
    resize: vertical;
    background: #1c1c1c;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    padding: 14px;
    color: #eee;
    font-size: 0.8rem;
    line-height: 1.7;
    font-family: "JetBrains Mono", monospace;
    outline: none;
  }
  .docs-edit-area:focus { border-color: rgba(255,201,81,0.35); }

  /* ── Wyrenderowany Markdown ───────────────────────────────────────────
     Styl "zwarty/techniczny": gęstszy, terminalowy klimat spójny z
     monospace appki — hierarchia nagłówków przez kolor/obramowanie, nie
     przez duże skoki rozmiaru; akcent appki (#ffc951) konsekwentnie na
     nagłówkach/markerach list/linkach/kodzie zamiast gołego białego tekstu. */
  .docs-markdown {
    font-size: 0.82rem;
    line-height: 1.68;
    color: rgba(255,255,255,0.78);
    width: 100%;
  }
  .docs-markdown :global(h1) {
    font-size: 1.02rem;
    font-weight: 800;
    color: #ffc951;
    letter-spacing: 0.01em;
    margin: 1.4em 0 0.6em;
    padding-bottom: 7px;
    border-bottom: 1px solid rgba(255,201,81,0.25);
    line-height: 1.3;
  }
  .docs-markdown :global(h2) {
    font-size: 0.92rem;
    font-weight: 700;
    color: #f0f0f0;
    margin: 1.2em 0 0.5em;
    padding-bottom: 5px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    line-height: 1.3;
  }
  .docs-markdown :global(h3) {
    font-size: 0.78rem;
    font-weight: 700;
    color: rgba(255,255,255,0.65);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 1.1em 0 0.4em;
    line-height: 1.3;
  }
  .docs-markdown :global(h1:first-child),
  .docs-markdown :global(h2:first-child),
  .docs-markdown :global(h3:first-child) { margin-top: 0; }
  .docs-markdown :global(p) { margin: 0 0 0.85em; }
  .docs-markdown :global(strong) { color: #ffc951; font-weight: 700; }
  .docs-markdown :global(em) { font-style: italic; color: rgba(255,255,255,0.9); }
  .docs-markdown :global(ul), .docs-markdown :global(ol) {
    margin: 0 0 0.85em 1.2em;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .docs-markdown :global(li) { line-height: 1.58; }
  .docs-markdown :global(li)::marker { color: #ffc951; font-weight: 700; }
  .docs-markdown :global(li > ul), .docs-markdown :global(li > ol) { margin-top: 4px; margin-bottom: 0; }
  .docs-markdown :global(li li)::marker { color: rgba(255,201,81,0.55); }
  .docs-markdown :global(a) { color: #ffc951; text-decoration: none; border-bottom: 1px solid rgba(255,201,81,0.3); }
  .docs-markdown :global(a:hover) { border-bottom-color: #ffc951; }
  .docs-markdown :global(code) {
    background: rgba(255,201,81,0.1);
    border-radius: 4px;
    padding: 0.1em 0.4em;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.85em;
    color: #ffc951;
  }
  .docs-markdown :global(pre) {
    position: relative;
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.08);
    border-top: 2px solid rgba(255,201,81,0.35);
    border-radius: 0 0 8px 8px;
    padding: 11px 14px;
    overflow-x: auto;
    margin: 0 0 0.85em;
  }
  .docs-markdown :global(pre code) { background: none; padding: 0; color: rgba(255,255,255,0.78); }
  .docs-markdown :global(blockquote) {
    margin: 0 0 0.85em;
    padding: 6px 14px;
    background: rgba(255,201,81,0.06);
    border-left: 3px solid rgba(255,201,81,0.45);
    border-radius: 0 6px 6px 0;
    color: rgba(255,255,255,0.6);
  }
  .docs-markdown :global(blockquote) :global(p):last-child { margin-bottom: 0; }
  .docs-markdown :global(hr) {
    border: none;
    border-top: 1px solid rgba(255,201,81,0.18);
    margin: 1.1em 0;
  }
  .docs-markdown :global(table) {
    border-collapse: collapse;
    margin: 0 0 0.85em;
    font-size: 0.95em;
  }
  .docs-markdown :global(th), .docs-markdown :global(td) {
    border: 1px solid rgba(255,201,81,0.15);
    padding: 5px 10px;
    text-align: left;
  }
  .docs-markdown :global(th) {
    background: rgba(255,255,255,0.04);
    color: #f0f0f0;
    font-weight: 700;
  }
</style>
