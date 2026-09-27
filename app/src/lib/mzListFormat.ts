// Format tekstowy listy m/z współdzielony między węzłem "Lista m/z (próg)"
// w Node Graph (producent, patrz nodegraph.widmo.ts / NodeGraphTab.svelte) i
// modalem "Lista m/z" w zakładce m/z → Grupy (konsument, patrz
// MzListModal.svelte) — jedno miejsce definiujące ten format, żeby obie
// strony się nie rozjechały.

/** "[m1;m2;...]" — max. 4 miejsca po przecinku, bez końcowych zer. */
export function formatMzListText(values: number[]): string {
  return `[${values.map((v) => String(Math.round(v * 10000) / 10000)).join(";")}]`;
}

/** Odwrotność formatMzListText — nawiasy kwadratowe opcjonalne, separator
 * ";" albo biały znak (spacja/nowa linia), tolerancyjne na wklejony tekst.
 * Przecinek w liczbie (np. "323,44") jest traktowany jako separator
 * dziesiętny, nie jako separator listy. */
export function parseMzListText(text: string): number[] {
  const stripped = text.trim().replace(/^\[+/, "").replace(/\]+$/, "");
  if (!stripped) return [];
  return stripped
    .split(/[;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseFloat(s.replace(",", ".")))
    .filter((v) => Number.isFinite(v));
}
