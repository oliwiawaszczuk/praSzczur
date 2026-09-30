// Store dla WIELU Node Graphów per workspace (w odróżnieniu od Tablicy, grafy
// SĄ per-workspace, nie globalne — patrz board.svelte.ts dla kontrastu).
// Ten sam duch co board.svelte.ts: lekki rejestr metadanych (nazwa/daty) +
// osobny endpoint /data na pełną treść grafu (nodes/edges/viewport/notes),
// autozapis debounced z frontu.

import { activeWorkspaceId } from "$lib/workspace.svelte";
import { defaultGraph, type Graph } from "$lib/nodegraph";

const BASE = "http://127.0.0.1:7432";

export interface NodeGraphMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

let _list = $state<NodeGraphMeta[]>([]);
let _loaded = $state(false);

export function nodeGraphs(): NodeGraphMeta[] {
  return _list;
}

export function nodeGraphsLoaded(): boolean {
  return _loaded;
}

export async function loadNodeGraphs(): Promise<NodeGraphMeta[]> {
  const wid = activeWorkspaceId();
  if (!wid) { _list = []; _loaded = true; return _list; }
  const r = await fetch(`${BASE}/workspaces/${wid}/nodegraphs`);
  const d = await r.json();
  _list = d.graphs ?? [];
  _loaded = true;
  return _list;
}

export async function createNodeGraph(name: string): Promise<NodeGraphMeta> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/nodegraphs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const g = await r.json();
  await loadNodeGraphs();
  return g;
}

export async function renameNodeGraph(id: string, name: string): Promise<void> {
  const wid = activeWorkspaceId();
  await fetch(`${BASE}/workspaces/${wid}/nodegraphs/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await loadNodeGraphs();
}

export async function deleteNodeGraph(id: string): Promise<void> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/nodegraphs/${id}`, { method: "DELETE" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd usuwania" }));
    throw new Error(err.detail ?? "Błąd usuwania grafu");
  }
  await loadNodeGraphs();
}

export async function getNodeGraphData(id: string): Promise<Graph> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/nodegraphs/${id}/data`);
  if (!r.ok) throw new Error(`Błąd wczytywania grafu (${r.status})`);
  return r.json();
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingSave: { id: string; data: Graph } | null = null;

export function scheduleSaveNodeGraph(id: string, data: Graph): void {
  _pendingSave = { id, data };
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { flushSaveNodeGraph(); }, 300);
}

export async function flushSaveNodeGraph(): Promise<void> {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (!_pendingSave) return;
  const { id, data } = _pendingSave;
  _pendingSave = null;
  const wid = activeWorkspaceId();
  try {
    await fetch(`${BASE}/workspaces/${wid}/nodegraphs/${id}/data`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const entry = _list.find((g) => g.id === id);
    if (entry) entry.updatedAt = new Date().toISOString();
  } catch {}
}

/** Zapewnia, że aktywny workspace ma przynajmniej jeden graf — jeśli lista
 * jest pusta po wczytaniu, tworzy pusty "Graf 1" (jak Tablica dla tablic). */
export async function ensureAtLeastOneGraph(): Promise<NodeGraphMeta> {
  if (!nodeGraphsLoaded()) await loadNodeGraphs();
  if (_list.length > 0) return _list[0];
  return createNodeGraph("Graf 1");
}

export function emptyGraphData(): Graph {
  return defaultGraph();
}
