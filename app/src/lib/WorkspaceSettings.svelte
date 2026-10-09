<script lang="ts">
  import { onMount } from "svelte";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { listen } from "@tauri-apps/api/event";
  import ConfirmModal from "$lib/ConfirmModal.svelte";
  import {
    workspaces, activeWorkspaceId, createWorkspace, switchWorkspace,
    renameWorkspace, deleteWorkspace, exportWorkspace, importWorkspace,
  } from "$lib/workspace.svelte";
  import {
    datasets, activeDatasetId, loadDatasets, datasetsLoaded,
    createDataset, renameDataset, deleteDataset, activateDataset,
  } from "$lib/datasets.svelte";
  import {
    nodeGraphs, loadNodeGraphs, nodeGraphsLoaded, createNodeGraph, renameNodeGraph, deleteNodeGraph,
  } from "$lib/nodegraphs.svelte";
  import {
    groupSets, ensureGroupSets, createGroupSet, renameGroupSet, deleteGroupSet,
  } from "$lib/mzGroups.svelte";
  import {
    mzListDecimals, setMzListDecimals, MZ_LIST_DECIMALS_MIN, MZ_LIST_DECIMALS_MAX,
  } from "$lib/mzListSettings.svelte";
  import { formatMzListText } from "$lib/mzListFormat";
  import { getSetting, setSetting } from "$lib/appSettings.svelte";
  import IonCanvas from "$lib/IonCanvas.svelte";
  import {
    savedMapsList, loadSavedMaps, savedMapsLoaded, fetchSavedMapData, type SavedPixelMap, type SavedPixelMapMeta,
  } from "$lib/savedPixelMaps.svelte";
  import { savedSpectraList, loadSavedSpectra, savedSpectraLoaded } from "$lib/spectraLibrary.svelte";
  import { activeWorkspace } from "$lib/workspace.svelte";
  import { COLORMAPS, COLORMAP_SETTING_KEY, activeColormapId, colormapGradientCss } from "$lib/colormap";

  // ── Czułość zoomu/przesuwania płótna — GLOBALNA, współdzielona przez
  // wszystkie Node Graphy oraz Tablicę (patrz appSettings.svelte.ts). ────────
  let canvasZoomSensitivity = $derived(getSetting("canvasZoomSensitivity", 1));
  let canvasPanSensitivity = $derived(getSetting("canvasPanSensitivity", 1));
  function setCanvasZoomSens(v: number) { setSetting("canvasZoomSensitivity", v); }
  function setCanvasPanSens(v: number) { setSetting("canvasPanSensitivity", v); }

  // ── Personalizacja: tablica kolorów (LUT) map m/z — GLOBALNA preferencja wyglądu,
  // wspólna dla wszystkich workspace'ów (patrz colormap.ts). ────────────────────
  let colormapId = $derived(activeColormapId());
  function setColormap(id: string) { setSetting(COLORMAP_SETTING_KEY, id); }

  let creating   = $state(false);
  let newName    = $state("");
  let busy       = $state(false);
  let errorMsg   = $state("");
  let renamingId = $state<string | null>(null);
  let renameVal  = $state("");
  let deleteTarget = $state<{ id: string; name: string } | null>(null);

  function fmtDate(iso: string): string {
    try { return new Date(iso).toLocaleString("pl-PL"); } catch { return iso; }
  }

  async function doCreate() {
    if (!newName.trim()) return;
    busy = true; errorMsg = "";
    try { await createWorkspace(newName.trim()); }
    catch (e) { errorMsg = (e as Error).message; busy = false; }
  }

  async function doSwitch(id: string) {
    if (id === activeWorkspaceId()) return;
    busy = true; errorMsg = "";
    try { await switchWorkspace(id); }
    catch (e) { errorMsg = (e as Error).message; busy = false; }
  }

  function startRename(id: string, current: string) {
    renamingId = id; renameVal = current;
  }

  async function commitRename() {
    if (!renamingId || !renameVal.trim()) { renamingId = null; return; }
    busy = true; errorMsg = "";
    try { await renameWorkspace(renamingId, renameVal.trim()); }
    catch (e) { errorMsg = (e as Error).message; }
    finally { renamingId = null; busy = false; }
  }

  function askDelete(id: string, name: string) {
    deleteTarget = { id, name };
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
    deleteTarget = null;
    busy = true; errorMsg = "";
    try { await deleteWorkspace(id); }
    catch (e) { errorMsg = (e as Error).message; }
    finally { busy = false; }
  }

  async function doExport(id: string) {
    const dir = await openDialog({ directory: true, multiple: false });
    if (!dir) return;
    busy = true; errorMsg = "";
    try {
      const path = await exportWorkspace(id, dir as string);
      alert(`Wyeksportowano do: ${path}`);
    } catch (e) { errorMsg = (e as Error).message; }
    finally { busy = false; }
  }

  async function doImport() {
    const dir = await openDialog({ directory: true, multiple: false });
    if (!dir) return;
    busy = true; errorMsg = "";
    try { await importWorkspace(dir as string); }
    catch (e) { errorMsg = (e as Error).message; busy = false; }
  }

  // ── Zestawy danych ───────────────────────────────────────────────────────
  let dsCreating      = $state(false);
  let dsNewName        = $state("");
  let dsBusy           = $state(false);
  let dsError          = $state("");
  let dsRenamingId     = $state<string | null>(null);
  let dsRenameVal      = $state("");
  let dsDeleteTarget   = $state<{ id: string; name: string } | null>(null);

  onMount(async () => { if (!datasetsLoaded()) await loadDatasets(); });

  // ── Node Graphy (per workspace, jak Zestawy danych powyżej) ─────────────
  let ngCreating    = $state(false);
  let ngNewName     = $state("");
  let ngBusy        = $state(false);
  let ngError       = $state("");
  let ngRenamingId  = $state<string | null>(null);
  let ngRenameVal   = $state("");
  let ngDeleteTarget = $state<{ id: string; name: string } | null>(null);

  onMount(async () => { if (!nodeGraphsLoaded()) await loadNodeGraphs(); });

  async function ngDoCreate() {
    if (!ngNewName.trim()) return;
    ngBusy = true; ngError = "";
    try { await createNodeGraph(ngNewName.trim()); ngNewName = ""; ngCreating = false; }
    catch (e) { ngError = (e as Error).message; }
    finally { ngBusy = false; }
  }

  function ngStartRename(id: string, current: string) {
    ngRenamingId = id; ngRenameVal = current;
  }

  async function ngCommitRename() {
    if (!ngRenamingId || !ngRenameVal.trim()) { ngRenamingId = null; return; }
    ngBusy = true; ngError = "";
    try { await renameNodeGraph(ngRenamingId, ngRenameVal.trim()); }
    catch (e) { ngError = (e as Error).message; }
    finally { ngRenamingId = null; ngBusy = false; }
  }

  function ngAskDelete(id: string, name: string) {
    ngDeleteTarget = { id, name };
  }

  async function ngConfirmDelete() {
    if (!ngDeleteTarget) return;
    const { id } = ngDeleteTarget;
    ngDeleteTarget = null;
    ngBusy = true; ngError = "";
    try { await deleteNodeGraph(id); }
    catch (e) { ngError = (e as Error).message; }
    finally { ngBusy = false; }
  }

  // ── Zestawy grup m/z (per workspace; zakładka m/z → Grupy) ──────────────
  let gsCreating     = $state(false);
  let gsNewName      = $state("");
  let gsRenamingId   = $state<string | null>(null);
  let gsRenameVal    = $state("");
  let gsDeleteTarget = $state<{ id: string; name: string } | null>(null);

  onMount(() => { ensureGroupSets(); });

  function gsDoCreate() {
    if (!gsNewName.trim()) return;
    createGroupSet(gsNewName.trim());
    gsNewName = ""; gsCreating = false;
  }
  function gsStartRename(id: string, current: string) { gsRenamingId = id; gsRenameVal = current; }
  function gsCommitRename() {
    if (gsRenamingId && gsRenameVal.trim()) renameGroupSet(gsRenamingId, gsRenameVal);
    gsRenamingId = null;
  }
  function gsConfirmDelete() {
    if (!gsDeleteTarget) return;
    deleteGroupSet(gsDeleteTarget.id);
    gsDeleteTarget = null;
  }

  async function dsDoCreate() {
    if (!dsNewName.trim()) return;
    dsBusy = true; dsError = "";
    try { await createDataset(dsNewName.trim(), "empty"); dsNewName = ""; dsCreating = false; }
    catch (e) { dsError = (e as Error).message; }
    finally { dsBusy = false; }
  }

  async function dsDoActivate(id: string) {
    if (id === activeDatasetId()) return;
    dsBusy = true; dsError = "";
    try { await activateDataset(id); }
    catch (e) { dsError = (e as Error).message; }
    finally { dsBusy = false; }
  }

  function dsStartRename(id: string, current: string) {
    dsRenamingId = id; dsRenameVal = current;
  }

  async function dsCommitRename() {
    if (!dsRenamingId || !dsRenameVal.trim()) { dsRenamingId = null; return; }
    dsBusy = true; dsError = "";
    try { await renameDataset(dsRenamingId, dsRenameVal.trim()); }
    catch (e) { dsError = (e as Error).message; }
    finally { dsRenamingId = null; dsBusy = false; }
  }

  function dsAskDelete(id: string, name: string) {
    dsDeleteTarget = { id, name };
  }

  async function dsConfirmDelete() {
    if (!dsDeleteTarget) return;
    const { id } = dsDeleteTarget;
    dsDeleteTarget = null;
    dsBusy = true; dsError = "";
    try { await deleteDataset(id); }
    catch (e) { dsError = (e as Error).message; }
    finally { dsBusy = false; }
  }

  // ── Nagłówek strony: statystyki workspace'u, losowa zapisana mapa m/z, wskazówka ──
  let stats = $derived([
    { n: datasets().length, label: "zestawów danych" },
    { n: nodeGraphs().length, label: "grafów" },
    { n: groupSets().length, label: "zestawów grup m/z" },
    { n: savedMapsList().length, label: "zapisanych map" },
    { n: savedSpectraList().length, label: "zapisanych widm" },
  ]);

  /** Zapisane mapy m/z (bez segmentów — to maski, nie intensywności). */
  let mapCandidates = $derived(savedMapsList().filter((m) => m.mode !== "segment"));
  let featuredMeta = $state<SavedPixelMapMeta | null>(null);
  let featuredData = $state<SavedPixelMap | null>(null);
  let featuredLoading = $state(false);

  async function pickFeatured() {
    const pool = mapCandidates;
    if (pool.length === 0) { featuredMeta = null; featuredData = null; return; }
    // przy >1 mapie nie losuj dwa razy tej samej, żeby "Losuj" zawsze coś zmieniał
    const others = pool.length > 1 ? pool.filter((m) => m.id !== featuredMeta?.id) : pool;
    const next = others[Math.floor(Math.random() * others.length)];
    featuredMeta = next;
    featuredLoading = true;
    try { featuredData = await fetchSavedMapData(next.id); }
    catch { featuredData = null; }
    finally { featuredLoading = false; }
  }

  function featuredCaption(m: SavedPixelMapMeta): string {
    if (m.mode === "single" && m.sources.length === 1) {
      return `m/z ${m.sources[0].mz.toFixed(2)} ±${m.sources[0].tol}`;
    }
    return m.sources.length > 0 ? `${m.sources.length} × m/z (${m.mode})` : m.mode;
  }

  const TIPS = [
    "Node Graph: spacja albo prawy klik otwiera paletę node'ów, a klawisz F dopasowuje widok do zaznaczenia.",
    "Cmd/Ctrl + klik na wykresie widma kopiuje wartość pod kursorem (i dopisuje ją do przypiętej notatki).",
    "Tablica: klawisz T dodaje tekst w miejscu kursora, a strzałki w górę/dół zmieniają kolejność warstw.",
    "m/z → Grupy: wklej listę z node'a „Top m/z” przyciskiem „Lista m/z” — każda wartość stanie się osobną kolumną.",
    "Zestawy grup m/z działają jak grafy: osobne zestawy kolumn per workspace, przełączane listą nad kolumnami.",
    "Ikonka (i) na node'ie otwiera jego opis w Dokumentacji — edycja opisu zmienia też podpowiedź na node'ie.",
  ];
  let tipIdx = $state(Math.floor(Math.random() * TIPS.length));

  onMount(async () => {
    if (!savedMapsLoaded()) { try { await loadSavedMaps(); } catch {} }
    if (!savedSpectraLoaded()) { try { await loadSavedSpectra(); } catch {} }
    pickFeatured();
  });

  // Obsługa natywnego menu Plik → Workspace (Tauri, src-tauri/src/lib.rs)
  onMount(() => {
    const unlisten = listen<string>("workspace-menu", (e) => {
      switch (e.payload) {
        case "new":    creating = true; break;
        case "open":   break; // przełączenie zakładki obsługuje +page.svelte
        case "import": doImport(); break;
        case "export": { const id = activeWorkspaceId(); if (id) doExport(id); break; }
      }
    });
    return () => { unlisten.then((f) => f()); };
  });
</script>

<div class="settings-tab">
  <header class="hero">
    <div class="hero-main">
      <div class="hero-eyebrow">Ustawienia</div>
      <h1 class="hero-title">{activeWorkspace()?.name ?? "praSzczur"}</h1>
      <div class="stat-row">
        {#each stats as st (st.label)}
          <div class="stat"><span class="stat-n">{st.n}</span><span class="stat-l">{st.label}</span></div>
        {/each}
      </div>
      <button class="tip" onclick={() => (tipIdx = (tipIdx + 1) % TIPS.length)} title="Następna wskazówka">
        <span class="tip-tag">Wskazówka</span>
        <span class="tip-text">{TIPS[tipIdx]}</span>
      </button>
    </div>

    <div class="featured">
      <div class="featured-head">
        <span class="featured-title">Z Twoich map</span>
        <button class="icon-btn" title="Losuj inną mapę" onclick={pickFeatured} disabled={mapCandidates.length === 0 || featuredLoading}>↻</button>
      </div>
      <div class="featured-canvas">
        {#if featuredMeta && featuredData}
          <IonCanvas
            tissue={{ label: featuredMeta.tissueLabel || featuredMeta.tissueId, data: featuredData.data, mask: featuredData.mask, width: featuredMeta.width, height: featuredMeta.height, vmax: featuredMeta.vmax }}
            dispMin={0} dispMax={1} invertColors={false} showColorbar={false} showVmax={false} compact
          />
        {:else if featuredLoading}
          <div class="featured-empty">Ładowanie…</div>
        {:else}
          <div class="featured-empty">Zapisz mapę m/z (💾 w zakładce m/z), a pojawi się tutaj.</div>
        {/if}
      </div>
      {#if featuredMeta}
        <div class="featured-caption">
          <span class="featured-name">{featuredMeta.name}</span>
          <span class="featured-sub">{featuredCaption(featuredMeta)}</span>
        </div>
      {/if}
    </div>
  </header>

  <div class="settings-grid">
  <div class="col">
  <div class="card">
    <div class="card-header">
      <span class="card-title">Workspace</span>
      <div class="header-actions">
        <button class="btn-secondary" onclick={doImport} disabled={busy}>↓ Importuj</button>
        <button class="btn-primary-sm" onclick={() => (creating = !creating)} disabled={busy}>+ Nowy</button>
      </div>
    </div>

    {#if creating}
      <div class="create-row">
        <input class="field-input" type="text" placeholder="nazwa workspace" bind:value={newName}
               onkeydown={(e) => e.key === "Enter" && doCreate()} />
        <button class="btn-primary-sm" onclick={doCreate} disabled={busy || !newName.trim()}>Utwórz</button>
        <button class="btn-secondary" onclick={() => { creating = false; newName = ""; }}>Anuluj</button>
      </div>
    {/if}

    {#if errorMsg}<div class="error-msg">⚠ {errorMsg}</div>{/if}

    <div class="ws-list">
      {#each workspaces() as w}
        {@const isActive = w.id === activeWorkspaceId()}
        <div class="ws-row" class:active={isActive}>
          <span class="ws-dot" class:on={isActive}></span>
          {#if renamingId === w.id}
            <input class="field-input rename-input" type="text" bind:value={renameVal}
                   onkeydown={(e) => e.key === "Enter" && commitRename()}
                   onblur={commitRename} />
          {:else}
            <button class="ws-name" onclick={() => doSwitch(w.id)} disabled={busy || isActive}>
              {w.name}{#if isActive}<span class="ws-active-badge">aktywny</span>{/if}
            </button>
          {/if}
          <span class="ws-meta">zmieniony {fmtDate(w.updatedAt)}</span>
          <div class="ws-actions">
            <button class="icon-btn" title="Zmień nazwę" onclick={() => startRename(w.id, w.name)}>✎</button>
            <button class="icon-btn" title="Eksportuj" onclick={() => doExport(w.id)}>↑</button>
            <button class="icon-btn del" title="Usuń" onclick={() => askDelete(w.id, w.name)} disabled={workspaces().length <= 1}>×</button>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <span class="card-title">Zestawy danych</span>
      <div class="header-actions">
        <button class="btn-primary-sm" onclick={() => (dsCreating = !dsCreating)} disabled={dsBusy}>+ Nowy</button>
      </div>
    </div>

    {#if dsCreating}
      <div class="create-row">
        <input class="field-input" type="text" placeholder="nazwa zestawu" bind:value={dsNewName}
               onkeydown={(e) => e.key === "Enter" && dsDoCreate()} />
        <button class="btn-primary-sm" onclick={dsDoCreate} disabled={dsBusy || !dsNewName.trim()}>Utwórz</button>
        <button class="btn-secondary" onclick={() => { dsCreating = false; dsNewName = ""; }}>Anuluj</button>
      </div>
    {/if}

    {#if dsError}<div class="error-msg">⚠ {dsError}</div>{/if}

    <div class="ws-list">
      {#each datasets() as d}
        {@const isActive = d.id === activeDatasetId()}
        <div class="ws-row" class:active={isActive}>
          <span class="ws-dot" class:on={isActive}></span>
          {#if dsRenamingId === d.id}
            <input class="field-input rename-input" type="text" bind:value={dsRenameVal}
                   onkeydown={(e) => e.key === "Enter" && dsCommitRename()}
                   onblur={dsCommitRename} />
          {:else}
            <button class="ws-name" onclick={() => dsDoActivate(d.id)} disabled={dsBusy || isActive}>
              {d.name}{#if isActive}<span class="ws-active-badge">aktywny</span>{/if}
            </button>
          {/if}
          <span class="ws-meta">{d.kind} · zmieniony {fmtDate(d.updatedAt)}</span>
          <div class="ws-actions">
            <button class="icon-btn" title="Zmień nazwę" onclick={() => dsStartRename(d.id, d.name)}>✎</button>
            <button class="icon-btn del" title="Usuń" onclick={() => dsAskDelete(d.id, d.name)}>×</button>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <span class="card-title">Node Graphy</span>
      <div class="header-actions">
        <button class="btn-primary-sm" onclick={() => (ngCreating = !ngCreating)} disabled={ngBusy}>+ Nowy</button>
      </div>
    </div>

    {#if ngCreating}
      <div class="create-row">
        <input class="field-input" type="text" placeholder="nazwa grafu" bind:value={ngNewName}
               onkeydown={(e) => e.key === "Enter" && ngDoCreate()} />
        <button class="btn-primary-sm" onclick={ngDoCreate} disabled={ngBusy || !ngNewName.trim()}>Utwórz</button>
        <button class="btn-secondary" onclick={() => { ngCreating = false; ngNewName = ""; }}>Anuluj</button>
      </div>
    {/if}

    {#if ngError}<div class="error-msg">⚠ {ngError}</div>{/if}

    <div class="ws-list">
      {#each nodeGraphs() as g (g.id)}
        <div class="ws-row">
          {#if ngRenamingId === g.id}
            <input class="field-input rename-input" type="text" bind:value={ngRenameVal}
                   onkeydown={(e) => e.key === "Enter" && ngCommitRename()}
                   onblur={ngCommitRename} />
          {:else}
            <span class="ws-name">{g.name}</span>
          {/if}
          <span class="ws-meta">zmieniony {fmtDate(g.updatedAt)}</span>
          <div class="ws-actions">
            <button class="icon-btn" title="Zmień nazwę" onclick={() => ngStartRename(g.id, g.name)}>✎</button>
            <button class="icon-btn del" title="Usuń" onclick={() => ngAskDelete(g.id, g.name)}>×</button>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <span class="card-title">Zestawy grup m/z</span>
      <div class="header-actions">
        <button class="btn-primary-sm" onclick={() => (gsCreating = !gsCreating)}>+ Nowy</button>
      </div>
    </div>

    {#if gsCreating}
      <div class="create-row">
        <input class="field-input" type="text" placeholder="nazwa zestawu" bind:value={gsNewName}
               onkeydown={(e) => e.key === "Enter" && gsDoCreate()} />
        <button class="btn-primary-sm" onclick={gsDoCreate} disabled={!gsNewName.trim()}>Utwórz</button>
        <button class="btn-secondary" onclick={() => { gsCreating = false; gsNewName = ""; }}>Anuluj</button>
      </div>
    {/if}

    <div class="ws-list">
      {#each groupSets() as g (g.id)}
        <div class="ws-row">
          {#if gsRenamingId === g.id}
            <input class="field-input rename-input" type="text" bind:value={gsRenameVal}
                   onkeydown={(e) => e.key === "Enter" && gsCommitRename()}
                   onblur={gsCommitRename} />
          {:else}
            <span class="ws-name">{g.name}</span>
          {/if}
          <span class="ws-meta">zmieniony {fmtDate(g.updatedAt)}</span>
          <div class="ws-actions">
            <button class="icon-btn" title="Zmień nazwę" onclick={() => gsStartRename(g.id, g.name)}>✎</button>
            <button class="icon-btn del" title="Usuń" onclick={() => (gsDeleteTarget = { id: g.id, name: g.name })}>×</button>
          </div>
        </div>
      {/each}
    </div>
  </div>

  </div>

  <div class="col">
  <div class="card">
    <div class="card-header">
      <span class="card-title">Format listy m/z</span>
    </div>
    <div class="field-group">
      <label class="field-label" for="mzlist-decimals">Miejsca po przecinku: {mzListDecimals()}</label>
      <input id="mzlist-decimals" type="range" min={MZ_LIST_DECIMALS_MIN} max={MZ_LIST_DECIMALS_MAX} step="1"
             value={mzListDecimals()}
             oninput={(e) => setMzListDecimals(Number((e.target as HTMLInputElement).value))} />
    </div>
    <div class="canvas-hint">
      Zaokrąglenie wartości w liście "[m1;m2;…]" z node'ów "Lista m/z (próg)" i "Top m/z".
      Podgląd: {formatMzListText([323.44567, 512.30123, 700.07891], mzListDecimals())}.
      Dotyczy bieżącego workspace'u.
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <span class="card-title">Personalizacja</span>
    </div>
    <div class="field-group">
      <label class="field-label" for="colormap-select">Tablica kolorów map m/z (lookup table)</label>
      <select id="colormap-select" class="field-select" value={colormapId}
              onchange={(e) => setColormap((e.target as HTMLSelectElement).value)}>
        {#each COLORMAPS as c (c.id)}
          <option value={c.id}>{c.label}</option>
        {/each}
      </select>
      <div class="cmap-preview" style="background:{colormapGradientCss(colormapId)}"></div>
      <div class="cmap-scale"><span>niska intensywność</span><span>wysoka</span></div>
    </div>
    <div class="canvas-hint">
      Dotyczy wszystkich map m/z: zakładki m/z (pojedyncze, Grupy, Łączenie, Zapisane), panelu pikseli
      oraz map w Node Graph. Ustawienie wspólne dla wszystkich workspace'ów.
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <span class="card-title">Widok płótna</span>
    </div>
    <div class="field-group">
      <label class="field-label" for="canvas-zoom-sens">Czułość zoomu</label>
      <input id="canvas-zoom-sens" type="range" min="0.3" max="3" step="0.1" value={canvasZoomSensitivity}
             oninput={(e) => setCanvasZoomSens(Number((e.target as HTMLInputElement).value))} />
    </div>
    <div class="field-group">
      <label class="field-label" for="canvas-pan-sens">Czułość przesuwania</label>
      <input id="canvas-pan-sens" type="range" min="0.3" max="3" step="0.1" value={canvasPanSensitivity}
             oninput={(e) => setCanvasPanSens(Number((e.target as HTMLInputElement).value))} />
    </div>
    <div class="canvas-hint">Dotyczy wszystkich Node Graphów oraz Tablicy.</div>
  </div>
  </div>
  </div>
</div>

<ConfirmModal
  open={deleteTarget !== null}
  title="Usunąć workspace?"
  message={deleteTarget ? `Usunąć workspace "${deleteTarget.name}"? Tej operacji nie można cofnąć — wszystkie dane, przetworzone pliki i ustawienia zostaną trwale usunięte.` : ""}
  confirmLabel="Usuń"
  danger={true}
  onconfirm={confirmDelete}
  oncancel={() => (deleteTarget = null)}
/>

<ConfirmModal
  open={gsDeleteTarget !== null}
  title="Usunąć zestaw grup?"
  message={gsDeleteTarget ? `Zestaw "${gsDeleteTarget.name}" zostanie trwale usunięty razem z wszystkimi jego kolumnami m/z i zaznaczeniami. Tej operacji nie można cofnąć.` : ""}
  confirmLabel="Usuń"
  danger={true}
  onconfirm={gsConfirmDelete}
  oncancel={() => (gsDeleteTarget = null)}
/>

<ConfirmModal
  open={dsDeleteTarget !== null}
  title="Usunąć zestaw danych?"
  message={dsDeleteTarget ? `Zestaw "${dsDeleteTarget.name}" zostanie trwale usunięty razem z danymi. Tej operacji nie można cofnąć.` : ""}
  confirmLabel="Usuń"
  danger={true}
  onconfirm={dsConfirmDelete}
  oncancel={() => (dsDeleteTarget = null)}
/>

<ConfirmModal
  open={ngDeleteTarget !== null}
  title="Usunąć graf?"
  message={ngDeleteTarget ? `Graf "${ngDeleteTarget.name}" zostanie trwale usunięty razem z wszystkimi node'ami. Tej operacji nie można cofnąć.` : ""}
  confirmLabel="Usuń"
  danger={true}
  onconfirm={ngConfirmDelete}
  oncancel={() => (ngDeleteTarget = null)}
/>

<style>
  /* One-page: całe Ustawienia mieszczą się w oknie, bez przewijania strony i na pełną szerokość.
   * Długie listy (workspace'y, zestawy, grafy…) przewijają się wewnątrz swoich kart. */
  .settings-tab { flex: 1; min-height: 0; padding: 14px 18px; overflow: hidden; display: flex; flex-direction: column; gap: 14px; box-sizing: border-box; }

  /* ── Nagłówek: tytuł + statystyki + wskazówka (lewo), losowa mapa (prawo) ── */
  .hero {
    flex-shrink: 0; width: 100%; box-sizing: border-box;
    display: grid; grid-template-columns: minmax(0, 1fr) 270px; gap: 20px; align-items: stretch;
    padding: 12px 16px; border-radius: 14px;
    background: linear-gradient(135deg, rgba(255,201,81,0.09), rgba(255,255,255,0.025) 55%);
    border: 1px solid rgba(255,201,81,0.16);
  }
  .hero-main { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .hero-eyebrow { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #ffc951; }
  .hero-title { margin: 0; font-size: 1.3rem; font-weight: 700; color: #f2f2f2; line-height: 1.15; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stat-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .stat {
    display: flex; flex-direction: column; min-width: 86px; padding: 5px 12px;
    background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.08); border-radius: 9px;
  }
  .stat-n { font-size: 1.15rem; font-weight: 700; color: #ffc951; line-height: 1.1; }
  .stat-l { font-size: 0.58rem; color: rgba(255,255,255,0.45); letter-spacing: 0.03em; }
  .tip {
    margin-top: auto; display: flex; gap: 10px; align-items: baseline; text-align: left;
    background: rgba(0,0,0,0.22); border: 1px dashed rgba(255,255,255,0.13); border-radius: 9px;
    padding: 6px 12px; cursor: pointer; font-family: inherit; color: rgba(255,255,255,0.6);
    transition: border-color 0.15s, color 0.15s;
  }
  .tip:hover { border-color: rgba(255,201,81,0.45); color: rgba(255,255,255,0.85); }
  .tip-tag { flex-shrink: 0; font-size: 0.55rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #ffc951; }
  .tip-text { font-size: 0.68rem; line-height: 1.4; }

  .featured {
    display: flex; flex-direction: column; gap: 6px; min-width: 0;
    background: #1a1a1a; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 8px 10px 10px;
  }
  .featured-head { display: flex; align-items: center; }
  .featured-title { flex: 1; font-size: 0.58rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.4); }
  .featured-canvas { height: 104px; display: flex; border-radius: 8px; overflow: hidden; background: #111; }
  .featured-canvas :global(.card) { flex: 1; min-height: 0; border-radius: 8px; box-shadow: none; }
  .featured-empty {
    flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
    padding: 12px; font-size: 0.64rem; line-height: 1.4; color: rgba(255,255,255,0.35);
  }
  .featured-caption { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .featured-name { font-size: 0.72rem; font-weight: 600; color: #e6e6e6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .featured-sub { font-size: 0.6rem; color: rgba(255,255,255,0.4); }

  /* ── Dwie kolumny: projekt (workspace/dane/grafy/grupy) | wygląd i zachowanie ── */
  /* Siatka 12 kolumn × 2 wiersze: góra = 4 karty z listami (po 3 kol.), dół = 3 karty z
   * ustawieniami (po 4 kol.). Wrappery .col to tylko grupowanie w markupie (display: contents),
   * karty są bezpośrednimi elementami siatki. */
  .settings-grid {
    flex: 1; min-height: 0; width: 100%;
    display: grid; grid-template-columns: repeat(12, minmax(0, 1fr));
    grid-template-rows: minmax(0, 1fr) auto; gap: 14px;
  }
  .col { display: contents; }
  .col:first-child > .card { grid-column: span 3; }
  .col:last-child > .card { grid-column: span 4; }

  .card {
    background: #222; border: 1px solid rgba(255,255,255,0.07);
    border-radius: 12px; padding: 12px 14px;
    display: flex; flex-direction: column; min-height: 0; min-width: 0;
  }
  .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-shrink: 0; }
  .card-title {
    font-size: 0.8rem; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: rgba(255,255,255,0.5); flex: 1;
  }
  .header-actions { display: flex; gap: 6px; }

  .btn-primary-sm {
    padding: 5px 11px; background: rgba(255,201,81,0.15);
    border: 1px solid rgba(255,201,81,0.3); border-radius: 7px;
    color: #ffc951; font-size: 0.7rem; font-weight: 600; cursor: pointer; font-family: inherit;
  }
  .btn-primary-sm:hover:not(:disabled) { background: rgba(255,201,81,0.25); }
  .btn-primary-sm:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-secondary {
    padding: 5px 10px; background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 7px;
    color: rgba(255,255,255,0.55); font-size: 0.7rem; cursor: pointer; font-family: inherit;
  }
  .btn-secondary:hover:not(:disabled) { border-color: rgba(255,201,81,0.3); color: #ffc951; }
  .btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }

  .create-row { display: flex; gap: 6px; margin-bottom: 10px; }
  .field-input {
    flex: 1; background: #1a1a1a; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px; color: #f0f0f0; font-size: 0.75rem; padding: 6px 9px;
    outline: none; font-family: inherit;
  }
  .field-input:focus { border-color: #ffc951; }

  .field-select {
    width: 100%; background: #1a1a1a; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px; color: #f0f0f0; font-size: 0.75rem; padding: 6px 9px;
    outline: none; font-family: inherit; cursor: pointer; box-sizing: border-box;
  }
  .field-select:hover, .field-select:focus { border-color: rgba(255,201,81,0.5); }
  .field-select option { background: #1a1a1a; color: #e0e0e0; }
  .cmap-preview {
    height: 14px; border-radius: 4px; margin-top: 8px;
    border: 1px solid rgba(255,255,255,0.12);
  }
  .cmap-scale {
    display: flex; justify-content: space-between; margin-top: 3px;
    font-size: 0.58rem; color: rgba(255,255,255,0.35);
  }

  .error-msg { font-size: 0.68rem; color: #ff8080; margin-bottom: 8px; }

  .ws-list { display: flex; flex-direction: column; gap: 5px; flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.12) transparent; }
  .ws-row {
    display: flex; align-items: center; gap: 8px; flex-shrink: 0; min-width: 0;
    padding: 7px 10px; background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07); border-radius: 8px;
  }
  .ws-row.active { border-color: rgba(255,201,81,0.3); background: rgba(255,201,81,0.05); }

  .ws-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,0.15); flex-shrink: 0; }
  .ws-dot.on { background: #ffc951; box-shadow: 0 0 6px rgba(255,201,81,0.6); }

  .ws-name {
    background: none; border: none; color: #e0e0e0; font-size: 0.78rem;
    font-weight: 600; font-family: inherit; cursor: pointer; text-align: left;
    padding: 0; display: flex; align-items: center; gap: 6px;
    min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  .ws-name:disabled { cursor: default; color: #ffc951; }
  .ws-active-badge {
    font-size: 0.55rem; padding: 1px 6px; border-radius: 10px;
    background: rgba(255,201,81,0.15); color: #ffc951; font-weight: 700;
  }

  .rename-input { max-width: 200px; }

  .ws-meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.6rem; color: rgba(255,255,255,0.25); text-align: right; }

  .ws-actions { display: flex; gap: 2px; flex-shrink: 0; }
  .icon-btn {
    background: none; border: none; color: rgba(255,255,255,0.3);
    cursor: pointer; font-size: 0.8rem; padding: 3px 6px; border-radius: 5px; font-family: inherit;
  }
  .icon-btn:hover:not(:disabled) { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.8); }
  .icon-btn.del:hover:not(:disabled) { color: #ff6b6b; }
  .icon-btn:disabled { opacity: 0.2; cursor: not-allowed; }

  .field-group { margin-bottom: 12px; }
  .field-label {
    display: block; font-size: 0.62rem; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: rgba(255,255,255,0.35); margin-bottom: 5px;
  }
  .canvas-hint { font-size: 0.66rem; color: rgba(255,255,255,0.3); }

  /* Suwaki — ten sam cienki track + okrągły uchwyt co w BoardSidebar/m/z. */
  input[type="range"] {
    -webkit-appearance: none; appearance: none; width: 100%; height: 16px;
    background: transparent; outline: none; border: none; padding: 0; margin: 0; cursor: pointer;
  }
  input[type="range"]::-webkit-slider-runnable-track { background: rgba(255,255,255,0.1); border-radius: 3px; height: 6px; }
  input[type="range"]::-moz-range-track { background: rgba(255,255,255,0.1); border-radius: 3px; height: 6px; }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%;
    background: #ffc951; border: 2px solid #1a1a1a; box-shadow: 0 1px 6px rgba(0,0,0,0.5);
    cursor: pointer; margin-top: -5px; transition: transform 0.1s, box-shadow 0.1s;
  }
  input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.15); box-shadow: 0 0 0 4px rgba(255,201,81,0.2); }
  input[type="range"]::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #ffc951; border: 2px solid #1a1a1a; cursor: pointer; }
</style>
