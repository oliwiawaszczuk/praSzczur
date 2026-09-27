<script lang="ts">
  // Modal "Lista m/z" w zakładce m/z → Grupy (WieleMz.svelte) — wklejenie
  // listy w formacie "[m1;m2;...]" (ten sam format co produkuje węzeł
  // "Lista m/z (próg)" w Node Graph, patrz nodegraph.widmo.ts/mzListFormat.ts)
  // tworzy po kliknięciu "Zatwierdź" jedną grupę (kolumnę) per m/z, wszystkie
  // z tym samym wybranym zestawem danych.
  import { datasets, activeDatasetId, RAW_DATASET_ID } from "$lib/datasets.svelte";
  import { addGroupsFromMzList } from "$lib/mzGroups.svelte";
  import { parseMzListText } from "$lib/mzListFormat";

  interface Props {
    open?: boolean;
    tolDefault?: number;
    onclose?: () => void;
  }
  let { open = false, tolDefault = 0.3, onclose }: Props = $props();

  let text = $state("");
  let dataset = $state(RAW_DATASET_ID);
  let error = $state("");

  // Reset przy każdym otwarciu — modal nie ma sensu zachowywać wpisanego
  // tekstu po zatwierdzeniu/zamknięciu (inny wzorzec niż zapamiętane pola
  // formularza per-workspace — to jednorazowy formularz wsadowy).
  $effect(() => {
    if (open) { text = ""; dataset = RAW_DATASET_ID; error = ""; }
  });

  function close() { onclose?.(); }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  function submit() {
    const values = parseMzListText(text);
    if (values.length === 0) { error = "Podaj przynajmniej jedną wartość m/z."; return; }
    addGroupsFromMzList(values, dataset, tolDefault);
    close();
  }
</script>

{#if open}
  <div class="modal-backdrop" onclick={close} onkeydown={onKeydown} role="presentation">
    <div class="modal-box" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-header">
        <span class="modal-title">Lista m/z</span>
        <button class="close-btn" onclick={close}>×</button>
      </div>
      <p class="modal-hint">
        Wklej listę m/z w formacie <code>[323.44;989.3]</code> (nawiasy opcjonalne,
        separator „;” albo biały znak) — każda wartość utworzy własną grupę.
      </p>

      <label class="field-label" for="mzlist-ds">Zestaw danych</label>
      <select id="mzlist-ds" class="ds-select" bind:value={dataset}>
        <option value={RAW_DATASET_ID}>Dane oryginalne</option>
        {#each datasets() as d}
          <option value={d.id}>{d.name}{d.id === activeDatasetId() ? " (aktywny)" : ""}</option>
        {/each}
      </select>

      <label class="field-label" for="mzlist-text" style="margin-top:10px">Lista m/z</label>
      <textarea
        id="mzlist-text"
        class="mzlist-input"
        rows="4"
        placeholder="[323.44;989.3;...]"
        bind:value={text}
        onkeydown={(e) => e.stopPropagation()}
      ></textarea>
      {#if error}<span class="error-msg">{error}</span>{/if}

      <div class="modal-actions">
        <button class="btn-cancel" onclick={close}>Anuluj</button>
        <button class="btn-confirm" onclick={submit}>Zatwierdź</button>
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
    max-width: 400px; width: calc(100vw - 40px);
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
  .modal-hint code {
    background: rgba(255,255,255,0.08); border-radius: 4px; padding: 1px 5px;
    color: #ffc951; font-size: 0.66rem;
  }

  .field-label {
    display: block; font-size: 0.62rem; font-weight: 600;
    letter-spacing: 0.09em; text-transform: uppercase;
    color: rgba(255,255,255,0.38); margin-bottom: 5px;
  }

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

  .mzlist-input {
    width: 100%; background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.1); border-radius: 7px;
    color: #f0f0f0; font-size: 0.75rem; font-family: "SF Mono", Menlo, monospace;
    padding: 8px 9px; outline: none; box-sizing: border-box;
    resize: vertical; line-height: 1.4;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .mzlist-input:focus {
    border-color: #ffc951; box-shadow: 0 0 0 2px rgba(255,201,81,0.15);
  }

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
