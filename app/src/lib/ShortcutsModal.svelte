<script lang="ts">
  interface Props {
    open?: boolean;
    onclose?: () => void;
  }
  let { open = false, onclose }: Props = $props();

  function close() { onclose?.(); }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  const groups: { title: string; items: { keys: string; desc: string }[] }[] = [
    {
      title: "Narzędzia",
      items: [
        { keys: "W", desc: "Kursor (zaznaczanie)" },
        { keys: "T", desc: "Dodaj tekst (w miejscu kursora, jeśli jest nad tablicą)" },
        { keys: "P", desc: "Włącz/wyłącz pędzel (rysowanie odręczne)" },
        { keys: "Shift (przy rysowaniu kształtu)", desc: "Kwadrat / koło zamiast prostokąta / elipsy" },
        { keys: "Esc", desc: "Wróć do zaznaczania / zamknij edycję" },
      ],
    },
    {
      title: "Widok",
      items: [
        { keys: "Scroll", desc: "Przesuwanie tablicy" },
        { keys: "Ctrl/Cmd + Scroll", desc: "Zoom" },
        { keys: "Spacja + przeciąganie", desc: "Przesuwanie tablicy (alternatywnie)" },
        { keys: "F", desc: "Wycentruj i dopasuj widok do wszystkich obiektów" },
      ],
    },
    {
      title: "Obiekty",
      items: [
        { keys: "Przeciągnij obraz na tablicę", desc: "Dodaj obraz" },
        { keys: "Ctrl/Cmd + C", desc: "Kopiuj zaznaczenie" },
        { keys: "Ctrl/Cmd + V", desc: "Wklej" },
        { keys: "Delete / Backspace", desc: "Usuń zaznaczone" },
        { keys: "↑", desc: "Przenieś zaznaczone warstwę wyżej" },
        { keys: "↓", desc: "Przenieś zaznaczone warstwę niżej" },
      ],
    },
    {
      title: "Historia",
      items: [
        { keys: "Ctrl/Cmd + Z", desc: "Cofnij" },
        { keys: "Ctrl/Cmd + Shift + Z", desc: "Ponów" },
      ],
    },
  ];
</script>

{#if open}
  <div class="modal-backdrop" onclick={close} onkeydown={onKeydown} role="presentation">
    <div class="modal-box" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-header">
        <span class="modal-title">Skróty klawiszowe</span>
        <button class="close-btn" onclick={close}>×</button>
      </div>
      <div class="groups">
        {#each groups as g}
          <div class="group">
            <div class="group-title">{g.title}</div>
            {#each g.items as item}
              <div class="row">
                <span class="keys">{item.keys}</span>
                <span class="desc">{item.desc}</span>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    z-index: 2000; display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(3px); animation: fade-in 0.15s ease;
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

  .modal-box {
    background: #262626; border: 1px solid rgba(255,201,81,0.18);
    border-radius: 12px; padding: 18px 20px;
    max-width: 460px; width: calc(100vw - 40px);
    max-height: 80vh; overflow-y: auto;
    box-shadow: 0 24px 60px rgba(0,0,0,0.5);
    animation: modal-in 0.16s ease;
  }
  @keyframes modal-in {
    from { opacity: 0; transform: scale(0.95); }
    to   { opacity: 1; transform: scale(1); }
  }

  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 14px;
  }
  .modal-title { font-size: 0.88rem; font-weight: 700; color: #ffc951; }
  .close-btn {
    background: none; border: none; color: rgba(255,255,255,0.4);
    font-size: 1.2rem; line-height: 1; cursor: pointer; padding: 2px 6px;
    border-radius: 6px; font-family: inherit;
  }
  .close-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }

  .groups { display: flex; flex-direction: column; gap: 14px; }
  .group-title {
    font-size: 0.64rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
    color: rgba(255,255,255,0.32); margin-bottom: 6px;
  }
  .row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 4px 0;
  }
  .keys {
    flex-shrink: 0; font-size: 0.68rem; font-weight: 700; color: #ffc951;
    background: rgba(255,201,81,0.1); border: 1px solid rgba(255,201,81,0.25);
    border-radius: 6px; padding: 2px 8px;
  }
  .desc { font-size: 0.72rem; color: rgba(255,255,255,0.55); text-align: right; }
</style>
