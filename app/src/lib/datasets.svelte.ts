// Store dla Zestawów Danych (Datasets). Każdy workspace ma własną listę
// zestawów (surowy binning z Dane, oraz kolejne = wyniki pipeline'u
// preprocessingu z preWidma). CRUD analogiczny do workspace.svelte.ts,
// ale scope'owany do aktywnego workspace'u (przeładowywany po jego zmianie).

import { activeWorkspaceId } from "./workspace.svelte";

const BASE = "http://127.0.0.1:7432";

export interface DatasetMeta {
  id: string;
  name: string;
  kind: "binned" | "pipeline" | "empty";
  createdAt: string;
  updatedAt: string;
  params?: Record<string, unknown>;
  source_dataset_id?: string;
  steps?: { method: string; params: Record<string, number> }[];
}

export const RAW_DATASET_ID = "__raw__"; // pseudo-zestaw: surowe widmo z imzML

let _list = $state<DatasetMeta[]>([]);
let _activeId = $state<string>("");
let _loaded = $state(false);

export function datasets(): DatasetMeta[] {
  return _list;
}

export function activeDatasetId(): string {
  return _activeId;
}

export function datasetsLoaded(): boolean {
  return _loaded;
}

export function datasetLabel(id: string): string {
  if (id === RAW_DATASET_ID) return "Oryginalne (raw imzML)";
  return _list.find((d) => d.id === id)?.name ?? id;
}

export async function loadDatasets(): Promise<DatasetMeta[]> {
  const wid = activeWorkspaceId();
  if (!wid) { _list = []; _activeId = ""; _loaded = true; return _list; }
  const r = await fetch(`${BASE}/workspaces/${wid}/datasets`);
  const d = await r.json();
  _list = d.datasets ?? [];
  _activeId = d.active_id ?? "";
  _loaded = true;
  return _list;
}

export async function createDataset(name: string, kind: DatasetMeta["kind"] = "empty"): Promise<DatasetMeta> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/datasets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, kind }),
  });
  const ds = await r.json();
  await loadDatasets();
  return ds;
}

export async function renameDataset(id: string, name: string): Promise<void> {
  const wid = activeWorkspaceId();
  await fetch(`${BASE}/workspaces/${wid}/datasets/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await loadDatasets();
}

export async function deleteDataset(id: string): Promise<void> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/datasets/${id}`, { method: "DELETE" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd usuwania" }));
    throw new Error(err.detail ?? "Błąd usuwania zestawu danych");
  }
  await loadDatasets();
}

export async function activateDataset(id: string): Promise<void> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/datasets/${id}/activate`, { method: "POST" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd aktywacji" }));
    throw new Error(err.detail ?? "Błąd aktywacji zestawu danych");
  }
  await loadDatasets();
}

export interface SseEvent { event: string; data: any; }

async function* streamSse(r: Response): AsyncGenerator<SseEvent> {
  if (!r.body) return;
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const evMatch = part.match(/^event: (.+)$/m);
      const dataMatch = part.match(/^data: (.+)$/m);
      if (!dataMatch) continue;
      yield { event: evMatch?.[1] ?? "message", data: JSON.parse(dataMatch[1]) };
    }
  }
}

/** Buduje zestaw `datasetId` stosując łańcuch kroków preprocessingu (z grafu
 * preWidma) do każdego piksela zestawu źródłowego. Zwraca strumień zdarzeń SSE. */
export async function buildPipelineDataset(
  datasetId: string,
  sourceDatasetId: string,
  steps: { method: string; params: Record<string, number> }[],
  onProgress?: (pct: number, message: string) => void,
): Promise<void> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/datasets/${datasetId}/build_pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_dataset_id: sourceDatasetId, steps }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: `API error ${r.status}` }));
    throw new Error(err.detail ?? `API error ${r.status}`);
  }
  for await (const ev of streamSse(r)) {
    if (ev.event === "progress") onProgress?.(ev.data.pct ?? 0, ev.data.message ?? "");
    if (ev.event === "error") throw new Error(ev.data.message ?? "Błąd budowania zestawu");
  }
  await loadDatasets();
}
