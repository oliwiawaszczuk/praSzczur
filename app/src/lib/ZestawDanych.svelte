<script lang="ts">
  import { onMount } from "svelte";
  import ConfirmModal from "$lib/ConfirmModal.svelte";
  import PreNodesEditor from "$lib/PreNodesEditor.svelte";
  import {
    datasets, loadDatasets, datasetsLoaded, activeDatasetId,
    createDataset, renameDataset, deleteDataset,
    consumePendingSelectDataset, type DatasetMeta,
  } from "$lib/datasets.svelte";

  interface Props { visible?: boolean; }
  let { visible = true }: Props = $props();

  onMount(async () => {
    if (!datasetsLoaded()) await loadDatasets();
    const pending = consumePendingSelectDataset();
    selectedId = pending || activeDatasetId() || datasets()[0]?.id || "";
  });

  let selectedId = $state("");
  let newName = $state("");
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");
  let confirmDeleteId = $state<string | null>(null);

  function selectDataset(id: string) {
    selectedId = id;
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const ds = await createDataset(name, "binned");
    newName = "";
    selectedId = ds.id;
  }

  function startRename(d: DatasetMeta) {
    renamingId = d.id;
    renameValue = d.name;
  }
  async function commitRename() {
    if (renamingId && renameValue.trim()) {
      await renameDataset(renamingId, renameValue.trim());
    }
    renamingId = null;
  }

  function requestDelete(id: string) {
    confirmDeleteId = id;
  }
  async function confirmDelete() {
    const id = confirmDeleteId;
    confirmDeleteId = null;
    if (!id) return;
    await deleteDataset(id);
    if (selectedId === id) selectedId = activeDatasetId() || datasets()[0]?.id || "";
  }

  function chainSummary(d: DatasetMeta): string {
    if (d.id === "original") return "Dane oryginalne → Wynik";
    if (!d.steps || d.steps.length === 0) return d.kind === "empty" ? "pusty zestaw" : "brak zapisanego łańcucha";
    const src = d.source_dataset_id === "__raw__" ? "Dane oryginalne" : (d.source_dataset_id ?? "?");
    return `${src} → ` + d.steps.map((s) => s.method).join(" → ");
  }
</script>

<div class="zd-layout">
  <aside class="zd-list">
    <div class="zd-new">
      <input type="text" placeholder="nazwa nowego zestawu…" bind:value={newName}
             onkeydown={(e) => e.key === "Enter" && handleCreate()} />
      <button onclick={handleCreate} disabled={!newName.trim()}>+ Nowy zestaw</button>
    </div>
    <div class="zd-items">
      {#each datasets() as d (d.id)}
        <div class="zd-item" class:active={d.id === selectedId} onclick={() => selectDataset(d.id)}>
          {#if renamingId === d.id}
            <input class="zd-rename-input" type="text" bind:value={renameValue}
                   onblur={commitRename}
                   onkeydown={(e) => e.key === "Enter" && commitRename()}
                   onclick={(e) => e.stopPropagation()} autofocus />
          {:else}
            <div class="zd-item-head">
              <span class="zd-item-name">{d.name}</span>
            </div>
            <div class="zd-item-chain">{chainSummary(d)}</div>
            <div class="zd-item-actions" onclick={(e) => e.stopPropagation()}>
              {#if d.id !== "original"}
                <button onclick={() => startRename(d)}>Zmień nazwę</button>
                <button class="danger" onclick={() => requestDelete(d.id)}>Usuń</button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </aside>

  <section class="zd-editor">
    {#if selectedId}
      <PreNodesEditor datasetId={selectedId} {visible} />
    {:else}
      <div class="zd-empty">Wybierz albo utwórz zestaw danych.</div>
    {/if}
  </section>
</div>

<ConfirmModal
  open={confirmDeleteId !== null}
  title="Usuń zestaw danych"
  message="Czy na pewno chcesz usunąć ten zestaw? Tej operacji nie da się cofnąć."
  confirmLabel="Usuń"
  danger
  onconfirm={confirmDelete}
  oncancel={() => (confirmDeleteId = null)}
/>

<style>
  .zd-layout {
    display: flex;
    gap: 14px;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
  }

  .zd-list {
    width: 280px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    /* Taki sam odstęp od góry/lewej/dołu jak odstęp do edytora po prawej
       (flex `gap` w .zd-layout) — bez tego lista przylegała do krawędzi zakładki. */
    padding: 14px 0 14px 14px;
    box-sizing: border-box;
  }

  .zd-new {
    display: flex;
    gap: 6px;
  }
  .zd-new input {
    flex: 1;
    min-width: 0;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.72rem;
    font-family: inherit;
    padding: 6px 8px;
  }
  .zd-new button {
    background: rgba(255,201,81,0.12);
    border: 1px solid rgba(255,201,81,0.4);
    border-radius: 6px;
    color: #ffc951;
    font-size: 0.68rem;
    font-weight: 700;
    padding: 6px 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .zd-new button:disabled { opacity: 0.4; cursor: not-allowed; }

  .zd-items {
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
  }

  .zd-item {
    background: #222;
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 8px;
    padding: 8px 10px;
    cursor: pointer;
  }
  .zd-item.active { border-color: rgba(255,201,81,0.5); }

  .zd-item-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .zd-item-name {
    font-size: 0.74rem;
    font-weight: 700;
    color: #f0f0f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .zd-item-chain {
    margin-top: 4px;
    font-size: 0.62rem;
    color: rgba(255,255,255,0.4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .zd-item-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .zd-item-actions button {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 5px;
    color: rgba(255,255,255,0.7);
    font-size: 0.6rem;
    padding: 3px 7px;
    cursor: pointer;
    font-family: inherit;
  }
  .zd-item-actions button.danger { color: #ff6b6b; border-color: rgba(255,107,107,0.3); }
  .zd-rename-input {
    width: 100%;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,201,81,0.4);
    border-radius: 5px;
    color: #e0e0e0;
    font-size: 0.72rem;
    font-family: inherit;
    padding: 4px 6px;
    box-sizing: border-box;
  }

  .zd-editor {
    flex: 1;
    min-width: 0;
  }

  .zd-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: rgba(255,255,255,0.35);
    font-size: 0.78rem;
  }
</style>
