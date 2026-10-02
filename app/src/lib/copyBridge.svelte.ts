// Most między "kopiuj wartość z wykresu" (plotlyCopy.ts, wołane z każdego
// komponentu widma) a małym pływającym notatnikiem (FloatingNotePad.svelte):
// gdy notatnik jest przypięty i otwarty (nie zminimalizowany), Cmd/Ctrl+click
// na dowolnym wykresie w appce dopisuje skopiowaną wartość do jego treści —
// NIEZALEŻNIE od zapisu do schowka systemowego, który dzieje się zawsze.
//
// FloatingNotePad.svelte jest jedynym właścicielem aktualnej treści notatki
// w pamięci (jego lokalny `$state` związany z textarea) — zamiast duplikować
// ten stan tutaj, widget REJESTRUJE funkcję dopisującą (registerAppendTarget),
// a appendCopiedValue tylko ją woła. Unika to rozjazdu między tym, co widget
// pokazuje, a tym, co faktycznie zostaje zapisane.

export type FloatingNotePadState = "min" | "medium" | "focus";

let _pinnedNoteId = $state<string | null>(null);
let _widgetState = $state<FloatingNotePadState>("min");
let _appendTarget: ((text: string) => void) | null = null;

export function setPinnedNote(id: string | null): void {
  _pinnedNoteId = id;
}

export function pinnedNoteId(): string | null {
  return _pinnedNoteId;
}

export function setWidgetState(s: FloatingNotePadState): void {
  _widgetState = s;
}

export function widgetState(): FloatingNotePadState {
  return _widgetState;
}

/** Wołane przez FloatingNotePad.svelte w onMount/onDestroy — rejestruje
 * funkcję, która dopisuje tekst do AKTUALNIE wyświetlanej notatki w widgecie
 * (i zapisuje go, patrz FloatingNotePad.svelte:onTextInput). `null` wyrejestrowuje. */
export function registerAppendTarget(fn: ((text: string) => void) | null): void {
  _appendTarget = fn;
}

export function appendCopiedValue(text: string): void {
  if (_widgetState === "min" || !_pinnedNoteId || !_appendTarget) return;
  _appendTarget(text);
}
