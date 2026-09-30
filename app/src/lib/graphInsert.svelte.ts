// Most między zakładkami dla "Wyślij do Node Graph" (pkt 10/11/13/14) — inny
// duch niż wsGet/wsSet (per-workspace trwały stan): to czysto EFEMERYCZNY,
// wewnątrz-sesyjny sygnał, ten sam wzorzec co reszta store'ów $state (patrz
// mzGroups.svelte.ts), tylko bez zapisu na dysk.
//
// Przepływ: przycisk "→ Node Graph" w innej zakładce najpierw zapisuje dany
// obiekt do biblioteki ("Zapisane"/"Zapisane widma" — jeśli jeszcze nie był
// zapisany), potem woła requestGraphInsert(...) z id tego zapisu i żądaną
// zakładką. +page.svelte reaguje na żądanie zakładki (przełącza activeTab),
// NodeGraphTab.svelte reaguje na `pendingGraphInsert()` — pokazuje "duszka"
// pod kursorem (jak paletteDrag przy przeciąganiu z palety) i po kliknięciu
// na płótnie wstawia węzeł mapa/segment/widmo źródłowy, już podłączony do
// tego zapisu.

export type PendingGraphInsert =
  | { kind: "mapa"; savedMapId: string; label: string }
  | { kind: "segment"; savedMapId: string; label: string }
  | { kind: "widmo"; savedSpectrumId: string; label: string };

let _pending = $state<PendingGraphInsert | null>(null);
let _tabRequest = $state<string | null>(null);

export function requestGraphInsert(p: PendingGraphInsert, tab: string): void {
  _pending = p;
  _tabRequest = tab;
}

export function pendingGraphInsert(): PendingGraphInsert | null {
  return _pending;
}

export function clearGraphInsert(): void {
  _pending = null;
}

/** Wołane raz z +page.svelte (efekt reaktywny) — zwraca żądaną zakładkę i
 * OD RAZU ją "konsumuje" (czyści), żeby nie przełączać ponownie przy
 * kolejnym renderze. */
export function consumeTabRequest(): string | null {
  const t = _tabRequest;
  _tabRequest = null;
  return t;
}
