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
  open={dsDeleteTarget !== null}
  title="Usunąć zestaw danych?"
  message={dsDeleteTarget ? `Zestaw "${dsDeleteTarget.name}" zostanie trwale usunięty razem z danymi. Tej operacji nie można cofnąć.` : ""}
  confirmLabel="Usuń"
  danger={true}
  onconfirm={dsConfirmDelete}
  oncancel={() => (dsDeleteTarget = null)}
/>

<style>
  .settings-tab { flex: 1; min-height: 0; padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
  .card {
    background: #222; border: 1px solid rgba(255,255,255,0.07);
    border-radius: 12px; padding: 14px 16px; max-width: 640px;
  }
  .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
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

  .error-msg { font-size: 0.68rem; color: #ff8080; margin-bottom: 8px; }

  .ws-list { display: flex; flex-direction: column; gap: 5px; }
  .ws-row {
    display: flex; align-items: center; gap: 8px;
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
  }
  .ws-name:disabled { cursor: default; color: #ffc951; }
  .ws-active-badge {
    font-size: 0.55rem; padding: 1px 6px; border-radius: 10px;
    background: rgba(255,201,81,0.15); color: #ffc951; font-weight: 700;
  }

  .rename-input { max-width: 200px; }

  .ws-meta { flex: 1; font-size: 0.6rem; color: rgba(255,255,255,0.25); text-align: right; }

  .ws-actions { display: flex; gap: 2px; flex-shrink: 0; }
  .icon-btn {
    background: none; border: none; color: rgba(255,255,255,0.3);
    cursor: pointer; font-size: 0.8rem; padding: 3px 6px; border-radius: 5px; font-family: inherit;
  }
  .icon-btn:hover:not(:disabled) { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.8); }
  .icon-btn.del:hover:not(:disabled) { color: #ff6b6b; }
  .icon-btn:disabled { opacity: 0.2; cursor: not-allowed; }
</style>
