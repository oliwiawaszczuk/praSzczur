// Store dla Tablicy (Miro-like whiteboard). Tablice są NIEZALEŻNE od workspace'ów
// MSI — jedna wspólna lista widoczna niezależnie od aktywnego workspace'u,
// przechowywana w boards/ (osobno od workspaces/). Workspace zapamiętuje tylko,
// która tablica była ostatnio otwarta (przez wsGet/wsSet "tablica_activeBoardId").

const BASE = "http://127.0.0.1:7432";

export interface BoardMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type BoardObjectType = "image" | "text" | "draw" | "shape";
export type BoardTextAlign = "left" | "center" | "right";
export type BoardTool = "select" | "draw" | "shape" | "text";
export type ShapeKind = "rect" | "ellipse";

export interface BoardObjectBase {
  id: string;
  type: BoardObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees
  opacity: number;  // 0..1
  zIndex: number;
}

export interface BoardImageObject extends BoardObjectBase {
  type: "image";
  assetUrl: string; // relative path, np. /boards/{bid}/assets/xxx.png
}

export interface BoardTextObject extends BoardObjectBase {
  type: "text";
  content: string;
  color: string;
  fontSize: number;
  bold: boolean;
  align: BoardTextAlign;
  borderEnabled: boolean;
  borderColor: string;
  borderWidth: number;
}

export interface BoardDrawObject extends BoardObjectBase {
  type: "draw";
  points: number[]; // płaska lista [x1,y1,x2,y2,...] lokalnie względem (x,y)
  color: string;
  strokeWidth: number;
}

export interface BoardShapeObject extends BoardObjectBase {
  type: "shape";
  shape: ShapeKind;
  fillColor: string;
  fillTransparent: boolean;
  strokeColor: string;
  strokeWidth: number;
  strokeTransparent: boolean;
  cornerRadius: number; // tylko dla shape === "rect"
}

export type BoardObject = BoardImageObject | BoardTextObject | BoardDrawObject | BoardShapeObject;

export interface BoardViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface BoardData {
  objects: BoardObject[];
  viewport: BoardViewport;
}

let _list = $state<BoardMeta[]>([]);
let _loaded = $state(false);

export function boards(): BoardMeta[] {
  return _list;
}

export function boardsLoaded(): boolean {
  return _loaded;
}

export async function loadBoards(): Promise<BoardMeta[]> {
  const r = await fetch(`${BASE}/boards`);
  const d = await r.json();
  _list = d.boards ?? [];
  _loaded = true;
  return _list;
}

export async function createBoard(name: string): Promise<BoardMeta> {
  const r = await fetch(`${BASE}/boards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const b = await r.json();
  await loadBoards();
  return b;
}

export async function renameBoard(id: string, name: string): Promise<void> {
  await fetch(`${BASE}/boards/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await loadBoards();
}

export async function deleteBoard(id: string): Promise<void> {
  const r = await fetch(`${BASE}/boards/${id}`, { method: "DELETE" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd usuwania" }));
    throw new Error(err.detail ?? "Błąd usuwania tablicy");
  }
  await loadBoards();
}

export async function getBoard(id: string): Promise<BoardData> {
  const r = await fetch(`${BASE}/boards/${id}/data`);
  if (!r.ok) throw new Error(`Błąd wczytywania tablicy (${r.status})`);
  return r.json();
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingSave: { id: string; data: BoardData } | null = null;

export function scheduleSaveBoard(id: string, data: BoardData): void {
  _pendingSave = { id, data };
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { flushSaveBoard(); }, 800);
}

export async function flushSaveBoard(): Promise<void> {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (!_pendingSave) return;
  const { id, data } = _pendingSave;
  _pendingSave = null;
  try {
    await fetch(`${BASE}/boards/${id}/data`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    // Backend bije znacznik czasu w registry.json przy każdym zapisie, ale
    // lokalna lista tablic (_list) nie odświeża się sama — bez tego wpis na
    // liście pokazywał "zmieniona X temu" sprzed dawna, mimo że autozapis
    // działał poprawnie (dane były aktualne po ponownym otwarciu appki).
    const entry = _list.find((b) => b.id === id);
    if (entry) entry.updatedAt = new Date().toISOString();
  } catch {}
}

export async function uploadBoardAsset(boardId: string, file: File): Promise<{ id: string; filename: string; url: string }> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`${BASE}/boards/${boardId}/assets`, { method: "POST", body: form });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd wgrywania obrazu" }));
    throw new Error(err.detail ?? "Błąd wgrywania obrazu");
  }
  return r.json();
}

export function assetFullUrl(url: string): string {
  return `${BASE}${url}`;
}
