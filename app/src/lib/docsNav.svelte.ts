// Most do zakładki "Dokumentacja" — ten sam duch co graphInsert.svelte.ts
// ("Wyślij do Node Graph"), tylko w drugą stronę: kliknięcie ikonki "(i)" na
// node'ie w Node Graphu ma przełączyć zakładkę na Dokumentację i od razu
// otworzyć sekcję opisującą TEN konkretny typ node'a.

export type DocSectionRef =
  | { kind: "tab"; key: string }
  | { kind: "node"; typeId: string };

let _pendingSection = $state<DocSectionRef | null>(null);
let _tabRequest = $state<string | null>(null);

export function requestDocsSection(section: DocSectionRef): void {
  _pendingSection = section;
  _tabRequest = "dokumentacja";
}

/** Wołane raz z +page.svelte (efekt reaktywny), analogicznie do
 * consumeTabRequest() w graphInsert.svelte.ts. */
export function consumeDocsTabRequest(): string | null {
  const t = _tabRequest;
  _tabRequest = null;
  return t;
}

/** Wołane z Dokumentacja.svelte — zwraca żądaną sekcję i od razu ją
 * "konsumuje", żeby nie przeskakiwać do niej ponownie przy kolejnym
 * renderze (np. po powrocie usera do innej sekcji ręcznie). */
export function consumePendingDocsSection(): DocSectionRef | null {
  const s = _pendingSection;
  _pendingSection = null;
  return s;
}
