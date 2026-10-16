// Events: graduation, Annual Day, Pongal, a camping trip. What's needed (in sections), where each thing is now,
// and who has it.
//  - In a group, events belong to the GROUP: they're kept in the group's directory sheet, everyone in the group sees
//    them, and each line can point at an item in any of the group's inventories (school, storage unit, a volunteer's).
//  - An inventory that isn't in a group keeps its own events in its own sheet (an inventory in a group can too).
// Other inventories are read from this phone's copy (refreshed in the background), the same way search across them works.
import { esc, $, toast, sheet, confirmSheet, icon } from './ui.js';
import { search, findDuplicates } from './search.js';
import { loadKnown } from './inventories.js';
import { XFRESH_MS, xmem, xlocal, xfetch, xpath } from './xinv.js';

// ctx: { repo(), thumbHtml(item, cls), goBack(fallback), shareOut({title,text}), shareSign, todayStr(), invName(),
//        switchTo(sheetId, { hash }), openGroupInventories(groupId), redraw() }
let ctx = null;
export function initEvents(c) { ctx = c; }
const R = () => ctx.repo();

const SUGGESTED_SECTIONS = [`Stage`, `Decor`, `AV`, `Food`, `Supplies`];
const STATE_LABEL = { ready: `Ready`, short: `Short`, out: `With someone`, missing: `Missing`, none: `Not in inventory`, unknown: `Not checked` };
const STATE_ORDER = [`ready`, `short`, `out`, `missing`, `none`, `unknown`];

// ------------------------------------------------------------ inventories an event can draw on
const known = () => loadKnown(R().user.email);
function invNameOf(id) { return id === R().hereId ? ctx.invName() : known().inv[id]?.name || `Inventory`; }

/** { items, pathText, thumbs } for an inventory, or null when this phone has no copy of it yet. */
function dataOf(id) {
  const repo = R();
  if (!id || id === repo.hereId) return repo.hereData();
  const m = xlocal(id);
  return m?.items ? { items: m.items, pathText: (locId) => xpath(m.locations || [], locId).join(` › `), thumbs: m.thumbs || {} } : null;
}
const lineState = (l) => R().lineState(l, dataOf);
const summaryOf = (ev) => R().eventSummary(ev.id, dataOf);

/** The group's inventories: [{ id, name, reachable, here }], this one first. */
function groupInventories() {
  const repo = R(); const g = repo.group(); if (!g) return [];
  const k = known();
  const ids = Object.keys(k.inv).filter((id) => k.inv[id].groupId === g.id && id !== repo.hereId);
  return [{ id: repo.hereId, name: ctx.invName(), reachable: true, here: true },
    ...ids.map((id) => ({ id, name: k.inv[id].name || `Inventory`, reachable: k.inv[id].reachable !== false, here: false }))];
}

/** Fetch other inventories' latest in the background (at most every few minutes each), then redraw. */
const tried = {};
function freshen(ids) {
  if (!navigator.onLine || R().backend.kind !== `google`) return;
  const k = known();
  for (const id of new Set(ids)) {
    if (!id || id === R().hereId || k.inv[id]?.reachable === false || xmem[id]?.loading) continue;
    const m = xlocal(id);
    if (m?.items && Date.now() - (m.at || 0) < XFRESH_MS) continue;
    if (Date.now() - (tried[id] || 0) < XFRESH_MS) continue;
    tried[id] = Date.now();
    xfetch(id).then(() => ctx.redraw());
  }
}
const otherInvs = (ev) => (ev._g ? R().linesOf(ev.id).flatMap((l) => R().sourcesOf(l).filter((x) => !x.off).map((x) => R().srcInv(x))) : []);

// ------------------------------------------------------------ dates
function whenText(date) {
  if (!date) return { day: ``, month: ``, main: `No date set`, rel: `` };
  const d = new Date(`${date}T00:00`); if (isNaN(d)) return { day: ``, month: ``, main: String(date), rel: `` };
  const today = new Date(`${ctx.todayStr()}T00:00`);
  const days = Math.round((d - today) / 86400000);
  const sameYear = d.getFullYear() === today.getFullYear();
  const main = d.toLocaleDateString(undefined, { weekday: `short`, month: `short`, day: `numeric`, ...(sameYear ? {} : { year: `numeric` }) });
  const rel = days === 0 ? `today` : days === 1 ? `tomorrow` : days === -1 ? `yesterday`
    : days > 1 ? (days < 14 ? `in ${days} days` : days < 60 ? `in ${Math.round(days / 7)} weeks` : `in ${Math.round(days / 30)} months`)
    : `${-days} days ago`;
  return { day: String(d.getDate()), month: d.toLocaleDateString(undefined, { month: `short` }), main, rel, past: days < 0 };
}

/** Upcoming (today or later, or no date) soonest first; past ones newest first. */
export function splitEvents() {
  const today = ctx.todayStr();
  const all = R().liveEvents();
  const upcoming = all.filter((e) => !e.date || String(e.date) >= today)
    .sort((a, b) => String(a.date || `9999`).localeCompare(String(b.date || `9999`)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const past = all.filter((e) => e.date && String(e.date) < today).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { upcoming, past };
}

// ------------------------------------------------------------ readiness bits
function summaryText(s) {
  if (!s.total) return `No items yet`;
  const bits = [`${s.ready} of ${s.total} ready`];
  if (s.short) bits.push(`${s.short} short`);
  if (s.out) bits.push(`${s.out} with someone`);
  if (s.missing) bits.push(`${s.missing} missing`);
  if (s.none) bits.push(`${s.none} not in inventory`);
  if (s.unknown) bits.push(`${s.unknown} not checked`);
  return bits.join(` · `);
}
function readyBar(s) {
  if (!s.total) return `<div class="ready-bar is-empty"></div>`;
  return `<div class="ready-bar" role="img" aria-label="${esc(summaryText(s))}">${STATE_ORDER.filter((k) => s[k]).map((k) => `<i class="st-${k}" style="flex:${s[k]}"></i>`).join(``)}</div>`;
}

/** Card used on the Events list and the Find dashboard. */
export function eventCard(ev) {
  freshen(otherInvs(ev));
  const w = whenText(ev.date); const s = summaryOf(ev);
  const g = R().group();
  const scope = g && !ev._g ? ` · only ${ctx.invName()}` : ``;
  return `<a class="event-card${w.past ? ` past` : ``}" href="#/event/${esc(ev.id)}">
    <div class="ev-date">${w.day ? `<b>${esc(w.day)}</b><span>${esc(w.month)}</span>` : icon(`calendar`)}</div>
    <div class="ev-main"><b>${esc(ev.name)}</b>
      <small>${esc(w.main)}${w.rel ? ` · ${esc(w.rel)}` : ``}${esc(scope)}</small>
      ${readyBar(s)}
      <small class="ev-sum">${esc(summaryText(s))}</small></div>
    ${icon(`chevron`)}</a>`;
}

// ------------------------------------------------------------ Events list
export function viewEvents(view) {
  const repo = R();
  const { upcoming, past } = splitEvents();
  const g = repo.group();
  const canNew = g ? !repo.groupReadOnly || !repo.readOnly : !repo.readOnly;
  const newBtn = (cls) => (canNew ? `<button type="button" class="btn primary ${cls}" data-ev="new">${icon(`plus`)} New event</button>` : ``);
  view.innerHTML = `<div class="events">
    <div class="more-head"><a class="back" href="#/more">${icon(`back`)} More</a></div>
    <div class="page-head"><h1>Events</h1>${newBtn(`small`)}</div>
    <p class="muted small">${g ? `Events for <b>${esc(g.name)}</b>. Everyone in the group sees them, and they can use things from any of its ${groupInventories().length} inventories.`
      : `List what an event needs, see where each thing is right now and who has it.`}</p>
    ${upcoming.length ? `<div class="label-sm">Coming up</div><div class="cards">${upcoming.map(eventCard).join(``)}</div>`
      : `<div class="empty">${icon(`calendar`, `big`)}<h3>No events yet</h3>
        <p>Graduation, Annual Day, Pongal, a camping trip: anything you gather the same things for.</p>${newBtn(``)}</div>`}
    ${past.length ? `<div class="label-sm">Past</div><div class="cards">${past.map(eventCard).join(``)}</div>` : ``}
  </div>`;
  view.onclick = async (e) => {
    if (e.target.closest(`[data-ev="new"]`)) {
      const f = await eventForm(); if (!f) return;
      const { group, ...fields } = f;
      const ev = repo.saveEvent(fields, { group }); if (!ev) return;
      location.hash = `#/event/${ev.id}`;
    }
  };
}

/** Name, date, notes (and, in a group, whole group or only this inventory). Resolves the fields, or null. */
function eventForm(ev = null) {
  const repo = R(); const g = ev ? null : repo.group();
  const canGroup = g && !repo.groupReadOnly; const canHere = !repo.readOnly;
  let group = Boolean(canGroup);
  return new Promise((resolve) => {
    let answered = false;
    sheet(ev ? `Edit event` : `New event`, (el, close) => {
      el.innerHTML = `<form class="stack">
        <label class="field"><span>Name</span><input name="name" required value="${esc(ev?.name || ``)}" placeholder="e.g. Graduation ceremony, Pongal, Camping trip"></label>
        <label class="field"><span>Date <small>(optional)</small></span><input name="date" type="date" value="${esc(ev?.date || ``)}"></label>
        <label class="field"><span>Notes <small>(optional)</small></span><input name="notes" value="${esc(ev?.notes || ``)}" placeholder="e.g. School gym, about 200 people"></label>
        ${canGroup && canHere ? `<div class="field"><span>Who it’s for</span><div class="seg ev-scope">
          <button type="button" data-scope="g" class="on">${icon(`users`)} ${esc(g.name)}</button>
          <button type="button" data-scope="i">${icon(`box`)} Only ${esc(ctx.invName())}</button></div>
          <small class="fine" data-scopenote>Everyone in ${esc(g.name)} sees it. Things can come from any of its inventories.</small></div>` : ``}
        <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn primary">${ev ? `Save` : `Create`}</button></div></form>`;
      const f = $(`form`, el);
      if (!ev) setTimeout(() => f.elements.name.focus(), 250);
      el.querySelector(`.ev-scope`)?.addEventListener(`click`, (e) => {
        const b = e.target.closest(`[data-scope]`); if (!b) return;
        group = b.dataset.scope === `g`;
        el.querySelectorAll(`[data-scope]`).forEach((x) => x.classList.toggle(`on`, x === b));
        $(`[data-scopenote]`, el).textContent = group ? `Everyone in ${g.name} sees it. Things can come from any of its inventories.` : `Only people with ${ctx.invName()} see it. Things come from this inventory.`;
      });
      $(`[data-no]`, el).onclick = () => { answered = true; resolve(null); close(); };
      f.onsubmit = (e) => {
        e.preventDefault(); answered = true;
        resolve({ ...(ev ? { id: ev.id } : { group }), name: f.elements.name.value.trim(), date: f.elements.date.value, notes: f.elements.notes.value.trim() });
        close();
      };
    }, { onClose: () => { if (!answered) resolve(null); } });
  });
}

// ------------------------------------------------------------ One event
const evView = {}; // eventId -> { by: 'section'|'place', filter: '' | state key }

export function viewEvent(view, r) {
  const repo = R();
  const ev = repo.eventById(r.id);
  if (!ev) { view.innerHTML = `<div class="empty"><h3>Event not found</h3><a class="btn ghost" href="#/events">All events</a></div>`; return; }
  freshen(otherInvs(ev));
  const canEdit = repo.canEditEvent(ev);
  const st = evView[ev.id] ||= { by: `section`, filter: `` };
  const lines = repo.linesOf(ev.id);
  const s = summaryOf(ev);
  if (st.filter && !s[st.filter]) st.filter = ``;
  const w = whenText(ev.date);
  const shown = lines.map((l) => ({ l, x: lineState(l) })).filter(({ x }) => !st.filter || x.key === st.filter);
  const g = ev._g ? repo.group() : null;
  const used = new Set(lines.flatMap((l) => repo.sourcesOf(l).filter((x) => !x.off).map((x) => repo.srcInv(x))));
  const notHere = groupInventories().filter((i) => !i.here && !i.reachable && used.has(i.id));

  const groups = st.by === `place` ? byPlace(shown, ev) : bySection(shown, repo.sectionsOf(ev.id));
  const plus = (sec) => (canEdit ? `<button type="button" class="icon-btn" data-addto="${esc(sec)}" aria-label="Add">${icon(`plus`)}</button>` : ``);
  view.innerHTML = `<div class="detail event">
    <div class="detail-top">
      <button type="button" class="back" data-a="back">${icon(`back`)} Back</button>
      <div class="detail-tools">
        <button type="button" class="icon-btn" data-ev="share" aria-label="Share or print">${icon(`share`)}</button>
        ${canEdit ? `<button type="button" class="icon-btn" data-ev="menu" aria-label="More actions">${icon(`more`)}</button>` : ``}
      </div>
    </div>
    <h1>${esc(ev.name)}</h1>
    <p class="ev-when">${icon(`calendar`)}<span>${esc(w.main)}${w.rel ? ` · ${esc(w.rel)}` : ``}</span></p>
    ${g ? `<p class="ev-scope-line">${icon(`users`)}<span>${esc(g.name)}${used.size ? ` · things from ${used.size} inventor${used.size === 1 ? `y` : `ies`}` : ``}</span></p>`
      : repo.group() ? `<p class="ev-scope-line">${icon(`box`)}<span>Only ${esc(ctx.invName())}</span></p>` : ``}
    ${ev.notes ? `<p class="muted">${esc(ev.notes)}</p>` : ``}
    ${notHere.length ? `<button type="button" class="xtap" data-include>${icon(`plus`)} Include ${esc(notHere.map((i) => i.name).join(`, `))} <small>one tap to open on this phone, so their items show here</small></button>` : ``}
    ${lines.length ? `
      <div class="readiness">
        <div class="rd-head"><b>${s.ready} of ${s.total}</b><span>ready</span></div>
        ${readyBar(s)}
        <div class="chips scroll rd-chips">
          <button type="button" class="chip${st.filter ? `` : ` on`}" data-filter="">All ${s.total}</button>
          ${STATE_ORDER.filter((k) => s[k]).map((k) => `<button type="button" class="chip st-${k}${st.filter === k ? ` on` : ``}" data-filter="${k}"><i></i>${esc(STATE_LABEL[k])} ${s[k]}</button>`).join(``)}
        </div>
      </div>
      <div class="seg ev-by">
        <button type="button" data-by="section" class="${st.by === `section` ? `on` : ``}">${icon(`sheet`)} By section</button>
        <button type="button" data-by="place" class="${st.by === `place` ? `on` : ``}">${icon(`place`)} Where to get it</button>
      </div>
      ${groups.map((gr) => `<section class="ev-group">
        <div class="ev-ghead"><h2>${esc(gr.label)}</h2><span>${esc(gr.sub)}</span>${gr.section !== undefined ? plus(gr.section) : ``}</div>
        <div class="elines">${gr.rows.map(({ l, x }) => lineRow(ev, l, x, st.by === `place`)).join(``)}</div>
      </section>`).join(``) || `<p class="muted pad">Nothing ${esc((STATE_LABEL[st.filter] || ``).toLowerCase())} right now.</p>`}
      ${canEdit ? `<div class="row-actions left"><button type="button" class="btn ghost" data-ev="add">${icon(`plus`)} Add items</button></div>` : ``}
      ${neededCard(ev)}`
      : `<div class="empty">${icon(`box`, `big`)}<h3>What does ${esc(ev.name)} need?</h3>
        <p>Add things from ${g ? `any of ${esc(g.name)}’s inventories` : `your inventory`}, grouped in sections like Stage, Decor or Food. Things nobody has logged yet can go on the list too.</p>
        ${canEdit ? `<button type="button" class="btn primary" data-ev="add">${icon(`plus`)} Add items</button>` : ``}</div>`}
  </div>`;

  view.onclick = async (e) => {
    const t = e.target;
    if (t.closest(`[data-a="back"]`)) return ctx.goBack(`#/events`);
    if (t.closest(`[data-include]`)) { await ctx.openGroupInventories(repo.group()?.id); return ctx.redraw(); }
    const f = t.closest(`[data-filter]`); if (f) { st.filter = f.dataset.filter; return viewEvent(view, r); }
    const by = t.closest(`[data-by]`); if (by) { st.by = by.dataset.by; return viewEvent(view, r); }
    const add = t.closest(`[data-addto]`); if (add) return addItemsSheet(ev, add.dataset.addto);
    const ln = t.closest(`[data-line]`); if (ln) { const line = repo.eventLines.find((x) => x.id === ln.dataset.line); if (line) lineSheet(ev, line); return; }
    const a = t.closest(`[data-ev]`)?.dataset.ev; if (!a) return;
    if (a === `add`) return addItemsSheet(ev, ``);
    if (a === `share`) return shareMenu(ev);
    if (a === `needshare`) return shareNeeded(ev);
    if (a === `needprint`) return printNeeded(ev);
    if (a === `menu`) return eventMenu(ev);
  };
}

function picOf(item, thumbs, cls = `thumb sm`) {
  const t = thumbs?.[item.id];
  return t ? `<img class="${cls}" src="${t}" alt="" loading="lazy">` : `<div class="${cls} ph">${icon(`photo`)}</div>`;
}
const lineName = (l, x) => x.item?.name || l.name || `Item`;
/** "Storage unit" when the item is in another inventory of the group. */
const fromText = (ev, x) => (ev._g && x.invId && x.invId !== R().hereId ? invNameOf(x.invId) : ``);
/** "Volunteer garage › Shelf 2", without repeating the name when the place already starts with it. */
const withInv = (inv, path) => (!inv ? path : !path ? inv : path.toLowerCase().startsWith(inv.toLowerCase()) ? path : `${inv} › ${path}`);
/** One line about a line's state, naming the inventory when it's another one. */
function stateText(ev, x) {
  if (x.parts?.length > 1) return x.text;
  const from = fromText(ev, x);
  if (x.key === `ready`) return withInv(from, x.where || ``) || `Place not set`;
  if (x.key === `short`) return [x.text.split(` · `)[0], withInv(from, x.where || ``)].filter(Boolean).join(` · `);
  if (x.key === `unknown`) return `In ${invNameOf(x.invId)} · not on this phone yet`;
  return [x.text, from].filter(Boolean).join(` · `);
}

/** Where one item behind a line is: "15 · Storage unit › Shelf 1", "4 with Ravi". */
function partText(ev, p) {
  const inv = ev._g && p.invId !== R().hereId ? invNameOf(p.invId) : ``;
  if (p.key === `ready`) return `${p.have} · ${withInv(inv, p.where) || `place not set`}`;
  if (p.key === `out`) return `${p.have} ${p.reserved ? `reserved for` : `with`} ${p.who || `someone`}`;
  if (p.key === `missing`) return `${p.have} missing${inv ? ` · ${inv}` : ``}`;
  if (p.key === `unknown`) return `? in ${invNameOf(p.invId)}`;
  return `${p.src?.name || `an item`} no longer in ${inv || `the inventory`}`;
}

function lineRow(ev, l, x, placeView) {
  const pic = x.item ? picOf(x.item, x.thumbs) : `<div class="thumb sm ph">${icon(x.key === `unknown` ? `cloud` : `plus`)}</div>`;
  let sub; let parts = ``;
  if (placeView) { // the group heading already says where: show how many of what's needed (if it matters) and the section
    const problem = x.partOf ? `${x.have} of ${x.need}` : x.key === `short` ? x.text.split(` · `)[0] : x.key === `ready` || x.key === `out` || x.key === `missing` ? `` : x.text;
    sub = [problem, l.section].filter(Boolean).join(` · `) || STATE_LABEL[x.key];
  } else {
    sub = stateText(ev, x);
    if (x.key === `none` && !x.parts?.length && !x.off && R().canEditEvent(ev)) sub += ` · tap to find or add it`;
    if (x.parts?.length > 1 || x.off) {
      parts = `<small class="el-parts">${[...(x.parts?.length > 1 ? x.parts.map((p) => esc(partText(ev, p))) : []),
        ...(x.off ? [`${x.off} not for this event`] : [])].join(`<br>`)}</small>`;
    }
  }
  return `<button type="button" class="eline st-${x.key}" data-line="${esc(l.id)}">
    ${pic}
    <span class="el-main"><b>${esc(lineName(l, x))}${Number(l.qty) > 1 ? ` <span class="qty">×${esc(l.qty)}</span>` : ``}</b>
      <small class="el-state">${esc(sub)}</small>${parts}
      ${l.note ? `<small class="el-note">${esc(l.note)}</small>` : ``}</span>
    <span class="el-dot" title="${esc(STATE_LABEL[x.key])}"></span></button>`;
}

function bySection(rows, order) {
  const named = order.filter(Boolean).length;
  return order.map((sec) => {
    const r = rows.filter(({ l }) => (l.section || ``) === sec);
    const ready = r.filter(({ x }) => x.key === `ready`).length;
    return { section: sec, label: sec || (named ? `Other` : `Items`), sub: `${ready}/${r.length} ready`, rows: r };
  }).filter((g) => g.rows.length);
}

/** Group by where to go and get each thing: its place (in which inventory), the person who has it, or what's left to sort out. */
function byPlace(rows, ev) {
  const map = new Map();
  const put = (key, label, sort, row) => { if (!map.has(key)) map.set(key, { label, sort, rows: [] }); map.get(key).rows.push(row); };
  // a line drawing on several items shows up under each of their places
  const flat = rows.flatMap((row) => (row.x.parts?.length > 1 ? row.x.parts.map((p) => ({ l: row.l, x: {
    key: p.key === `gone` ? `none` : p.key, item: p.item, thumbs: p.thumbs, invId: p.invId, where: p.where, who: p.who, have: p.have, need: row.x.need, partOf: true,
    text: p.key === `out` ? `${p.reserved ? `Reserved for` : `With`} ${p.who || `someone`}` : p.key === `gone` ? `No longer in the inventory` : ``,
  } })) : [row]));
  for (const row of flat) {
    const { x } = row;
    if (x.key === `ready` || x.key === `short`) {
      const path = x.where || `Place not set`;
      const label = ev._g ? withInv(invNameOf(x.invId), path) : path;
      put(`p:${x.invId}:${x.item.locationId}`, label, `0${label}`, row);
    } else if (x.key === `out`) put(`o:${String(x.who || ``).toLowerCase()}`, `${x.text.startsWith(`Reserved`) ? `Reserved for` : `With`} ${x.who || `someone`}`, `1${x.who}`, row);
    else if (x.key === `missing`) put(`m`, `Missing`, `2`, row);
    else if (x.key === `unknown`) put(`u:${x.invId}`, `In ${invNameOf(x.invId)} (not checked yet)`, `4${x.invId}`, row);
    else put(`n`, `Not in inventory yet`, `3`, row);
  }
  return [...map.values()].sort((a, b) => a.sort.localeCompare(b.sort)).map((g) => ({ ...g, sub: `${g.rows.length} item${g.rows.length === 1 ? `` : `s`}` }));
}

// ------------------------------------------------------------ Add items to an event
/** Items an event can use: [{ invId, invName, item, pathText, thumbs }]. Group events: every inventory of the group on this phone. */
function pool(ev) {
  const repo = R();
  const invs = ev._g ? groupInventories() : [{ id: repo.hereId, name: ctx.invName(), here: true, reachable: true }];
  const out = []; const missing = [];
  for (const inv of invs) {
    const d = dataOf(inv.id);
    if (!d) { missing.push(inv); continue; }
    for (const item of d.items) if (!item.deleted) out.push({ invId: inv.id, invName: inv.here ? `` : inv.name, item, pathText: d.pathText, thumbs: d.thumbs });
  }
  return { entries: out, missing };
}
const keyOf = (invId, itemId) => `${invId}|${itemId}`;
const srcKey = (src) => keyOf(R().srcInv(src), src.id);
/** A line's item reference for a pool entry. Group events name the inventory; an inventory's own events leave it empty. */
const srcOf = (ev, e) => ({ inv: ev._g ? e.invId : ``, id: e.item.id, name: e.item.name });
/** Same-named items the event could also use (tablecloths in the closet and the storage unit). */
function matchesFor(ev, name, skip = new Set()) {
  const byInv = new Map();
  for (const e of pool(ev).entries) { if (!byInv.has(e.invId)) byInv.set(e.invId, []); byInv.get(e.invId).push(e); }
  const out = [];
  for (const list of byInv.values()) {
    const idx = new Map(list.map((e) => [e.item.id, e]));
    for (const d of findDuplicates(list.map((e) => e.item), name)) {
      const e = idx.get(d.item.id);
      if (e && !skip.has(keyOf(e.invId, e.item.id))) out.push(e);
    }
  }
  return out;
}
function searchPool(entries, q) {
  if (!q) return [...entries].sort((a, b) => a.item.name.localeCompare(b.item.name));
  // search each inventory with its own place names, keep this inventory first
  const byInv = new Map(); for (const e of entries) { if (!byInv.has(e.invId)) byInv.set(e.invId, []); byInv.get(e.invId).push(e); }
  const out = [];
  for (const list of byInv.values()) {
    const hits = search(list.map((e) => e.item), q, (locId) => list[0].pathText(locId));
    const idx = new Map(list.map((e) => [e.item.id, e]));
    for (const h of hits) out.push(idx.get(h.id));
  }
  return out;
}

function addItemsSheet(ev, startSection) {
  const repo = R();
  freshen(ev._g ? groupInventories().map((i) => i.id) : []);
  const sections = repo.sectionsOf(ev.id).filter(Boolean);
  let section = startSection || sections[sections.length - 1] || ``;
  const extra = new Set(section && !sections.includes(section) ? [section] : []); // sections typed in this sheet
  const chosen = new Map(); const named = []; // key -> entry; free-text things not in any inventory yet
  const already = new Set(repo.linesOf(ev.id).flatMap((l) => repo.sourcesOf(l).map(srcKey)));
  sheet(`Add to ${ev.name}`, (el, close) => {
    el.innerHTML = `<div class="label-sm first">Section</div><div class="chips sec-chips"></div>
      <label class="search sm">${icon(`search`)}<input data-q type="search" placeholder="Search ${ev._g ? `the group’s items` : `your items`}, or type something new" autocomplete="off" enterkeyhint="search"></label>
      <div class="named"></div>
      <div class="bring-list"></div>
      <div class="pool-note"></div>
      <div class="row-actions sticky-actions"><button type="button" class="btn primary full" data-go disabled>Pick items</button></div>`;
    const qEl = $(`[data-q]`, el); const listEl = $(`.bring-list`, el); const go = $(`[data-go]`, el);
    const secEl = $(`.sec-chips`, el); const namedEl = $(`.named`, el); const noteEl = $(`.pool-note`, el);
    const drawSections = () => {
      const all = [...new Set([...sections, ...extra])];
      const sugg = all.length ? [] : SUGGESTED_SECTIONS;
      secEl.innerHTML = [...all, ...sugg].map((s) => `<button type="button" class="chip${s === section ? ` on` : ``}" data-sec="${esc(s)}">${esc(s)}</button>`).join(``)
        + `<button type="button" class="chip${section ? `` : ` on`}" data-sec="">No section</button>`
        + `<button type="button" class="chip add" data-newsec>${icon(`plus`)} New</button>`;
    };
    const upd = () => {
      const n = chosen.size + named.length;
      go.disabled = !n; go.textContent = n ? `Add ${n}${section ? ` to ${section}` : ``}` : `Pick items`;
      namedEl.innerHTML = named.length ? `<div class="chips">${named.map((t, i) => `<button type="button" class="chip on" data-unname="${i}">${esc(t)} ${icon(`x`)}</button>`).join(``)}</div>` : ``;
    };
    const draw = () => {
      const { entries, missing } = pool(ev);
      const q = qEl.value.trim();
      const list = searchPool(entries, q);
      const newRow = q && !named.some((t) => t.toLowerCase() === q.toLowerCase())
        ? `<button type="button" class="bring-row new-need" data-name="${esc(q)}">${icon(`plus`)}<div><b>Add “${esc(q)}”</b><small>Not in ${ev._g ? `any inventory` : `the inventory`} yet, but needed</small></div></button>` : ``;
      listEl.innerHTML = newRow + (list.slice(0, 100).map((e) => {
        const k = keyOf(e.invId, e.item.id); const on = already.has(k);
        const where = withInv(e.invName, e.pathText(e.item.locationId)) || `No location`;
        return `<label class="bring-row${on ? ` done` : ``}">
          <input type="checkbox" data-k="${esc(k)}" ${chosen.has(k) ? `checked` : ``} ${on ? `disabled` : ``}>
          ${picOf(e.item, e.thumbs)}
          <div><b>${esc(e.item.name)}${Number(e.item.qty) > 1 ? ` <span class="qty">×${esc(e.item.qty)}</span>` : ``}</b><small>${on ? `Already on the list` : esc(where)}${!on && e.item.status === `lent` ? ` · with ${esc(e.item.lentTo)}` : ``}</small></div>
        </label>`;
      }).join(``) || (q ? `` : `<p class="muted pad">Nothing logged yet. Type what’s needed above.</p>`));
      const unreachable = missing.filter((i) => !i.reachable); const loading = missing.filter((i) => i.reachable);
      noteEl.innerHTML = [
        loading.length ? `<p class="fine">${navigator.onLine ? `Getting` : `Offline: can’t show`} items from ${esc(loading.map((i) => i.name).join(`, `))}${navigator.onLine ? `…` : `.`}</p>` : ``,
        unreachable.length ? `<button type="button" class="xtap" data-include>${icon(`plus`)} Include ${esc(unreachable.map((i) => i.name).join(`, `))} <small>one tap to open on this phone</small></button>` : ``,
      ].join(``);
      upd();
      el._entries = new Map(entries.map((e) => [keyOf(e.invId, e.item.id), e]));
    };
    secEl.addEventListener(`click`, (e) => {
      const b = e.target.closest(`[data-sec]`);
      if (b) { section = b.dataset.sec; drawSections(); return upd(); }
      if (e.target.closest(`[data-newsec]`)) {
        const row = document.createElement(`form`); row.className = `inline-new`;
        row.innerHTML = `<input placeholder="e.g. Stage, Food, Registration desk" required><button class="btn primary">Add</button>`;
        secEl.after(row); const input = $(`input`, row); input.focus();
        row.onsubmit = (ev2) => { ev2.preventDefault(); const v = input.value.trim(); if (v) { extra.add(v); section = v; } row.remove(); drawSections(); upd(); };
      }
    });
    namedEl.addEventListener(`click`, (e) => { const b = e.target.closest(`[data-unname]`); if (b) { named.splice(Number(b.dataset.unname), 1); draw(); } });
    listEl.addEventListener(`click`, (e) => {
      const b = e.target.closest(`[data-name]`); if (!b) return;
      named.push(b.dataset.name); qEl.value = ``; draw(); qEl.focus();
    });
    noteEl.addEventListener(`click`, async (e) => { if (e.target.closest(`[data-include]`)) { await ctx.openGroupInventories(R().group()?.id); draw(); } });
    listEl.addEventListener(`change`, (e) => {
      const k = e.target.dataset.k; if (!k) return;
      if (e.target.checked) chosen.set(k, el._entries.get(k)); else chosen.delete(k);
      upd();
    });
    qEl.addEventListener(`input`, draw);
    qEl.addEventListener(`keydown`, (e) => { // Enter on a new name adds it to the list
      if (e.key !== `Enter`) return; e.preventDefault();
      const q = qEl.value.trim(); if (!q) return;
      if (!searchPool(pool(ev).entries, q).length) { named.push(q); qEl.value = ``; draw(); }
    });
    go.onclick = () => {
      // Each pick becomes one line, together with same-named items elsewhere (and other picks of the same thing):
      // "Tablecloths" in the school closet and in the storage unit count toward one total.
      const used = new Set(already); const lines = []; let found = 0;
      for (const e of [...chosen.values()].filter(Boolean)) {
        const k = keyOf(e.invId, e.item.id); if (used.has(k)) continue;
        used.add(k);
        const more = matchesFor(ev, e.item.name, used);
        more.forEach((m) => used.add(keyOf(m.invId, m.item.id)));
        found += more.filter((m) => !chosen.has(keyOf(m.invId, m.item.id))).length;
        const all = [e, ...more];
        const total = all.reduce((n, m) => n + (Number(m.item.qty) || 1), 0);
        lines.push({ name: e.item.name, sources: all.map((m) => srcOf(ev, m)), qty: all.length > 1 ? total : 1 });
      }
      const entries = [...lines, ...named.map((name) => ({ name }))];
      close(); // first, so the event page redraws with the new lines
      const added = repo.addLines(ev.id, section, entries);
      if (added.length) toast(`Added ${added.length} to ${section || ev.name}${found ? ` · found ${found} more in other places` : ``}`, { ms: 4500 });
    };
    el._redraw = draw; // other inventories arriving in the background
    drawSections(); draw();
  });
}

// ------------------------------------------------------------ One line: quantity, items it draws on, note, section
function lineSheet(ev, line) {
  const repo = R();
  const canEdit = repo.canEditEvent(ev);
  sheet(lineName(line, lineState(line)), (el, close) => {
    const draw = () => {
      const cur = repo.eventLines.find((l) => l.id === line.id) || line;
      const x = lineState(cur);
      const name = lineName(cur, x);
      const srcs = repo.sourcesOf(cur);
      const sections = repo.sectionsOf(ev.id).filter(Boolean);
      const inUse = new Set(srcs.map(srcKey));
      const also = canEdit && srcs.length ? matchesFor(ev, cur.name || name, inUse) : [];
      const srcRow = (src, i) => {
        const p = repo.sourceState(src, dataOf);
        const inv = ev._g && p.invId !== repo.hereId ? invNameOf(p.invId) : ``;
        const where = p.key === `ready` ? withInv(inv, p.where) || `Place not set`
          : p.key === `out` ? `${p.reserved ? `Reserved for` : `With`} ${p.who || `someone`}${inv ? ` · ${inv}` : ``}`
          : p.key === `missing` ? `Marked missing${inv ? ` · ${inv}` : ``}`
          : p.key === `unknown` ? `In ${invNameOf(p.invId)} · not on this phone yet` : `No longer in ${inv || `the inventory`}`;
        return `<div class="src-row${src.off ? ` off` : ``} st-${p.key === `gone` ? `none` : p.key}">
          ${p.item ? picOf(p.item, p.thumbs) : `<div class="thumb sm ph">${icon(p.key === `unknown` ? `cloud` : `x`)}</div>`}
          <button type="button" class="src-main" data-open="${i}" ${p.item ? `` : `disabled`}><b>${esc(p.item?.name || src.name || `Item`)}${p.have ? ` <span class="qty">×${esc(p.have)}</span>` : ``}</b><small>${esc(src.off ? `Not for this event` : where)}</small></button>
          ${canEdit ? `<button type="button" class="btn small ${src.off ? `ghost` : `text`}" data-off="${i}">${src.off ? `Use it` : `Not for this event`}</button>` : ``}
        </div>`;
      };
      el.innerHTML = `<div class="el-banner st-${x.key}"><span class="el-dot"></span><div>${x.key === `none` ? `<b>${esc(x.text)}</b>`
          : x.key === `unknown` && srcs.length === 1 ? `<b>In ${esc(invNameOf(x.invId))}</b><small>Not on this phone yet, so it can’t be checked here.</small>`
          : `<b>${esc(STATE_LABEL[x.key])}</b><small>${esc(stateText(ev, x))}</small>`}</div></div>
        ${srcs.length ? `<div class="label-sm first">${srcs.length > 1 ? `From ${srcs.length} items` : `From`}</div><div class="src-list">${srcs.map(srcRow).join(``)}</div>`
          : canEdit ? `<div class="label-sm first">Already logged? Find it</div>
            <label class="search sm">${icon(`search`)}<input data-linkq type="search" value="${esc(el._q ?? (cur.name || name))}" placeholder="Search ${ev._g ? `the group’s items` : `your items`}" autocomplete="off" enterkeyhint="search"></label>
            <div class="bring-list link-results"></div>` : ``}
        ${also.length ? `<div class="label-sm">Also found</div><div class="src-list">${also.map((m, i) => `<div class="src-row maybe">${picOf(m.item, m.thumbs)}
            <div class="src-main"><b>${esc(m.item.name)}${Number(m.item.qty) > 1 ? ` <span class="qty">×${esc(m.item.qty)}</span>` : ``}</b><small>${esc(withInv(m.invName, m.pathText(m.item.locationId)) || `No location`)}</small></div>
            <button type="button" class="btn small ghost" data-also="${i}">${icon(`plus`)} Use it</button></div>`).join(``)}</div>` : ``}
        ${canEdit ? `<form class="stack line-form">
          <div class="two">
            <label class="field"><span>How many needed</span><input name="qty" type="number" min="1" inputmode="numeric" value="${esc(cur.qty || 1)}"></label>
            <label class="field"><span>Section</span><input name="section" list="ev-secs" value="${esc(cur.section || ``)}" placeholder="No section"></label>
          </div>
          <datalist id="ev-secs">${sections.map((s2) => `<option value="${esc(s2)}">`).join(``)}</datalist>
          <label class="field"><span>Note <small>(optional)</small></span><input name="note" value="${esc(cur.note || ``)}" placeholder="e.g. the tall one, check batteries"></label>
          <div class="row-actions"><button class="btn primary">Save</button></div></form>` : (cur.note ? `<p class="muted">${esc(cur.note)}</p>` : ``)}
        <div class="menu">
          ${srcs.some((s2) => !s2.off && repo.sourceState(s2, dataOf).key === `unknown`) ? `<button data-l="include">${icon(`plus`)} Check ${esc([...new Set(srcs.filter((s2) => repo.sourceState(s2, dataOf).key === `unknown`).map((s2) => invNameOf(repo.srcInv(s2))))].join(`, `))} on this phone</button>` : ``}
          ${canEdit && !repo.readOnly ? `<button data-l="add">${icon(`plus`)} ${srcs.length ? `Log more` : `Add`} “${esc(name)}” in ${esc(ctx.invName())}</button>` : ``}
          ${canEdit && srcs.length ? `<button data-l="link">${icon(`search`)} Search and add another item to this line</button>` : ``}
          ${canEdit ? `<button data-l="remove" class="danger">${icon(`trash`)} Remove from ${esc(ev.name)}</button>` : ``}
        </div>`;
      el._also = also; el._srcs = srcs; el._name = name; el._cur = cur;
      if ($(`[data-linkq]`, el)) drawLinkResults();
    };
    // manual link: search everything the event can use (all the group's inventories on this phone)
    const drawLinkResults = () => {
      const q = $(`[data-linkq]`, el).value.trim(); el._q = q;
      const entries = pool(ev).entries;
      let hits = q ? searchPool(entries, q) : []; let loose = false;
      if (q && !hits.length) { // every word has to match; if nothing does, try each word on its own ("lamps", "diyas")
        const seen = new Set(); loose = true;
        for (const w of q.split(/[\s(),/-]+/).filter((x) => x.length >= 3).sort((x, y) => y.length - x.length)) {
          for (const m of searchPool(entries, w)) { const k = keyOf(m.invId, m.item.id); if (!seen.has(k)) { seen.add(k); hits.push(m); } }
        }
      }
      el._hits = hits.slice(0, 8);
      $(`.link-results`, el).innerHTML = el._hits.map((m, i) => `<button type="button" class="bring-row" data-linkpick="${i}">${picOf(m.item, m.thumbs)}
          <div><b>${esc(m.item.name)}${Number(m.item.qty) > 1 ? ` <span class="qty">×${esc(m.item.qty)}</span>` : ``}</b><small>${esc(withInv(m.invName, m.pathText(m.item.locationId)) || `No location`)}</small></div>
          <span class="link-go">${icon(`plus`)} Link</span></button>`).join(``)
        || `<p class="fine pad">${q ? `Nothing matches “${esc(q)}”. Try a different word.` : `Type part of its name.`}</p>`;
      if (loose && el._hits.length) $(`.link-results`, el).insertAdjacentHTML(`afterbegin`, `<p class="fine">Nothing has all those words. Close matches:</p>`);
    };
    el.addEventListener(`input`, (e) => { if (e.target.matches(`[data-linkq]`)) drawLinkResults(); });
    el.addEventListener(`submit`, (e) => {
      const form = e.target.closest(`.line-form`); if (!form) return;
      e.preventDefault();
      close();
      repo.saveLine({ id: line.id, qty: Math.max(1, Number(form.elements.qty.value) || 1), section: form.elements.section.value.trim(), note: form.elements.note.value.trim() });
      toast(`Saved`);
    });
    el.addEventListener(`click`, async (e) => {
      const srcs = el._srcs; const name = el._name; const cur = el._cur;
      const off = e.target.closest(`[data-off]`);
      if (off) { // mark one item "not for this event" (or use it again)
        const list = srcs.map((s2, i) => (i === Number(off.dataset.off) ? { ...s2, off: s2.off ? undefined : 1 } : s2)).map(({ off: o, ...rest }) => (o ? { ...rest, off: 1 } : rest));
        repo.setSources(cur, list); draw(); return;
      }
      const lp = e.target.closest(`[data-linkpick]`);
      if (lp) {
        const pick = el._hits[Number(lp.dataset.linkpick)]; if (!pick) return;
        const k = keyOf(pick.invId, pick.item.id);
        const more = matchesFor(ev, pick.item.name, new Set([k]));
        repo.setSources(cur, [srcOf(ev, pick), ...more.map((m) => srcOf(ev, m))], { name: pick.item.name });
        toast(more.length ? `Linked ${pick.item.name} · found ${more.length} more in other places` : `Linked ${pick.item.name}`);
        el._q = undefined; draw(); return;
      }
      const also = e.target.closest(`[data-also]`);
      if (also) { const m = el._also[Number(also.dataset.also)]; repo.setSources(cur, [...srcs, srcOf(ev, m)]); draw(); return; }
      const op = e.target.closest(`[data-open]`);
      if (op) {
        const src = srcs[Number(op.dataset.open)]; const inv = repo.srcInv(src);
        close();
        if (inv !== repo.hereId) ctx.switchTo(inv, { hash: `#/item/${src.id}` }); else location.hash = `#/item/${src.id}`;
        return;
      }
      const a = e.target.closest(`[data-l]`)?.dataset.l; if (!a) return;
      if (a === `include`) {
        close();
        const invs = [...new Set(srcs.map((s2) => repo.srcInv(s2)).filter((id) => id !== repo.hereId))];
        if (invs.some((id) => known().inv[id]?.reachable === false)) await ctx.openGroupInventories(repo.group()?.id);
        for (const id of invs) { tried[id] = 0; await xfetch(id); }
        ctx.redraw(); return;
      }
      if (a === `add`) { close(); location.hash = `#/add?name=${encodeURIComponent(name)}&qty=${encodeURIComponent(srcs.length ? 1 : cur.qty || 1)}&eline=${encodeURIComponent(line.id)}`; return; }
      if (a === `link`) {
        close();
        const pick = await pickItem(ev, srcs.length ? `Add to “${name}”` : `Which item is “${name}”?`, cur.name || name);
        if (!pick) return;
        const k = keyOf(pick.invId, pick.item.id);
        if (srcs.some((s2) => srcKey(s2) === k)) { toast(`Already on this line`); return; }
        const more = srcs.length ? [] : matchesFor(ev, pick.item.name, new Set([k]));
        repo.setSources(cur, [...srcs, srcOf(ev, pick), ...more.map((m) => srcOf(ev, m))], srcs.length ? {} : { name: pick.item.name });
        toast(more.length ? `Linked ${pick.item.name} · found ${more.length} more in other places` : `Added ${pick.item.name}`);
        return;
      }
      if (a === `remove`) {
        close();
        repo.deleteLine(cur);
        toast(`Removed ${name}`, { action: `Undo`, ms: 6000, onAction: () => repo.saveLine({ id: line.id, deleted: `` }) });
      }
    });
    draw();
  }, { onClose: () => setTimeout(() => ctx.redraw(), 0) });
}

/** Pick one item the event can use. Resolves a pool entry { invId, item }, or null. */
function pickItem(ev, title, query = ``) {
  return new Promise((resolve) => {
    let done = false;
    sheet(title, (el, close) => {
      el.innerHTML = `<label class="search sm">${icon(`search`)}<input data-q type="search" value="${esc(query)}" placeholder="Search ${ev._g ? `the group’s items` : `your items`}" autocomplete="off" enterkeyhint="search"></label><div class="bring-list"></div>`;
      const qEl = $(`[data-q]`, el); const listEl = $(`.bring-list`, el);
      let shown = [];
      const draw = () => {
        const q = qEl.value.trim();
        shown = searchPool(pool(ev).entries, q).slice(0, 60);
        listEl.innerHTML = shown.map((e, i) => `<button type="button" class="bring-row" data-pick="${i}">${picOf(e.item, e.thumbs)}
          <div><b>${esc(e.item.name)}</b><small>${esc(withInv(e.invName, e.pathText(e.item.locationId)) || `No location`)}</small></div></button>`).join(``)
          || `<p class="muted pad">${q ? `Nothing matches “${esc(q)}”.` : `Nothing logged yet.`}</p>`;
      };
      qEl.addEventListener(`input`, draw);
      listEl.addEventListener(`click`, (e) => { const b = e.target.closest(`[data-pick]`); if (b) { done = true; close(); resolve(shown[Number(b.dataset.pick)]); } });
      draw();
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

// ------------------------------------------------------------ menu + share
function eventMenu(ev) {
  const repo = R();
  sheet(ev.name, (el, close) => {
    const secs = repo.sectionsOf(ev.id).filter(Boolean);
    el.innerHTML = `<div class="menu">
      <button data-m="edit">${icon(`edit`)} Rename, date, notes</button>
      ${secs.length ? `<button data-m="sections">${icon(`sheet`)} Rename a section</button>` : ``}
      <button data-m="delete" class="danger">${icon(`trash`)} Delete event</button></div>
      <p class="fine">Deleting the event only removes its list${ev._g ? ` for everyone in the group` : ``}. Nothing in any inventory changes.</p>`;
    el.onclick = async (e) => {
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `edit`) { const f = await eventForm(ev); if (f) { repo.saveEvent(f); toast(`Saved`); } }
      if (m === `sections`) renameSectionSheet(ev, secs);
      if (m === `delete` && await confirmSheet(`Delete ${ev.name}?`, `Its list of ${repo.linesOf(ev.id).length} item(s) goes too${ev._g ? `, for everyone in the group` : ``}. Nothing in any inventory changes.`, `Delete`, true)) {
        repo.deleteEvent(ev); location.hash = `#/events`;
        toast(`Deleted ${ev.name}`, { action: `Undo`, ms: 6000, onAction: () => { repo.saveEvent({ id: ev.id, deleted: `` }); location.hash = `#/event/${ev.id}`; } });
      }
    };
  });
}

function renameSectionSheet(ev, secs) {
  const repo = R();
  sheet(`Rename a section`, (el, close) => {
    el.innerHTML = `<div class="menu">${secs.map((s) => `<button data-s="${esc(s)}">${icon(`edit`)} ${esc(s)}</button>`).join(``)}</div>`;
    el.onclick = (e) => {
      const b = e.target.closest(`[data-s]`); if (!b) return;
      const from = b.dataset.s;
      el.innerHTML = `<form class="stack"><label class="field"><span>New name</span><input value="${esc(from)}" required></label>
        <div class="row-actions"><button class="btn primary">Rename</button></div></form>`;
      const f = $(`form`, el); const input = $(`input`, f); input.focus(); input.select();
      f.onsubmit = (ev2) => {
        ev2.preventDefault(); const to = input.value.trim();
        close();
        if (to && to !== from) { repo.renameSection(ev.id, from, to); toast(`Renamed to ${to}`); }
      };
    };
  });
}

/** Everything on the list, section by section, with where each thing is (and which inventory). */
function fullList(ev) {
  const repo = R();
  return bySection(repo.linesOf(ev.id).map((l) => ({ l, x: lineState(l) })), repo.sectionsOf(ev.id)).map((g) => ({
    label: g.label,
    rows: g.rows.map(({ l, x }) => ({
      key: x.key, name: lineName(l, x), qty: Number(l.qty) || 1, note: l.note || ``,
      where: x.key === `unknown` && (x.parts || []).length <= 1 ? `in ${invNameOf(x.invId)}` : stateText(ev, x),
      parts: x.parts?.length > 1 ? x.parts.map((p) => partText(ev, p)) : [],
    })),
  }));
}

/**
 * What's left to sort out before the event, grouped by what someone has to do:
 * buy or borrow (not enough anywhere), get back (lent out), find (marked missing), check (an inventory not on this phone).
 */
export function stillNeeded(ev) {
  const repo = R(); const lines = repo.linesOf(ev.id);
  const g = { buy: [], back: [], find: [], check: [] }; let open = 0;
  for (const l of lines) {
    const x = lineState(l);
    if (x.key === `ready`) continue;
    open++;
    const name = lineName(l, x); const need = Number(l.qty) || 1; const section = l.section || ``;
    const parts = x.parts || [];
    const ready = parts.filter((p) => p.key === `ready`).reduce((n, p) => n + p.have, 0);
    let gap = need - ready;
    let unsure = false;
    for (const p of parts) {
      const inv = ev._g && p.invId !== repo.hereId ? invNameOf(p.invId) : ``;
      if (p.key === `out`) { g.back.push({ name, qty: p.have, detail: `${p.reserved ? `reserved for` : `with`} ${p.who || `someone`}${inv ? ` (${inv})` : ``}`, section }); gap -= p.have; }
      else if (p.key === `missing`) { g.find.push({ name, qty: p.have, detail: `marked missing${p.where || inv ? `, last in ${withInv(inv, p.where || ``)}` : ``}`, section }); gap -= p.have; }
      else if (p.key === `unknown`) { g.check.push({ name, qty: 0, detail: `in ${invNameOf(p.invId)}, not checked on this phone`, section }); unsure = true; }
    }
    if (!unsure && gap > 0) {
      const have = ready ? `have ${ready} of ${need}` : parts.length ? `none ready` : `not in any inventory`;
      g.buy.push({ name, qty: gap, more: Boolean(ready), detail: have, section });
    }
  }
  const groups = [
    { key: `buy`, title: `To buy or borrow`, items: g.buy },
    { key: `back`, title: `To get back`, items: g.back },
    { key: `find`, title: `To find`, items: g.find },
    { key: `check`, title: `To check`, items: g.check },
  ].filter((x) => x.items.length);
  return { groups, open, total: lines.length };
}

const neededLine = (it) => `${it.name}${it.qty > 1 || it.more ? ` ×${it.qty}${it.more ? ` more` : ``}` : ``}`;

function neededCard(ev) {
  const n = stillNeeded(ev);
  if (!n.total) return ``;
  if (!n.open) return `<section class="needed-card done">${icon(`check`)}<div><b>Everything on the list is ready</b><small>${n.total} item${n.total === 1 ? `` : `s`}, all in place.</small></div></section>`;
  return `<section class="needed-card">
    <div class="nc-head"><h2>Still needed</h2><span>${n.open} of ${n.total}</span></div>
    ${n.groups.map((g) => `<div class="nc-group nc-${g.key}"><div class="label-sm">${esc(g.title)}</div><ul>${g.items.map((it) => `<li><b>${esc(neededLine(it))}</b><small>${esc(it.detail)}</small></li>`).join(``)}</ul></div>`).join(``)}
    <div class="row-actions left">
      <button type="button" class="btn primary" data-ev="needshare">${icon(`share`)} Share</button>
      <button type="button" class="btn ghost" data-ev="needprint">${icon(`print`)} Print</button>
    </div></section>`;
}

const header = (ev) => { const w = whenText(ev.date); return `${ev.name}${ev.date ? ` – ${w.main}` : ``}`; };

/** "Still needed" as text for WhatsApp or Messages. */
function shareNeeded(ev) {
  const n = stillNeeded(ev);
  const out = [header(ev), `Still needed: ${n.open} of ${n.total} on the list`, ``];
  for (const g of n.groups) {
    out.push(g.title.toUpperCase());
    for (const it of g.items) out.push(`• ${neededLine(it)} – ${it.detail}`);
    out.push(``);
  }
  out.push(ctx.shareSign);
  return ctx.shareOut({ title: `${ev.name}: still needed`, text: out.join(`\n`) });
}

/** The full list as text. */
function shareEvent(ev) {
  const mark = { ready: `✓`, short: `!`, out: `→`, missing: `✗`, none: `○`, unknown: `?` };
  const out = [header(ev), summaryText(summaryOf(ev)), ``];
  for (const g of fullList(ev)) {
    out.push(g.label.toUpperCase());
    for (const r of g.rows) {
      out.push(`${mark[r.key]} ${r.name}${r.qty > 1 ? ` ×${r.qty}` : ``} – ${r.where}${r.note ? ` (${r.note})` : ``}`);
      for (const p of r.parts) out.push(`    ${p}`);
    }
    out.push(``);
  }
  out.push(ctx.shareSign);
  return ctx.shareOut({ title: ev.name, text: out.join(`\n`) });
}

/** Print a page: only #print-sheet shows on paper (see @media print). Tick boxes to use on the day. */
function printPage(title, bodyHtml) {
  document.getElementById(`print-sheet`)?.remove();
  const el = document.createElement(`div`);
  el.id = `print-sheet`;
  el.innerHTML = `<h1>${esc(title)}</h1>${bodyHtml}<p class="ps-foot">${esc(ctx.shareSign)} · printed ${esc(new Date().toLocaleDateString(undefined, { month: `short`, day: `numeric`, year: `numeric` }))}</p>`;
  document.body.appendChild(el);
  document.body.classList.add(`print-mode`);
  const done = () => { document.body.classList.remove(`print-mode`); el.remove(); window.removeEventListener(`afterprint`, done); };
  window.addEventListener(`afterprint`, done);
  setTimeout(() => { try { window.print(); } catch { toast(`This phone can’t print from here. Use Share instead.`); done(); } }, 50);
}

function printNeeded(ev) {
  const n = stillNeeded(ev);
  printPage(`${header(ev)}: still needed`, `<p class="ps-sub">${n.open} of ${n.total} on the list</p>`
    + n.groups.map((g) => `<h2>${esc(g.title)}</h2><table>${g.items.map((it) => `<tr><td class="box">☐</td><td><b>${esc(neededLine(it))}</b></td><td>${esc(it.detail)}</td><td class="sec">${esc(it.section)}</td></tr>`).join(``)}</table>`).join(``));
}

function printFull(ev) {
  printPage(header(ev), `<p class="ps-sub">${esc(summaryText(summaryOf(ev)))}</p>`
    + fullList(ev).map((g) => `<h2>${esc(g.label)}</h2><table>${g.rows.map((r) => `<tr><td class="box">☐</td><td><b>${esc(r.name)}${r.qty > 1 ? ` ×${r.qty}` : ``}</b>${r.note ? `<br><small>${esc(r.note)}</small>` : ``}</td>
        <td>${esc(r.where)}${r.parts.map((p) => `<br><small>${esc(p)}</small>`).join(``)}</td></tr>`).join(``)}</table>`).join(``));
}

function shareMenu(ev) {
  const n = stillNeeded(ev);
  sheet(`Share or print`, (el, close) => {
    el.innerHTML = `<div class="menu">
      <button data-s="full">${icon(`share`)} Share the full list</button>
      <button data-s="fullprint">${icon(`print`)} Print the full list</button>
      ${n.open ? `<button data-s="need">${icon(`share`)} Share what’s still needed <small>${n.open}</small></button>
      <button data-s="needprint">${icon(`print`)} Print what’s still needed</button>` : ``}
    </div><p class="fine">Shares as a message (WhatsApp, Messages, email). Printed lists have boxes to tick on the day.</p>`;
    el.onclick = (e) => {
      const k = e.target.closest(`[data-s]`)?.dataset.s; if (!k) return;
      close();
      setTimeout(() => ({ full: shareEvent, fullprint: printFull, need: shareNeeded, needprint: printNeeded })[k](ev), 250); // after the sheet closes
    };
  });
}

/** Item page: the upcoming events that need this item. */
export function neededForHtml(item) {
  const evs = R().eventsForItem(item.id); if (!evs.length) return ``;
  return `<div class="block needed-for"><div class="label-sm">Needed for</div><div class="chips">${evs.map((e) => {
    const w = whenText(e.date);
    return `<a class="chip ev-chip" href="#/event/${esc(e.id)}">${icon(`calendar`)} ${esc(e.name)}${w.rel ? ` · ${esc(w.rel)}` : ``}</a>`;
  }).join(``)}</div></div>`;
}

/** After "Add to the inventory" from an event line: the new item (in this inventory) counts toward that line. */
export function linkLineToItem(lineId, itemId) {
  const repo = R();
  const line = repo.eventLines.find((l) => l.id === lineId && !l.deleted);
  if (!line || !itemId) return false;
  const item = repo.items.find((i) => i.id === itemId);
  const src = { inv: line._g ? repo.hereId : ``, id: itemId, name: item?.name || line.name };
  const list = repo.sourcesOf(line).filter((x) => !(x.id === itemId && repo.srcInv(x) === repo.srcInv(src)));
  repo.setSources(line, [...list, src], list.length ? {} : { name: item?.name || line.name });
  return true;
}

/** An open Add sheet wants to show items that just arrived from another inventory. */
export function redrawOpenAddSheet() {
  const body = document.querySelector(`.sheet-wrap.open .sheet-body`);
  if (body?._redraw) body._redraw();
}
