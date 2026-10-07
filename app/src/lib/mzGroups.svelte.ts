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

// Klucze sprzed wprowadzenia zestawów grup — czytane już tylko przy migracji.
const GROUPS_KEY   = "wielemz_groups";
const SELECTION_KEY = "wielemz_selection";
const MODE_KEY      = "wielemz_combine_mode";

// Wiele zestawów grup per workspace (jak grafy/tablice): lista metadanych, id aktywnego
// zestawu i osobny wpis z danymi (kolumny + zaznaczenia + tryb łączenia) per zestaw.
// Wszystko przez wsGet/wsSet — przenosi się z workspace'em (eksport/import).
const SETS_KEY       = "wielemz_sets";
const ACTIVE_SET_KEY = "wielemz_activeSetId";
const setDataKey = (id: string) => `wielemz_set_${id}`;

export interface GroupSetMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface GroupSetData {
  groups: MzGroup[];
  selection: Record<string, string[]>;
  combineMode: CombineMode;
}

let groups        = $state<MzGroup[]>([]);
let groupResults  = $state<Record<string, GroupResult>>({});
let selection     = $state<Record<string, string[]>>({});
let combineMode   = $state<CombineMode>("mean");
let sets          = $state<GroupSetMeta[]>([]);
let activeSetId   = $state("");
let setsLoaded    = $state(false);
let lastTolDefault = 0.3;

export function allGroups(): MzGroup[] { return groups; }
export function resultFor(groupId: string): GroupResult | undefined { return groupResults[groupId]; }
export function currentCombineMode(): CombineMode { return combineMode; }

function newGroup(tolDefault: number): MzGroup {
  return { id: crypto.randomUUID(), dataset: RAW_DATASET_ID, mz: null, tol: tolDefault, dispMin: 0, dispMax: 1, invert: false };
}

/** Zapisuje stan AKTYWNEGO zestawu (kolumny, zaznaczenia, tryb łączenia) — jedno miejsce,
 * wołane przez wszystkie mutatory poniżej. */
function saveActive() {
  if (!activeSetId) return;
  wsSet(setDataKey(activeSetId), { groups, selection, combineMode } satisfies GroupSetData);
  const now = new Date().toISOString();
  sets = sets.map((x) => (x.id === activeSetId ? { ...x, updatedAt: now } : x));
  wsSet(SETS_KEY, sets);
}
const saveGroups = saveActive;
const saveSelection = saveActive;
const saveMode = saveActive;

function newSetMeta(name: string): GroupSetMeta {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now };
}

export function groupSets(): GroupSetMeta[] { return sets; }
export function groupSetsLoaded(): boolean { return setsLoaded; }
export function activeGroupSetId(): string { return activeSetId; }

/** Wczytuje listę zestawów (bez ładowania ich zawartości). Przy pierwszym uruchomieniu po
 * wprowadzeniu zestawów migruje dotychczasowe, pojedyncze kolumny do "Zestawu 1". */
export function ensureGroupSets(): void {
  if (setsLoaded) return;
  let list = wsGet<GroupSetMeta[]>(SETS_KEY, []);
  if (list.length === 0) {
    const meta = newSetMeta("Zestaw 1");
    wsSet(setDataKey(meta.id), {
      groups: wsGet<MzGroup[]>(GROUPS_KEY, []),
      selection: wsGet<Record<string, string[]>>(SELECTION_KEY, {}),
      combineMode: wsGet<CombineMode>(MODE_KEY, "mean"),
    } satisfies GroupSetData);
    list = [meta];
    wsSet(SETS_KEY, list);
  }
  sets = list;
  const saved = wsGet<string>(ACTIVE_SET_KEY, "");
  activeSetId = list.some((x) => x.id === saved) ? saved : list[0].id;
  wsSet(ACTIVE_SET_KEY, activeSetId);
  setsLoaded = true;
}

/** Ładuje zawartość aktywnego zestawu do stanu i dopytuje jego kolumny. */
function applyActiveSet(tolDefault: number): void {
  const d = wsGet<Partial<GroupSetData>>(setDataKey(activeSetId), {});
  const normalized: MzGroup[] = ((d.groups ?? []) as Partial<MzGroup>[]).map((g) => ({ dispMin: 0, dispMax: 1, invert: false, ...g } as MzGroup));
  groups = normalized.length > 0 ? normalized : [newGroup(tolDefault)];
  selection = d.selection ?? {};
  combineMode = d.combineMode ?? "mean";
  if (normalized.length === 0) saveActive();

  // Auto-fetch kolumn (spójne z auto-restore lastMz w +page.svelte); wynik już pobrany
  // wcześniej w tej sesji (przełączanie tam i z powrotem) nie jest pobierany ponownie.
  for (const g of groups) {
    if (g.mz !== null && !groupResults[g.id]?.tissues) runGroupQuery(g.id, g.mz, g.tol, g.dataset);
  }
}

export function loadWieleMz(tolDefault: number): void {
  lastTolDefault = tolDefault;
  ensureGroupSets();
  applyActiveSet(tolDefault);
}

export function switchGroupSet(id: string): void {
  if (id === activeSetId || !sets.some((x) => x.id === id)) return;
  saveActive();
  activeSetId = id;
  wsSet(ACTIVE_SET_KEY, id);
  applyActiveSet(lastTolDefault);
}

/** Tworzy pusty zestaw (jedna pusta kolumna) i od razu go otwiera. */
export function createGroupSet(name?: string): void {
  ensureGroupSets();
  saveActive();
  const meta = newSetMeta(name?.trim() || `Zestaw ${sets.length + 1}`);
  wsSet(setDataKey(meta.id), { groups: [], selection: {}, combineMode: "mean" } satisfies GroupSetData);
  sets = [...sets, meta];
  wsSet(SETS_KEY, sets);
  activeSetId = meta.id;
  wsSet(ACTIVE_SET_KEY, meta.id);
  applyActiveSet(lastTolDefault);
}

export function renameGroupSet(id: string, name: string): void {
  const n = name.trim();
  if (!n) return;
  sets = sets.map((x) => (x.id === id ? { ...x, name: n, updatedAt: new Date().toISOString() } : x));
  wsSet(SETS_KEY, sets);
}

/** Usuwa zestaw. Gdy znika ostatni, powstaje pusty (jak przy grafach/tablicach). */
export function deleteGroupSet(id: string): void {
  if (!sets.some((x) => x.id === id)) return;
  wsSet(setDataKey(id), null);
  const rest = sets.filter((x) => x.id !== id);
  if (rest.length === 0) {
    sets = [];
    activeSetId = "";
    createGroupSet("Zestaw 1");
    return;
  }
  sets = rest;
  wsSet(SETS_KEY, sets);
  if (id === activeSetId) {
    activeSetId = rest[0].id;
    wsSet(ACTIVE_SET_KEY, activeSetId);
    applyActiveSet(lastTolDefault);
  }
}

export function addGroup(tolDefault: number): void {
  groups = [...groups, newGroup(tolDefault)];
  saveGroups();
}

/** Podzakładka "m/z" (pojedyncze zapytanie, Sidebar.svelte) → przycisk
 * "Grupa" obok "Wczytaj": tworzy nową grupę od razu z podanym m/z/tol/
 * zestawem danych i odpytuje ją, zamiast dodawać pustą kolumnę jak
 * `addGroup`. */
export function addGroupWithQuery(mz: number, tol: number, dataset: string): void {
  const ds = sanitizeDatasetId(dataset);
  const g: MzGroup = { id: crypto.randomUUID(), dataset: ds, mz, tol, dispMin: 0, dispMax: 1, invert: false };
  groups = [...groups, g];
  saveGroups();
  runGroupQuery(g.id, mz, tol, ds);
}

/** Modal "Lista m/z" (WieleMz.svelte) — jedna wklejona lista m/z staje się
 * wieloma grupami naraz, jedno m/z = jedna grupa, wszystkie z tym samym
 * zestawem danych i wybraną w modalu tolerancją; dopisywane na koniec istniejących kolumn (jak
 * `addGroup`), nie zastępują ich. */
export function addGroupsFromMzList(values: number[], dataset: string, tol: number): void {
  const ds = sanitizeDatasetId(dataset);
  const newGroups: MzGroup[] = values.map((mz) => ({
    id: crypto.randomUUID(), dataset: ds, mz, tol, dispMin: 0, dispMax: 1, invert: false,
  }));
  groups = [...groups, ...newGroups];
  saveGroups();
  for (const g of newGroups) runGroupQuery(g.id, g.mz as number, g.tol, g.dataset);
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
  mask?: number[][];
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
      slot.sources.map((s) => ({ data: s.image.data, dispMin: s.dispMin, dispMax: s.dispMax, invert: s.invert, mask: s.image.mask })),
      combineMode,
    );
    if (!merged) return [];
    return [{
      tissueId: slot.tissueId,
      label: slot.sources[0].image.label,
      width: slot.sources[0].image.width,
      height: slot.sources[0].image.height,
      data: merged.data,
      mask: merged.mask,
      vmax: maxOf(merged.data),
      mode: combineMode,
      sources: slot.sources.map((s) => ({ groupId: s.groupId, groupIndex: s.groupIndex, mz: s.mz, tol: s.tol, dataset: s.dataset })),
    }];
  });
}
