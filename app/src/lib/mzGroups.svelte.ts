// Store zakładki "Wiele m/z" — centralny stan grup (kolumn), wyników
// zapytań ion_image i zaznaczeń tkanek do łączenia. Scentralizowany (nie w
// WieleMz.svelte/MzColumn.svelte lokalnie), bo podzakładka "Łączenie"
// potrzebuje jednoczesnego, reaktywnego wglądu w dane WIELU grup naraz — ten
// sam wzorzec co datasets.svelte.ts / workspace.svelte.ts / board.svelte.ts.

import { fetchIonImage, fetchIonImageRaw } from "./api.js";
import type { TissueImage } from "./api.js";
import { wsGet, wsSet } from "$lib/workspace.svelte";
import { RAW_DATASET_ID, sanitizeDatasetId } from "$lib/datasets.svelte";
import { mergeTissueMaps, maxOf, type CombineMode } from "./tissueMerge";

export interface MzGroup {
  id: string;
  dataset: string;
  mz: number | null;
  tol: number;
  dispMin: number;
  dispMax: number;
  invert: boolean;
}

interface GroupResult {
  tissues: Record<string, TissueImage> | null;
  loading: boolean;
  error: string;
}

const GROUPS_KEY   = "wielemz_groups";
const SELECTION_KEY = "wielemz_selection";
const MODE_KEY      = "wielemz_combine_mode";

let groups        = $state<MzGroup[]>([]);
let groupResults  = $state<Record<string, GroupResult>>({});
let selection     = $state<Record<string, string[]>>({});
let combineMode   = $state<CombineMode>("mean");

export function allGroups(): MzGroup[] { return groups; }
export function resultFor(groupId: string): GroupResult | undefined { return groupResults[groupId]; }
export function currentCombineMode(): CombineMode { return combineMode; }

function newGroup(tolDefault: number): MzGroup {
  return { id: crypto.randomUUID(), dataset: RAW_DATASET_ID, mz: null, tol: tolDefault, dispMin: 0, dispMax: 1, invert: false };
}

function saveGroups() { wsSet(GROUPS_KEY, groups); }
function saveSelection() { wsSet(SELECTION_KEY, selection); }
function saveMode() { wsSet(MODE_KEY, combineMode); }

export function loadWieleMz(tolDefault: number): void {
  const saved = wsGet<Partial<MzGroup>[]>(GROUPS_KEY, []);
  const normalized: MzGroup[] = saved.map((g) => ({ dispMin: 0, dispMax: 1, invert: false, ...g } as MzGroup));
  groups = normalized.length > 0 ? normalized : [newGroup(tolDefault)];
  if (normalized.length === 0) saveGroups();

  selection = wsGet<Record<string, string[]>>(SELECTION_KEY, {});
  combineMode = wsGet<CombineMode>(MODE_KEY, "mean");

  // Auto-fetch przywróconych grup (spójne z auto-restore lastMz w +page.svelte).
  for (const g of groups) {
    if (g.mz !== null) runGroupQuery(g.id, g.mz, g.tol, g.dataset);
  }
}

export function addGroup(tolDefault: number): void {
  groups = [...groups, newGroup(tolDefault)];
  saveGroups();
}

export function removeGroup(id: string): void {
  groups = groups.filter((g) => g.id !== id);
  const { [id]: _removed, ...restResults } = groupResults;
  groupResults = restResults;
  if (id in selection) {
    const { [id]: _sel, ...restSel } = selection;
    selection = restSel;
    saveSelection();
  }
  saveGroups();
}

export function updateGroup(id: string, patch: Partial<Omit<MzGroup, "id">>): void {
  groups = groups.map((g) => (g.id === id ? { ...g, ...patch } : g));
  saveGroups();
}

// Przenosi grupę ze srcIdx na targetIdx (przesuwając pozostałe, jak przy
// przeciąganiu warstwy widma w zakładce Widma), a nie zwykła zamiana miejsc.
export function reorderGroups(srcIdx: number, targetIdx: number): void {
  if (srcIdx === targetIdx) return;
  const next = [...groups];
  const [moved] = next.splice(srcIdx, 1);
  next.splice(targetIdx, 0, moved);
  groups = next;
  saveGroups();
}

export async function runGroupQuery(id: string, mz: number, tol: number, dataset: string): Promise<void> {
  const ds = sanitizeDatasetId(dataset);
  groupResults = { ...groupResults, [id]: { tissues: groupResults[id]?.tissues ?? null, loading: true, error: "" } };
  try {
    const res = ds === RAW_DATASET_ID ? await fetchIonImageRaw(mz, tol) : await fetchIonImage(mz, tol, ds);
    const allZero = Object.values(res.tissues).every((t) => t.vmax === 0);
    if (allZero) {
      groupResults = { ...groupResults, [id]: { tissues: null, loading: false, error: `Brak sygnału przy m/z ${mz.toFixed(3)} Da.` } };
    } else {
      groupResults = { ...groupResults, [id]: { tissues: res.tissues, loading: false, error: "" } };
    }
  } catch (e) {
    const msg = (e as Error).message.includes("503")
      ? "Brak przetworzonych danych. Uruchom preprocessing w zakładce Dane."
      : (e as Error).message;
    groupResults = { ...groupResults, [id]: { tissues: null, loading: false, error: msg } };
  }
}

export function toggleSelected(groupId: string, tissueId: string): void {
  const current = selection[groupId] ?? [];
  const next = current.includes(tissueId) ? current.filter((t) => t !== tissueId) : [...current, tissueId];
  selection = { ...selection, [groupId]: next };
  saveSelection();
}

export function isSelected(groupId: string, tissueId: string): boolean {
  return (selection[groupId] ?? []).includes(tissueId);
}

export function clearSelection(): void {
  selection = {};
  saveSelection();
}

export function hasAnySelection(): boolean {
  return Object.values(selection).some((tids) => tids.length > 0);
}

export function setCombineMode(mode: CombineMode): void {
  combineMode = mode;
  saveMode();
}

// ── Derived: grupowanie zaznaczeń po tożsamości tkanki (slot) ──────────────

export interface TissueSlotSource {
  groupId: string;
  groupIndex: number;
  mz: number;
  tol: number;
  dataset: string;
  image: TissueImage;
  dispMin: number;
  dispMax: number;
  invert: boolean;
}

export interface TissueSlotSelection {
  tissueId: string;
  sources: TissueSlotSource[];
}

export function selectedSlots(): TissueSlotSelection[] {
  const bySlot = new Map<string, TissueSlotSource[]>();
  groups.forEach((g, groupIndex) => {
    const tids = selection[g.id];
    if (!tids || tids.length === 0) return;
    const res = groupResults[g.id];
    if (!res?.tissues) return;
    for (const tid of tids) {
      const image = res.tissues[tid];
      if (!image) continue;
      const src: TissueSlotSource = {
        groupId: g.id, groupIndex, mz: g.mz ?? 0, tol: g.tol, dataset: g.dataset,
        image, dispMin: g.dispMin, dispMax: g.dispMax, invert: g.invert,
      };
      if (!bySlot.has(tid)) bySlot.set(tid, []);
      bySlot.get(tid)!.push(src);
    }
  });
  return Array.from(bySlot.entries()).map(([tissueId, sources]) => ({ tissueId, sources }));
}

export interface MergedTissueResult {
  tissueId: string;
  label: string;
  width: number;
  height: number;
  data: number[][];
  vmax: number;
  mode: CombineMode;
  sources: { groupId: string; groupIndex: number; mz: number; tol: number; dataset: string }[];
}

/** Wyniki połączenia per slot tkanki — gotowa "tablica 2D" per tkanka do
 * dalszej konsumpcji (np. przez przyszłą Segmentację: `import { mergedResults }
 * from "$lib/mzGroups.svelte"`). W pełni pochodne ze store'u — żadnego
 * zamrożonego snapshotu, przelicza się przy każdej zmianie grup/zaznaczeń. */
export function mergedResults(): MergedTissueResult[] {
  return selectedSlots().flatMap((slot) => {
    const merged = mergeTissueMaps(
      slot.sources.map((s) => ({ data: s.image.data, dispMin: s.dispMin, dispMax: s.dispMax, invert: s.invert })),
      combineMode,
    );
    if (!merged) return [];
    return [{
      tissueId: slot.tissueId,
      label: slot.sources[0].image.label,
      width: slot.sources[0].image.width,
      height: slot.sources[0].image.height,
      data: merged,
      vmax: maxOf(merged),
      mode: combineMode,
      sources: slot.sources.map((s) => ({ groupId: s.groupId, groupIndex: s.groupIndex, mz: s.mz, tol: s.tol, dataset: s.dataset })),
    }];
  });
}
