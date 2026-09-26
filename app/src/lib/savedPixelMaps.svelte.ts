// Store zapisanych map pikseli (Wiele m/z → 💾 na tkance w grupie lub na
// wyniku w "Łączenie"). Ten sam wzorzec CRUD co datasets.svelte.ts, ale
// osobny rejestr per workspace — mapy pikseli to obrazy, nie zestawy widm.

import { activeWorkspaceId } from "./workspace.svelte";
import type { CombineMode } from "./tissueMerge";

const BASE = "http://127.0.0.1:7432";

export interface SavedPixelMapSource {
  groupIndex: number;
  mz: number;
  tol: number;
  datasetId: string;
  datasetLabel: string; // snapshot nazwy w momencie zapisu
}

/** CombineMode rozszerzony o tryby node'a "Łączenie" w grafie node'ów (subtract/
 * mask_*, patrz CombineModeExt w nodegraph.mapa.ts) oraz o "segment" — mapa
 * wyeksportowana z domeny Segmentacja (węzeł "Wybór segmentów" → "Zapis").
 * Zdublowane literały zamiast importu CombineModeExt, żeby uniknąć cyklu
 * (nodegraph.ts importuje typy z tego pliku). */
export type SavedPixelMapMode = CombineMode | "single" | "subtract" | "mask_exclude" | "mask_keep" | "segment";

export interface SavedPixelMapMeta {
  id: string;
  name: string;
  tissueId: string;
  tissueLabel: string;
  width: number;
  height: number;
  vmax: number;
  mode: SavedPixelMapMode;
  sources: SavedPixelMapSource[];
  createdAt: string;
  updatedAt: string;
}

export interface SavedPixelMap extends SavedPixelMapMeta {
  data: number[][];
  /** Maska "prawdziwych" pikseli (0/1, ten sam kształt co `data`) — 0 = poza
   * faktycznym skanem tkanki w imzML (tło), patrz TissueImage.mask w api.ts i
   * mask w /ion_image (sidecar). Opcjonalna: mapy zapisane przed wprowadzeniem
   * maski (albo bez propagowanej maski przez cały łańcuch) jej nie mają. */
  mask?: number[][];
}

let _list = $state<SavedPixelMapMeta[]>([]);
let _loaded = $state(false);

export function savedMapsList(): SavedPixelMapMeta[] { return _list; }
export function savedMapsLoaded(): boolean { return _loaded; }

export async function loadSavedMaps(): Promise<void> {
  const wid = activeWorkspaceId();
  if (!wid) { _list = []; _loaded = true; return; }
  const r = await fetch(`${BASE}/workspaces/${wid}/pixel_maps`);
  const d = await r.json();
  _list = d.maps ?? [];
  _loaded = true;
}

export async function savePixelMap(input: Omit<SavedPixelMap, "id" | "createdAt" | "updatedAt">): Promise<void> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/pixel_maps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd zapisu mapy" }));
    throw new Error(err.detail ?? "Błąd zapisu mapy");
  }
  await loadSavedMaps();
}

export async function renameSavedMap(id: string, name: string): Promise<void> {
  const wid = activeWorkspaceId();
  await fetch(`${BASE}/workspaces/${wid}/pixel_maps/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await loadSavedMaps();
}

export async function deleteSavedMap(id: string): Promise<void> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/pixel_maps/${id}`, { method: "DELETE" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd usuwania mapy" }));
    throw new Error(err.detail ?? "Błąd usuwania mapy");
  }
  await loadSavedMaps();
}

export async function fetchSavedMapData(id: string): Promise<SavedPixelMap> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/pixel_maps/${id}`);
  if (!r.ok) throw new Error(`API error ${r.status}`);
  return r.json();
}
