// Ustawienie formatu listy m/z ("[m1;m2;...]") generowanej przez node'y Node Grapha
// ("Lista m/z (próg)", "Top m/z") — liczba miejsc po przecinku. Per workspace (wsGet/wsSet),
// edytowane w Ustawieniach (karta "Format listy m/z"). `$state` sprawia, że zmiana w
// Ustawieniach od razu odświeża listy w node'ach.

import { wsGet, wsSet } from "$lib/workspace.svelte";

const KEY = "mzList_decimals";
export const MZ_LIST_DECIMALS_DEFAULT = 2;
export const MZ_LIST_DECIMALS_MIN = 0;
export const MZ_LIST_DECIMALS_MAX = 6;

function clamp(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return MZ_LIST_DECIMALS_DEFAULT;
  return Math.min(MZ_LIST_DECIMALS_MAX, Math.max(MZ_LIST_DECIMALS_MIN, n));
}

// null = jeszcze nie ustawiane w tej sesji → czytamy zapisaną wartość workspace'u
// (bez mutacji stanu w trakcie renderu, której Svelte zabrania).
let _decimals = $state<number | null>(null);

export function mzListDecimals(): number {
  return _decimals ?? clamp(wsGet(KEY, MZ_LIST_DECIMALS_DEFAULT));
}

export function setMzListDecimals(v: number): void {
  _decimals = clamp(v);
  wsSet(KEY, _decimals);
}
