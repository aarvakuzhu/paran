// Small UI helpers: escaping, toasts, bottom sheets, confirm.
export const esc = (s) => String(s ?? ``).replace(/[&<>"']/g, (c) => ({ '&': `&amp;`, '<': `&lt;`, '>': `&gt;`, '"': `&quot;`, "'": `&#39;` }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, { action, onAction, ms = 3200 } = {}) {
  const host = $(`#toasts`);
  host.querySelectorAll(`.toast`).forEach((t) => t.remove()); // one message at a time: the newest wins
  const el = document.createElement(`div`);
  el.className = `toast`;
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ``}`;
  if (action) el.querySelector(`button`).onclick = () => { onAction?.(); el.remove(); };
  host.appendChild(el);
  setTimeout(() => el.classList.add(`out`), ms);
  setTimeout(() => el.remove(), ms + 400);
}

/** Bottom sheet. Returns { el, close }. `render(el, close)` fills the body. */
export function sheet(title, render, { onClose } = {}) {
  const wrap = document.createElement(`div`);
  wrap.className = `sheet-wrap`;
  wrap.innerHTML = `
    <div class="sheet-backdrop"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon(`x`)}</button></header>
      <div class="sheet-body"></div>
    </section>`;
  document.body.appendChild(wrap);
  document.querySelectorAll(`#toasts .toast`).forEach((t) => t.remove()); // don't cover the sheet with an old message
  requestAnimationFrame(() => wrap.classList.add(`open`));
  const close = () => {
    wrap.classList.remove(`open`);
    setTimeout(() => wrap.remove(), 220);
    onClose?.();
  };
  wrap.querySelector(`.sheet-backdrop`).onclick = close;
  wrap.querySelector(`[data-close]`).onclick = close;
  const body = wrap.querySelector(`.sheet-body`);
  render(body, close);
  return { el: body, close };
}

export function confirmSheet(title, message, okLabel = `Confirm`, danger = false) {
  return new Promise((resolve) => {
    let answered = false;
    sheet(title, (el, close) => {
      el.innerHTML = `<p class="muted">${esc(message)}</p>
        <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button>
        <button type="button" class="btn ${danger ? `danger` : `primary`}" data-yes>${esc(okLabel)}</button></div>`;
      el.querySelector(`[data-no]`).onclick = () => { answered = true; resolve(false); close(); };
      el.querySelector(`[data-yes]`).onclick = () => { answered = true; resolve(true); close(); };
    }, { onClose: () => { if (!answered) resolve(false); } });
  });
}

export function promptSheet(title, { label = ``, value = ``, placeholder = ``, okLabel = `Save`, type = `text` } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    sheet(title, (el, close) => {
      el.innerHTML = `<form class="stack">
        <label class="field"><span>${esc(label)}</span><input type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" required></label>
        <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn primary">${esc(okLabel)}</button></div></form>`;
      const input = el.querySelector(`input`);
      setTimeout(() => input.focus(), 250);
      el.querySelector(`[data-no]`).onclick = () => { answered = true; resolve(null); close(); };
      el.querySelector(`form`).onsubmit = (e) => { e.preventDefault(); answered = true; resolve(input.value.trim()); close(); };
    }, { onClose: () => { if (!answered) resolve(null); } });
  });
}

// Inline stroke icons (no network needed).
const ICONS = {
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  x: `<path d="M6 6l12 12M18 6 6 18"/>`,
  home: `<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>`,
  room: `<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h7V4"/>`,
  info: `<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>`,
  box: `<path d="M3 7 12 3l9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>`,
  place: `<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>`,
  more: `<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>`,
  camera: `<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>`,
  chevron: `<path d="m9 6 6 6-6 6"/>`,
  back: `<path d="m15 6-6 6 6 6"/>`,
  move: `<path d="M5 12h14M13 6l6 6-6 6"/>`,
  lend: `<path d="M7 7h10v10"/><path d="M7 17 17 7"/>`,
  ret: `<path d="M17 17H7V7"/><path d="M17 7 7 17"/>`,
  edit: `<path d="M4 20h4L19 9l-4-4L4 16z"/>`,
  trash: `<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>`,
  qr: `<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>`,
  users: `<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>`,
  sheet: `<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>`,
  download: `<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 20h16"/>`,
  out: `<path d="M14 4h6v16h-6"/><path d="M10 8l-4 4 4 4M6 12h10"/>`,
  alert: `<path d="M12 4 2 20h20z"/><path d="M12 10v4M12 17v.5"/>`,
  check: `<path d="m5 12 5 5 9-10"/>`,
  photo: `<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/>`,
  cloud: `<path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>`,
  ext: `<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>`,
  share: `<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>`,
  calendar: `<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>`,
  clock: `<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`,
  spark: `<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>`,
};
export function icon(name, cls = ``) {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ``}</svg>`;
}

export function timeAgo(iso) {
  if (!iso) return ``;
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `just now`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
