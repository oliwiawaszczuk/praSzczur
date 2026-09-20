<script lang="ts">
  import { onMount } from "svelte";
  import { waitForSidecar, fetchIonImage } from "$lib/api.js";
  import type { TissueImage } from "$lib/api.js";
  import IonGrid from "$lib/IonGrid.svelte";
  import Sidebar from "$lib/Sidebar.svelte";
  import DaneTab from "$lib/DaneTab.svelte";
  import "@fontsource/jetbrains-mono/400.css";
  import "@fontsource/jetbrains-mono/600.css";

  type AppState = "booting" | "ready" | "error";
  type Tab = "dane" | "mz" | "ustawienia";

  let state:       AppState = $state("booting");
  let errorMsg     = $state("");
  let tissues: Record<string, TissueImage> | null = $state(null);
  let queryLoading = $state(false);
  let bootProgress = $state(0);
  let dispMin      = $state(0);
  let dispMax      = $state(1);
  let activeTab: Tab = $state("dane");

  onMount(async () => {
    const tick = setInterval(() => {
      bootProgress = Math.min(bootProgress + 3, 85);
    }, 200);
    try {
      await waitForSidecar();
      bootProgress = 100;
      await new Promise(r => setTimeout(r, 400));
      state = "ready";
    } catch (e) {
      errorMsg = (e as Error).message;
      state = "error";
    } finally {
      clearInterval(tick);
    }
  });

  async function handleQuery({ mz, tol }: { mz: number; tol: number }) {
    queryLoading = true;
    try {
      const res = await fetchIonImage(mz, tol);
      tissues = res.tissues;
    } catch (e) {
      errorMsg = (e as Error).message;
      state = "error";
    } finally {
      queryLoading = false;
    }
  }
</script>

<!-- ── Boot ──────────────────────────────────────────────── -->
{#if state === "booting"}
  <div class="boot-screen">
    <div class="boot-content">
      <div class="boot-logo">⬡</div>
      <div class="boot-title">praSzczur</div>
      <div class="boot-sub">Ładowanie danych MSI…</div>
      <div class="progress-track">
        <div class="progress-bar" style="width: {bootProgress}%"></div>
      </div>
    </div>
  </div>

<!-- ── Error ─────────────────────────────────────────────── -->
{:else if state === "error"}
  <div class="error-screen">
    <div class="error-icon">⚠</div>
    <div class="error-title">Błąd uruchomienia</div>
    <div class="error-body">{errorMsg}</div>
    <div class="error-hint">Sprawdź logi w /tmp/praSzczur_debug.log — może port 7432 jest zajęty przez inny proces.</div>
  </div>

<!-- ── Główny UI ──────────────────────────────────────────── -->
{:else}
  <div class="layout">

    <!-- Obszar roboczy -->
    <div class="work-area">

      <!-- Zakładki nad contentem -->
      <div class="tabbar">
        {#each (["dane", "mz", "ustawienia"] as const) as t}
          <button
            class="tab"
            class:active={activeTab === t}
            onclick={() => { activeTab = t; }}
          >
            {{ dane: "Dane", mz: "m/z", ustawienia: "Ustawienia" }[t]}
          </button>
        {/each}
      </div>

      <!-- Content zakładki — zawsze zamontowane, ukrywane przez CSS -->
      <main class="content" class:hidden={activeTab !== "dane"}>
        <DaneTab />
      </main>
      <main class="content" class:hidden={activeTab !== "mz"}>
        <IonGrid {tissues} loading={queryLoading} {dispMin} {dispMax} />
      </main>
      <main class="content full-tab" class:hidden={activeTab !== "ustawienia"}>
        <div class="tab-placeholder">
          <div class="tp-icon">⚙</div>
          <div class="tp-title">Ustawienia</div>
          <div class="tp-sub">Zakres m/z, BIN_SIZE, granice tkanek i inne parametry analizy.</div>
        </div>
      </main>

    </div>

    <!-- Sidebar — tylko w zakładce m/z -->
    {#if activeTab === "mz"}
      <div class="sidebar-shell">
        <Sidebar
          loading={queryLoading}
          {activeTab}
          onquery={handleQuery}
          {dispMin}
          {dispMax}
          ondisprange={(mn, mx) => { dispMin = mn; dispMax = mx; }}
        />
      </div>
    {/if}

  </div>
{/if}

<style>
  :global(*) { box-sizing: border-box; margin: 0; padding: 0; }

  :global(body) {
    background: #333;
    color: #e0e0e0;
    font-family: "JetBrains Mono", monospace;
    overflow: hidden;
    height: 100vh;
    width: 100vw;
  }

  /* ── Boot ─────────────────────────────────────────── */
  .boot-screen {
    position: fixed;
    inset: 0;
    background: #222;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .boot-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    animation: rise 0.5s ease;
  }

  @keyframes rise {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .boot-logo {
    font-size: 3.5rem;
    color: #ffc951;
    animation: glow 1.8s ease-in-out infinite;
  }

  @keyframes glow {
    0%, 100% { filter: drop-shadow(0 0 10px rgba(255,201,81,0.4)); }
    50%       { filter: drop-shadow(0 0 24px rgba(255,201,81,0.9)); }
  }

  .boot-title {
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #f0f0f0;
  }

  .boot-sub {
    font-size: 0.85rem;
    color: rgba(255,255,255,0.4);
  }

  .progress-track {
    width: 260px;
    height: 3px;
    background: rgba(255,255,255,0.08);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 8px;
  }

  .progress-bar {
    height: 100%;
    background: #ffc951;
    border-radius: 2px;
    transition: width 0.25s ease;
    box-shadow: 0 0 8px rgba(255,201,81,0.7);
  }

  /* ── Error ────────────────────────────────────────── */
  .error-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 12px;
    padding: 2rem;
    text-align: center;
  }

  .error-icon  { font-size: 2.5rem; color: #ff6b6b; }
  .error-title { font-size: 1.4rem; font-weight: 700; color: #ff6b6b; }
  .error-body  { font-size: 0.85rem; color: rgba(255,255,255,0.45); max-width: 480px; }
  .error-hint  { font-size: 0.72rem; color: rgba(255,255,255,0.22); max-width: 400px; line-height: 1.6; }

  /* ── Main layout ──────────────────────────────────── */
  .layout {
    display: flex;
    flex-direction: row;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    animation: fadein 0.35s ease;
  }

  @keyframes fadein {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  /* Sidebar — szerszy o 5% (280 → 295) */
  .sidebar-shell {
    width: 295px;
    min-width: 295px;
    max-width: 295px;
    flex-shrink: 0;
    height: 100vh;
  }

  /* Obszar roboczy (zakładki + content) */
  .work-area {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Pasek zakładek */
  .tabbar {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    padding: 10px 16px 0;
    flex-shrink: 0;
  }

  .tab {
    padding: 7px 18px;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    font-family: "JetBrains Mono", monospace;
    background: rgba(0,0,0,0.2);
    border: 1px solid rgba(255,255,255,0.07);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    color: rgba(255,255,255,0.35);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .tab:hover:not(.active) {
    background: rgba(255,255,255,0.05);
    color: rgba(255,255,255,0.6);
  }

  .tab.active {
    background: #2a2a2a;
    color: #ffc951;
    border-color: rgba(255,255,255,0.1);
    box-shadow: 0 -2px 8px rgba(255,201,81,0.1);
  }

  .hidden { display: none !important; }

  /* Content zakładki */
  .content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #2a2a2a;
    border-top: 1px solid rgba(255,255,255,0.08);
    border-radius: 0 8px 0 0;
  }

  .full-tab {
    align-items: center;
    justify-content: center;
  }

  .tab-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    text-align: center;
    max-width: 400px;
  }

  .tp-icon  { font-size: 2.5rem; opacity: 0.3; }
  .tp-title { font-size: 1.2rem; font-weight: 600; color: rgba(255,255,255,0.3); }
  .tp-sub   { font-size: 0.78rem; color: rgba(255,255,255,0.18); line-height: 1.7; }
</style>
