<script lang="ts">
  import { fetchPixelSpectrumRaw } from "./api.js";
  import type { PixelSpectrum, PreprocessChainResult } from "./api.js";
  import { wsGet, wsSet } from "$lib/workspace.svelte";
  import PixelMapPanel from "$lib/PixelMapPanel.svelte";
  import SpectrumPlot from "$lib/SpectrumPlot.svelte";
  import PreNodesEditor from "$lib/PreNodesEditor.svelte";

  const LS_TISSUE_L = "prewidma_tissueLeft";
  const LS_TISSUE_R = "prewidma_tissueRight";
  const LS_PIXEL_L  = "prewidma_pixelLeft";
  const LS_PIXEL_R  = "prewidma_pixelRight";
  const LS_SYNCVIEW = "prewidma_syncView";

  interface Props {
    tissues?: string[];
    activeMz?: number | null;
    activeTol?: number;
    tissueLabels?: Record<string, string>;
    dispMin?: number;
    dispMax?: number;
    invertColors?: boolean;
    filekey?: number;
    tissueVmax?: Record<string, number>;
  }

  let { tissues = [], activeMz = null, activeTol = 0.3, tissueLabels = {}, dispMin = 0, dispMax = 1, invertColors = false, filekey = 0, tissueVmax = {} }: Props = $props();

  interface Pixel { tissue: string; x: number; y: number; }

  const COLOR_L = "#ffc951";
  const COLOR_R = "#7ec8e3";

  let selectedTissueLeft  = $state(wsGet<string>(LS_TISSUE_L, tissues[0] ?? ""));
  let selectedTissueRight = $state(wsGet<string>(LS_TISSUE_R, tissues[0] ?? ""));
  let selectedPixelLeft   = $state<Pixel | null>(wsGet<Pixel | null>(LS_PIXEL_L, null));
  let selectedPixelRight  = $state<Pixel | null>(wsGet<Pixel | null>(LS_PIXEL_R, null));
  let spectrumLeft        = $state<PixelSpectrum | null>(null);
  let spectrumRight       = $state<PixelSpectrum | null>(null);
  let loadingLeft         = $state(false);
  let loadingRight        = $state(false);

  let syncView = $state(wsGet<boolean>(LS_SYNCVIEW, false));
  $effect(() => { wsSet(LS_SYNCVIEW, syncView); });

  // Wspólny zakres m/z dla obu widm przy synchronizacji — pochodzi z
  // bezpośredniej interakcji (zoom/drag/"home") na którymkolwiek z wykresów,
  // odbija się na drugim. `null` = pełny zakres (reset).
  let sharedXRange = $state<[number, number] | null>(null);

  function handlePlotXRangeChange(range: [number, number] | null) {
    sharedXRange = range;
  }

  function resetAxes() {
    sharedXRange = null;
  }

  $effect(() => {
    if (!syncView) sharedXRange = null;
  });

  let xRange = $derived<[number, number] | null>(syncView ? sharedXRange : null);

  // ── Preprocessing (graf node'ów — PreNodesEditor.svelte) ────────
  // Kliknięcie "Realizuj" na węźle Wynik w edytorze grafu woła onResult(),
  // co nadpisuje resultLeft/resultRight — wynik pojawia się jako nakładka
  // (linia ciągła) na wykresie widma poniżej.
  let resultLeft   = $state<PreprocessChainResult | null>(null);
  let resultRight  = $state<PreprocessChainResult | null>(null);
  let applying     = $state(false);

  function handleNodesResult(side: "left" | "right", result: PreprocessChainResult | null) {
    if (side === "left") resultLeft = result;
    else resultRight = result;
  }

  function toOverlay(r: PreprocessChainResult | null): PixelSpectrum | null {
    return r ? { tissue: r.tissue, x: r.x, y: r.y, mz: r.mz, intensity: r.intensity_after } : null;
  }
  let overlayLeft  = $derived(toOverlay(resultLeft));
  let overlayRight = $derived(toOverlay(resultRight));

  // Przy synchronizacji widoku oś Y ma być wspólna dla obu widm: liczona
  // z maksimum spośród danych OBU widm widocznych w bieżącym oknie m/z
  // (nie z pełnego widma) — więc nadal "przybliżanie pokazuje szczegóły",
  // ale oba wykresy mają identyczną skalę, porównywalną 1:1.
  function maxInRange(s: PixelSpectrum | null, range: [number, number] | null): number {
    if (!s) return 0;
    let m = 0;
    for (let i = 0; i < s.mz.length; i++) {
      if (range && (s.mz[i] < range[0] || s.mz[i] > range[1])) continue;
      if (s.intensity[i] > m) m = s.intensity[i];
    }
    return m;
  }
  let sharedYRange = $derived.by((): [number, number] | null => {
    if (!syncView) return null;
    const m = Math.max(
      maxInRange(spectrumLeft, xRange), maxInRange(spectrumRight, xRange),
      maxInRange(overlayLeft, xRange), maxInRange(overlayRight, xRange),
    );
    return m > 0 ? [0, m * 1.05] : null;
  });

  $effect(() => {
    if (tissues.length > 0 && !selectedTissueLeft)  selectedTissueLeft  = tissues[0];
    if (tissues.length > 0 && !selectedTissueRight) selectedTissueRight = tissues[0];
  });

  // Wyczyść zaznaczenia gdy zmienia się plik
  let _prevFilekey = $state(filekey);
  $effect(() => {
    if (filekey !== _prevFilekey) {
      selectedPixelLeft = null;
      selectedPixelRight = null;
      spectrumLeft = null;
      spectrumRight = null;
      resultLeft = null;
      resultRight = null;
      _prevFilekey = filekey;
    }
  });

  $effect(() => { wsSet(LS_TISSUE_L, selectedTissueLeft); });
  $effect(() => { wsSet(LS_TISSUE_R, selectedTissueRight); });
  $effect(() => { wsSet(LS_PIXEL_L, selectedPixelLeft); });
  $effect(() => { wsSet(LS_PIXEL_R, selectedPixelRight); });

  async function loadSpectrum(tissue: string, x: number, y: number): Promise<PixelSpectrum | null> {
    try { return await fetchPixelSpectrumRaw(tissue, x, y); }
    catch { return null; }
  }

  async function restoreSpectrum(px: Pixel | null, setSpec: (s: PixelSpectrum | null) => void, setLoading: (v: boolean) => void) {
    if (!px) return;
    setLoading(true);
    try { setSpec(await loadSpectrum(px.tissue, px.x, px.y)); }
    finally { setLoading(false); }
  }

  $effect(() => { restoreSpectrum(selectedPixelLeft,  (s) => spectrumLeft  = s, (v) => loadingLeft  = v); });
  $effect(() => { restoreSpectrum(selectedPixelRight, (s) => spectrumRight = s, (v) => loadingRight = v); });

  async function onPixelClickLeft(x: number, y: number) {
    if (!selectedTissueLeft) return;
    selectedPixelLeft = { tissue: selectedTissueLeft, x, y };
    resultLeft = null;
  }

  async function onPixelClickRight(x: number, y: number) {
    if (!selectedTissueRight) return;
    selectedPixelRight = { tissue: selectedTissueRight, x, y };
    resultRight = null;
  }

  let markersLeft  = $derived(selectedPixelLeft  ? [{ x: selectedPixelLeft.x,  y: selectedPixelLeft.y,  color: COLOR_L }] : []);
  let markersRight = $derived(selectedPixelRight ? [{ x: selectedPixelRight.x, y: selectedPixelRight.y, color: COLOR_R }] : []);
</script>

<div class="prewidma-layout">

  <!-- ── RZĄD 1: mapy pikseli + wolny box ─────────────────────── -->
  <div class="row row-maps">
    <PixelMapPanel
      {tissues}
      {tissueLabels}
      selectedTissue={selectedTissueLeft}
      {activeMz}
      {activeTol}
      {dispMin}
      {dispMax}
      {invertColors}
      {tissueVmax}
      markers={markersLeft}
      loading={loadingLeft}
      title="Mapa pikseli — górne widmo"
      onselecttissue={(t) => selectedTissueLeft = t}
      onpixelclick={onPixelClickLeft}
    />
    <PixelMapPanel
      {tissues}
      {tissueLabels}
      selectedTissue={selectedTissueRight}
      {activeMz}
      {activeTol}
      {dispMin}
      {dispMax}
      {invertColors}
      {tissueVmax}
      markers={markersRight}
      loading={loadingRight}
      title="Mapa pikseli — dolne widmo"
      onselecttissue={(t) => selectedTissueRight = t}
      onpixelclick={onPixelClickRight}
    />
    <div class="free-box card nodes-box">
      <span class="panel-title">Preprocessing — graf node'ów</span>
      <div class="nodes-editor-wrap">
        <PreNodesEditor pixelLeft={selectedPixelLeft} pixelRight={selectedPixelRight} onResult={handleNodesResult} />
      </div>
    </div>
  </div>

  <!-- ── RZĄD 2: górne widmo ──────────────────────────────────── -->
  <SpectrumPlot
    spectrum={spectrumLeft}
    color={COLOR_L}
    label="oryginał (lewa)"
    overlaySpectrum={overlayLeft}
    overlayLabel="po przetworzeniu"
    loading={loadingLeft || (applying && !!selectedPixelLeft)}
    {xRange}
    yRange={sharedYRange}
    onXRangeChange={syncView ? handlePlotXRangeChange : undefined}
  />

  <!-- ── RZĄD 3: pasek operacji na widmach ────────────────────── -->
  <div class="ops-bar card">
    <span class="ops-label">Operowanie widmami</span>
    <label class="toggle-field">
      <input type="checkbox" bind:checked={syncView} />
      <span>Synchronizuj widok (to samo miejsce w obu widmach)</span>
    </label>
    <button class="reset-btn" onclick={resetAxes} disabled={!syncView} title="Wróć do pełnego zakresu m/z na obu widmach">
      ⤢ Reset osi
    </button>
  </div>

  <!-- ── RZĄD 4: dolne widmo ──────────────────────────────────── -->
  <SpectrumPlot
    spectrum={spectrumRight}
    color={COLOR_R}
    label="oryginał (prawa)"
    overlaySpectrum={overlayRight}
    overlayLabel="po przetworzeniu"
    loading={loadingRight || (applying && !!selectedPixelRight)}
    {xRange}
    yRange={sharedYRange}
    onXRangeChange={syncView ? handlePlotXRangeChange : undefined}
  />

</div>

<style>
  .prewidma-layout {
    display: flex;
    flex-direction: column;
    height: 100%;
    gap: 10px;
    padding: 12px;
    box-sizing: border-box;
    overflow: hidden;
  }

  .row { display: flex; gap: 10px; }

  .row-maps { flex-shrink: 0; }

  .card {
    background: #222;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;
    box-sizing: border-box;
  }

  .free-box {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    overflow-y: auto;
  }

  .panel-title {
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.38);
  }

  .nodes-box {
    overflow: hidden;
  }

  .nodes-editor-wrap {
    flex: 1;
    min-height: 0;
  }

  .ops-bar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 8px 14px;
    flex-wrap: wrap;
  }

  .ops-label {
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.3);
  }

  .toggle-field {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.7rem;
    color: rgba(255,255,255,0.6);
    cursor: pointer;
  }

  .reset-btn {
    background: transparent;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 6px;
    color: rgba(255,255,255,0.6);
    font-size: 0.7rem;
    padding: 5px 10px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, color 0.15s;
  }
  .reset-btn:hover:not(:disabled) { border-color: #ffc951; color: #ffc951; }
  .reset-btn:disabled { opacity: 0.35; cursor: not-allowed; }
</style>
