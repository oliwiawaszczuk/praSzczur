<script lang="ts">
  // Zakładka "Dokumentacja" — poradnik + opis DZIAŁANIA appki (nie kodu).
  // Lewy panel: spis (zakładki appki + typy node'ów Node Grapha, pogrupowane
  // tak samo jak paleta w NodeGraphTab.svelte). Prawy panel: pełna treść
  // wybranej sekcji + przycisk "Edytuj".
  //
  // Synchronizacja z ikonką "(i)" na node'ach Node Grapha: opisy node'ów NIE
  // są tu duplikowane — czytane/zapisywane przez appdocs.svelte.ts (getNodeDoc/
  // setNodeDoc), DOKŁADNIE to samo źródło, z którego NodeGraphTab.svelte
  // bierze tekst tooltipa "(i)". Nawigacja w drugą stronę (klik "(i)" → tu)
  // idzie przez docsNav.svelte.ts, ten sam duch co "Wyślij do Node Graph"
  // (graphInsert.svelte.ts), tylko odwrotny kierunek.
  import { onMount } from "svelte";
  import {
    NODE_TYPES, nodeTypeList, DOMAIN_ORDER, DOMAIN_LABELS, STAGE_ORDER, STAGE_LABELS,
    PORT_KIND_COLORS, type NodeTypeDef,
  } from "$lib/nodegraph";
  import {
    loadAppDocs, appDocsLoaded, getTabDoc, setTabDoc,
    getNodeDoc, setNodeDoc, hasNodeDocOverride, clearNodeDoc,
  } from "$lib/appdocs.svelte";
  import { consumePendingDocsSection, type DocSectionRef } from "$lib/docsNav.svelte";
  import { TAB_DOCS } from "$lib/docsSeed";
  // Rejestrują swoje typy węzłów przy imporcie (side-effect na moduł) — patrz
  // ten sam komentarz w NodeGraphTab.svelte. Niezbędne tu niezależnie od
  // kolejności importów w +page.svelte, żeby lista node'ów w spisie nie była
  // pusta, gdy Dokumentacja wczyta się jako pierwsza.
  import "$lib/nodegraph.mapa";
  import "$lib/nodegraph.segmentacja";
  import "$lib/nodegraph.widmo";

  let ready = $state(false);
  let selected = $state<DocSectionRef>({ kind: "tab", key: TAB_DOCS[0].key });
  let editing = $state(false);
  let draftText = $state("");

  onMount(async () => {
    if (!appDocsLoaded()) await loadAppDocs();
    ready = true;
  });

  // Reaguje na klik ikonki "(i)" w Node Graphu (requestDocsSection) — czyta
  // i od razu "konsumuje" żądanie, żeby nie przeskakiwać tu ponownie przy
  // kolejnym renderze.
  $effect(() => {
    const pending = consumePendingDocsSection();
    if (pending) {
      selected = pending;
      editing = false;
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

  function nodeDot(t: NodeTypeDef): string {
    const kind = t.inputs[0]?.kind ?? t.outputs[0]?.kind;
    return kind ? PORT_KIND_COLORS[kind] : "rgba(255,255,255,0.3)";
  }

  function selectTab(key: string) {
    selected = { kind: "tab", key };
    editing = false;
  }

  function selectNode(typeId: string) {
    selected = { kind: "node", typeId };
    editing = false;
  }

  let currentTabMeta = $derived.by(() => {
    const sel = selected;
    if (sel.kind !== "tab") return null;
    return TAB_DOCS.find((t) => t.key === sel.key) ?? null;
  });
  let currentNodeDef = $derived.by(() => {
    const sel = selected;
    return sel.kind === "node" ? (NODE_TYPES[sel.typeId] ?? null) : null;
  });

  let title = $derived(selected.kind === "tab" ? (currentTabMeta?.title ?? "") : (currentNodeDef?.label ?? ""));
  let subtitle = $derived(selected.kind === "node" ? (currentNodeDef?.detail ?? "") : "");
  let defaultBody = $derived(selected.kind === "tab" ? (currentTabMeta?.body ?? "") : (currentNodeDef?.description ?? ""));
  let body = $derived.by(() => {
    const sel = selected;
    if (sel.kind === "tab") return getTabDoc(sel.key) || defaultBody;
    return currentNodeDef ? getNodeDoc(sel.typeId, defaultBody) : "";
  });
  let nodeHasOverride = $derived.by(() => {
    const sel = selected;
    return sel.kind === "node" ? hasNodeDocOverride(sel.typeId) : false;
  });

  function startEdit() {
    draftText = body;
    editing = true;
  }

  function cancelEdit() {
    editing = false;
  }

  function saveEdit() {
    if (selected.kind === "tab") setTabDoc(selected.key, draftText);
    else setNodeDoc(selected.typeId, draftText);
    editing = false;
  }

  function restoreDefault() {
    if (selected.kind !== "node") return;
    clearNodeDoc(selected.typeId);
    draftText = defaultBody;
  }

  interface Block { type: "p" | "ul"; lines: string[]; }

  function toBlocks(text: string): Block[] {
    const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    return paras.map((p) => {
      const lines = p.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      const isList = lines.length > 0 && lines.every((l) => l.startsWith("- "));
      return isList
        ? { type: "ul" as const, lines: lines.map((l) => l.slice(2)) }
        : { type: "p" as const, lines: [p] };
    });
  }
</script>

{#if ready}
  <div class="docs-layout">
    <nav class="docs-nav">
      <div class="docs-nav-group-title">Zakładki aplikacji</div>
      {#each TAB_DOCS as t (t.key)}
        <button
          class="docs-nav-item"
          class:active={selected.kind === "tab" && selected.key === t.key}
          onclick={() => selectTab(t.key)}
        >
          {t.title}
        </button>
      {/each}

      {#each groupedNodeTypes as g (g.domain)}
        <div class="docs-nav-group-title docs-nav-group-nodes">Node Graph — {g.label}</div>
        {#each g.stages as s (s.label)}
          <div class="docs-nav-stage">{s.label}</div>
          {#each s.items as t (t.id)}
            <button
              class="docs-nav-item node"
              class:active={selected.kind === "node" && selected.typeId === t.id}
              onclick={() => selectNode(t.id)}
            >
              <span class="docs-nav-dot" style="background:{nodeDot(t)}"></span>
              {t.label}
            </button>
          {/each}
        {/each}
      {/each}
    </nav>

    <div class="docs-main">
      <div class="docs-main-head">
        <div class="docs-main-titlewrap">
          <h2 class="docs-main-title">{title}</h2>
          {#if subtitle}<span class="docs-main-subtitle">{subtitle}</span>{/if}
        </div>
        {#if !editing}
          <button class="docs-edit-btn" onclick={startEdit}>✎ Edytuj</button>
        {:else}
          <div class="docs-edit-actions">
            {#if selected.kind === "node" && nodeHasOverride}
              <button class="docs-reset-btn" onclick={restoreDefault}>Przywróć domyślny</button>
            {/if}
            <button class="docs-cancel-btn" onclick={cancelEdit}>Anuluj</button>
            <button class="docs-save-btn" onclick={saveEdit}>Zapisz</button>
          </div>
        {/if}
      </div>

      <div class="docs-main-body">
        {#if editing}
          <textarea class="docs-edit-area" bind:value={draftText} placeholder="Opisz…"></textarea>
        {:else}
          {#each toBlocks(body) as b}
            {#if b.type === "ul"}
              <ul class="docs-ul">
                {#each b.lines as li}<li>{li}</li>{/each}
              </ul>
            {:else}
              <p class="docs-p">{b.lines[0]}</p>
            {/if}
          {/each}
          {#if body.trim().length === 0}
            <p class="docs-empty">Brak opisu — kliknij "Edytuj", żeby go dodać.</p>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .docs-layout {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: row;
    overflow: hidden;
  }

  /* ── Lewy panel: spis ─────────────────────────────────────── */
  .docs-nav {
    width: 260px;
    min-width: 260px;
    flex-shrink: 0;
    overflow-y: auto;
    padding: 14px 10px;
    border-right: 1px solid rgba(255,255,255,0.08);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .docs-nav-group-title {
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.3);
    padding: 10px 8px 4px;
  }
  .docs-nav-group-nodes { margin-top: 8px; }

  .docs-nav-stage {
    font-size: 0.6rem;
    font-weight: 600;
    color: rgba(255,255,255,0.22);
    padding: 4px 8px 2px 14px;
  }

  .docs-nav-item {
    display: flex;
    align-items: center;
    gap: 7px;
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-radius: 7px;
    padding: 6px 10px;
    font-size: 0.74rem;
    font-family: inherit;
    color: rgba(255,255,255,0.55);
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .docs-nav-item.node { padding-left: 18px; font-size: 0.7rem; }
  .docs-nav-item:hover { background: rgba(255,255,255,0.05); color: #f0f0f0; }
  .docs-nav-item.active {
    background: rgba(255,201,81,0.12);
    border-color: rgba(255,201,81,0.3);
    color: #ffc951;
  }

  .docs-nav-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

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
    flex-direction: column;
    gap: 2px;
  }

  .docs-main-title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #f0f0f0;
  }

  .docs-main-subtitle {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.4);
  }

  .docs-edit-btn, .docs-cancel-btn, .docs-save-btn, .docs-reset-btn {
    padding: 7px 14px;
    font-size: 0.72rem;
    font-weight: 600;
    font-family: inherit;
    border-radius: 7px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .docs-edit-btn {
    background: rgba(255,201,81,0.12);
    border: 1px solid rgba(255,201,81,0.3);
    color: #ffc951;
  }
  .docs-edit-btn:hover { background: rgba(255,201,81,0.22); }

  .docs-edit-actions { display: flex; gap: 8px; }

  .docs-cancel-btn {
    background: none;
    border: 1px solid rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.6);
  }
  .docs-cancel-btn:hover { border-color: rgba(255,255,255,0.3); color: #f0f0f0; }

  .docs-reset-btn {
    background: none;
    border: 1px solid rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.45);
  }
  .docs-reset-btn:hover { border-color: #ff6b6b; color: #ff6b6b; }

  .docs-save-btn {
    background: rgba(123,196,127,0.15);
    border: 1px solid rgba(123,196,127,0.4);
    color: #7bc47f;
  }
  .docs-save-btn:hover { background: rgba(123,196,127,0.28); }

  .docs-main-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 26px 32px;
    max-width: 820px;
  }

  .docs-p {
    font-size: 0.82rem;
    line-height: 1.75;
    color: rgba(255,255,255,0.78);
    white-space: pre-wrap;
    margin-bottom: 16px;
  }

  .docs-ul {
    margin: 0 0 16px 1.1em;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .docs-ul li {
    font-size: 0.82rem;
    line-height: 1.6;
    color: rgba(255,255,255,0.78);
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
</style>
