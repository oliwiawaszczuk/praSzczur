<script lang="ts">
  // Modal "Zmień wszystkie" w zakładce m/z → Grupy (WieleMz.svelte) — ustawia zestaw danych
  // i/lub tolerancję WSZYSTKIM kolumnom aktywnego zestawu grup naraz (updateAllGroups) i od
  // nowa odpytuje kolumny z wpisanym m/z. Wygląd 1:1 z MzListModal.svelte.
  import { datasets, activeDatasetId, RAW_DATASET_ID, sanitizeDatasetId } from "$lib/datasets.svelte";
  import { allGroups, updateAllGroups } from "$lib/mzGroups.svelte";

  interface Props {
    open?: boolean;
    tolDefault?: number;
    onclose?: () => void;
  }
  let { open = false, tolDefault = 0.3, onclose }: Props = $props();

  let changeDataset = $state(true);
  let changeTol = $state(true);
  let dataset = $state(RAW_DATASET_ID);
  let tol = $state(0.3);
  let error = $state("");

  // Przy otwarciu: wartości startowe z pierwszej kolumny (zwykle wszystkie mają te same).
  $effect(() => {
    if (!open) return;
    const first = allGroups()[0];
    dataset = sanitizeDatasetId(first?.dataset ?? RAW_DATASET_ID);
    tol = first?.tol ?? tolDefault;
    changeDataset = true;
    changeTol = true;
    error = "";
  });

  const count = $derived(allGroups().length);
  const withMz = $derived(allGroups().filter((g) => g.mz !== null).length);

  function close() { onclose?.(); }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  function submit() {
    if (!changeDataset && !changeTol) { error = "Zaznacz, co zmienić."; return; }
    const t = Number(tol);
    if (changeTol && (!Number.isFinite(t) || t < 0)) { error = "Tolerancja musi być liczbą nie mniejszą niż 0."; return; }
    updateAllGroups({ dataset: changeDataset ? dataset : undefined, tol: changeTol ? t : undefined });
    close();
  }
</script>

{#if open}
  <div class="modal-backdrop" onclick={close} onkeydown={onKeydown} role="presentation">
    <div class="modal-box" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-header">
        <span class="modal-title">Zmień wszystkie kolumny</span>
        <button class="close-btn" onclick={close}>×</button>
      </div>
      <p class="modal-hint">
        Ustawia wybrane pola we wszystkich {count} kolumnach tego zestawu grup.
        {withMz > 0 ? `${withMz} kolumn z wpisanym m/z zostanie wczytanych ponownie.` : ""}
      </p>

      <div class="ds-row">
        <div class="ds-col">
          <label class="check-label">
            <input type="checkbox" bind:checked={changeDataset} />
            <span class="field-label">Zestaw danych</span>
          </label>
          <select class="ds-select" bind:value={dataset} disabled={!changeDataset}>
            <option value={RAW_DATASET_ID}>Dane oryginalne</option>
            {#each datasets() as d}
              <option value={d.id}>{d.name}{d.id === activeDatasetId() ? " (aktywny)" : ""}</option>
            {/each}
          </select>
        </div>
        <div class="tol-col">
          <label class="check-label">
            <input type="checkbox" bind:checked={changeTol} />
            <span class="field-label">Tolerancja ±[Da]</span>
          </label>
          <input class="tol-input" type="number" min="0" step="0.01" bind:value={tol} disabled={!changeTol}
                 onkeydown={(e) => { e.stopPropagation(); if (e.key === "Enter") submit(); }} />
        </div>
      </div>
      {#if error}<span class="error-msg">{error}</span>{/if}

      <div class="modal-actions">
        <button class="btn-cancel" onclick={close}>Anuluj</button>
        <button class="btn-confirm" onclick={submit}>Zastosuj do wszystkich</button>
      </div>
    </div>
  </div>
{/if}


<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    z-index: 2000; display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(3px); animation: fade-in 0.15s ease;
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

  .modal-box {
    background: #262626; border: 1px solid rgba(255,201,81,0.18);
    border-radius: 12px; padding: 18px 20px;
    max-width: 440px; width: calc(100vw - 40px);
    box-shadow: 0 24px 60px rgba(0,0,0,0.5);
    animation: modal-in 0.16s ease;
    display: flex; flex-direction: column;
  }
  @keyframes modal-in {
    from { opacity: 0; transform: scale(0.95); }
    to   { opacity: 1; transform: scale(1); }
  }

  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .modal-title { font-size: 0.88rem; font-weight: 700; color: #ffc951; }
  .close-btn {
    background: none; border: none; color: rgba(255,255,255,0.4);
    font-size: 1.2rem; line-height: 1; cursor: pointer; padding: 2px 6px;
    border-radius: 6px; font-family: inherit;
  }
  .close-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }

  .modal-hint {
    font-size: 0.68rem; line-height: 1.5; color: rgba(255,255,255,0.45);
    margin: 0 0 14px;
  }

  .field-label {
    display: block; font-size: 0.62rem; font-weight: 600;
    letter-spacing: 0.09em; text-transform: uppercase;
    color: rgba(255,255,255,0.38); margin-bottom: 5px;
  }

  .ds-row { display: flex; gap: 10px; align-items: flex-end; }
  .check-label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .check-label input { accent-color: #ffc951; margin: 0 0 5px; }
  .tol-col { width: 130px; }
  .ds-select:disabled, .tol-input:disabled { opacity: 0.4; cursor: not-allowed; }
  .ds-col { flex: 1; min-width: 0; }
  .tol-col { width: 110px; flex-shrink: 0; }
  .tol-input {
    width: 100%;
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.72rem;
    padding: 5px 8px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .tol-input:hover { border-color: rgba(255,201,81,0.3); }
  .tol-input:focus { border-color: #ffc951; box-shadow: 0 0 0 2px rgba(255,201,81,0.15); }

  .ds-select {
    width: 100%;
    appearance: none; -webkit-appearance: none; -moz-appearance: none;
    background: #1a1a1a
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23ffc951' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>")
      no-repeat right 8px center;
    background-size: 9px 6px;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.72rem;
    padding: 5px 22px 5px 8px;
    font-family: inherit;
    cursor: pointer;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s, color 0.15s;
  }
  .ds-select:hover  { border-color: rgba(255,201,81,0.3); color: #ffc951; }
  .ds-select option { background: #1a1a1a; color: #e0e0e0; }


  .error-msg { font-size: 0.66rem; color: #ff7070; margin-top: 6px; display: block; }

  .modal-actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;
  }
  .btn-cancel {
    padding: 6px 13px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px;
    color: rgba(255,255,255,0.55);
    font-size: 0.72rem;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, color 0.15s;
  }
  .btn-cancel:hover { border-color: rgba(255,255,255,0.25); color: rgba(255,255,255,0.85); }
  .btn-confirm {
    padding: 6px 13px;
    background: rgba(255,201,81,0.15);
    border: 1px solid rgba(255,201,81,0.3);
    border-radius: 7px;
    color: #ffc951;
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s;
  }
  .btn-confirm:hover { background: rgba(255,201,81,0.25); }
</style>
