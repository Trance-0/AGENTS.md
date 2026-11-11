let active;
export function showToast(message, { undo, error = false } = {}) {
  active?.remove();
  const toast = document.createElement('div'); toast.className = `dashboard-toast${error ? ' error' : ''}`;
  toast.setAttribute('role', error ? 'alert' : 'status'); toast.setAttribute('aria-live', error ? 'assertive' : 'polite');
  const label = document.createElement('span'); label.textContent = message; toast.append(label);
  let timer;
  if (undo) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Undo';
    button.onclick = async () => {
      clearTimeout(timer); toast.classList.add('pending'); button.disabled = true;
      try { await undo(); toast.remove(); showToast('Changes undone'); }
      catch (e) { toast.remove(); showToast(`Undo failed: ${e.message}`, { error: true }); }
    };
    toast.append(button);
  }
  document.body.append(toast); active = toast;
  timer = setTimeout(() => toast.remove(), 5000);
}
