/**
 * Sprite Sheet Builder V2.0 — Safe DOM helpers & native <dialog> wrappers.
 * Never injects untrusted text via innerHTML (Spec §12.3).
 */

export function $(id) {
  return document.getElementById(id);
}

export function clearEl(node) {
  if (!node) return;
  if (typeof node.replaceChildren === 'function') {
    node.replaceChildren();
    return;
  }
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'dataset' && typeof v === 'object') {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const ch of list) {
    if (ch === null || ch === undefined || ch === false) continue;
    if (typeof ch === 'string' || typeof ch === 'number') {
      node.appendChild(document.createTextNode(String(ch)));
    } else {
      node.appendChild(ch);
    }
  }
  return node;
}

export function showToast(message, type = 'info', durationMs = 4200) {
  const container = $('toast-container');
  if (!container) return;
  const cls = type === 'error' ? 'toast is-error' : type === 'warn' ? 'toast is-warn' : type === 'ok' ? 'toast is-ok' : 'toast';
  const closeBtn = el('button', { type: 'button', className: 'btn-xs', text: '✕', 'aria-label': 'Đóng thông báo' });
  const toast = el('div', { className: cls }, [
    el('span', { text: message }),
    closeBtn
  ]);
  const remove = () => {
    if (toast.parentNode) toast.remove();
  };
  closeBtn.addEventListener('click', remove);
  while (container.children.length >= 3) {
    container.firstElementChild.remove();
  }
  container.appendChild(toast);
  if (durationMs > 0) {
    setTimeout(remove, durationMs);
  }
}

/**
 * Show native modal <dialog> confirmation returning chosen button value (or '' on Esc/dismiss).
 * Resets dialog.returnValue after reading per modern-web-guidance.
 */
export function showChoiceDialog({
  title,
  message,
  details = null,
  buttons = [
    { label: 'Hủy', value: 'cancel', autofocus: true },
    { label: 'Xác nhận', value: 'ok', className: 'btn-primary' }
  ]
}) {
  return new Promise((resolve) => {
    const dialog = $('dialog-confirm');
    const titleEl = $('confirm-title');
    const bodyEl = $('confirm-body');
    const footerEl = $('confirm-footer');

    titleEl.textContent = title;
    clearEl(bodyEl);
    clearEl(footerEl);

    if (typeof message === 'string') {
      bodyEl.appendChild(el('p', { style: { margin: '0' }, text: message }));
    } else if (message) {
      bodyEl.appendChild(message);
    }

    if (Array.isArray(details) && details.length > 0) {
      const ul = el('ul', { style: { margin: '4px 0 0 18px', padding: '0', fontSize: '12px', color: 'var(--text-muted)' } });
      for (const line of details) {
        ul.appendChild(el('li', { text: line }));
      }
      bodyEl.appendChild(ul);
    }

    for (const btn of buttons) {
      const b = el('button', {
        type: 'button',
        className: btn.className || '',
        text: btn.label,
        autofocus: Boolean(btn.autofocus)
      });
      b.addEventListener('click', () => {
        dialog.close(btn.value);
      });
      footerEl.appendChild(b);
    }

    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      const val = dialog.returnValue || '';
      dialog.returnValue = '';
      resolve(val);
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

/**
 * Specialized 3-way guard for unsaved frame draft edits (Spec §3.4).
 * Returns 'apply' | 'discard' | 'continue'.
 */
export async function showUnsavedDraftDialog(cellLabel) {
  const choice = await showChoiceDialog({
    title: 'Bản nháp chỉnh sửa frame chưa được áp dụng',
    message: `Ô (${cellLabel}) đang có thay đổi nháp chưa Áp dụng. Bạn muốn xử lý thế nào?`,
    buttons: [
      { label: 'Tiếp tục sửa', value: 'continue', autofocus: true },
      { label: 'Hủy bản nháp', value: 'discard', className: 'btn-danger' },
      { label: 'Áp dụng', value: 'apply', className: 'btn-primary' }
    ]
  });
  return choice || 'continue';
}

export function isTypingInField(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}
