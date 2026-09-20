<script lang="ts">
  import "@fontsource/jetbrains-mono/400.css";
  import "@fontsource/jetbrains-mono/600.css";
  import DualRange from "./DualRange.svelte";

  type Tab = "dane" | "mz" | "ustawienia";

  interface Props {
    loading?: boolean;
    activeTab?: Tab;
    onquery?: (args: { mz: number; tol: number }) => void;
    dispMin?: number;
    dispMax?: number;
    ondisprange?: (min: number, max: number) => void;
    mzMin?: number;
    mzMax?: number;
  }

  let {
    loading = false,
    activeTab = "mz",
    onquery,
    dispMin = 0,
    dispMax = 1,
    ondisprange,
    mzMin = 0,
    mzMax = Infinity,
  }: Props = $props();

  interface MzEntry { name: string; mz: number; }

  const STORAGE_KEY = "praSzczur_mzList";

  function loadList(): MzEntry[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw) as MzEntry[];
    } catch {}
    return [];
  }

  function saveList(list: MzEntry[]) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
  }

  const DEFAULT_TOL = 0.3;
  let mzInput    = $state("");
  let tol        = $state(DEFAULT_TOL);
  let mzError    = $state("");
  let mzList     = $state<MzEntry[]>(loadList());
  let selectedIdx = $state<number | null>(null);
  let newName    = $state("");
  let newMz      = $state("");
  let addError   = $state("");

  function validateMz(val: string): number | null {
    const mz = parseFloat(val);
    const lo = mzMin > 0 ? mzMin : 0;
    const hi = isFinite(mzMax) ? mzMax : Infinity;
    if (isNaN(mz) || mz < lo || (isFinite(hi) && mz > hi)) return null;
    return mz;
  }

  function submit() {
    const mz = validateMz(mzInput);
    if (mz === null) {
      const lo = mzMin > 0 ? mzMin : 0;
      const hi = isFinite(mzMax) ? mzMax : Infinity;
      mzError = isFinite(hi)
        ? `Wartość m/z: ${lo.toFixed(0)}–${hi.toFixed(0)} Da`
        : "Podaj prawidłową wartość m/z";
      return;
    }
    mzError = "";
    onquery?.({ mz, tol });
  }

  function selectEntry(i: number) {
    selectedIdx = i;
    mzInput = mzList[i].mz.toString();
    mzError = "";
    onquery?.({ mz: mzList[i].mz, tol });
  }

  function removeEntry(i: number) {
    mzList = mzList.filter((_, idx) => idx !== i);
    saveList(mzList);
    if (selectedIdx === i) selectedIdx = null;
    else if (selectedIdx !== null && selectedIdx > i) selectedIdx--;
  }

  function addEntry() {
    const mz = validateMz(newMz);
    if (mz === null) { addError = "Nieprawidłowa wartość m/z"; return; }
    if (!newName.trim()) { addError = "Podaj nazwę"; return; }
    addError = "";
    mzList = [...mzList, { name: newName.trim(), mz }];
    saveList(mzList);
    newName = "";
    newMz = "";
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") submit();
  }

  function onInputChange() {
    selectedIdx = null;
  }
</script>

<aside class="sidebar">
  <!-- Logo -->
  <div class="logo-area">
    <span class="logo-mark">⬡</span>
    <span class="app-name">praSzczur</span>
  </div>

  <!-- ── Zakładka: m/z ─────────────────────────────── -->
  {#if activeTab === "mz"}

    <section class="section">
      <label class="field-label" for="mz-input">m/z [Da]</label>
      <input
        id="mz-input"
        class="field-input"
        class:error={!!mzError}
        type="number"
        min={mzMin > 0 ? mzMin : 0}
        max={isFinite(mzMax) ? mzMax : undefined}
        step="0.01"
        placeholder="np. 569.25"
        bind:value={mzInput}
        onkeydown={onKeydown}
        oninput={onInputChange}
        disabled={loading}
      />
      {#if mzError}
        <span class="error-msg">{mzError}</span>
      {/if}
    </section>

    <section class="section">
      <label class="field-label" for="tol-input">Tolerancja ± [Da]</label>
      <input
        id="tol-input"
        class="field-input"
        type="number"
        min="0.05"
        max="2"
        step="0.05"
        bind:value={tol}
        disabled={loading}
      />
    </section>

    <button class="btn-primary" onclick={submit} disabled={loading || !mzInput}>
      {#if loading}
        <span class="spinner"></span>Wczytuję…
      {:else}
        Wczytaj
      {/if}
    </button>

    <!-- ── Lista m/z ──────────────────────────────── -->
    <div class="divider"></div>

    <div class="section-title">Lista m/z</div>

    {#if mzList.length > 0}
      <div class="mz-list">
        {#each mzList as entry, i}
          <div
            class="mz-entry"
            class:selected={selectedIdx === i}
            role="button"
            tabindex="0"
            onclick={() => selectEntry(i)}
            onkeydown={(e) => e.key === "Enter" && selectEntry(i)}
          >
            <span class="mz-entry-name">{entry.name}</span>
            <span class="mz-entry-val">{entry.mz}</span>
            <button class="mz-remove" onclick={(e) => { e.stopPropagation(); removeEntry(i); }}>×</button>
          </div>
        {/each}
      </div>
    {/if}

    <div class="add-row">
      <input
        class="field-input add-name"
        type="text"
        placeholder="nazwa"
        bind:value={newName}
      />
      <input
        class="field-input add-mz"
        type="number"
        step="0.01"
        placeholder="m/z"
        bind:value={newMz}
      />
    </div>
    {#if addError}<span class="error-msg">{addError}</span>{/if}
    <button class="btn-add" onclick={addEntry}>+ Dodaj</button>

    <div class="divider"></div>

    <div class="section-title">Zakres wyświetlania</div>
    <DualRange
      min={dispMin}
      max={dispMax}
      {ondisprange}
    />
    <button class="btn-reset" onclick={() => ondisprange?.(0, 1)}>Reset zakresu</button>

  <!-- ── Zakładka: Dane ────────────────────────────── -->
  {:else if activeTab === "dane"}

    <div class="tab-content-placeholder">
      <div class="placeholder-icon">📂</div>
      <div class="placeholder-title">Wczytywanie danych</div>
      <div class="placeholder-sub">
        Zmiana pliku .npz, ustawianie granic tkanek i parametrów podziału.
        Funkcja dostępna wkrótce.
      </div>
    </div>

  <!-- ── Zakładka: Ustawienia ──────────────────────── -->
  {:else if activeTab === "ustawienia"}

    <div class="tab-content-placeholder">
      <div class="placeholder-icon">⚙</div>
      <div class="placeholder-title">Ustawienia</div>
      <div class="placeholder-sub">
        Zakres m/z, BIN_SIZE, granice tkanek i inne parametry analizy.
        Funkcja dostępna wkrótce.
      </div>
    </div>

  {/if}

  <div class="spacer"></div>
  <div class="footer">FMP10 · Rat Brain · bregma 0.84</div>
</aside>

<style>
  .sidebar {
    width: 100%;
    height: 100%;
    background: #2a2a2a;
    border-left: 1px solid rgba(255,255,255,0.06);
    border-radius: 14px 0 0 14px;
    display: flex;
    flex-direction: column;
    padding: 20px 18px 16px;
    box-sizing: border-box;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .logo-area {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 18px;
  }

  .logo-mark {
    font-size: 1.5rem;
    color: #ffc951;
    filter: drop-shadow(0 0 5px rgba(255,201,81,0.5));
  }

  .app-name {
    font-size: 1.1rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: #f0f0f0;
  }

  /* ── Sekcje ───────────────────────────────────────── */
  .section { margin-bottom: 14px; }

  .field-label {
    display: block;
    font-size: 0.66rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.38);
    margin-bottom: 6px;
  }

  .field-input {
    width: 100%;
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    color: #f0f0f0;
    font-size: 0.9rem;
    padding: 8px 11px;
    outline: none;
    box-sizing: border-box;
    font-family: inherit;
    transition: border-color 0.2s, box-shadow 0.2s;
    -moz-appearance: textfield;
  }

  .field-input::-webkit-inner-spin-button,
  .field-input::-webkit-outer-spin-button { opacity: 0.3; }

  .field-input:focus {
    border-color: #ffc951;
    box-shadow: 0 0 0 2px rgba(255,201,81,0.15);
  }

  .field-input.error { border-color: #ff5555; }

  .error-msg { font-size: 0.68rem; color: #ff7070; }

  /* ── Przycisk główny ──────────────────────────────── */
  .btn-primary {
    width: 100%;
    padding: 10px;
    background: #ffc951;
    color: #1a1a1a;
    border: none;
    border-radius: 9px;
    font-size: 0.88rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    transition: background 0.18s, transform 0.1s, box-shadow 0.18s;
    box-shadow: 0 2px 10px rgba(255,201,81,0.22);
    font-family: inherit;
  }

  .btn-primary:hover:not(:disabled) {
    background: #ffd57a;
    box-shadow: 0 4px 18px rgba(255,201,81,0.38);
    transform: translateY(-1px);
  }

  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .spinner {
    width: 12px; height: 12px;
    border: 2px solid rgba(0,0,0,0.2);
    border-top-color: #1a1a1a;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    display: inline-block;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Divider ──────────────────────────────────────── */
  .divider {
    height: 1px;
    background: rgba(255,255,255,0.07);
    margin: 14px 0;
  }

  /* ── Display range ────────────────────────────────── */
  .section-title {
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.38);
    margin-bottom: 12px;
  }

  .btn-reset {
    width: 100%;
    margin-top: 10px;
    padding: 6px;
    background: transparent;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px;
    color: rgba(255,255,255,0.3);
    font-size: 0.7rem;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.18s, color 0.18s;
  }

  .btn-reset:hover {
    border-color: rgba(255,201,81,0.35);
    color: #ffc951;
  }

  /* ── Lista m/z ────────────────────────────────────── */
  .mz-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }

  .mz-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 7px;
    cursor: pointer;
    width: 100%;
    text-align: left;
    font-family: inherit;
    font-size: 0.78rem;
    color: rgba(255,255,255,0.6);
    transition: border-color 0.15s, background 0.15s;
  }

  .mz-entry:hover { border-color: rgba(255,201,81,0.3); background: #222; }

  .mz-entry.selected {
    border-color: #ffc951;
    background: rgba(255,201,81,0.08);
    color: #ffc951;
  }

  .mz-entry-name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mz-entry-val  { font-size: 0.72rem; color: rgba(255,255,255,0.35); white-space: nowrap; }

  .mz-remove {
    background: none;
    border: none;
    color: rgba(255,255,255,0.2);
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0 2px;
    line-height: 1;
    font-family: inherit;
    transition: color 0.15s;
  }
  .mz-remove:hover { color: #ff6b6b; }

  .add-row {
    display: flex;
    gap: 6px;
    margin-bottom: 4px;
  }
  .add-name { flex: 1.2; }
  .add-mz   { flex: 1; }

  .btn-add {
    width: 100%;
    padding: 6px;
    margin-bottom: 2px;
    background: transparent;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px;
    color: rgba(255,255,255,0.4);
    font-size: 0.75rem;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.18s, color 0.18s;
  }
  .btn-add:hover { border-color: rgba(255,201,81,0.4); color: #ffc951; }

  /* ── Placeholder dla zakładek ─────────────────────── */
  .tab-content-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 32px 8px;
    text-align: center;
  }

  .placeholder-icon { font-size: 2rem; opacity: 0.4; }

  .placeholder-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: rgba(255,255,255,0.35);
  }

  .placeholder-sub {
    font-size: 0.68rem;
    color: rgba(255,255,255,0.2);
    line-height: 1.6;
  }

  /* ── Footer ───────────────────────────────────────── */
  .spacer { flex: 1; }

  .footer {
    font-size: 0.6rem;
    color: rgba(255,255,255,0.13);
    text-align: center;
    letter-spacing: 0.05em;
    margin-top: 12px;
  }
</style>
