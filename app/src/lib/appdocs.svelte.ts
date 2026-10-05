// Dane zakładki "Dokumentacja" — globalne, NIEZALEŻNE od workspace'u (ten sam
// duch co board.svelte.ts/notes.svelte.ts), przechowywane w app_docs.json w
// rootcie (endpointy /app_docs w sidecarze, ten sam wzorzec co
// appSettings.svelte.ts). Trzy sekcje:
//  - "tabs"  — poradnik per zakładka appki (treść edytowalna przez usera).
//  - "nodes" — NADPISANIA domyślnego NodeTypeDef.description per typ node'a
//              Node Grapha. Puste/nieobecne = pokaż domyślny opis z kodu.
//  - "pages" — dowolne dodatkowe strony dodane przez usera (tytuł + treść),
//              w kolejności wyświetlania (index w tablicy = kolejność).
// To jedyne źródło prawdy dla opisu node'a: NodeGraphTab.svelte (tooltip
// "(i)" na node'ie, podpowiedź w palecie) i Dokumentacja.svelte (widok/edycja
// sekcji node'a) czytają i zapisują DOKŁADNIE ten sam klucz — edycja w jednym
// miejscu natychmiast odzwierciedla się w drugim.

const BASE = "http://127.0.0.1:7432";

export interface CustomPage {
  id: string;
  title: string;
  body: string;
}

interface AppDocsData {
  tabs: Record<string, string>;
  nodes: Record<string, string>;
  pages: CustomPage[];
}

let _data = $state<AppDocsData>({ tabs: {}, nodes: {}, pages: [] });
let _loaded = $state(false);
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadAppDocs(): Promise<void> {
  try {
    const r = await fetch(`${BASE}/app_docs`);
    const d = r.ok ? await r.json() : { tabs: {}, nodes: {}, pages: [] };
    _data = { tabs: d.tabs ?? {}, nodes: d.nodes ?? {}, pages: d.pages ?? [] };
  } catch {
    _data = { tabs: {}, nodes: {}, pages: [] };
  }
  _loaded = true;
}

export function appDocsLoaded(): boolean {
  return _loaded;
}

function scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { flushAppDocs(); }, 500);
}

export async function flushAppDocs(): Promise<void> {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    await fetch(`${BASE}/app_docs`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_data),
    });
  } catch {}
}

export function getTabDoc(tabKey: string): string {
  return _data.tabs[tabKey] ?? "";
}

export function setTabDoc(tabKey: string, body: string): void {
  _data.tabs = { ..._data.tabs, [tabKey]: body };
  scheduleSave();
}

/** Opis node'a — nadpisanie, jeśli zapisane, inaczej `fallback` (domyślny
 * NodeTypeDef.description zdefiniowany w kodzie). */
export function getNodeDoc(typeId: string, fallback: string): string {
  const v = _data.nodes[typeId];
  return v && v.trim() ? v : fallback;
}

/** true, jeśli opis node'a ma zapisane (userowe) nadpisanie, a nie tylko
 * domyślny opis z kodu — Dokumentacja.svelte używa tego, żeby pokazać
 * przycisk "Przywróć domyślny". */
export function hasNodeDocOverride(typeId: string): boolean {
  return !!_data.nodes[typeId]?.trim();
}

export function setNodeDoc(typeId: string, body: string): void {
  _data.nodes = { ..._data.nodes, [typeId]: body };
  scheduleSave();
}

export function clearNodeDoc(typeId: string): void {
  const next = { ..._data.nodes };
  delete next[typeId];
  _data.nodes = next;
  scheduleSave();
}

// ── Własne strony (dowolne dodatkowe strony dodawane przez usera) ──────────

export function getCustomPages(): CustomPage[] {
  return _data.pages;
}

export function createCustomPage(title = "Nowa strona"): CustomPage {
  const p: CustomPage = { id: crypto.randomUUID(), title, body: "" };
  _data.pages = [..._data.pages, p];
  scheduleSave();
  return p;
}

export function setCustomPageTitle(id: string, title: string): void {
  _data.pages = _data.pages.map((p) => (p.id === id ? { ...p, title } : p));
  scheduleSave();
}

export function setCustomPageBody(id: string, body: string): void {
  _data.pages = _data.pages.map((p) => (p.id === id ? { ...p, body } : p));
  scheduleSave();
}

export function deleteCustomPage(id: string): void {
  _data.pages = _data.pages.filter((p) => p.id !== id);
  scheduleSave();
}

/** Przesunięcie strony na nową pozycję — drag-to-reorder (ten sam wzorzec co
 * reorderGroups w mzGroups.svelte.ts, wołane przez Pointer Events w
 * Dokumentacja.svelte, nie natywny HTML5 DnD — niestabilny w webview Tauri). */
export function reorderCustomPages(srcIdx: number, targetIdx: number): void {
  if (srcIdx === targetIdx) return;
  const next = [..._data.pages];
  const [moved] = next.splice(srcIdx, 1);
  next.splice(targetIdx, 0, moved);
  _data.pages = next;
  scheduleSave();
}
