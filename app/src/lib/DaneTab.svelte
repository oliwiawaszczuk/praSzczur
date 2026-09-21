<script lang="ts">
  import { onMount } from "svelte";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";

  const BASE = "http://127.0.0.1:7432";

  // ── Typy ────────────────────────────────────────────────────────────────
  interface TissueMeta {
    id: string; label: string;
    x_min: number; x_max: number;
    y_min?: number; y_max?: number;
    n_spectra?: number; is_ref: boolean;
    enabled?: boolean;
  }
  interface DetectionResult {
    detected: TissueMeta[];
    col_profile: number[];
    row_profile?: number[];
    presence_image: number[][];
    width: number; height: number; x_offset: number; y_offset: number;
    n_detected: number;
  }
  interface NpzFile { id: string; filename: string; size_mb: number; modified: string; }
  interface Status {
    npz_files: NpzFile[];
    tissues: TissueMeta[];
    n_tissues: number;
    mz_min: number; mz_max: number; n_bins: number;
  }

  interface Props {
    onlabelschange?: (labels: Record<string, string>) => void;
    onfileload?: () => void;
  }
  let { onlabelschange, onfileload }: Props = $props();

  // ── State ────────────────────────────────────────────────────────────────
  let imzmlPath    = $state("source/FMP10_Rat_brain_breg_084.imzML");
  let fileInfo     = $state<{width:number;height:number}|null>(null);
  let fileError    = $state("");
  let loadingFile  = $state(false);

  let detectionData = $state<DetectionResult|null>(null);
  let tissues       = $state<TissueMeta[]>([]);
  let detecting     = $state(false);

  let spectrumData    = $state<{mz:number[];intensity:number[];mz_min:number;mz_max:number}|null>(null);
  let loadingSpectrum = $state(false);
  // ── Persistence helpers ───────────────────────────────────────────────────
  function lsGet<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }
  function lsSet(key: string, val: unknown) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  let mzMin   = $state(300);
  let mzMax   = $state(1500);
  let binSize = $state(0.3);

  $effect(() => { lsSet("dane_mzMin", mzMin); });
  $effect(() => { lsSet("dane_mzMax", mzMax); });
  $effect(() => { lsSet("dane_binSize", binSize); });
  const nBins = $derived(Math.floor((mzMax - mzMin) / binSize));

  // Widok widma — null = pełny zakres danych
  let viewMin = $state<number|null>(null);
  let viewMax = $state<number|null>(null);

  // Bin preview — pozycja, zoom i wzmocnienie Y
  let binCenter = $state(900);   // środek okna [Da]
  let binNBins  = $state(12);    // ile binów pokazać
  let binYShift = $state(0);     // przesunięcie Y w pikselach (0 = normalnie, + = przesuń w górę)

  // Dane pełnej rozdzielczości dla bin preview
  let binWinData = $state<{mz:number[];intensity:number[]}|null>(null);
  let binWinLoading = $state(false);

  let status       = $state<Status|null>(null);
  let processing   = $state(false);
  let processLog   = $state<string[]>([]);
  let processPct   = $state(0);
  let processError = $state("");

  const TISSUE_COLORS = ["#ffc951","#4ecdc4","#ff6b6b","#a8e6cf","#c3a6ff","#ffb347"];

  // Canvas refs
  let ticCanvas: HTMLCanvasElement|undefined     = $state();
  let profileCanvas: HTMLCanvasElement|undefined = $state();
  let specCanvas: HTMLCanvasElement|undefined    = $state();
  let binCanvas: HTMLCanvasElement|undefined     = $state();

  // Rysuj po zamontowaniu canvas — gdy ref się pojawia
  $effect(() => { if (specCanvas && spectrumData) requestAnimationFrame(drawSpectrum); });
  $effect(() => { if (binCanvas && (binWinData || spectrumData)) requestAnimationFrame(drawBinPreview); });

  // Spectrum drag
  let dragging: "min"|"max"|"bin"|null = null;
  let dragBinStartX = 0;
  let dragBinStartCenter = 0;

  // ── On mount ─────────────────────────────────────────────────────────────
  onMount(async () => {
    // Restore persisted settings (must be in onMount — localStorage unavailable during SSR)
    mzMin     = lsGet("dane_mzMin", 300);
    mzMax     = lsGet("dane_mzMax", 1500);
    binSize   = lsGet("dane_binSize", 0.3);
    imzmlPath = lsGet("dane_imzmlPath", imzmlPath);

    await refreshStatus();
    // Auto-reload detection data so UI shows previous state
    if (imzmlPath) {
      try { await loadFile(); } catch {}
    } else {
      // Fallback: load from default_tissues if no file path
      try {
        const r = await fetch(`${BASE}/default_tissues`);
        if (r.ok) {
          const d = await r.json();
          if (tissues.length === 0 && d.tissues?.length > 0) {
            const savedLabels: Record<string,string> = lsGet(labelsKey(), {});
            const savedEnabled: Record<string,boolean> = lsGet(enabledKey(), {});
            tissues = d.tissues.map((t: TissueMeta) => ({
              ...t,
              label:   savedLabels[t.id] ?? t.label,
              enabled: savedEnabled[t.id] ?? true,
            }));
            // Notify parent of restored labels
            const labels: Record<string,string> = {};
            tissues.forEach(t => { labels[t.id] = t.label; });
            onlabelschange?.(labels);
          }
        }
      } catch {}
    }
  });

  function labelsKey()  { return `dane_tissueLabels:${imzmlPath}`; }
  function enabledKey() { return `dane_tissueEnabled:${imzmlPath}`; }

  function saveTissueLabels() {
    const labels: Record<string,string> = {};
    const enabled: Record<string,boolean> = {};
    tissues.forEach(t => { labels[t.id] = t.label; enabled[t.id] = t.enabled ?? true; });
    lsSet(labelsKey(), labels);
    lsSet(enabledKey(), enabled);
    lsSet("dane_tissueLabels", labels);   // current — dla +page.svelte
    onlabelschange?.(labels);
  }

  async function refreshStatus() {
    try {
      const r = await fetch(`${BASE}/dataset_status`);
      if (r.ok) status = await r.json();
    } catch {}
  }

  // ── Krok 1: plik ─────────────────────────────────────────────────────────
  async function pickFile() {
    const selected = await openDialog({
      filters: [{ name: "imzML", extensions: ["imzML","imzml"] }],
      multiple: false,
    });
    if (selected) { imzmlPath = selected as string; await loadFile(); }
  }

  async function loadFile() {
    loadingFile = true; fileError = ""; fileInfo = null;
    detectionData = null; spectrumData = null;
    try {
      const r = await fetch(`${BASE}/detect_from_imzml?path=${encodeURIComponent(imzmlPath)}&threshold_pct=5`);
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        fileError = err.detail ?? "Błąd wczytywania"; return;
      }
      const d: DetectionResult = await r.json();
      detectionData = d;
      const savedLabels: Record<string,string> = lsGet(labelsKey(), {});
      const savedEnabled: Record<string,boolean> = lsGet(enabledKey(), {});
      tissues = d.detected.map((t,i) => ({
        ...t, is_ref: i===0,
        label:   savedLabels[t.id] ?? t.label,
        enabled: savedEnabled[t.id] ?? true,
      }));
      fileInfo = { width: d.width, height: d.height };
      lsSet("dane_imzmlPath", imzmlPath);  // tylko po udanym załadowaniu
      // Notify parent with restored/current labels
      const labels: Record<string,string> = {};
      tissues.forEach(t => { labels[t.id] = t.label; });
      onlabelschange?.(labels);
      onfileload?.();
      const t1 = d.detected[0];
      loadSpectrum(t1?.x_min, t1?.x_max);
    } catch (e) {
      fileError = (e as Error).message;
    } finally { loadingFile = false; }
  }

  async function detectTissues() {
    detecting = true;
    try { await loadFile(); } finally { detecting = false; }
  }

  // ── Krok 3: widmo ────────────────────────────────────────────────────────
  async function loadSpectrum(xMin?: number, xMax?: number) {
    loadingSpectrum = true;
    try {
      let url = `${BASE}/sample_spectrum?path=${encodeURIComponent(imzmlPath)}&n_samples=300`;
      if (xMin !== undefined && xMax !== undefined) url += `&x_min=${xMin}&x_max=${xMax}`;
      const r = await fetch(url);
      if (r.ok) {
        spectrumData = await r.json();
        if (spectrumData) {
          mzMin = Math.ceil(spectrumData.mz_min);
          mzMax = Math.floor(spectrumData.mz_max);
          viewMin = null; viewMax = null;
          binCenter = Math.round((mzMin + mzMax) / 2);
          binYShift = 0;
        }
      }
    } catch {} finally { loadingSpectrum = false; }
  }

  // ── Krok 4: preprocessing ─────────────────────────────────────────────────
  async function runProcess() {
    processing = true; processPct = 0; processLog = []; processError = "";
    try {
      const resp = await fetch(`${BASE}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bin_size: binSize, mz_min: mzMin, mz_max: mzMax, tissues: tissues.filter(t => t.enabled !== false), imzml_path: imzmlPath }),
      });
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const lines  = part.trim().split("\n");
          const evLine = lines.find(l => l.startsWith("event:"));
          const dtLine = lines.find(l => l.startsWith("data:"));
          if (!evLine || !dtLine) continue;
          const event = evLine.replace("event:", "").trim();
          const data  = JSON.parse(dtLine.replace("data:", "").trim());
          if (event === "progress") {
            processPct = data.pct ?? processPct;
            processLog = [...processLog, data.message];
          } else if (event === "done") {
            processPct = 100;
            const summary: {id:string;n_spectra:number}[] = data.summary ?? [];
            processLog = [...processLog, `✓ ${data.message}`, ...summary.map(s => `  ${s.id}: ${s.n_spectra.toLocaleString()} spektrów`)];
            await refreshStatus();
          } else if (event === "error") {
            processError = data.message + (data.trace ? "\n" + data.trace : "");
          }
        }
      }
    } catch (e) { processError = (e as Error).message; }
    finally { processing = false; }
  }

  // ── Canvas: TIC ──────────────────────────────────────────────────────────
  $effect(() => {
    if (!ticCanvas || !detectionData?.presence_image) return;
    const ctx = ticCanvas.getContext("2d"); if (!ctx) return;
    const { presence_image: img, width: W, height: H, x_offset: xOff } = detectionData;
    const dpr = window.devicePixelRatio || 1;

    // CSS width z kontenera, height z proporcji danych
    const rect = ticCanvas.getBoundingClientRect();
    const cssW = rect.width || W;
    const cssH = cssW * (H / W);   // zachowaj aspect ratio danych
    ticCanvas.style.height = cssH + "px";

    ticCanvas.width  = cssW * dpr;
    ticCanvas.height = cssH * dpr;
    ctx.scale(dpr, dpr);

    // Skala: dane → CSS px
    const sx = cssW / W, sy = cssH / H;

    // Piksele TIC przez tymczasowy canvas (putImageData ignoruje transform)
    const tmp = document.createElement("canvas");
    tmp.width = W; tmp.height = H;
    const tCtx = tmp.getContext("2d")!;
    const imgData = tCtx.createImageData(W, H);
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
      const v = img[y][x] > 0 ? 220 : 30;
      const i = (y*W+x)*4;
      imgData.data[i]=imgData.data[i+1]=imgData.data[i+2]=v; imgData.data[i+3]=255;
    }
    tCtx.putImageData(imgData, 0, 0);
    ctx.drawImage(tmp, 0, 0, cssW, cssH);  // rozciągnij do CSS rozmiaru

    const yOff = detectionData.y_offset;
    tissues.forEach((t,i) => {
      const color = TISSUE_COLORS[i%TISSUE_COLORS.length];
      const disabled = t.enabled === false;
      // Przelicz współrzędne danych na CSS px
      const px0=(t.x_min-xOff)*sx, px1=(t.x_max-xOff)*sx;
      const py0=(t.y_min != null ? (t.y_min-yOff)*sy : 0);
      const py1=(t.y_max != null ? (t.y_max-yOff)*sy : cssH-1);
      if (disabled) {
        ctx.fillStyle="rgba(0,0,0,0.55)"; ctx.fillRect(px0,py0,px1-px0+1,py1-py0+1);
        ctx.strokeStyle="rgba(120,120,120,0.4)"; ctx.lineWidth=1;
        ctx.strokeRect(px0+0.5,py0+0.5,px1-px0,py1-py0);
      } else {
        ctx.fillStyle=color+"50"; ctx.fillRect(px0,py0,px1-px0+1,py1-py0+1);
        ctx.strokeStyle=color; ctx.lineWidth=1.5;
        ctx.strokeRect(px0+0.5,py0+0.5,px1-px0,py1-py0);
      }
      const labelX = px0 + (px1-px0)/2;
      const labelY = py0 + 12;
      ctx.font = `bold 11px monospace`;
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.fillText(t.label, labelX+1, labelY+1);
      ctx.fillStyle = disabled ? "rgba(180,180,180,0.8)" : color;
      ctx.fillText(t.label, labelX, labelY);
    });
  });

  function onTicClick(e: MouseEvent) {
    if (!ticCanvas || !detectionData) return;
    const rect = ticCanvas.getBoundingClientRect();
    const scaleX = detectionData.width  / rect.width;
    const scaleY = detectionData.height / rect.height;
    const cx = detectionData.x_offset + Math.floor((e.clientX - rect.left)  * scaleX);
    const cy = detectionData.y_offset + Math.floor((e.clientY - rect.top)   * scaleY);
    const idx = tissues.findIndex(t => {
      const y0 = t.y_min ?? detectionData!.y_offset;
      const y1 = t.y_max ?? (detectionData!.y_offset + detectionData!.height - 1);
      return cx >= t.x_min && cx <= t.x_max && cy >= y0 && cy <= y1;
    });
    if (idx < 0) return;
    tissues[idx] = { ...tissues[idx], enabled: tissues[idx].enabled !== false ? false : true };
    saveTissueLabels();
  }

  // ── Canvas: profil X ─────────────────────────────────────────────────────
  $effect(() => {
    if (!profileCanvas || !detectionData) return;
    const ctx = profileCanvas.getContext("2d"); if (!ctx) return;
    const profile = detectionData.col_profile;
    const W = profileCanvas.offsetWidth||600, H = profileCanvas.offsetHeight||40;
    profileCanvas.width=W; profileCanvas.height=H;
    ctx.fillStyle="#111"; ctx.fillRect(0,0,W,H);
    tissues.forEach((t,i) => {
      const color=TISSUE_COLORS[i%TISSUE_COLORS.length];
      const x0=((t.x_min-detectionData!.x_offset)/profile.length)*W;
      const x1=((t.x_max-detectionData!.x_offset+1)/profile.length)*W;
      ctx.fillStyle=color+"25"; ctx.fillRect(x0,0,x1-x0,H);
    });
    ctx.beginPath(); ctx.strokeStyle="#ffc951"; ctx.lineWidth=1.5;
    profile.forEach((v,i)=>{
      const px=(i/(profile.length-1))*W, py=H-v*(H-4)-2;
      i===0?ctx.moveTo(px,py):ctx.lineTo(px,py);
    });
    ctx.stroke();
  });

  // ── Canvas: widmo pełne z suwakami ───────────────────────────────────────
  $effect(() => { mzMin; mzMax; viewMin; viewMax; spectrumData; binCenter; binNBins; binSize; if (specCanvas && spectrumData) requestAnimationFrame(drawSpectrum); });

  function scaleToSelection() { viewMin = mzMin; viewMax = mzMax; }
  function resetView() { viewMin = null; viewMax = null; }

  function drawSpectrum() {
    if (!specCanvas || !spectrumData) return;
    const ctx = specCanvas.getContext("2d"); if (!ctx) return;
    const { mz, intensity, mz_min: dMin, mz_max: dMax } = spectrumData;
    const rect = specCanvas.getBoundingClientRect();
    const W = rect.width||800, H = rect.height||100;
    specCanvas.width=W; specCanvas.height=H;
    const PAD = 6;
    ctx.fillStyle="#111"; ctx.fillRect(0,0,W,H);
    // Użyj viewMin/viewMax jeśli ustawione, inaczej pełny zakres
    const vMin = viewMin ?? dMin;
    const vMax = viewMax ?? dMax;
    const range = vMax - vMin;
    const toX=(m:number)=>PAD+((m-vMin)/range)*(W-PAD*2);

    // Filtruj punkty do widocznego zakresu (±10% zapas)
    const margin = range * 0.02;
    const vis = mz.map((_,i)=>i).filter(i=>mz[i]>=vMin-margin && mz[i]<=vMax+margin);

    // Area fill
    ctx.beginPath();
    vis.forEach((i,j)=>{
      const px=toX(mz[i]), py=H-PAD-intensity[i]*(H-PAD*2);
      j===0?ctx.moveTo(px,py):ctx.lineTo(px,py);
    });
    ctx.lineTo(PAD+(W-PAD*2), H-PAD); ctx.lineTo(PAD, H-PAD);
    ctx.closePath();
    ctx.fillStyle="rgba(255,255,255,0.07)"; ctx.fill();

    // Spectrum line
    ctx.beginPath(); ctx.strokeStyle="rgba(255,255,255,0.4)"; ctx.lineWidth=1;
    vis.forEach((i,j)=>{
      const px=toX(mz[i]), py=H-PAD-intensity[i]*(H-PAD*2);
      j===0?ctx.moveTo(px,py):ctx.lineTo(px,py);
    });
    ctx.stroke();

    // Selected range fill (tylko jeśli w widoku)
    const x0=toX(mzMin), x1=toX(mzMax);
    if (x1 > PAD && x0 < W-PAD) {
      ctx.fillStyle="rgba(255,201,81,0.10)";
      ctx.fillRect(Math.max(x0,PAD), 0, Math.min(x1,W-PAD)-Math.max(x0,PAD), H);
    }

    // Labels first (visible over fill)
    ctx.fillStyle="#ffc951"; ctx.font="11px monospace"; ctx.textAlign="center";
    ctx.fillText(`${mzMin}`, x0, 13);
    ctx.fillText(`${mzMax}`, x1, 13);

    // Handle lines — start below text
    ctx.strokeStyle="#ffc951"; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(x0,18); ctx.lineTo(x0,H-PAD); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1,18); ctx.lineTo(x1,H-PAD); ctx.stroke();

    // Bin preview window indicator — draggable bar at very bottom
    const winHalf = (binNBins * binSize) / 2;
    const bwMin = binCenter - winHalf;
    const bwMax = binCenter + winHalf;
    const bx0 = toX(bwMin), bx1 = toX(bwMax);
    const barH = 10, barY = H - barH;
    // Track background
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(PAD, barY, W - PAD*2, barH);
    // Window fill
    ctx.fillStyle = "rgba(255,201,81,0.25)";
    ctx.fillRect(Math.max(bx0, PAD), barY, Math.min(bx1, W-PAD) - Math.max(bx0, PAD), barH);
  }

  function specPointerDown(e: PointerEvent) {
    if (!specCanvas||!spectrumData) return;
    const rect=specCanvas.getBoundingClientRect();
    const px=e.clientX-rect.left, py=e.clientY-rect.top, W=rect.width, H=rect.height;
    const PAD=6;
    const vMin=viewMin??spectrumData.mz_min, vMax=viewMax??spectrumData.mz_max;
    const toX=(m:number)=>PAD+((m-vMin)/(vMax-vMin))*(W-PAD*2);
    const barH=10, barY=H-barH;
    // Check if click is in bin bar zone
    if (py >= barY) {
      dragging = "bin";
      dragBinStartX = px;
      dragBinStartCenter = binCenter;
      specCanvas.setPointerCapture(e.pointerId);
      return;
    }
    const x0=toX(mzMin), x1=toX(mzMax);
    dragging=Math.abs(px-x0)<Math.abs(px-x1)?"min":"max";
    specCanvas.setPointerCapture(e.pointerId);
  }

  function specPointerMove(e: PointerEvent) {
    if (!dragging||!specCanvas||!spectrumData) return;
    const rect=specCanvas.getBoundingClientRect();
    const px=e.clientX-rect.left, W=rect.width;
    const PAD=6;
    const vMin=viewMin??spectrumData.mz_min, vMax=viewMax??spectrumData.mz_max;
    if (dragging==="bin") {
      const pxPerDa=(W-PAD*2)/(vMax-vMin);
      const deltaMz=(px-dragBinStartX)/pxPerDa;
      const {mz_min:dMin,mz_max:dMax}=spectrumData;
      binCenter=Math.max(dMin,Math.min(dMax,dragBinStartCenter+deltaMz));
      return;
    }
    const mzAt=vMin+(px-PAD)/((W-PAD*2))*(vMax-vMin);
    const {mz_min:dMin,mz_max:dMax}=spectrumData;
    if (dragging==="min") mzMin=Math.round(Math.max(dMin,Math.min(mzMax-1,mzAt)));
    else mzMax=Math.round(Math.min(dMax,Math.max(mzMin+1,mzAt)));
  }

  function specPointerUp() { dragging=null; }

  // ── Fetch pełnorozdzielczościowego okna dla bin preview ──────────────────
  let _binFetchTimer: ReturnType<typeof setTimeout>|null = null;
  $effect(() => {
    // Śledź zmiany — muszą być odczytane żeby effect był reaktywny
    const center = binCenter, nBins = binNBins, bs = binSize;
    if (!spectrumData || !imzmlPath) return;
    if (_binFetchTimer) clearTimeout(_binFetchTimer);
    _binFetchTimer = setTimeout(async () => {
      const winHalf = (nBins * bs) / 2;
      const lo = Math.max(spectrumData!.mz_min, center - winHalf);
      const hi = Math.min(spectrumData!.mz_max, center + winHalf);
      binWinLoading = true;
      try {
        const r = await fetch(`${BASE}/spectrum_window?path=${encodeURIComponent(imzmlPath)}&mz_lo=${lo}&mz_hi=${hi}&n_avg=10`);
        if (r.ok) binWinData = await r.json();
      } catch {} finally { binWinLoading = false; }
    }, 400);
  });

  // ── Canvas: bin size zoom ─────────────────────────────────────────────────
  $effect(() => {
    binSize; binCenter; binNBins; binYShift; binWinData; spectrumData;
    if (!binCanvas) return;
    requestAnimationFrame(drawBinPreview);
  });

  function drawBinPreview() {
    if (!binCanvas) return;
    const ctx = binCanvas.getContext("2d"); if (!ctx) return;
    const W = binCanvas.offsetWidth || binCanvas.width || 300;
    const H = binCanvas.offsetHeight || binCanvas.height || 200;
    if (W < 10 || H < 10) return;   // nie rysuj gdy canvas zwinięty
    binCanvas.width=W; binCanvas.height=H;
    ctx.fillStyle="#111"; ctx.fillRect(0,0,W,H);

    // Użyj pełnorozdzielczościowych danych okna jeśli dostępne, inaczej fallback
    const src = binWinData ?? spectrumData;
    if (!src) {
      ctx.fillStyle="rgba(255,255,255,0.15)"; ctx.font="11px sans-serif";
      ctx.textAlign="center"; ctx.fillText(binWinLoading ? "Ładowanie…" : "Wczytaj plik", W/2, H/2);
      return;
    }

    const { mz, intensity } = src;
    const winHalf = (binNBins * binSize) / 2;
    const dMin = spectrumData?.mz_min ?? mz[0];
    const dMax = spectrumData?.mz_max ?? mz[mz.length-1];
    const wMin = Math.max(dMin, binCenter - winHalf);
    const wMax = Math.min(dMax, binCenter + winHalf);
    const wRange = wMax - wMin || 1;
    const toX = (m:number) => ((m - wMin) / wRange) * W;

    // Filtruj do okna (dla fallback danych)
    const idxs = mz.map((_,i)=>i).filter(i => mz[i] >= wMin && mz[i] <= wMax);
    if (idxs.length === 0) {
      ctx.fillStyle="rgba(255,255,255,0.15)"; ctx.font="10px sans-serif";
      ctx.textAlign="center"; ctx.fillText("Ładowanie…", W/2, H/2);
      return;
    }

    // Lokalne max w widocznym oknie — pełna skala, widać wszystkie piki
    const localMax = Math.max(...idxs.map(i => intensity[i])) || 1;
    const baseline = H + binYShift;
    const scaleY = (v: number) => baseline - (v / localMax) * H;

    // Bin boundaries
    const firstBin = Math.floor((wMin - mzMin) / binSize);
    const bins: number[] = [];
    for (let b = firstBin; b <= firstBin + binNBins + 2; b++) {
      const bEdge = mzMin + b * binSize;
      if (bEdge >= wMin && bEdge <= wMax) bins.push(bEdge);
    }

    // Alternating bin fills
    bins.forEach((bLeft, bi) => {
      const bRight = bLeft + binSize;
      const px0 = toX(bLeft), px1 = toX(bRight);
      ctx.fillStyle = bi%2===0 ? "rgba(255,201,81,0.07)" : "rgba(255,201,81,0.14)";
      ctx.fillRect(px0, 0, px1-px0, H);
    });

    // Clip
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();

    // Area fill
    ctx.beginPath();
    idxs.forEach((i, j) => {
      const px = toX(mz[i]), py = scaleY(intensity[i]);
      j === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.lineTo(toX(mz[idxs[idxs.length-1]]), H);
    ctx.lineTo(toX(mz[idxs[0]]), H);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.07)"; ctx.fill();

    // Linia widma — bez wygładzania, punkt-do-punktu
    ctx.beginPath(); ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1.2;
    idxs.forEach((i, j) => {
      const px = toX(mz[i]), py = scaleY(intensity[i]);
      j === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();

    // Bin boundary lines
    ctx.strokeStyle="rgba(255,201,81,0.5)"; ctx.lineWidth=1;
    bins.forEach(bEdge => {
      const px=toX(bEdge);
      ctx.beginPath(); ctx.moveTo(px,0); ctx.lineTo(px,H); ctx.stroke();
    });

    // Label lewy górny: bin size + zakres
    ctx.fillStyle="rgba(255,201,81,0.6)"; ctx.font="9px monospace";
    ctx.textAlign="left"; ctx.fillText(`bin ${binSize} Da · ${Math.round(wMin)}–${Math.round(wMax)} Da`, 4, 10);
    // Label prawy górny: liczba binów
    ctx.textAlign="right"; ctx.fillText(`→ ${nBins.toLocaleString()} binów`, W - 4, 10);
  }
</script>

<!-- ════════════════════════════════════════════════════════════════════════ -->
<div class="dane-tab">

  <!-- ── GÓRNA POŁOWA: LEWA (1+2) + PRAWA (4+bin) ─────────────────────── -->
  <div class="top-row">

    <!-- LEWA: Krok 1 + Krok 2 -->
    <div class="col-left">

      <!-- KROK 1 — PLIK -->
      <div class="card step-card">
        <div class="step-header">
          <span class="step-num">1</span>
          <span class="step-title">Plik źródłowy</span>
          {#if fileInfo}<span class="badge ok">✓ wczytany</span>{/if}
        </div>
        <div class="file-row">
          <input class="path-input" type="text" placeholder="ścieżka .imzML"
                 bind:value={imzmlPath} />
          <button class="btn-secondary" onclick={pickFile}>📁</button>
          <button class="btn-load" onclick={loadFile} disabled={loadingFile}>
            {#if loadingFile}<span class="spinner-sm"></span>{:else}Wczytaj{/if}
          </button>
        </div>
        {#if fileError}
          <div class="error-msg">⚠ {fileError}</div>
        {:else if fileInfo}
          <div class="file-info">{fileInfo.width}×{fileInfo.height} px</div>
        {/if}
      </div>

      <!-- KROK 2 — TIC + DETEKCJA -->
      <div class="card step-card flex-grow">
        <div class="step-header">
          <span class="step-num">2</span>
          <span class="step-title">Detekcja tkanek</span>
          <span class="badge accent">{tissues.length} ROI</span>
          <button class="btn-secondary ml-auto" onclick={detectTissues} disabled={detecting||loadingFile}>
            {detecting ? "…" : "Auto-detekcja"}
          </button>
        </div>

        {#if detectionData}
          <div class="tic-wrap">
            <canvas bind:this={ticCanvas} class="tic-canvas" onclick={onTicClick} style="cursor:pointer"></canvas>
          </div>
          <canvas bind:this={profileCanvas} class="profile-canvas"></canvas>
          <div class="profile-axis">
            <span>{detectionData.x_offset}</span>
            <span style="color:rgba(255,255,255,0.2)">x [px]</span>
            <span>{detectionData.x_offset+detectionData.width-1}</span>
          </div>
        {:else}
          <div class="empty-hint">Wczytaj plik, aby zobaczyć mapę i wykryć ROI</div>
        {/if}

        {#if tissues.length > 0}
          <div class="tissue-chips">
            {#each tissues as t, i}
              <div
                class="tissue-chip"
                class:chip-disabled={t.enabled === false}
                style="border-color:{TISSUE_COLORS[i%TISSUE_COLORS.length]}"
              >
                <input
                  class="chip-name-input"
                  type="text"
                  value={t.label}
                  onclick={(e) => e.stopPropagation()}
                  onchange={(e) => {
                    const el = e.target as HTMLInputElement;
                    const newVal = el.value.trim();
                    if (!newVal) { el.value = t.label; return; }
                    if (tissues.some((other, j) => j !== i && other.label === newVal)) {
                      el.value = t.label;
                      el.setCustomValidity(`Nazwa "${newVal}" jest już zajęta`);
                      el.reportValidity();
                      setTimeout(() => el.setCustomValidity(""), 3000);
                      return;
                    }
                    tissues[i] = { ...t, label: newVal };
                    saveTissueLabels();
                  }}
                  style="color:{TISSUE_COLORS[i%TISSUE_COLORS.length]}"
                />
                <span class="chip-range">x {t.x_min}–{t.x_max}{#if t.y_min != null}, y {t.y_min}–{t.y_max}{/if}</span>
                {#if t.is_ref}<span class="chip-star">★</span>{/if}
                {#if t.enabled === false}<span class="chip-off">off</span>{/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

    </div>

    <!-- PRAWA: Krok 4 + Bin preview -->
    <div class="col-right">

      <!-- KROK 4 — PRZETWARZANIE -->
      <div class="card step-card">
        <div class="step-header">
          <span class="step-num">4</span>
          <span class="step-title">Przetwarzanie</span>
          {#if status && status.npz_files.length > 0 && !processing}
            <span class="badge ok ml-auto">✓ gotowe</span>
          {/if}
        </div>

        <button class="btn-process" onclick={runProcess}
                disabled={processing || tissues.length === 0}>
          {#if processing}
            <span class="spinner-sm dark"></span> Przetwarzam…
          {:else}
            ▶ Przetwórz i zapisz .npz
          {/if}
        </button>

        {#if processing || processPct > 0}
          <div class="progress-wrap">
            <div class="progress-bar" style="width:{processPct}%"></div>
            <span class="progress-pct">{processPct}%</span>
          </div>
        {/if}

        {#if processError}
          <div class="error-msg">⚠ {processError}</div>
        {/if}

        <div class="process-bottom">
          {#if processLog.length > 0}
            <div class="process-log">
              {#each processLog.slice(-6) as line}
                <div class="log-line">{line}</div>
              {/each}
            </div>
          {/if}
          {#if status && status.npz_files.length > 0}
            <div class="npz-panel">
              {#each status.npz_files as f, i}
                {@const customName = tissues.find(t => t.id === f.id)?.label}
                <div class="npz-row">
                  <div class="npz-dot" style="background:{TISSUE_COLORS[i%TISSUE_COLORS.length]}"></div>
                  <span class="npz-name">{customName ?? f.filename}</span>
                  <span class="npz-meta">{f.size_mb} MB</span>
                </div>
              {/each}
              <div class="ready-hint">Gotowe!</div>
            </div>
          {/if}
        </div>
      </div>

      <!-- BIN SIZE PREVIEW -->
      <div class="card step-card bin-preview-card">
        <div class="step-header">
          <span class="step-num" style="background:rgba(100,180,255,0.15);color:#7ac">⊞</span>
          <span class="step-title">Podgląd bin size</span>
        </div>
        {#if spectrumData}
          <div class="bin-body">
            <canvas bind:this={binCanvas} class="bin-canvas"></canvas>
            {#if binWinLoading}<div class="bin-loading">⏳</div>{/if}
            <div class="bin-yscroll">
              <input type="range" min="0" max="600" step="5"
                     bind:value={binYShift} class="slider-vert" />
            </div>
          </div>
          <div class="bin-sliders">
            <div class="param-group" style="flex-shrink:0">
              <label class="param-label">Bin size [Da]</label>
              <input class="param-input" type="number" min="0.05" max="2" step="0.05"
                     bind:value={binSize} style="width:70px" />
            </div>
            <div class="slider-group">
              <label class="param-label">Pozycja</label>
              <input type="range"
                     min={spectrumData.mz_min} max={spectrumData.mz_max} step={binSize}
                     bind:value={binCenter} class="slider-ctrl" />
            </div>
            <div class="slider-group">
              <label class="param-label">Zoom (binów)</label>
              <input type="range" min="3" max="120" step="1"
                     bind:value={binNBins} class="slider-ctrl" />
              <span class="slider-val">{binNBins}</span>
            </div>
          </div>
        {:else}
          <div class="empty-hint">Wczytaj plik aby zobaczyć podgląd</div>
        {/if}
      </div>

    </div>
  </div>

  <!-- ── DOLNA SEKCJA: KROK 3 — WIDMO PEŁNA SZEROKOŚĆ ─────────────────── -->
  <div class="card step-card step3-full">
    <div class="step-header">
      <span class="step-num">3</span>
      <span class="step-title">Parametry preprocessingu — widmo {tissues[0]?.label ?? "T1"}</span>
      {#if spectrumData}
        <span class="badge">m/z {spectrumData.mz_min.toFixed(0)}–{spectrumData.mz_max.toFixed(0)} Da</span>
      {/if}
    </div>

    <div class="spec-wrap">
      {#if loadingSpectrum}
        <div class="spec-loading"><div class="shimmer"></div></div>
      {:else if spectrumData}
        <canvas bind:this={specCanvas} class="spec-canvas"
                onpointerdown={specPointerDown}
                onpointermove={specPointerMove}
                onpointerup={specPointerUp}></canvas>
      {:else}
        <div class="empty-hint">Wczytaj plik, aby zobaczyć widmo</div>
      {/if}
    </div>

    <div class="params-row">
      <div class="param-group">
        <label class="param-label">m/z min [Da]</label>
        <input class="param-input" type="number" min="100" max="5000" step="1"
               bind:value={mzMin} />
      </div>
      <div class="param-group">
        <label class="param-label">m/z max [Da]</label>
        <input class="param-input" type="number" min="100" max="5000" step="1"
               bind:value={mzMax} />
      </div>
      <div class="view-btns">
        <button class="btn-view" onclick={scaleToSelection} title="Rozszerz widmo do granic min/max">
          Skaluj
        </button>
        <button class="btn-view" onclick={resetView} title="Pokaż całe widmo">
          Reset
        </button>
      </div>
    </div>
  </div>

</div>

<!-- ════════════════════════════════════════════════════════════════════════ -->
<style>
  /* ── Layout główny ─────────────────────────────────────────────────────── */
  .dane-tab {
    flex: 1; min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    box-sizing: border-box;
    overflow: hidden;
  }

  .top-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    flex: 1; min-height: 0;
    overflow: hidden;
  }

  .col-left, .col-right {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    overflow: hidden;
  }

  /* Krok 3 — pełna szerokość u dołu, większa wysokość */
  .step3-full {
    flex-shrink: 0;
    height: 280px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* Bin preview — rośnie do dostępnej przestrzeni */
  .bin-preview-card {
    flex: 1;
    min-height: 0;
  }

  /* ── Cards ─────────────────────────────────────────────────────────────── */
  .card {
    background: #222;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 12px;
    padding: 10px 12px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 7px;
    overflow: hidden;
  }

  .flex-grow { flex: 1; min-height: 0; }

  /* ── Step header ───────────────────────────────────────────────────────── */
  .step-header {
    display: flex; align-items: center; gap: 7px; flex-shrink: 0;
  }
  .step-num {
    width: 19px; height: 19px; border-radius: 50%;
    background: rgba(255,201,81,0.18); color: #ffc951;
    font-size: 0.68rem; font-weight: 700;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .step-title {
    font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: rgba(255,255,255,0.45); flex: 1;
  }
  .ml-auto { margin-left: auto; }

  /* ── Badges ────────────────────────────────────────────────────────────── */
  .badge {
    font-size: 0.58rem; padding: 2px 6px; border-radius: 20px;
    background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.35);
    border: 1px solid rgba(255,255,255,0.08); white-space: nowrap;
  }
  .badge.ok { background: rgba(100,220,100,0.12); color: #80e080; border-color: rgba(100,220,100,0.2); }
  .badge.accent { background: rgba(255,201,81,0.12); color: #ffc951; border-color: rgba(255,201,81,0.2); }

  /* ── File row ──────────────────────────────────────────────────────────── */
  .file-row { display: flex; gap: 5px; align-items: center; flex-shrink: 0; }
  .path-input {
    flex: 1; background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.1); border-radius: 7px;
    color: rgba(255,255,255,0.7); font-size: 0.68rem;
    padding: 5px 8px; font-family: inherit; outline: none; min-width: 0;
  }
  .path-input:focus { border-color: #ffc951; }
  .btn-secondary {
    padding: 5px 9px; background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
    color: rgba(255,255,255,0.5); font-size: 0.68rem; cursor: pointer;
    font-family: inherit; white-space: nowrap; transition: all 0.15s; flex-shrink: 0;
  }
  .btn-secondary:hover:not(:disabled) { border-color: rgba(255,201,81,0.3); color: #ffc951; }
  .btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-load {
    padding: 5px 11px; background: rgba(255,201,81,0.15);
    border: 1px solid rgba(255,201,81,0.3); border-radius: 7px;
    color: #ffc951; font-size: 0.68rem; font-weight: 600; cursor: pointer;
    font-family: inherit; display: flex; align-items: center; gap: 5px; flex-shrink: 0;
  }
  .btn-load:hover:not(:disabled) { background: rgba(255,201,81,0.25); }
  .btn-load:disabled { opacity: 0.5; cursor: not-allowed; }
  .file-info { font-size: 0.62rem; color: rgba(255,255,255,0.28); }
  .error-msg { font-size: 0.62rem; color: #ff8080; }

  /* ── TIC ───────────────────────────────────────────────────────────────── */
  .tic-wrap { position: relative; flex-shrink: 0; }
  .tic-canvas {
    width: 100%; height: auto; display: block;
    image-rendering: pixelated;
  }
  .tic-labels-abs {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    pointer-events: none;
  }
  .tic-label {
    position: absolute;
    padding-top: 2px;
    font-size: 0.55rem; font-weight: 700; text-align: center;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .profile-canvas {
    width: 100%; height: 36px; display: block;
    border-radius: 4px; flex-shrink: 0;
  }
  .profile-axis {
    display: flex; justify-content: space-between;
    font-size: 0.52rem; color: rgba(255,255,255,0.18);
    flex-shrink: 0; margin-top: -4px;
  }

  /* ── Tissue chips ──────────────────────────────────────────────────────── */
  .tissue-chips {
    display: flex; flex-wrap: wrap; gap: 4px; flex-shrink: 0;
  }
  .tissue-chip {
    display: flex; align-items: center; gap: 4px;
    padding: 5px 9px;
    background: rgba(255,255,255,0.03);
    border: 1px solid; border-radius: 5px; font-size: 0.6rem;
    transition: opacity 0.15s;
    user-select: none;
  }
  .tissue-chip.chip-disabled { opacity: 0.35; background: rgba(0,0,0,0.2); }

  .chip-name-input {
    background: transparent; border: none; outline: none;
    font-family: inherit; font-size: inherit; font-weight: 600;
    width: 60px; cursor: text; padding: 0;
  }
  .chip-name-input:focus { border-bottom: 1px solid rgba(255,255,255,0.3); }

  .chip-range { color: rgba(255,255,255,0.3); }
  .chip-star  { color: #ffc951; }
  .chip-off   { color: rgba(255,100,100,0.7); font-size: 0.55rem; }

  /* ── Spectrum (krok 3) ──────────────────────────────────────────────────── */
  .spec-wrap {
    flex: 1; min-height: 0; position: relative;
    background: #111;
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 6px;
    overflow: hidden;
  }
  .spec-canvas {
    width: 100%; height: 100%; display: block; cursor: ew-resize;
    touch-action: none;
  }
  .spec-loading { width: 100%; height: 100%; }
  .shimmer {
    width: 100%; height: 100%;
    background: linear-gradient(90deg,#1a1a1a 25%,#2a2a2a 50%,#1a1a1a 75%);
    background-size: 200% 100%; animation: shimmer 1.4s infinite; border-radius: 5px;
  }
  @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

  /* ── Bin preview canvas ─────────────────────────────────────────────────── */
  .bin-loading {
    position: absolute; top: 4px; right: 26px;
    font-size: 0.65rem; color: rgba(255,201,81,0.6);
    pointer-events: none;
  }

  .bin-body {
    position: relative;
    display: flex; flex-direction: row; flex: 1; min-height: 0; gap: 4px;
  }

  .bin-canvas {
    flex: 1; height: 100%; min-width: 0; display: block;
    border-radius: 5px;
    background: #111;
    border: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
  }

  .bin-yscroll {
    display: flex; align-items: stretch; width: 18px; flex-shrink: 0;
  }

  .slider-vert {
    writing-mode: vertical-lr;
    direction: rtl;
    width: 18px;
    height: 100%;
    cursor: pointer;
    flex: 1;
    -webkit-appearance: none; appearance: none;
    background: #3a3a3a; border-radius: 2px; outline: none; border: none;
  }
  .slider-vert::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 13px; height: 13px; border-radius: 50%;
    background: #ffc951; cursor: pointer; border: none;
    box-shadow: 0 0 4px rgba(255,201,81,0.4);
  }
  .slider-vert::-moz-range-thumb {
    width: 13px; height: 13px; border-radius: 50%;
    background: #ffc951; cursor: pointer; border: none;
  }

  .bin-sliders {
    display: flex; gap: 10px; flex-shrink: 0; align-items: center;
  }

  .slider-group {
    display: flex; align-items: center; gap: 5px; flex: 1;
  }

  .slider-ctrl {
    flex: 1; cursor: pointer;
    -webkit-appearance: none; appearance: none;
    height: 13px;
    background: transparent;
    outline: none; border: none;
    padding: 0; margin: 0;
  }
  .slider-ctrl::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 13px; height: 13px;
    border-radius: 50%;
    background: #ffc951;
    cursor: pointer;
    border: none;
    box-shadow: 0 0 4px rgba(255,201,81,0.4);
    margin-top: -4.5px;
  }
  .slider-ctrl::-moz-range-thumb {
    width: 13px; height: 13px;
    border-radius: 50%;
    background: #ffc951;
    cursor: pointer;
    border: none;
  }
  .slider-ctrl::-webkit-slider-runnable-track {
    background: #3a3a3a; border-radius: 2px; height: 4px;
  }
  .slider-ctrl::-moz-range-track {
    background: #3a3a3a; border-radius: 2px; height: 4px;
  }

  .slider-val {
    font-size: 0.6rem; color: rgba(255,201,81,0.7);
    min-width: 20px; text-align: right;
  }

  /* ── View buttons (Skaluj / Reset) ──────────────────────────────────────── */
  .view-btns { display: flex; gap: 4px; flex-shrink: 0; align-self: flex-end; padding-bottom: 5px; }

  .btn-view {
    padding: 4px 9px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px; color: rgba(255,255,255,0.45);
    font-size: 0.65rem; cursor: pointer; font-family: inherit;
    transition: all 0.15s;
  }
  .btn-view:hover { border-color: rgba(255,201,81,0.35); color: #ffc951; }

  /* ── Params row ────────────────────────────────────────────────────────── */
  .params-row {
    display: flex; gap: 8px; align-items: flex-end; flex-shrink: 0;
  }
  .param-group { display: flex; flex-direction: column; gap: 2px; }
  .param-label {
    font-size: 0.55rem; text-transform: uppercase;
    letter-spacing: 0.07em; color: rgba(255,255,255,0.28);
  }
  .param-input {
    background: #1a1a1a; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px; color: #f0f0f0; font-size: 0.78rem;
    padding: 4px 7px; font-family: inherit; outline: none;
    width: 80px; box-sizing: border-box; -moz-appearance: textfield;
  }
  .param-input:focus { border-color: #ffc951; }
  .param-input::-webkit-inner-spin-button { opacity: 0.3; }
  .param-preview {
    font-size: 0.62rem; color: #ffc951; white-space: nowrap; padding-bottom: 5px;
  }

  /* ── Process (krok 4) ───────────────────────────────────────────────────── */
  .btn-process {
    width: 100%; padding: 9px; background: #ffc951; color: #1a1a1a;
    border: none; border-radius: 9px; font-size: 0.82rem; font-weight: 700;
    cursor: pointer; font-family: inherit;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    transition: background 0.18s; flex-shrink: 0;
  }
  .btn-process:hover:not(:disabled) { background: #ffd57a; }
  .btn-process:disabled { opacity: 0.4; cursor: not-allowed; }

  .progress-wrap {
    position: relative; height: 4px;
    background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; flex-shrink: 0;
  }
  .progress-bar { height: 100%; background: #ffc951; border-radius: 3px; transition: width 0.3s; }
  .progress-pct { position: absolute; right: 0; top: -15px; font-size: 0.58rem; color: #ffc951; }

  .process-bottom { display: flex; gap: 7px; flex-shrink: 0; }
  .process-log {
    flex: 1; background: #111; border-radius: 6px;
    padding: 5px 8px; display: flex; flex-direction: column; gap: 2px; min-width: 0;
  }
  .log-line { font-size: 0.58rem; color: rgba(255,255,255,0.28); }
  .npz-panel {
    flex: 1; background: rgba(100,220,100,0.04);
    border: 1px solid rgba(100,220,100,0.1); border-radius: 6px;
    padding: 5px 8px; display: flex; flex-direction: column; gap: 2px; min-width: 0;
  }
  .npz-row { display: flex; align-items: center; gap: 5px; font-size: 0.6rem; }
  .npz-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .npz-name { flex: 1; color: rgba(255,255,255,0.55); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .npz-meta { color: rgba(255,255,255,0.22); white-space: nowrap; }
  .ready-hint { font-size: 0.6rem; color: #80e080; text-align: center; padding-top: 2px; font-weight: 600; }

  /* ── Misc ──────────────────────────────────────────────────────────────── */
  .empty-hint {
    font-size: 0.65rem; color: rgba(255,255,255,0.18);
    text-align: center; padding: 8px 0;
  }
  .spinner-sm {
    width: 11px; height: 11px;
    border: 2px solid rgba(255,255,255,0.15); border-top-color: #ffc951;
    border-radius: 50%; animation: spin 0.7s linear infinite;
    display: inline-block; flex-shrink: 0;
  }
  .spinner-sm.dark { border-top-color: #1a1a1a; border-color: rgba(0,0,0,0.2); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
