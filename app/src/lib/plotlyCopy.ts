// Wspólny helper: Cmd/Ctrl+click na punkt wykresu Plotly kopiuje jego wartość
// do schowka, sformatowaną jako "x.xx;y.yy" (2 miejsca po przecinku). Używane
// przez każdy komponent renderujący widmo (SpectrumPlot, SpectrumTracesPlot,
// Widma) — patrz wywołania po Plotly.react(...).then(...) w tych plikach.
import { appendCopiedValue } from "./copyBridge.svelte";

export function attachCopyOnModifierClick(plotDiv: any, onCopied?: (text: string) => void): void {
  if (!plotDiv || plotDiv.__copyOnModifierClickAttached) return;
  plotDiv.__copyOnModifierClickAttached = true;
  plotDiv.on("plotly_click", (evt: any) => {
    const native: MouseEvent | undefined = evt?.event;
    if (!native || !(native.ctrlKey || native.metaKey)) return;
    const p = evt.points?.[0];
    if (!p || typeof p.x !== "number") return;
    // Kopiowana jest WYŁĄCZNIE wartość m/z (oś X) klikniętego punktu — jedna
    // liczba, 2 miejsca po przecinku, zakończona ';' i nic więcej (żeby dało
    // się wklejać kolejne wartości jedna po drugiej np. do Excela).
    const text = `${p.x.toFixed(2)};`;
    navigator.clipboard.writeText(text).then(() => {
      onCopied?.(text);
      appendCopiedValue(text);
    }).catch(() => {});
  });
}
