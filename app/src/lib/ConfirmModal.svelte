<script lang="ts">
  interface Props {
    open?: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onconfirm?: () => void;
    oncancel?: () => void;
  }

  let {
    open = false,
    title = "Potwierdź",
    message = "",
    confirmLabel = "Potwierdź",
    cancelLabel = "Anuluj",
    danger = false,
    onconfirm,
    oncancel,
  }: Props = $props();

  function cancel() { oncancel?.(); }
  function confirm() { onconfirm?.(); }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
  }

  let modalBox = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (open) modalBox?.focus();
  });
</script>

{#if open}
  <div class="modal-backdrop" onclick={cancel} role="presentation">
    <div bind:this={modalBox} class="modal-box" class:danger onclick={(e) => e.stopPropagation()} onkeydown={onKeydown} role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-title">{title}</div>
      {#if message}<div class="modal-message">{message}</div>{/if}
      <div class="modal-actions">
        <button class="btn-cancel" onclick={cancel}>{cancelLabel}</button>
        <button class="btn-confirm" class:danger onclick={confirm}>{confirmLabel}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 2000;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(3px);
    animation: fade-in 0.15s ease;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .modal-box {
    background: #262626;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    padding: 18px 20px;
    max-width: 360px;
    width: calc(100vw - 40px);
    box-shadow: 0 24px 60px rgba(0,0,0,0.5);
    animation: modal-in 0.16s ease;
  }
  .modal-box.danger { border-color: rgba(255,107,107,0.25); }

  @keyframes modal-in {
    from { opacity: 0; transform: scale(0.95); }
    to   { opacity: 1; transform: scale(1); }
  }

  .modal-title {
    font-size: 0.85rem;
    font-weight: 700;
    color: #f0f0f0;
    margin-bottom: 6px;
  }

  .modal-message {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.5);
    line-height: 1.5;
    margin-bottom: 16px;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn-cancel {
    padding: 6px 13px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px;
    color: rgba(255,255,255,0.55);
    font-size: 0.72rem;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, color 0.15s;
  }
  .btn-cancel:hover { border-color: rgba(255,255,255,0.25); color: rgba(255,255,255,0.85); }

  .btn-confirm {
    padding: 6px 13px;
    background: rgba(255,201,81,0.15);
    border: 1px solid rgba(255,201,81,0.3);
    border-radius: 7px;
    color: #ffc951;
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s;
  }
  .btn-confirm:hover { background: rgba(255,201,81,0.25); }
  .btn-confirm.danger {
    background: rgba(255,107,107,0.15);
    border-color: rgba(255,107,107,0.35);
    color: #ff8080;
  }
  .btn-confirm.danger:hover { background: rgba(255,107,107,0.28); }
</style>
