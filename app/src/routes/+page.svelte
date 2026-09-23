<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { waitForSidecar, fetchIonImage, fetchIonImageRaw, fetchDatasetStatus } from "$lib/api.js";
  import type { TissueImage } from "$lib/api.js";
  import IonGrid from "$lib/IonGrid.svelte";
  import Sidebar from "$lib/Sidebar.svelte";
  import DaneTab from "$lib/DaneTab.svelte";
  import Widma from "$lib/Widma.svelte";
  import WorkspaceSettings from "$lib/WorkspaceSettings.svelte";
  import { loadWorkspaces, wsGet, wsSet } from "$lib/workspace.svelte";
  import "@fontsource/jetbrains-mono/400.css";
  import "@fontsource/jetbrains-mono/600.css";

  type AppState = "booting" | "ready" | "error";
  type Tab = "dane" | "mz" | "preprocessing" | "widma" | "segmentacja" | "settings";

  const TABS: { key: Tab; label: string }[] = [
    { key: "dane",          label: "Dane" },
    { key: "mz",            label: "m/z" },
    { key: "widma",         label: "Widma" },
    { key: "preprocessing", label: "Preprocessing" },
    { key: "segmentacja",   label: "Segmentacja" },
    { key: "settings",   label: "Ustawienia" },
  ];

  let state:       AppState = $state("booting");
  let errorMsg     = $state("");
  let tissues: Record<string, TissueImage> | null = $state(null);
  let queryError  = $state("");
  let queryLoading = $state(false);
  let bootProgress = $state(0);
  let dispMin      = $state(0);
  let dispMax      = $state(1);
  let activeTab: Tab   = $state("dane");
  let mzMin            = $state(0);
  let mzMax            = $state(Infinity);
  let tissueIds        = $state<string[]>([]);
  let tissueLabels     = $state<Record<string,string>>({});
  let tissueColors     = $state<Record<string,string>>({});
  let invertColors     = $state(false);
  let filekey          = $state(0);
  let tissueVmax       = $state<Record<string, number>>({});
  let lastMz           = $state<number | null>(null);
  let lastTol          = $state(0.3);
  let defaultTol       = $state(0.3);
  // Gdy true, workspace jest wczytany i stan poniżej odzwierciedla zapisane
  // wartości — dopiero wtedy wolno zacząć zapisywać zmiany z powrotem
  // (inaczej efekty odpaliłyby się z domyślnymi wartościami PRZED
  // odczytaniem workspace i nadpisałyby to, co było zapisane).
  let restored          = $state(false);

  // Persist to workspace (only write, browser-only)
  $effect(() => { if (restored) wsSet("app_activeTab", activeTab); });
  $effect(() => { if (restored && lastMz !== null) wsSet("app_lastMz", lastMz); });
  $effect(() => { if (restored) wsSet("app_lastTol", lastTol); });
  $effect(() => { if (restored) wsSet("app_dispMin", dispMin); });
  $effect(() => { if (restored) wsSet("app_dispMax", dispMax); });

  onMount(async () => {
    const tick = setInterval(() => {
      bootProgress = Math.min(bootProgress + 3, 85);
    }, 200);
    try {
      await waitForSidecar();
      await loadWorkspaces();

      // Load all persisted state — dopiero po wczytaniu workspace
      activeTab    = wsGet<Tab>("app_activeTab", "dane");
      tissueLabels = wsGet("dane_tissueLabels", {});
      lastMz       = wsGet("app_lastMz", null);
      dispMin      = wsGet("app_dispMin", 0);
      dispMax      = wsGet("app_dispMax", 1);
      const hadSavedTol = wsGet<number | null>("app_lastTol", null) !== null;
      lastTol      = wsGet("app_lastTol", 0.3);
      restored     = true;

      bootProgress = 100;
      await new Promise(r => setTimeout(r, 400));
      state = "ready";
      const ds = await fetchDatasetStatus();
      if (ds && ds.mz_min > 0 && ds.mz_max > 0) {
        mzMin = ds.mz_min;
        mzMax = ds.mz_max;
        tissueIds = (ds as any).npz_files?.map((f: any) => f.id) ?? [];
        if (ds.n_bins > 1) {
          const binSize = (ds.mz_max - ds.mz_min) / (ds.n_bins - 1);
          defaultTol = Math.round(binSize * 100) / 100;
          if (!hadSavedTol) lastTol = defaultTol;
        }
        // Auto-restore last m/z query
        if (lastMz !== null) handleQuery({ mz: lastMz, tol: lastTol });
      }
    } catch (e) {
      errorMsg = (e as Error).message;
      state = "error";
    } finally {
      clearInterval(tick);
    }

    listen<string>("workspace-menu", () => { activeTab = "settings"; });
  });

  async function handleFileLoad() {
    // Nowy plik — odśwież dataset, ponów m/z query, wyczyść ion images
    filekey += 1;
    tissues = null;
    queryError = "";
    try {
      const ds = await fetchDatasetStatus();
      if (ds && ds.mz_min > 0 && ds.mz_max > 0) {
        mzMin = ds.mz_min;
        mzMax = ds.mz_max;
        tissueIds = (ds as any).npz_files?.map((f: any) => f.id) ?? [];
        if (ds.n_bins > 1) {
          const binSize = (ds.mz_max - ds.mz_min) / (ds.n_bins - 1);
          defaultTol = Math.round(binSize * 100) / 100;
        }
        if (lastMz !== null) handleQuery({ mz: lastMz, tol: lastTol });
      }
    } catch {}
  }

  async function handleQuery({ mz, tol, raw = false }: { mz: number; tol: number; raw?: boolean }) {
    queryLoading = true;
    queryError = "";
    lastMz = mz;
    lastTol = tol;
    try {
      const res = raw ? await fetchIonImageRaw(mz, tol) : await fetchIonImage(mz, tol);
      tissues = res.tissues;
      // Zapisz globalny vmax per tkanka (spójny z Widma)
      const newVmax: Record<string, number> = {};
      for (const [id, t] of Object.entries(res.tissues)) newVmax[id] = t.vmax;
      tissueVmax = newVmax;
      const allZero = Object.values(res.tissues).every(t => t.vmax === 0);
      if (allZero) {
        queryError = `Brak sygnału przy m/z ${mz.toFixed(3)} Da — wartość poza zakresem przetworzonych danych lub brak jonów.`;
        tissues = null;
      }
    } catch (e) {
      queryError = (e as Error).message.includes("503")
        ? "Brak przetworzonych danych. Uruchom preprocessing w zakładce Dane."
        : (e as Error).message;
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
        {#each TABS.filter(t => t.key !== "preprocessing" && t.key !== "segmentacja") as t}
          <button
            class="tab"
            class:active={activeTab === t.key}
            onclick={() => { activeTab = t.key; }}
          >
            {t.label}
          </button>
        {/each}
      </div>

      <!-- Content zakładki — zawsze zamontowane, ukrywane przez CSS -->
      <main class="content" class:hidden={activeTab !== "dane"}>
        <DaneTab
          onlabelschange={(labels) => { tissueLabels = { ...labels }; }}
          oncolorschange={(colors) => { tissueColors = { ...colors }; }}
          onfileload={handleFileLoad}
        />
      </main>
      <main class="content content-mz" class:hidden={activeTab !== "mz"}>
        <IonGrid {tissues} loading={queryLoading} {dispMin} {dispMax} error={queryError} {tissueLabels} {tissueColors} {invertColors} />
        <div class="sidebar-panel">
          <Sidebar
            loading={queryLoading}
            onquery={handleQuery}
            {dispMin}
            {dispMax}
            ondisprange={(mn, mx) => { dispMin = mn; dispMax = mx; }}
            {mzMin}
            {mzMax}
            tolDefault={defaultTol}
            oninvert={(v) => { invertColors = v; }}
            currentMz={lastMz}
            currentTol={lastTol}
          />
        </div>
      </main>
      <main class="content full-tab" class:hidden={activeTab !== "preprocessing"}>
        <div class="tab-placeholder">
          <div class="tp-icon">⚗</div>
          <div class="tp-title">Preprocessing</div>
          <div class="tp-sub">Normalizacja, korekcja bazowej linii, redukcja szumu — parametry przetwarzania wstępnego widm.</div>
        </div>
      </main>
      <main class="content" class:hidden={activeTab !== "widma"}>
        <Widma tissues={tissueIds} activeMz={lastMz} activeTol={lastTol} {tissueLabels} {dispMin} {dispMax} {invertColors} {filekey} {tissueVmax} />
      </main>
      <main class="content full-tab" class:hidden={activeTab !== "segmentacja"}>
        <div class="tab-placeholder">
          <div class="tp-icon">⬡</div>
          <div class="tp-title">Segmentacja</div>
          <div class="tp-sub">Klasteryzacja pikseli na podstawie widm MSI — mapy segmentów i analiza składowych.</div>
        </div>
      </main>
      <main class="content" class:hidden={activeTab !== "settings"}>
        <WorkspaceSettings />
      </main>

    </div>

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
    animation:
      bouncespin 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite,
      glow       2.2s ease-in-out infinite;
  }

  @keyframes bouncespin {
    0%   { transform: translateY(0px)   rotateY(0deg); }
    30%  { transform: translateY(-22px) rotateY(200deg); }
    50%  { transform: translateY(-26px) rotateY(250deg); }
    70%  { transform: translateY(-10px) rotateY(320deg); }
    85%  { transform: translateY(-2px)  rotateY(350deg); }
    100% { transform: translateY(0px)   rotateY(360deg); }
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
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    animation: fadein 0.35s ease;
  }

  @keyframes fadein {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .content-mz {
    flex-direction: row !important;
    padding: 0;
  }

  .sidebar-panel {
    width: 280px;
    min-width: 280px;
    max-width: 280px;
    flex-shrink: 0;
    height: 100%;
    overflow: hidden;
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
