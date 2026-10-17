// A photo of a receipt → items in the inventory, with price, store and date, matched to what's already there and to
// event lines still to buy. Nothing is saved until the person checks the list. The receipt photo is kept with the items.
import { esc, $, toast, sheet, icon } from './ui.js';
import { aiReady, readReceipt } from './ai.js';
import { processReceipt } from './image.js';
import { openNeeds, linkLineToItem } from './events.js';

let ctx = null;
export function initReceipts(c) { ctx = c; }
const R = () => ctx.repo();
const uid = () => Math.random().toString(36).slice(2, 12);

/** "24.99 USD" for the sheet; shown as $24.99. */
export const moneyValue = (n, cur) => (n == null ? `` : `${n.toFixed(2)}${cur ? ` ${cur}` : ``}`);
export function moneyText(v) {
  const m = /^(\d+(?:\.\d+)?)\s*([A-Z]{3})?$/.exec(String(v || ``).trim());
  if (!m) return String(v || ``);
  try { return new Intl.NumberFormat(undefined, { style: `currency`, currency: m[2] || `USD` }).format(Number(m[1])); } catch { return m[1]; }
}
const addMonths = (iso, n) => { const d = new Date(`${iso}T00:00`); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };
const nice = (iso) => { try { return new Date(`${iso}T00:00`).toLocaleDateString(undefined, { day: `numeric`, month: `short`, year: `numeric` }); } catch { return iso; } };

/** Start here: from Add (eventId empty) or from an event (its open lines are matched first). */
export async function scanReceipt({ eventId = `` } = {}) {
  if (!aiReady() && !(await ctx.aiSetup())) return;
  const file = await pickReceipt(eventId);
  if (!file) return;
  let wait = null;
  sheet(`Reading the receipt`, (el, close) => { wait = close; el.innerHTML = `<div class="pad center"><div class="spinner"></div><p class="muted">Finding what you bought…</p></div>`; });
  const repo = R();
  let shot, result;
  try {
    shot = await processReceipt(file);
    const inventory = [...new Map(repo.activeItems().map((i) => [i.name.trim().toLowerCase(), { name: i.name }])).values()];
    const lines = openNeeds(eventId);
    result = await readReceipt(shot.ai, { inventory, lines, categories: repo.categories() });
    result.lines = lines;
  } catch (e) { wait?.(); toast(e.message || String(e), { ms: 6000 }); return; }
  wait?.();
  if (!result.items.length) { toast(`Couldn’t read any products on that. Try a flatter, closer photo in good light.`, { ms: 6000 }); return; }
  review(result, shot, eventId);
}

/** One screen, two ways in: camera, or a photo or screenshot already on the phone (an online order). */
function pickReceipt(eventId) {
  return new Promise((resolve) => {
    let answered = false;
    const ev = eventId ? R().eventById(eventId) : null;
    sheet(`Scan a receipt`, (el, close) => {
      el.innerHTML = `<div class="stack rc-pick">
        <p class="muted">${ev ? `What you bought is matched to what ${esc(ev.name)} still needs, and added to the inventory.` : `Everything on it becomes an item, with price, store and date. Things you already have are matched.`}</p>
        <label class="btn primary full big">${icon(`camera`)} Take a photo of it<input type="file" accept="image/*" capture="environment" hidden data-file></label>
        <label class="btn ghost full">${icon(`photo`)} Choose a photo or screenshot<input type="file" accept="image/*" hidden data-file></label>
        <p class="fine">${icon(`alert`)} Receipts can show card digits or your name. Paran keeps neither, but with a free key Google may see the photo.</p>
      </div>`;
      el.onchange = (e) => { const f = e.target.files?.[0]; if (!f) return; answered = true; resolve(f); close(); };
    }, { onClose: () => { if (!answered) resolve(null); } });
  });
}

function review(result, shot, eventId) {
  const repo = R();
  const byName = new Map(); // name → every item with it (the same thing can be kept in two places)
  for (const i of repo.activeItems()) { const k = i.name.trim().toLowerCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(i); }
  const lines = result.lines || [];
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const date = result.date || ctx.todayStr();
  let locationId = ``;
  const rows = result.items.map((it) => {
    const existing = (it.match ? byName.get(it.match.trim().toLowerCase()) : null) || [];
    existing.sort((a, b) => (Number(b.qty) || 1) - (Number(a.qty) || 1));
    return { ...it, on: !(it.consumable && !it.line), mode: existing.length ? `more:${existing[0].id}` : `new`, existing, line: it.line || `` };
  });
  sheet(`Check what you bought`, (el, close) => {
    const draw = () => {
      const on = rows.filter((r) => r.on);
      el.innerHTML = `<div class="rc-review">
        <div class="rc-head"><img src="${shot.thumb}" alt="Receipt">
          <div><b>${esc(result.store || `Receipt`)}</b><small>${esc(nice(date))}${result.total != null ? ` · ${esc(moneyText(moneyValue(result.total, result.currency)))}` : ``}</small>
          ${result.returnBy ? `<small>Return by ${esc(nice(result.returnBy))}</small>` : ``}</div></div>
        <div class="pr-list">${rows.map((r, i) => `<div class="pr-row${r.on ? `` : ` off`}">
          <label class="tick"><input type="checkbox" data-on="${i}" ${r.on ? `checked` : ``} aria-label="Include ${esc(r.name)}"></label>
          <div class="pr-main">
            <div class="pr-top"><input class="pr-name" data-name="${i}" value="${esc(r.name)}" aria-label="Name">
              <span class="pr-qty"><span>×</span><input type="number" min="1" inputmode="numeric" data-qty="${i}" value="${r.qty}" aria-label="How many"></span></div>
            <div class="rc-meta">${r.price != null ? `<span>${esc(moneyText(moneyValue(r.price, result.currency)))}</span>` : ``}${r.brand ? `<span>${esc(r.brand)}</span>` : ``}${r.model ? `<span>${esc(r.model)}</span>` : ``}${r.warrantyMonths ? `<span>Warranty to ${esc(nice(addMonths(date, r.warrantyMonths)))}</span>` : ``}${r.consumable ? `<span>Used up</span>` : ``}</div>
            ${r.existing.length ? `<select class="pr-pick${r.mode === `new` ? `` : ` found`}" data-mode="${i}" aria-label="New or existing">
              ${r.existing.map((x) => { const at = r.existing.length > 1 ? ` in ${repo.pathText(x.locationId).split(` › `).pop() || `no place`}` : ``;
                return `<option value="more:${esc(x.id)}" ${r.mode === `more:${x.id}` ? `selected` : ``}>Add ${r.qty} to your ${esc(x.name)}${esc(at)} (have ${esc(x.qty || 1)})</option>
                  <option value="same:${esc(x.id)}" ${r.mode === `same:${x.id}` ? `selected` : ``}>It’s the ${esc(x.name)}${esc(at)} you have: just add the receipt</option>`; }).join(``)}
              <option value="new" ${r.mode === `new` ? `selected` : ``}>A new item</option></select>` : ``}
            ${lines.length ? `<select class="pr-pick${r.line ? ` found` : ``}" data-line="${i}" aria-label="For an event">
              <option value="">Not for an event</option>
              ${lines.map((l) => `<option value="${esc(l.id)}" ${l.id === r.line ? `selected` : ``}>For ${esc(l.event)}: ${esc(l.name)}${l.qty > 1 ? ` ×${l.qty}` : ``}</option>`).join(``)}</select>` : ``}
          </div></div>`).join(``)}</div>
        <div class="field"><span>Put new items in</span>
          <button type="button" class="loc-btn" data-loc>${icon(`place`)}<span>${locationId ? esc(repo.pathText(locationId)) : `<span class="muted">Choose a place (optional)</span>`}</span>${icon(`chevron`)}</button></div>
        <div class="row-actions sticky-actions"><button type="button" class="btn primary full" data-save ${on.length ? `` : `disabled`}>Add ${on.length} to ${esc(ctx.invName())}</button></div>
      </div>`;
    };
    draw();
    el.onchange = (e) => {
      const t = e.target;
      if (t.dataset.on) { rows[t.dataset.on].on = t.checked; draw(); }
      else if (t.dataset.mode) { rows[t.dataset.mode].mode = t.value; draw(); }
      else if (t.dataset.line !== undefined && t.tagName === `SELECT`) { rows[t.dataset.line].line = t.value; if (t.value) rows[t.dataset.line].on = true; draw(); }
      else if (t.dataset.qty) rows[t.dataset.qty].qty = Math.max(1, parseInt(t.value, 10) || 1);
      else if (t.dataset.name) rows[t.dataset.name].name = t.value.trim() || rows[t.dataset.name].name;
    };
    el.onclick = async (e) => {
      if (e.target.closest(`[data-loc]`)) { const id = await ctx.pickLocation(locationId); if (id) { locationId = id; draw(); } return; }
      const save = e.target.closest(`[data-save]`); if (!save) return;
      save.disabled = true; save.textContent = `Saving…`;
      const n = await saveAll(rows.filter((r) => r.on), { result, shot, date, locationId, lineById });
      close();
      toast(`${n.items} added from ${result.store || `the receipt`}${n.linked ? ` · ${n.linked} ready for events` : ``}`, { ms: 5000 });
      ctx.done?.();
    };
  });
}

async function saveAll(rows, { result, shot, date, locationId, lineById }) {
  const repo = R();
  const rid = uid();
  const bought = { store: result.store || ``, boughtAt: date, receipt: `p:${rid}` };
  let items = 0, linked = 0;
  for (const r of rows) {
    const price = moneyValue(r.price, result.currency);
    const extra = [r.brand && `Brand: ${r.brand}`, r.model && `Model: ${r.model}`, result.returnBy && `Return by ${result.returnBy}`].filter(Boolean).join(` · `);
    const warranty = r.warrantyMonths ? addMonths(date, r.warrantyMonths) : ``;
    let item;
    const [mode, id] = r.mode.split(`:`);
    if (mode !== `new` && r.existing.some((x) => x.id === id)) {
      const it = r.existing.find((x) => x.id === id);
      const patch = { id: it.id, ...bought, price, ...(warranty && !it.warranty ? { warranty } : {}) };
      if (mode === `more`) patch.qty = (Number(it.qty) || 1) + r.qty;
      item = await repo.saveItem(patch, { logAction: mode === `more` ? `qty+${r.qty}` : `edited`, info: `From a receipt: ${result.store || ``} ${date}`.trim() });
    } else {
      item = await repo.saveItem({
        name: r.name, qty: r.qty, category: r.category, purpose: r.purpose, tags: r.tags, notes: extra, locationId, warranty, price, ...bought,
      }, { info: `From a receipt: ${result.store || ``} ${date}`.trim(), aiFields: [`category`, `purpose`, `tags`].filter((f) => r[f]) });
    }
    items++;
    if (r.line && lineById.has(r.line) && linkLineToItem(r.line, item.id)) linked++;
  }
  await repo.queueReceipt(rid, shot.photo);
  return { items, linked };
}
