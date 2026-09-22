// Centralny store Workspace — zastępuje rozproszone localStorage.
// Cały stan sesji (aktywna zakładka, tkanki, kolory, warstwy widm, itd.)
// jest trzymany w jednym obiekcie `_cache` i zapisywany (debounced) do sidecara,
// który trzyma go per-workspace na dysku.

const BASE = "http://127.0.0.1:7432";

export interface WorkspaceMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

let _cache = $state<Record<string, unknown>>({});
let _list = $state<WorkspaceMeta[]>([]);
let _activeId = $state<string>("");
let _loaded = $state(false);
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadWorkspaces(): Promise<void> {
  const r = await fetch(`${BASE}/workspaces`);
  const d = await r.json();
  _list = d.workspaces ?? [];
  _activeId = d.active_id ?? "";
  if (_activeId) {
    const s = await fetch(`${BASE}/workspaces/${_activeId}/settings`);
    _cache = s.ok ? await s.json() : {};
  } else {
    _cache = {};
  }
  _loaded = true;
}

export function isLoaded(): boolean {
  return _loaded;
}

export function wsGet<T>(key: string, fallback: T): T {
  return key in _cache ? (_cache[key] as T) : fallback;
}

export function wsSet(key: string, value: unknown): void {
  _cache[key] = value;
  _scheduleSave();
}

function _scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { saveNow(); }, 500);
}

export async function saveNow(): Promise<void> {
  if (!_activeId) return;
  try {
    await fetch(`${BASE}/workspaces/${_activeId}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_cache),
    });
  } catch {}
}

export function workspaces(): WorkspaceMeta[] {
  return _list;
}

export function activeWorkspaceId(): string {
  return _activeId;
}

export function activeWorkspace(): WorkspaceMeta | undefined {
  return _list.find((w) => w.id === _activeId);
}

export async function createWorkspace(name: string): Promise<void> {
  const r = await fetch(`${BASE}/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const w = await r.json();
  await switchWorkspace(w.id);
}

export async function switchWorkspace(id: string): Promise<void> {
  await saveNow();
  await fetch(`${BASE}/workspaces/${id}/activate`, { method: "POST" });
  location.reload();
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  await fetch(`${BASE}/workspaces/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await loadWorkspaces();
}

export async function deleteWorkspace(id: string): Promise<void> {
  const r = await fetch(`${BASE}/workspaces/${id}`, { method: "DELETE" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd usuwania" }));
    throw new Error(err.detail ?? "Błąd usuwania workspace");
  }
  await loadWorkspaces();
}

export async function exportWorkspace(id: string, destDir: string): Promise<string> {
  const r = await fetch(`${BASE}/workspaces/${id}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dest_dir: destDir }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd eksportu" }));
    throw new Error(err.detail ?? "Błąd eksportu workspace");
  }
  const d = await r.json();
  return d.path as string;
}

export async function importWorkspace(srcDir: string): Promise<void> {
  const r = await fetch(`${BASE}/workspaces/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ src_dir: srcDir }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd importu" }));
    throw new Error(err.detail ?? "Błąd importu workspace");
  }
  const w = await r.json();
  await switchWorkspace(w.id);
}
