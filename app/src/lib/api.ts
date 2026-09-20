const BASE = "http://127.0.0.1:7432";
const POLL_INTERVAL = 300; // ms
const POLL_TIMEOUT  = 15_000; // ms

export async function waitForSidecar(): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise(res => setTimeout(res, POLL_INTERVAL));
  }
  throw new Error("Sidecar nie odpowiedział w ciągu 30 s");
}

export interface TissueImage {
  label: string;
  data: number[][];
  width: number;
  height: number;
  vmax: number;
}

export interface IonImageResponse {
  mz: number;
  tol: number;
  tissues: Record<string, TissueImage>;
}

export async function fetchIonImage(mz: number, tol: number): Promise<IonImageResponse> {
  const r = await fetch(`${BASE}/ion_image?mz=${mz}&tol=${tol}`);
  if (!r.ok) throw new Error(`API error ${r.status}`);
  return r.json();
}

export interface DatasetStatus {
  mz_min: number;
  mz_max: number;
  n_bins: number;
  n_tissues: number;
}

export async function fetchDatasetStatus(): Promise<DatasetStatus | null> {
  try {
    const r = await fetch(`${BASE}/dataset_status`);
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

export interface PixelSpectrum {
  tissue: string; x: number; y: number;
  mz: number[]; intensity: number[];
}

export async function fetchPixelSpectrum(tissue: string, x: number, y: number): Promise<PixelSpectrum> {
  const r = await fetch(`${BASE}/pixel_spectrum?tissue=${tissue}&x=${x}&y=${y}`);
  if (!r.ok) throw new Error(`API error ${r.status}`);
  return r.json();
}

export interface TissuePixelMap {
  tissue: string; xs: number[]; ys: number[]; values: number[];
}

export async function fetchTissuePixelMap(tissue: string, mz?: number, tol?: number): Promise<TissuePixelMap> {
  const params = new URLSearchParams({ tissue });
  if (mz !== undefined) { params.set("mz", mz.toString()); params.set("tol", (tol ?? 0.3).toString()); }
  const r = await fetch(`${BASE}/tissue_pixel_map?${params}`);
  if (!r.ok) throw new Error(`API error ${r.status}`);
  return r.json();
}
