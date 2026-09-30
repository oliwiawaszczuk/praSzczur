// Store zapisanych widm ("Zapisane widma") — biblioteka analogiczna do
// savedPixelMaps.svelte.ts (ten sam wzorzec CRUD), ale dla widm (mz +
// intensity) zamiast map pikseli. Zasilana z dwóch miejsc: zakładki Widma
// (zapis pojedynczej warstwy/piksela) i Node Graph (węzeł "widmo/save_spectrum",
// dowolne obliczone widmo — połączenie, normalizacja, agregacja segmentu…).

import { activeWorkspaceId } from "./workspace.svelte";

const BASE = "http://127.0.0.1:7432";

/** Skąd pochodzi pojedynczy przyczynek do zapisanego widma — piksel z danego
 * zestawu danych, albo (dla widm obliczonych w grafie z segmentu) sam opis
 * trybu agregacji, bez rozbijania na tysiące pojedynczych pikseli. */
export interface SavedSpectrumSource {
  x?: number;
  y?: number;
  datasetId?: string;
  datasetLabel?: string;
  note?: string; // np. "segment (suma, 128 px)" — gdy nie ma sensu wymieniać pikseli
}

/** "single" — jeden piksel (z zakładki Widma); reszta to tryby łączenia/agregacji
 * z Node Graph, spójne z CombineModeExt (mapa/combine) tam gdzie ma to sens. */
export type SavedSpectrumMode = "single" | "sum" | "mean" | "max" | "diff";

export interface SavedSpectrumMeta {
  id: string;
  name: string;
  tissueId: string;
  tissueLabel: string;
  mode: SavedSpectrumMode;
  sources: SavedSpectrumSource[];
  createdAt: string;
  updatedAt: string;
}

export interface SavedSpectrum extends SavedSpectrumMeta {
  mz: number[];
  intensity: number[];
}

let _list = $state<SavedSpectrumMeta[]>([]);
let _loaded = $state(false);

export function savedSpectraList(): SavedSpectrumMeta[] { return _list; }
export function savedSpectraLoaded(): boolean { return _loaded; }

export async function loadSavedSpectra(): Promise<void> {
  const wid = activeWorkspaceId();
  if (!wid) { _list = []; _loaded = true; return; }
  const r = await fetch(`${BASE}/workspaces/${wid}/spectra`);
  const d = await r.json();
  _list = d.spectra ?? [];
  _loaded = true;
}

export async function saveSpectrum(input: Omit<SavedSpectrum, "id" | "createdAt" | "updatedAt">): Promise<SavedSpectrumMeta> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/spectra`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd zapisu widma" }));
    throw new Error(err.detail ?? "Błąd zapisu widma");
  }
  const meta = await r.json();
  await loadSavedSpectra();
  return meta;
}

export async function renameSavedSpectrum(id: string, name: string): Promise<void> {
  const wid = activeWorkspaceId();
  await fetch(`${BASE}/workspaces/${wid}/spectra/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await loadSavedSpectra();
}

export async function deleteSavedSpectrum(id: string): Promise<void> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/spectra/${id}`, { method: "DELETE" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Błąd usuwania widma" }));
    throw new Error(err.detail ?? "Błąd usuwania widma");
  }
  await loadSavedSpectra();
}

export async function fetchSavedSpectrumData(id: string): Promise<SavedSpectrum> {
  const wid = activeWorkspaceId();
  const r = await fetch(`${BASE}/workspaces/${wid}/spectra/${id}`);
  if (!r.ok) throw new Error(`API error ${r.status}`);
  return r.json();
}
