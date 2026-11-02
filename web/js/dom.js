// dom.js — small DOM helpers shared by the UI modules.

export function $(selector, root) {
  return (root || document).querySelector(selector);
}

export function $$(selector, root) {
  return Array.from((root || document).querySelectorAll(selector));
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Create an element: h('button', { class: 'btn', onclick: fn }, 'Label', child…). */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

/** Copy text to the clipboard; falls back to a hidden textarea + execCommand. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

let toastTimer = 0;

/** Brief notice at the bottom of the screen. kind: '' | 'good' | 'warn'. */
export function toast(message, kind = '') {
  const host = document.getElementById('toast');
  if (!host) return;
  host.textContent = message;
  host.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    host.className = `toast ${kind}`;
  }, 2600);
}

export function openDialog(dlg) {
  if (!dlg || dlg.open) return;
  try {
    dlg.showModal();
  } catch (e) {
    dlg.setAttribute('open', '');
  }
}

export function closeDialog(dlg, value) {
  if (!dlg || !dlg.open) return;
  try {
    dlg.close(value);
  } catch (e) {
    dlg.removeAttribute('open');
  }
}

export function anyDialogOpen() {
  return $$('dialog').some((d) => d.open);
}

/** Close a dialog when its backdrop (the area outside the dialog box) is clicked. */
export function closeOnBackdrop(dlg) {
  dlg.addEventListener('pointerdown', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) closeDialog(dlg, 'cancel');
  });
}
