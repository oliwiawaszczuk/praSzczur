// Store dla zakładki "Notatki" — swobodne notatki tekstowe, NIEZALEŻNE od
// workspace'ów (ten sam duch co board.svelte.ts dla Tablicy): jedna wspólna
// lista, przechowywana w notes/ (osobno od workspaces/).

const BASE = "http://127.0.0.1:7432";

export interface NoteMeta {
  id: string;
  title: string;
  titleManual: boolean;
  preview: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteData {
  text: string;
}

let _list = $state<NoteMeta[]>([]);
let _loaded = $state(false);

export function notes(): NoteMeta[] {
  return _list;
}

export function notesLoaded(): boolean {
  return _loaded;
}

export async function loadNotes(): Promise<NoteMeta[]> {
  const r = await fetch(`${BASE}/notes`);
  const d = await r.json();
  _list = d.notes ?? [];
  _loaded = true;
  return _list;
}

export async function createNote(title = "Nowa notatka"): Promise<NoteMeta> {
  const r = await fetch(`${BASE}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const n = await r.json();
  await loadNotes();
  return n;
}

export async function renameNote(id: string, title: string): Promise<void> {
  await fetch(`${BASE}/notes/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  await loadNotes();
}

export async function deleteNote(id: string): Promise<void> {
  const r = await fetch(`${BASE}/notes/${id}`, { method: "DELETE" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd usuwania" }));
    throw new Error(err.detail ?? "Błąd usuwania notatki");
  }
  await loadNotes();
}

export async function getNote(id: string): Promise<NoteData> {
  const r = await fetch(`${BASE}/notes/${id}/data`);
  if (!r.ok) throw new Error(`Błąd wczytywania notatki (${r.status})`);
  return r.json();
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingSave: { id: string; data: NoteData } | null = null;

export function scheduleSaveNote(id: string, data: NoteData): void {
  _pendingSave = { id, data };
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { flushSaveNote(); }, 800);
}

export async function flushSaveNote(): Promise<void> {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (!_pendingSave) return;
  const { id, data } = _pendingSave;
  _pendingSave = null;
  try {
    await fetch(`${BASE}/notes/${id}/data`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const entry = _list.find((n) => n.id === id);
    if (entry) {
      entry.updatedAt = new Date().toISOString();
      entry.preview = data.text.trim().slice(0, 300);
      if (!entry.titleManual) {
        const firstLine = data.text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
        if (firstLine) entry.title = firstLine.slice(0, 80);
      }
    }
  } catch {}
}
