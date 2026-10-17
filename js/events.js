// Events: graduation, Annual Day, Pongal, a camping trip. What's needed (in sections), where each thing is now,
// and who has it.
//  - In a group, events belong to the GROUP: they're kept in the group's directory sheet, everyone in the group sees
//    them, and each line can point at an item in any of the group's inventories (school, storage unit, a volunteer's).
//  - An inventory that isn't in a group keeps its own events in its own sheet (an inventory in a group can too).
// Other inventories are read from this phone's copy (refreshed in the background), the same way search across them works.
import { esc, $, $$, toast, sheet, confirmSheet, promptSheet, icon } from './ui.js';
import { aiReady, planEvent } from './ai.js';
import { search, findDuplicates } from './search.js';
import { loadKnown } from './inventories.js';
import { Repo } from './store.js';
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

// ------------------------------------------------------------ who can open what (group access vs one inventory)
/** email -> { group: true if in the group's people, invs: [inventory ids of the group they were given on their own] } */
function accessMap() {
  const repo = R(); const g = repo.group(); const map = new Map(); if (!g) return map;
  const get = (e) => { const k = String(e).toLowerCase(); if (!map.has(k)) map.set(k, { group: false, invs: [] }); return map.get(k); };
  for (const p of g.people || []) if (p.email && p.role !== `removed`) get(p.email).group = true;
  for (const inv of groupInventories()) {
    const members = inv.here ? repo.members : xlocal(inv.id)?.members || [];
    for (const m of members) if (m.email && m.role !== `removed`) { const a = get(m.email); if (!a.invs.includes(inv.id)) a.invs.push(inv.id); }
  }
  return map;
}
/** People who can open one or more of the group's inventories but not the group: [{ email, only: "School" }]. */
function inventoryOnlyPeople() {
  const out = [];
  for (const [email, a] of accessMap()) if (!a.group && a.invs.length) out.push({ email, only: a.invs.map(invNameOf).join(`, `) });
  return out;
}

/**
 * Keep the Tasks lists in inventories in step with the group's events: someone assigned who can only open an inventory
 * (not the group) gets their part of each event written into an inventory they can open. Only what changed is written.
 */
const taskIdxKey = () => `paran.taskidx.${R().group()?.dirId}`;
function taskIndex() { try { return JSON.parse(localStorage.getItem(taskIdxKey()) || `{}`); } catch { return {}; } }
export function syncTasks() {
  const repo = R(); const g = repo.group(); if (!g || repo.groupReadOnly) return;
  const acc = accessMap(); const idx = taskIndex(); const want = {};
  const byName = (a, b) => invNameOf(a).localeCompare(invNameOf(b));
  for (const ev of repo.liveEvents().filter((e) => e._g)) {
    for (const l of repo.linesOf(ev.id)) {
      const x = lineState(l);
      for (const b of shares(l)) {
        const a = b.email && acc.get(b.email); if (!a || a.group || !a.invs.length) continue;
        const from = repo.sourcesOf(l).filter((y) => !y.off).map((y) => repo.srcInv(y));
        const inv = a.invs.find((i) => from.includes(i)) || [...a.invs].sort(byName)[0]; // where the thing is, else their first inventory
        const id = `${l.id}:${b.email}`;
        want[id] = { inv, row: { id, eventId: ev.id, eventName: ev.name, eventDate: ev.date || ``, lineId: l.id, email: b.email, name: lineName(l, x), qty: b.qty, todo: todoText(ev, l, x), section: l.section || ``, deleted: `` } };
      }
    }
  }
  let changed = false;
  for (const [id, w] of Object.entries(want)) {
    const sig = `${w.inv}|${JSON.stringify(w.row)}`;
    if (idx[id]?.sig === sig) continue;
    if (idx[id] && idx[id].inv !== w.inv) repo.saveTask(idx[id].inv, { id, deleted: new Date().toISOString() }); // moved to another inventory
    repo.saveTask(w.inv, w.row); idx[id] = { inv: w.inv, sig }; changed = true;
  }
  for (const id of Object.keys(idx)) if (!want[id]) { repo.saveTask(idx[id].inv, { id, deleted: new Date().toISOString() }); delete idx[id]; changed = true; }
  if (changed) try { localStorage.setItem(taskIdxKey(), JSON.stringify(idx)); } catch { /* ignore */ }
}
/** The task someone marked done (on their own phone), as the organizer sees it. */
function taskDone(lineId, email) {
  const t = taskIndex()[`${lineId}:${email}`]; if (!t) return ``;
  const list = t.inv === R().hereId ? R().tasks : xlocal(t.inv)?.tasks || [];
  return list.find((x) => x.id === `${lineId}:${email}` && !x.deleted)?.done || ``;
}

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

/** Lines still to buy or borrow (no item yet) in upcoming events this person can change: for matching a receipt. */
export function openNeeds(eventId = ``) {
  const repo = R();
  const evs = splitEvents().upcoming.filter((e) => (!eventId || e.id === eventId) && repo.canEditEvent(e));
  const out = [];
  for (const ev of evs) for (const l of repo.linesOf(ev.id)) if (!repo.sourcesOf(l).some((x) => !x.off)) out.push({ id: l.id, name: l.name, qty: Number(l.qty) || 1, event: ev.name, eventId: ev.id });
  return out;
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
      <small class="ev-sum">${esc(summaryText(s))}</small>
      ${R().myLines(ev.id).length ? `<small class="ev-mine">${icon(`users`)} You’re bringing ${R().myLines(ev.id).length} thing${R().myLines(ev.id).length === 1 ? `` : `s`}</small>` : ``}</div>
    ${icon(`chevron`)}</a>`;
}

// ------------------------------------------------------------ Events list
export function viewEvents(view) {
  const repo = R();
  syncTasks();
  const { upcoming, past } = splitEvents();
  const g = repo.group();
  const google = repo.backend.kind === `google`;
  const runByGroup = !g && google ? repo.backend.inGroupName : ``; // in a group I can't open
  // Events belong to a group. An inventory on its own gets one first (its owner is asked); others can't start one.
  const needsGroup = !g && !runByGroup && google;
  const ownerHere = needsGroup && repo.backend.isOwner;
  const ownerEmail = (repo.members || []).find((m) => m.role === `owner`)?.email || ``;
  const canNew = runByGroup ? false : g ? !repo.groupReadOnly : needsGroup ? ownerHere : !repo.readOnly;
  const newBtn = (cls) => (canNew ? `<button type="button" class="btn primary ${cls}" data-ev="new">${icon(`plus`)} New event</button>` : ``);
  view.innerHTML = `<div class="events">
    <div class="more-head"><a class="back" href="#/more">${icon(`back`)} More</a></div>
    <div class="page-head"><h1>Events</h1>${newBtn(`small`)}</div>
    <p class="muted small">${g ? `Events for <b>${esc(g.name)}</b>. Everyone in the group sees them, and they can use things from ${groupInventories().length === 1 ? `its inventory, and from any you add to the group later` : `any of its ${groupInventories().length} inventories`}.`
      : runByGroup ? `${esc(ctx.invName())} is part of <b>${esc(runByGroup)}</b>, and its events are run by the group. Anything you’re asked to bring shows on your home screen.`
      : needsGroup && !ownerHere ? `Events are run by a group. ${esc(ctx.invName())} isn’t in one yet, so ${ownerEmail ? `ask its owner (${esc(ownerEmail)})` : `ask its owner`} to start an event: Paran will put ${esc(ctx.invName())} in a group first.`
      : `List what an event needs, see where each thing is right now and who has it.`}</p>
    ${upcoming.length ? `<div class="label-sm">Coming up</div><div class="cards">${upcoming.map(eventCard).join(``)}</div>`
      : runByGroup ? `` : `<div class="empty">${icon(`calendar`, `big`)}<h3>No events yet</h3>
        <p>Graduation, Annual Day, Pongal, a camping trip: anything you gather the same things for.</p>${newBtn(``)}</div>`}
    ${past.length ? `<div class="label-sm">Past</div><div class="cards">${past.map(eventCard).join(``)}</div>` : ``}
  </div>`;
  view.onclick = async (e) => {
    if (e.target.closest(`[data-ev="new"]`)) {
      if (needsGroup && !(await groupFirst())) return;
      const f = await eventForm(); if (!f) return;
      const { group, words, ...fields } = f;
      const ev = repo.saveEvent(fields, { group }); if (!ev) return;
      location.hash = `#/event/${ev.id}`;
      if (words) setTimeout(() => listFromWords(ev, words, { fresh: fields.name === `New event` }), 50);
    }
  };
}

/**
 * Events belong to a group, so access stays simple: group people see events, one-inventory people only get their tasks.
 * An inventory on its own is put in a group (a new one, or one of yours) before its first event. Resolves true when done.
 */
function groupFirst() {
  const repo = R(); const inv = ctx.invName();
  const mine = Object.entries(loadKnown(repo.user.email).groups || {}).filter(([, g]) => g.owner && g.dirId);
  return new Promise((resolve) => {
    let answered = false;
    sheet(`Events need a group`, (el, close) => {
      el.innerHTML = `<form class="stack">
        <p class="muted">Events are run by a group, so it’s clear who sees them. Paran will ${mine.length ? `put` : `create a group and put`} <b>${esc(inv)}</b> in ${mine.length ? `a group` : `it`}, then start your event.</p>
        <ul class="muted small bullets">
          <li>Its folder moves into the group’s folder in your Drive. Nothing in it changes.</li>
          <li>People you shared ${esc(inv)} with keep it; you choose whether to give them the whole group.</li>
          <li>Later you can add other inventories (a storage unit, a garage) and events can use them all.</li>
        </ul>
        ${mine.length ? `<label class="field"><span>Group</span><select name="gid">${mine.map(([id, g]) => `<option value="${esc(id)}">${esc(g.name)}</option>`).join(``)}<option value="">New group…</option></select></label>` : ``}
        <label class="field" data-newname ${mine.length ? `hidden` : ``}><span>Group name</span><input name="name" value="" placeholder="e.g. Tamil School, Our homes"></label>
        <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn primary">${mine.length ? `Continue` : `Create group`}</button></div></form>`;
      const f = $(`form`, el); const sel = f.elements.gid; const nameBox = $(`[data-newname]`, el);
      if (sel) sel.onchange = () => { nameBox.hidden = Boolean(sel.value); $(`button.primary`, el).textContent = sel.value ? `Continue` : `Create group`; if (!sel.value) f.elements.name.focus(); };
      $(`[data-no]`, el).onclick = () => { answered = true; resolve(false); close(); };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const gid = sel?.value || ``; const name = f.elements.name.value.trim();
        if (!gid && !name) { f.elements.name.focus(); return; }
        const btn = $(`button.primary`, el); btn.disabled = true; btn.textContent = `Setting up…`;
        answered = true; close();
        const g = await ctx.putInGroup({ gid, name });
        if (g) toast(`${inv} is now in ${g.name}`);
        resolve(Boolean(g));
      };
    }, { onClose: () => { if (!answered) resolve(false); } });
  });
}

/** Name, date, notes. Resolves the fields, or null. */
function eventForm(ev = null) {
  const repo = R(); const g = ev ? null : repo.group();
  const group = Boolean(g); // in a group, every event is the group's
  return new Promise((resolve) => {
    let answered = false;
    sheet(ev ? `Edit event` : `New event`, (el, close) => {
      el.innerHTML = `<form class="stack">
        <label class="field"><span>Name</span><input name="name" ${ev ? `required` : ``} value="${esc(ev?.name || ``)}" placeholder="e.g. Graduation ceremony, Pongal, Camping trip"></label>
        <label class="field"><span>Date <small>(optional)</small></span><input name="date" type="date" value="${esc(ev?.date || ``)}"></label>
        <label class="field"><span>Notes <small>(optional)</small></span><input name="notes" value="${esc(ev?.notes || ``)}" placeholder="e.g. School gym, about 200 people"></label>
        ${ev ? `` : `<label class="field ai-words"><span>${icon(`spark`)} What does it need? <small>(optional)</small></span>
          <textarea name="words" rows="4" placeholder="Describe it or paste your list. e.g. “Graduation for 200 in the gym: stage with podium and 2 mics, banner, 40 tablecloths, certificates for 35 students”"></textarea>
          <small class="fine">AI turns this into the list and finds what you already have. You check it before anything is added.</small></label>`}
        <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn primary">${ev ? `Save` : `Create`}</button></div></form>`;
      const f = $(`form`, el);
      if (!ev) setTimeout(() => f.elements.name.focus(), 250);
      $(`[data-no]`, el).onclick = () => { answered = true; resolve(null); close(); };
      f.onsubmit = (e) => {
        e.preventDefault(); answered = true;
        const name = f.elements.name.value.trim(); const words = f.elements.words?.value.trim() || ``;
        if (!name && !words) { answered = false; f.elements.name.focus(); toast(`Give it a name, or describe it below`); return; }
        resolve({ ...(ev ? { id: ev.id } : { group, words }), name: name || `New event`, date: f.elements.date.value, notes: f.elements.notes.value.trim() });
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
  syncTasks();
  const canEdit = repo.canEditEvent(ev);
  const st = evView[ev.id] ||= { by: `section`, filter: ``, dayBy: `section`, mode: defaultMode(ev) };
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
    ${mineCard(ev)}
    ${notHere.length ? `<button type="button" class="xtap" data-include>${icon(`plus`)} Include ${esc(notHere.map((i) => i.name).join(`, `))} <small>one tap to open on this phone, so their items show here</small></button>` : ``}
    ${lines.length ? modeTabs(ev, st) : ``}
    ${lines.length && st.mode === `day` ? dayBody(ev, st, canEdit) : lines.length && st.mode === `after` ? afterBody(ev, canEdit) : lines.length ? `${st.mode === `plan` ? reminderCard(ev, canEdit) : ``}
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
      ${canEdit ? `<div class="row-actions left"><button type="button" class="btn ghost" data-ev="add">${icon(`plus`)} Add items</button><button type="button" class="btn ghost" data-ev="words">${icon(`spark`)} From a list</button>${s.none ? `<button type="button" class="btn ghost" data-ev="receipt">${icon(`sheet`)} Bought some? Scan the receipt</button>` : ``}</div>` : ``}
      ${neededCard(ev)}`
      : `<div class="empty">${icon(`box`, `big`)}<h3>What does ${esc(ev.name)} need?</h3>
        <p>Add things from ${g ? `any of ${esc(g.name)}’s inventories` : `your inventory`}, grouped in sections like Stage, Decor or Food. Things nobody has logged yet can go on the list too.</p>
        ${canEdit ? `<div class="row-actions center"><button type="button" class="btn primary" data-ev="words">${icon(`spark`)} Describe it or paste a list</button><button type="button" class="btn ghost" data-ev="add">${icon(`plus`)} Pick items</button></div>` : ``}</div>`}
  </div>`;

  view.onclick = async (e) => {
    const t = e.target;
    if (t.closest(`[data-a="back"]`)) return ctx.goBack(`#/events`);
    if (t.closest(`[data-include]`)) { await ctx.openGroupInventories(repo.group()?.id); return ctx.redraw(); }
    const f = t.closest(`[data-filter]`); if (f) { st.filter = f.dataset.filter; return viewEvent(view, r); }
    const by = t.closest(`[data-by]`); if (by) { st.by = by.dataset.by; return viewEvent(view, r); }
    const md = t.closest(`[data-mode]`); if (md) { st.mode = md.dataset.mode; return viewEvent(view, r); }
    const db = t.closest(`[data-dayby]`); if (db) { st.dayBy = db.dataset.dayby; return viewEvent(view, r); }
    // on the day
    const tk = t.closest(`[data-tick]`); if (tk) { tickLine(tk.dataset.tick, tk.dataset.who); return; }
    const dc = t.closest(`[data-daycount]`); if (dc) { const line = repo.eventLines.find((x) => x.id === dc.dataset.daycount); if (line) countSheet(ev, line); return; }
    const pa = t.closest(`[data-personall]`); if (pa) { personAllHere(ev, pa.dataset.personall); return; }
    // after
    const af = t.closest(`[data-after]`); if (af) { await afterAction(ev, af.dataset.line2, af.dataset.after); return; }
    const add = t.closest(`[data-addto]`); if (add) return addItemsSheet(ev, add.dataset.addto);
    const ps = t.closest(`[data-person-share]`); if (ps) return sharePerson(ev, ps.dataset.personShare);
    const ln = t.closest(`[data-line]`); if (ln) { const line = repo.eventLines.find((x) => x.id === ln.dataset.line); if (line) lineSheet(ev, line); return; }
    const a = t.closest(`[data-ev]`)?.dataset.ev; if (!a) return;
    if (a === `add`) return addItemsSheet(ev, ``);
    if (a === `words`) return listFromWords(ev);
    if (a === `receipt`) return ctx.scanReceipt({ eventId: ev.id });
    if (a === `share`) return shareMenu(ev);
    if (a === `needshare`) return shareNeeded(ev);
    if (a === `needprint`) return printNeeded(ev);
    if (a === `menu`) return eventMenu(ev);
    if (a === `remind`) return peopleSheet(ev, { reminder: true });
    if (a === `missingshare`) return shareMissingToday(ev);
    if (a === `aftershare`) return shareAfter(ev);
    if (a === `copy`) return copyFlow(ev);
  };
}

// ------------------------------------------------------------ Plan / Day of / After
function defaultMode(ev) {
  if (!ev.date) return `plan`;
  const t = ctx.todayStr();
  return String(ev.date) === t ? `day` : String(ev.date) < t ? `after` : `plan`;
}
function modeTabs(ev, st) {
  const repo = R(); const lines = repo.linesOf(ev.id);
  const here = lines.filter((l) => repo.gotTotal(l) >= (Number(l.qty) || 1)).length;
  const sorted = lines.filter((l) => afterState(l)).length;
  const tab = (k, label, sub) => `<button type="button" data-mode="${k}" class="${st.mode === k ? `on` : ``}"><span>${label}</span>${sub ? `<small>${sub}</small>` : ``}</button>`;
  return `<div class="seg three ev-modes">${tab(`plan`, `Plan`, ``)}${tab(`day`, `Day of`, here ? `${here}/${lines.length} here` : ``)}${tab(`after`, `After`, sorted ? `${sorted}/${lines.length} sorted` : ``)}</div>`;
}

/** In the week before: remind everyone what they're bringing. */
function reminderCard(ev, canEdit) {
  if (!ev.date || !canEdit) return ``;
  const days = Math.round((new Date(`${ev.date}T00:00`) - new Date(`${ctx.todayStr()}T00:00`)) / 86400000);
  if (days < 0 || days > 7) return ``;
  const n = peopleLists(ev).length; if (!n) return ``;
  return `<section class="remind-card">${icon(`clock`)}<div class="grow"><b>${esc(ev.name)} is ${days === 0 ? `today` : days === 1 ? `tomorrow` : `in ${days} days`}</b>
    <small>Send ${n === 1 ? `the person` : `each of the ${n} people`} bringing things a reminder of their list.</small></div>
    <button type="button" class="btn small primary" data-ev="remind">Remind</button></section>`;
}

// ---- Day of: tick things off as they arrive
const needOf = (l) => Number(l.qty) || 1;
function dayBody(ev, st, canEdit) {
  const repo = R(); const lines = repo.linesOf(ev.id);
  const here = lines.filter((l) => repo.gotTotal(l) >= needOf(l)).length;
  const part = lines.filter((l) => { const g = repo.gotTotal(l); return g > 0 && g < needOf(l); }).length;
  const bar = `<div class="ready-bar">${here ? `<i class="st-ready" style="flex:${here}"></i>` : ``}${part ? `<i class="st-short" style="flex:${part}"></i>` : ``}${lines.length - here - part ? `<i class="st-unknown" style="flex:${lines.length - here - part}"></i>` : ``}</div>`;
  const row = (l, who = ``, share = 0) => {
    const x = lineState(l); const need = needOf(l); const got = repo.gotTotal(l);
    const mine = who ? (repo.gotOf(l).find((g) => g.who.toLowerCase() === who.toLowerCase())?.n || 0) : 0;
    const done = who ? mine >= share : got >= need;
    const sub = who ? `${share} of ${need}${got ? ` · ${got} here in all` : ``}` : [bringersText(l), x.parts?.length ? todoText(ev, l, x).replace(/^from /, ``) : ``].filter(Boolean).join(` · `);
    return `<div class="day-row${done ? ` done` : got ? ` part` : ``}">
      ${canEdit ? `<button type="button" class="tick" data-tick="${esc(l.id)}" ${who ? `data-who="${esc(who)}"` : ``} aria-label="${done ? `Not here` : `Here`}">${icon(`check`)}</button>` : `<span class="tick ro">${done ? icon(`check`) : ``}</span>`}
      <div class="dr-main" ${canEdit ? `data-daycount="${esc(l.id)}"` : ``}><b>${esc(lineName(l, x))}${need > 1 ? ` <span class="qty">×${need}</span>` : ``}</b>${sub ? `<small>${esc(sub)}</small>` : ``}</div>
      ${need > 1 && !who ? `<button type="button" class="dr-n" ${canEdit ? `data-daycount="${esc(l.id)}"` : `disabled`}>${got}/${need}</button>` : ``}
    </div>`;
  };
  let groupsHtml;
  if (st.dayBy === `person`) {
    const ppl = peopleLists(ev);
    const taken = new Set();
    groupsHtml = ppl.map((p) => {
      const ls = lines.filter((l) => shares(l).some((b) => (b.email && b.email === p.email) || b.name.toLowerCase() === p.name.toLowerCase()));
      ls.forEach((l) => taken.add(l.id));
      const rows = ls.map((l) => { const b = shares(l).find((y) => (y.email && y.email === p.email) || y.name.toLowerCase() === p.name.toLowerCase()); return row(l, b.name, b.qty); });
      const allDone = ls.every((l) => { const b = shares(l).find((y) => (y.email && y.email === p.email) || y.name.toLowerCase() === p.name.toLowerCase()); return (repo.gotOf(l).find((g) => g.who.toLowerCase() === b.name.toLowerCase())?.n || 0) >= b.qty; });
      return `<section class="ev-group"><div class="ev-ghead"><h2>${esc(p.name)}</h2><span>${ls.length} thing${ls.length === 1 ? `` : `s`}</span>
        ${canEdit && !allDone ? `<button type="button" class="btn small ghost" data-personall="${esc(p.name)}">${icon(`check`)} All here</button>` : allDone ? `<span class="all-here">${icon(`check`)} All here</span>` : ``}</div>
        <div class="day-rows">${rows.join(``)}</div></section>`;
    }).join(``);
    const rest = lines.filter((l) => !taken.has(l.id));
    if (rest.length) groupsHtml += `<section class="ev-group"><div class="ev-ghead"><h2>Nobody assigned</h2><span>${rest.length}</span></div><div class="day-rows">${rest.map((l) => row(l)).join(``)}</div></section>`;
  } else {
    groupsHtml = bySection(lines.map((l) => ({ l, x: lineState(l) })), repo.sectionsOf(ev.id)).map((g) => {
      const h = g.rows.filter(({ l }) => repo.gotTotal(l) >= needOf(l)).length;
      return `<section class="ev-group"><div class="ev-ghead"><h2>${esc(g.label)}</h2><span>${h}/${g.rows.length} here</span></div><div class="day-rows">${g.rows.map(({ l }) => row(l)).join(``)}</div></section>`;
    }).join(``);
  }
  const missing = lines.length - here;
  return `<div class="readiness day"><div class="rd-head"><b>${here} of ${lines.length}</b><span>here</span>${part ? `<small>${part} partly</small>` : ``}</div>${bar}</div>
    <div class="seg ev-by">
      <button type="button" data-dayby="section" class="${st.dayBy === `section` ? `on` : ``}">${icon(`sheet`)} By section</button>
      <button type="button" data-dayby="person" class="${st.dayBy === `person` ? `on` : ``}">${icon(`users`)} By person</button>
    </div>
    ${groupsHtml}
    ${missing ? `<div class="row-actions left"><button type="button" class="btn ghost" data-ev="missingshare">${icon(`share`)} Share what’s not here yet (${missing})</button></div>`
      : `<section class="needed-card done">${icon(`check`)}<div><b>Everything is here</b><small>All ${lines.length} on the list arrived.</small></div></section>`}`;
}

/** Tick a line (or one person's part of it) as here, or untick it. */
function tickLine(lineId, who) {
  const repo = R(); const l = repo.eventLines.find((x) => x.id === lineId); if (!l) return;
  const need = needOf(l); let got = repo.gotOf(l);
  if (who) {
    const share = shares(l).find((b) => b.name.toLowerCase() === who.toLowerCase())?.qty || need;
    const cur = got.find((g) => g.who.toLowerCase() === who.toLowerCase());
    got = got.filter((g) => g !== cur);
    if (!(cur && cur.n >= share)) got.push({ who, n: share });
  } else if (repo.gotTotal(l) >= need) got = [];
  else { const named = got.filter((g) => g.who); const n = named.reduce((a, g) => a + g.n, 0); got = [...named, ...(need - n > 0 ? [{ who: ``, n: need - n }] : [])]; }
  repo.setGot(l, got);
}
function personAllHere(ev, name) {
  const repo = R();
  for (const l of repo.linesOf(ev.id)) {
    const b = shares(l).find((y) => y.name.toLowerCase() === name.toLowerCase()); if (!b) continue;
    const got = repo.gotOf(l).filter((g) => g.who.toLowerCase() !== name.toLowerCase());
    repo.setGot(l, [...got, { who: b.name, n: b.qty }]);
  }
  toast(`Everything from ${name} is here`);
}
/** How many arrived, and from whom. */
function countSheet(ev, line) {
  const repo = R(); const need = needOf(line);
  sheet(lineName(line, lineState(line)), (el, close) => {
    const draw = () => {
      const cur = repo.eventLines.find((x) => x.id === line.id) || line;
      const got = repo.gotOf(cur); const total = repo.gotTotal(cur);
      const people = shares(cur);
      el.innerHTML = `<div class="need-row"><span>Here so far <small>of ${need}</small></span>
          <span class="stepper sm"><button type="button" class="icon-btn" data-cs="-1">−</button><input type="number" min="0" inputmode="numeric" value="${total}" data-csn><button type="button" class="icon-btn" data-cs="1">+</button></span></div>
        ${people.length ? `<div class="label-sm">Brought by</div><div class="who-rows">${people.map((b) => { const n = got.find((g) => g.who.toLowerCase() === b.name.toLowerCase())?.n || 0; return `<div class="who-row"><span class="who-name">${icon(n >= b.qty ? `check` : `users`)} <b>${esc(b.name)}</b><small>${n} of ${b.qty}</small></span>
            <button type="button" class="btn small ${n >= b.qty ? `ghost` : `primary`}" data-csp="${esc(b.name)}">${n >= b.qty ? `Undo` : `All ${b.qty} here`}</button></div>`; }).join(``)}</div>` : ``}
        <div class="row-actions"><button type="button" class="btn primary" data-csdone>Done</button></div>`;
    };
    const setTotal = (n) => { // keep what people brought; the rest is "not said"
      const cur = repo.eventLines.find((x) => x.id === line.id) || line;
      const named = repo.gotOf(cur).filter((g) => g.who); const nn = named.reduce((a, g) => a + g.n, 0);
      repo.setGot(cur, n >= nn ? [...named, { who: ``, n: n - nn }] : [{ who: ``, n }]);
      draw();
    };
    el.addEventListener(`click`, (e) => {
      const st2 = e.target.closest(`[data-cs]`); if (st2) { setTotal(Math.max(0, Number($(`[data-csn]`, el).value) + Number(st2.dataset.cs))); return; }
      const p = e.target.closest(`[data-csp]`); if (p) { tickLine(line.id, p.dataset.csp); draw(); return; }
      if (e.target.closest(`[data-csdone]`)) close();
    });
    el.addEventListener(`change`, (e) => { if (e.target.matches(`[data-csn]`)) setTotal(Math.max(0, Number(e.target.value) || 0)); });
    draw();
  }, { onClose: () => setTimeout(() => ctx.redraw(), 0) });
}
function shareMissingToday(ev) {
  const repo = R(); const out = [header(ev), `Not here yet:`, ``];
  for (const l of repo.linesOf(ev.id)) {
    const need = needOf(l); const got = repo.gotTotal(l); if (got >= need) continue;
    const x = lineState(l); const who = bringersText(l);
    out.push(`• ${lineName(l, x)}${need > 1 ? ` – ${got} of ${need} here` : ``}${who ? ` · ${who}` : ``}`);
  }
  out.push(``, ctx.shareSign);
  return ctx.shareOut({ title: `${ev.name}: not here yet`, text: out.join(`\n`) });
}

// ---- After: where everything went
/** Where a line went after the event (a 'keep it' still waiting for the item to be saved doesn't count yet). */
const afterState = (l) => { const a = R().afterOf(l); return a && a.state !== `kept-pending` ? a : null; };
const AFTER_LABEL = { back: `Back in its place`, moved: `Put somewhere else`, missing: `Missing`, damaged: `Damaged`, kept: `Added to the inventory`, gone: `Used up or returned` };
function afterBody(ev, canEdit) {
  const repo = R(); const lines = repo.linesOf(ev.id);
  const sorted = lines.filter((l) => afterState(l)).length;
  const issues = lines.filter((l) => [`missing`, `damaged`].includes(afterState(l)?.state)).length;
  const row = (l) => {
    const x = lineState(l); const a = afterState(l); const srcs = repo.sourcesOf(l).filter((s2) => !s2.off);
    const elsewhere = srcs.filter((s2) => repo.srcInv(s2) !== repo.hereId);
    const inInv = srcs.length > 0;
    const btn = (k, label, cls = `ghost`) => `<button type="button" class="btn small ${cls}" data-after="${k}" data-line2="${esc(l.id)}">${label}</button>`;
    return `<div class="after-row${a ? ` sorted st-${a.state}` : ``}">
      <div class="ar-main"><b>${esc(lineName(l, x))}${needOf(l) > 1 ? ` <span class="qty">×${needOf(l)}</span>` : ``}</b>
        <small>${a ? `${esc(AFTER_LABEL[a.state] || a.state)}${a.to ? `: ${esc(a.to)}` : ``}${a.note ? ` · ${esc(a.note)}` : ``}`
          : inInv ? esc(x.parts?.length ? todoText(ev, l, x).replace(/^from /, `kept in `) : ``) : `Not in the inventory`}</small>
        ${!a && elsewhere.length && ev._g ? `<small class="fine">${esc([...new Set(elsewhere.map((s2) => invNameOf(repo.srcInv(s2))))].join(`, `))}</small>` : ``}</div>
      ${!canEdit ? `` : a ? `<div class="ar-actions">${btn(`undo`, `Change`, `text`)}</div>`
        : inInv ? `<div class="ar-actions">${btn(`back`, `${icon(`check`)} Back in place`, `primary`)}${btn(`moved`, `Somewhere else`)}${btn(`missing`, `Missing`)}${btn(`damaged`, `Damaged`)}</div>`
        : `<div class="ar-actions">${repo.readOnly ? `` : btn(`kept`, `${icon(`plus`)} Keep it: add to inventory`, `primary`)}${btn(`gone`, `Used up or returned`)}</div>`}
    </div>`;
  };
  const groups = bySection(lines.map((l) => ({ l, x: lineState(l) })), repo.sectionsOf(ev.id));
  return `<div class="readiness"><div class="rd-head"><b>${sorted} of ${lines.length}</b><span>sorted</span>${issues ? `<small class="warn">${issues} missing or damaged</small>` : ``}</div>
      <div class="ready-bar">${sorted ? `<i class="st-ready" style="flex:${sorted}"></i>` : ``}${lines.length - sorted ? `<i class="st-unknown" style="flex:${lines.length - sorted}"></i>` : ``}</div></div>
    ${groups.map((g) => `<section class="ev-group"><div class="ev-ghead"><h2>${esc(g.label)}</h2><span>${g.rows.filter(({ l }) => afterState(l)).length}/${g.rows.length} sorted</span></div>
      <div class="after-rows">${g.rows.map(({ l }) => row(l)).join(``)}</div></section>`).join(``)}
    ${sorted === lines.length ? `<section class="needed-card done">${icon(`check`)}<div class="grow"><b>All packed up</b><small>${issues ? `${issues} missing or damaged. ` : ``}Next year, start from this list.</small></div></section>` : ``}
    <div class="row-actions left">
      ${sorted ? `<button type="button" class="btn ghost" data-ev="aftershare">${icon(`share`)} Share where things went</button>` : ``}
      ${canEdit ? `<button type="button" class="btn ${sorted === lines.length ? `primary` : `ghost`}" data-ev="copy">${icon(`calendar`)} Copy for next time</button>` : ``}
    </div>`;
}

/**
 * Every item a line uses (not marked "not for this event"), in whichever of the group's inventories it lives:
 * { list: [{ inv, item, here }], notOnPhone: [inventory ids not on this phone yet] }.
 */
function itemsOfLine(l) {
  const repo = R(); const list = []; const notOnPhone = new Set();
  for (const s2 of repo.sourcesOf(l).filter((y) => !y.off)) {
    const inv = repo.srcInv(s2); const d = dataOf(inv);
    if (!d) { notOnPhone.add(inv); continue; }
    const item = d.items.find((i) => i.id === s2.id && !i.deleted);
    if (item) list.push({ inv, item, here: inv === repo.hereId });
  }
  return { list, notOnPhone: [...notOnPhone] };
}
/** Change an item wherever it lives: this inventory as a normal edit, another inventory of the group through its sheet. */
async function changeItem(h, fields, log) {
  const repo = R();
  if (h.here) return repo.saveItem({ id: h.item.id, ...fields }, { logAction: log.action, detail: log.detail, ...(log.info !== undefined ? { info: log.info } : {}) });
  repo.updateElsewhere(h.inv, h.item, fields, log);
}
const heldFor = (h, ev) => h.item.status === `reserved` && Repo.personKey(h.item.lentTo) === Repo.personKey(ev.name);
const pathIn = (inv, locId) => (inv === R().hereId ? R().pathText(locId) : xpath(xlocal(inv)?.locations || [], locId).join(` › `));
/** Set aside for this event: free it again. */
async function release(h, ev) { if (heldFor(h, ev)) await changeItem(h, { status: `home`, lentTo: ``, dueAt: `` }, { action: `unreserved`, detail: h.item.lentTo }); }

/** Pick a place in another inventory of the group (its own places). Resolves a location id, or null. */
function pickPlaceIn(inv, title) {
  const locs = (xlocal(inv)?.locations || []).filter((l) => !l.deleted);
  return new Promise((resolve) => {
    let done = false;
    sheet(title, (el, close) => {
      el.innerHTML = `<p class="fine">Places in ${esc(invNameOf(inv))}</p><label class="search sm">${icon(`search`)}<input data-q type="search" placeholder="Search places" autocomplete="off"></label><div class="list pk-list"></div>`;
      const q = $(`[data-q]`, el); const list = $(`.pk-list`, el);
      const all = locs.map((l) => ({ id: l.id, path: xpath(locs, l.id).join(` › `) })).sort((a, b) => a.path.localeCompare(b.path));
      const draw = () => {
        const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        list.innerHTML = all.filter((x) => terms.every((t) => x.path.toLowerCase().includes(t))).slice(0, 60)
          .map((x) => `<div class="list-row"><button type="button" class="list-main" data-pick="${esc(x.id)}">${icon(`place`)}<span>${esc(x.path)}</span></button></div>`).join(``)
          || `<p class="muted pad">No place matches.</p>`;
      };
      q.addEventListener(`input`, draw);
      list.addEventListener(`click`, (e) => { const b = e.target.closest(`[data-pick]`); if (b) { done = true; close(); resolve(b.dataset.pick); } });
      draw();
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

async function afterAction(ev, lineId, act) {
  const repo = R(); const l = repo.eventLines.find((x) => x.id === lineId); if (!l) return;
  const name = lineName(l, lineState(l));
  const { list, notOnPhone } = itemsOfLine(l);
  const later = notOnPhone.length ? ` ${notOnPhone.map(invNameOf).join(`, `)} isn’t on this phone yet: include it to update its items too.` : ``;
  if (act === `undo`) { repo.setAfter(l, null); return; }
  if (act === `back`) {
    for (const h of list) await release(h, ev);
    repo.setAfter(l, { state: `back` }); toast(`${name}: back in its place.${later}`, later ? { ms: 5000 } : {}); return;
  }
  if (act === `moved`) { // one place per inventory the line draws on
    const byInv = new Map(); for (const h of list) { if (!byInv.has(h.inv)) byInv.set(h.inv, []); byInv.get(h.inv).push(h); }
    const where = [];
    for (const [inv, hs] of byInv) {
      const title = byInv.size > 1 ? `Where did ${name} in ${invNameOf(inv)} go?` : `Where did ${name} go?`;
      const to = inv === repo.hereId ? await ctx.pickLocation(hs[0].item.locationId || ``, title) : await pickPlaceIn(inv, title);
      if (!to) return;
      for (const h of hs) {
        if (h.here) { await release(h, ev); await repo.moveItem(repo.items.find((i) => i.id === h.item.id), to); continue; }
        const from = pathIn(inv, h.item.locationId);
        const keep = h.item.status === `reserved` && !heldFor(h, ev); // still reserved for someone else
        await changeItem(h, { locationId: to, ...(keep ? {} : { status: `home`, lentTo: ``, dueAt: `` }) }, { action: `moved`, detail: pathIn(inv, to), info: from ? `from ${from}` : `` });
      }
      where.push(byInv.size > 1 ? `${invNameOf(inv)} › ${pathIn(inv, to)}` : pathIn(inv, to));
    }
    repo.setAfter(l, { state: `moved`, to: where.join(` + `) }); toast(`${name} moved to ${where.join(` + `)}.${later}`, { ms: 4500 }); return;
  }
  if (act === `missing`) {
    for (const h of list) await changeItem(h, { status: `missing`, ...(heldFor(h, ev) ? { lentTo: ``, dueAt: `` } : {}) }, { action: `missing` });
    repo.setAfter(l, { state: `missing` }); toast(list.length ? `${name} marked missing in the inventory.${later}` : `${name}: missing`); return;
  }
  if (act === `damaged`) {
    const note = await promptSheet(`What’s wrong with ${name}?`, { label: `Damage`, placeholder: `e.g. cracked leg, one bulb out`, okLabel: `Save` });
    if (note === null) return;
    const text = `Damaged at ${ev.name}${ev.date ? ` (${ev.date})` : ``}${note ? `: ${note}` : ``}`;
    for (const h of list) {
      await release(h, ev);
      await changeItem(h, { notes: [h.item.notes, text].filter(Boolean).join(`\n`) }, { action: `edited`, info: text });
    }
    repo.setAfter(l, { state: `damaged`, note }); toast(`${name}: damage noted.${later}`); return;
  }
  if (act === `kept`) { // bought for the event and kept: log it, and the line points at it
    repo.setAfter(l, { state: `kept-pending` });
    location.hash = `#/add?name=${encodeURIComponent(name)}&qty=${encodeURIComponent(needOf(l))}&eline=${encodeURIComponent(l.id)}`; return;
  }
  if (act === `gone`) { repo.setAfter(l, { state: `gone` }); return; }
}

function shareAfter(ev) {
  const repo = R(); const out = [header(ev), `Where things went:`, ``];
  const by = {};
  for (const l of repo.linesOf(ev.id)) { const a = repo.afterOf(l); if (!a) continue; (by[a.state] ||= []).push(`• ${lineName(l, lineState(l))}${a.to ? ` → ${a.to}` : ``}${a.note ? ` (${a.note})` : ``}`); }
  for (const k of [`missing`, `damaged`, `moved`, `kept`, `back`, `gone`]) if (by[k]) out.push((AFTER_LABEL[k] || k).toUpperCase(), ...by[k], ``);
  out.push(ctx.shareSign);
  return ctx.shareOut({ title: `${ev.name}: after`, text: out.join(`\n`) });
}

/** Copy this event for next time. */
async function copyFlow(ev) {
  const repo = R(); const hasPeople = repo.linesOf(ev.id).some((l) => repo.bringersOf(l).length);
  const f = await new Promise((resolve) => {
    let answered = false;
    sheet(`Copy ${ev.name}`, (el, close) => {
      el.innerHTML = `<form class="stack">
        <label class="field"><span>Name</span><input name="name" required value="${esc(ev.name)}"></label>
        <label class="field"><span>Date</span><input name="date" type="date"></label>
        ${hasPeople ? `<label class="check-row"><input type="checkbox" name="people" checked> Keep who brings what</label>` : ``}
        <p class="fine">Copies the sections, items, quantities and notes. Nothing is ticked or sorted yet.</p>
        <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn primary">Copy</button></div></form>`;
      const form = $(`form`, el);
      $(`[data-no]`, el).onclick = () => { answered = true; resolve(null); close(); };
      form.onsubmit = (e) => { e.preventDefault(); answered = true; resolve({ name: form.elements.name.value.trim(), date: form.elements.date.value, keepPeople: Boolean(form.elements.people?.checked) }); close(); };
    }, { onClose: () => { if (!answered) resolve(null); } });
  });
  if (!f) return;
  const copy = repo.copyEvent(ev, f); if (!copy) return;
  toast(`Copied to ${copy.name}`);
  location.hash = `#/event/${copy.id}`;
}

/** Reserve the event's items (in every inventory of the group on this phone), so nobody lends them out before the date. */
async function reserveForEvent(ev) {
  const repo = R(); const todo = []; let already = 0; let busy = 0; const notOnPhone = new Set(); const perInv = new Map();
  for (const l of repo.linesOf(ev.id)) {
    const { list, notOnPhone: np } = itemsOfLine(l); np.forEach((x) => notOnPhone.add(x));
    for (const h of list) {
      if (heldFor(h, ev)) already++;
      else if (h.item.status === `home`) { todo.push(h); perInv.set(h.inv, (perInv.get(h.inv) || 0) + 1); } else busy++;
    }
  }
  const skipped = notOnPhone.size ? ` ${[...notOnPhone].map(invNameOf).join(`, `)} isn’t on this phone yet, so its items aren’t included (include it first).` : ``;
  if (!todo.length) { toast(already ? `Everything is already reserved for ${ev.name}.${skipped}` : `Nothing to reserve.${skipped}`, { ms: 5000 }); return; }
  const where = perInv.size > 1 || ![...perInv.keys()].includes(repo.hereId) ? ` (${[...perInv].map(([inv, n]) => `${n} in ${invNameOf(inv)}`).join(`, `)})` : ``;
  const msg = `Reserves ${todo.length} item${todo.length === 1 ? `` : `s`}${where} for ${ev.name}${ev.date ? `, to be picked up by ${whenText(ev.date).main}` : ``}, so nobody lends them out. They count as ready, and "Back in place" afterwards frees them.${busy ? ` ${busy} already lent or reserved for someone else stay as they are.` : ``}${skipped}`;
  if (!(await confirmSheet(`Reserve for ${ev.name}?`, msg, `Reserve ${todo.length}`))) return;
  for (const h of todo) await changeItem(h, { status: `reserved`, lentTo: ev.name, dueAt: ev.date || `` }, { action: `reserved`, detail: ev.name, info: ev.date ? `due ${ev.date}` : `` });
  toast(`Reserved ${todo.length} for ${ev.name}`);
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

/** Who brings how many: [{ name, qty, email, split }]. Older entries without a number get what's left. */
function shares(l) {
  const list = R().bringersOf(l); const need = Number(l.qty) || 1;
  const fixed = list.filter((b) => b.qty).reduce((n, b) => n + b.qty, 0);
  const rest = list.filter((b) => !b.qty);
  const each = rest.length ? Math.max(0, need - fixed) / rest.length : 0;
  return list.map((b) => ({ name: b.name, email: b.email || ``, qty: b.qty || Math.max(1, Math.ceil(each)), split: list.length > 1 || (b.qty && b.qty !== need) }));
}
/** "Ravi" or "Ravi 10, Kumar 10" */
const bringersText = (l) => shares(l).map((b) => (b.split ? `${b.name} ${b.qty}` : b.name)).join(`, `);

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
      ${bringersText(l) ? `<small class="el-who">${icon(`users`)} ${esc(bringersText(l))}</small>` : ``}
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

// ------------------------------------------------------------ An event's list from words (AI)
/** What the event can draw on, by name (one entry per name, quantities added up), for the AI to match against. */
function poolByName(ev) {
  const by = new Map();
  for (const e of pool(ev).entries) {
    const k = e.item.name.trim().toLowerCase(); if (!k) continue;
    if (!by.has(k)) by.set(k, { name: e.item.name, qty: 0, entries: [] });
    const g = by.get(k); g.qty += Number(e.item.qty) || 1; g.entries.push(e);
  }
  return by;
}

/** Describe the event or paste a list → AI drafts sections, lines and counts, matched to what the group has → review → add. */
async function listFromWords(ev, preset = ``, { fresh = false } = {}) {
  const repo = R();
  if (!aiReady() && !(await ctx.aiSetup())) return;
  if (ev._g) freshen(groupInventories().map((i) => i.id));
  const text = preset || await wordsSheet(ev);
  if (!text) return;
  let wait = null;
  sheet(`Making the list`, (el, close) => { wait = close; el.innerHTML = `<div class="pad center"><div class="spinner"></div><p class="muted">Reading what you wrote and checking ${ev._g ? `the group’s inventories` : `your inventory`}…</p></div>`; });
  const by = poolByName(ev);
  let plan;
  try {
    plan = await planEvent(text, { inventory: [...by.values()].map(({ name, qty }) => ({ name, qty })), sections: repo.sectionsOf(ev.id).filter(Boolean), eventName: fresh ? `` : ev.name, today: ctx.todayStr() });
  } catch (e) { wait?.(); toast(e.message || String(e), { ms: 6000 }); return; }
  wait?.();
  if (!plan.lines.length) { toast(`Couldn’t find things to gather in that. Try listing them, one per line.`, { ms: 6000 }); return; }
  // fill in what the organizer left empty
  const patch = {};
  if (fresh && plan.name) patch.name = plan.name;
  if (!ev.date && plan.date) patch.date = plan.date;
  if (!ev.notes && plan.notes) patch.notes = plan.notes;
  if (Object.keys(patch).length) repo.saveEvent({ id: ev.id, ...patch });
  planReview(repo.eventById(ev.id) || ev, plan, by);
}

function wordsSheet(ev) {
  return new Promise((resolve) => {
    let answered = false;
    sheet(`Make the list`, (el, close) => {
      el.innerHTML = `<form class="stack">
        <p class="muted small">Describe ${esc(ev.name)} or paste a list you already have (WhatsApp, email, notes). AI drafts the list and finds what ${ev._g ? `the group already has` : `you already have`}. You check it before anything is added.</p>
        <textarea name="t" rows="8" required placeholder="e.g. Graduation for 200 in the gym. Stage: podium, 2 mics, banner. 40 tablecloths, certificates for 35 students, snacks and water."></textarea>
        <button class="btn primary full">${icon(`spark`)} Make the list</button></form>`;
      const f = $(`form`, el); setTimeout(() => f.elements.t.focus(), 250);
      f.onsubmit = (e) => { e.preventDefault(); answered = true; resolve(f.elements.t.value.trim()); close(); };
    }, { onClose: () => { if (!answered) resolve(``); } });
  });
}

/** The AI's draft, line by line: tick, rename, change the count, and pick what in the inventory it uses. Then add. */
function planReview(ev, plan, by) {
  const repo = R();
  const have = new Set(repo.linesOf(ev.id).map((l) => l.name.trim().toLowerCase()));
  const entries = pool(ev).entries;
  const rows = plan.lines.map((l) => {
    const names = [...l.matches];
    for (const e of matchesFor(ev, l.name)) names.push(e.item.name);
    for (const e of searchPool(entries, l.name).slice(0, 3)) names.push(e.item.name);
    const cands = [...new Map(names.map((n) => [n.trim().toLowerCase(), n])).values()].filter((n) => by.has(n.trim().toLowerCase())).slice(0, 5);
    const dup = have.has(l.name.trim().toLowerCase());
    return { ...l, cands, pick: l.matches[0] || (matchesFor(ev, l.name)[0]?.item.name ?? ``), on: !dup, dup };
  });
  const where = (name) => {
    const g = by.get(name.trim().toLowerCase()); if (!g) return ``;
    const e = g.entries[0];
    const place = e.pathText(e.item.locationId).split(` › `).slice(-2).join(` › `);
    return `have ${g.qty}${place ? ` · ${place}` : ``}${e.invName ? ` (${e.invName})` : ``}${g.entries.length > 1 ? ` +${g.entries.length - 1}` : ``}`;
  };
  sheet(`Check the list`, (el, close) => {
    const draw = () => {
      const on = rows.filter((r) => r.on); const found = on.filter((r) => r.pick).length;
      const sections = [...new Set(rows.map((r) => r.section || ``))];
      el.innerHTML = `<div class="plan-review">
        <p class="pr-sum"><b>${on.length} thing${on.length === 1 ? `` : `s`}</b> · ${found} found in ${ev._g ? `the group’s inventories` : `your inventory`}${on.length - found ? ` · ${on.length - found} to buy or borrow` : ``}</p>
        ${sections.map((sec) => `<div class="label-sm">${esc(sec || `No section`)}</div>
          <div class="pr-list">${rows.map((r, i) => (r.section || ``) !== sec ? `` : `<div class="pr-row${r.on ? `` : ` off`}">
            <label class="tick"><input type="checkbox" data-on="${i}" ${r.on ? `checked` : ``} aria-label="Include ${esc(r.name)}"></label>
            <div class="pr-main">
              <div class="pr-top"><input class="pr-name" data-name="${i}" value="${esc(r.name)}" aria-label="Name">
                <span class="pr-qty"><span>×</span><input type="number" min="1" inputmode="numeric" data-qty="${i}" value="${r.qty}" aria-label="How many needed"></span></div>
              <select class="pr-pick${r.pick ? ` found` : ``}" data-pick="${i}" aria-label="Uses">
                ${r.cands.map((n) => `<option value="${esc(n)}" ${n === r.pick ? `selected` : ``}>✓ ${esc(n)} · ${esc(where(n))}</option>`).join(``)}
                <option value="" ${r.pick ? `` : `selected`}>Not in inventory yet (buy or borrow)</option></select>
              ${r.dup ? `<small class="pr-hint">Already on the list</small>` : r.guessed ? `<small class="pr-hint">≈ estimated, change if you know</small>` : r.note ? `<small class="pr-hint">${esc(r.note)}</small>` : ``}
            </div></div>`).join(``)}</div>`).join(``)}
        <div class="row-actions sticky-actions"><button type="button" class="btn primary full" data-addall ${on.length ? `` : `disabled`}>Add ${on.length} to ${esc(ev.name)}</button></div>
      </div>`;
    };
    draw();
    el.onchange = (e) => {
      const t = e.target;
      if (t.dataset.on) { rows[t.dataset.on].on = t.checked; draw(); }
      else if (t.dataset.pick) { rows[t.dataset.pick].pick = t.value; draw(); }
      else if (t.dataset.qty) rows[t.dataset.qty].qty = Math.max(1, parseInt(t.value, 10) || 1);
      else if (t.dataset.name) rows[t.dataset.name].name = t.value.trim() || rows[t.dataset.name].name;
    };
    el.onclick = (e) => {
      if (!e.target.closest(`[data-addall]`)) return;
      const on = rows.filter((r) => r.on); let n = 0;
      for (const sec of [...new Set(on.map((r) => r.section || ``))]) {
        const list = on.filter((r) => (r.section || ``) === sec);
        const added = repo.addLines(ev.id, sec, list.map((r) => ({
          name: r.name, qty: r.qty, sources: r.pick ? by.get(r.pick.trim().toLowerCase()).entries.map((x) => srcOf(ev, x)) : [],
        })));
        added.forEach((line, i) => { if (list[i].note && line) repo.saveLine({ id: line.id, note: list[i].note }, { quiet: true }); });
        n += added.length;
      }
      close(); repo.emit?.();
      toast(`${n} added to ${ev.name}`);
    };
  });
}

/**
 * Add things to an event. Every tap adds straight away (tap again to take it back), so nothing is lost by closing the
 * sheet; the button at the bottom is just Done. Typing something nobody has logged and tapping "Add" (or Enter) adds it too.
 */
function addItemsSheet(ev, startSection) {
  const repo = R();
  freshen(ev._g ? groupInventories().map((i) => i.id) : []);
  const sections = repo.sectionsOf(ev.id).filter(Boolean);
  let section = startSection || sections[sections.length - 1] || ``;
  const extra = new Set(section && !sections.includes(section) ? [section] : []); // sections typed in this sheet
  const mine = new Map(); // key (inventory|item) -> line id, for lines added in this sheet (tap again to undo)
  const named = []; // [{ name, lineId }] things not in any inventory, added in this sheet
  const onList = () => new Set(repo.linesOf(ev.id).flatMap((l) => repo.sourcesOf(l).map(srcKey)));
  let count = 0;
  sheet(`Add to ${ev.name}`, (el, close) => {
    el.innerHTML = `<div class="label-sm first">Section</div><div class="chips sec-chips"></div>
      <label class="search sm add-q">${icon(`search`)}<input data-q type="search" placeholder="Search ${ev._g ? `the group’s items` : `your items`}, or type something new" autocomplete="off" enterkeyhint="done"></label>
      <div class="named"></div>
      <div class="bring-list"></div>
      <div class="pool-note"></div>
      <div class="row-actions sticky-actions"><button type="button" class="btn primary full" data-done>Done</button></div>`;
    const qEl = $(`[data-q]`, el); const listEl = $(`.bring-list`, el); const done = $(`[data-done]`, el);
    const secEl = $(`.sec-chips`, el); const namedEl = $(`.named`, el); const noteEl = $(`.pool-note`, el);
    const drawSections = () => {
      const all = [...new Set([...sections, ...extra])];
      const sugg = all.length ? [] : SUGGESTED_SECTIONS;
      secEl.innerHTML = [...all, ...sugg].map((x) => `<button type="button" class="chip${x === section ? ` on` : ``}" data-sec="${esc(x)}">${esc(x)}</button>`).join(``)
        + `<button type="button" class="chip${section ? `` : ` on`}" data-sec="">No section</button>`
        + `<button type="button" class="chip add" data-newsec>${icon(`plus`)} New</button>`;
    };
    const upd = () => {
      done.textContent = count ? `Done · ${count} added${section ? ` to ${section}` : ``}` : `Done`;
      namedEl.innerHTML = named.length ? `<div class="chips">${named.map((t, i) => `<button type="button" class="chip on added" data-unname="${i}">${icon(`check`)} ${esc(t.name)} <span class="un">${icon(`x`)}</span></button>`).join(``)}</div>` : ``;
    };
    const draw = () => {
      const { entries, missing } = pool(ev);
      const q = qEl.value.trim();
      const list = searchPool(entries, q);
      const listed = onList();
      const newRow = q && !named.some((t) => t.name.toLowerCase() === q.toLowerCase())
        ? `<button type="button" class="bring-row new-need${list.length ? `` : ` only`}" data-name="${esc(q)}">${icon(`plus`)}<div><b>Add “${esc(q)}”</b><small>${list.length ? `Something else, not in ${ev._g ? `any inventory` : `the inventory`} yet` : `Not in ${ev._g ? `any inventory` : `the inventory`} yet. Tap to put it on the list`}</small></div></button>` : ``;
      listEl.innerHTML = (list.slice(0, 100).map((e) => {
        const k = keyOf(e.invId, e.item.id); const mineNow = mine.has(k); const other = !mineNow && listed.has(k);
        const where = withInv(e.invName, e.pathText(e.item.locationId)) || `No location`;
        return `<label class="bring-row${mineNow ? ` added` : ``}${other ? ` done` : ``}">
          <input type="checkbox" data-k="${esc(k)}" ${mineNow ? `checked` : ``} ${other ? `disabled` : ``}>
          ${picOf(e.item, e.thumbs)}
          <div><b>${esc(e.item.name)}${Number(e.item.qty) > 1 ? ` <span class="qty">×${esc(e.item.qty)}</span>` : ``}</b><small>${mineNow ? `Added` : other ? `Already on the list` : esc(where)}${!mineNow && !other && e.item.status === `lent` ? ` · with ${esc(e.item.lentTo)}` : ``}</small></div>
        </label>`;
      }).join(``) || (q ? `` : `<p class="muted pad">Nothing logged yet. Type what’s needed above.</p>`)) + newRow;
      // the "not logged" option goes first when nothing matches, last when there are matches
      if (newRow && !list.length) listEl.prepend(listEl.lastElementChild);
      const unreachable = missing.filter((i) => !i.reachable); const loading = missing.filter((i) => i.reachable);
      noteEl.innerHTML = [
        loading.length ? `<p class="fine">${navigator.onLine ? `Getting` : `Offline: can’t show`} items from ${esc(loading.map((i) => i.name).join(`, `))}${navigator.onLine ? `…` : `.`}</p>` : ``,
        unreachable.length ? `<button type="button" class="xtap" data-include>${icon(`plus`)} Include ${esc(unreachable.map((i) => i.name).join(`, `))} <small>one tap to open on this phone</small></button>` : ``,
      ].join(``);
      upd();
      el._entries = new Map(entries.map((e) => [keyOf(e.invId, e.item.id), e]));
    };
    const addNamed = (name) => {
      const [line] = repo.addLines(ev.id, section, [{ name }]);
      if (!line) return;
      named.push({ name, lineId: line.id }); count++;
      qEl.value = ``; draw(); qEl.focus(); // keep the keyboard up for the next one
      toast(`Added ${name}`, { ms: 1800 });
    };
    /** One pick = one line, with same-named items elsewhere counted toward it (tablecloths in two places). */
    const addItem = (k) => {
      const e = el._entries.get(k); if (!e) return;
      const used = onList(); used.add(k);
      const more = matchesFor(ev, e.item.name, used);
      const all = [e, ...more];
      const total = all.reduce((n, m) => n + (Number(m.item.qty) || 1), 0);
      const [line] = repo.addLines(ev.id, section, [{ name: e.item.name, sources: all.map((m) => srcOf(ev, m)), qty: all.length > 1 ? total : 1 }]);
      if (!line) return;
      for (const m of all) mine.set(keyOf(m.invId, m.item.id), line.id);
      count++;
      toast(more.length ? `Added ${e.item.name} · found ${more.length} more in other places` : `Added ${e.item.name}`, { ms: 2500 });
      draw();
    };
    const undoItem = (k) => {
      const lineId = mine.get(k); if (!lineId) return;
      const line = repo.eventLines.find((l) => l.id === lineId);
      if (line) repo.deleteLine(line);
      for (const [key, id] of [...mine]) if (id === lineId) mine.delete(key);
      count = Math.max(0, count - 1);
      toast(`Removed ${line?.name || `it`}`, { ms: 1800 });
      draw();
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
    namedEl.addEventListener(`click`, (e) => {
      const b = e.target.closest(`[data-unname]`); if (!b) return;
      const [t] = named.splice(Number(b.dataset.unname), 1);
      const line = repo.eventLines.find((l) => l.id === t.lineId); if (line) repo.deleteLine(line);
      count = Math.max(0, count - 1); draw();
    });
    listEl.addEventListener(`click`, (e) => { const b = e.target.closest(`[data-name]`); if (b) addNamed(b.dataset.name); });
    noteEl.addEventListener(`click`, async (e) => { if (e.target.closest(`[data-include]`)) { await ctx.openGroupInventories(R().group()?.id); draw(); } });
    listEl.addEventListener(`change`, (e) => {
      const k = e.target.dataset.k; if (!k) return;
      if (e.target.checked) addItem(k); else undoItem(k);
    });
    qEl.addEventListener(`input`, draw);
    qEl.addEventListener(`keydown`, (e) => { // Enter: nothing matches → add it as typed
      if (e.key !== `Enter`) return; e.preventDefault();
      const q = qEl.value.trim(); if (!q) { qEl.blur(); return; }
      if (!searchPool(pool(ev).entries, q).length) addNamed(q);
    });
    // keep the search box at the top of what's visible above the keyboard
    qEl.addEventListener(`focus`, () => setTimeout(() => $(`.add-q`, el)?.scrollIntoView({ block: `start`, behavior: `smooth` }), 320));
    done.onclick = () => close();
    el._redraw = draw; // other inventories arriving in the background
    drawSections(); draw();
  }, { onClose: () => setTimeout(() => { ctx.redraw(); if (count) toast(`${count} added to ${ev.name}`); }, 0) });
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
          : canEdit ? `<div class="label-sm first">Who’s bringing it</div>${whoBlock(cur, canEdit)}
            <div class="label-sm">Already logged? Find it</div>
            <label class="search sm">${icon(`search`)}<input data-linkq type="search" value="${esc(el._q ?? (cur.name || name))}" placeholder="Search ${ev._g ? `the group’s items` : `your items`}" autocomplete="off" enterkeyhint="search"></label>
            <div class="bring-list link-results"></div>` : ``}
        ${also.length ? `<div class="label-sm">Also found</div><div class="src-list">${also.map((m, i) => `<div class="src-row maybe">${picOf(m.item, m.thumbs)}
            <div class="src-main"><b>${esc(m.item.name)}${Number(m.item.qty) > 1 ? ` <span class="qty">×${esc(m.item.qty)}</span>` : ``}</b><small>${esc(withInv(m.invName, m.pathText(m.item.locationId)) || `No location`)}</small></div>
            <button type="button" class="btn small ghost" data-also="${i}">${icon(`plus`)} Use it</button></div>`).join(``)}</div>` : ``}
        ${srcs.length || !canEdit ? `<div class="label-sm">Who’s bringing it</div>${whoBlock(cur, canEdit)}` : ``}
        ${canEdit ? `<form class="stack line-form">
          <label class="field"><span>Section</span><input name="section" list="ev-secs" value="${esc(cur.section || ``)}" placeholder="No section"></label>
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
    /** Add (or update) a person on this line with a number. An email, or a name that belongs to an account, links them. */
    const assign = (typed, email, qty) => {
      const cur = el._cur;
      const extra = inventoryOnlyPeople();
      const acct = (email || repo.accountFor(typed, extra)).toLowerCase();
      const name = typed.includes(`@`) ? (repo.bringerNames(extra).find((p) => p.email === acct)?.name || Repo.nameFromEmail(typed)) : typed;
      const list = shares(cur).filter((b) => b.name.toLowerCase() !== name.toLowerCase() && !(acct && b.email === acct));
      repo.setBringers(cur, [...list, { name, qty, email: acct }]);
      draw();
      setTimeout(() => $(`.who-form [name=who]`, el)?.focus({ preventScroll: true }), 0);
    };
    el.addEventListener(`change`, (e) => {
      const cur = el._cur;
      const q = e.target.closest(`[data-wq]`);
      if (q) { const list = shares(cur); list[Number(q.dataset.wq)].qty = Math.max(1, Number(q.value) || 1); repo.setBringers(cur, list); draw(); return; }
      // "How many needed" applies at once, so the split below follows it
      const need = e.target.closest(`[data-need]`);
      if (need) { repo.saveLine({ id: cur.id, qty: Math.max(1, Number(need.value) || 1) }); draw(); }
    });
    el.addEventListener(`submit`, (e) => {
      const wf = e.target.closest(`.who-form`);
      if (wf) { // assign someone, with how many they bring
        e.preventDefault();
        const typed = wf.elements.who.value.trim(); if (!typed) return;
        assign(typed, ``, Number(wf.elements.wq.value) || 1); return;
      }
      const form = e.target.closest(`.line-form`); if (!form) return;
      e.preventDefault();
      close();
      repo.saveLine({ id: line.id, section: form.elements.section.value.trim(), note: form.elements.note.value.trim() });
      toast(`Saved`);
    });
    el.addEventListener(`click`, async (e) => {
      const srcs = el._srcs; const name = el._name; const cur = el._cur;
      const off = e.target.closest(`[data-off]`);
      if (off) { // mark one item "not for this event" (or use it again)
        const list = srcs.map((s2, i) => (i === Number(off.dataset.off) ? { ...s2, off: s2.off ? undefined : 1 } : s2)).map(({ off: o, ...rest }) => (o ? { ...rest, off: 1 } : rest));
        repo.setSources(cur, list); draw(); return;
      }
      const bq = e.target.closest(`[data-bring]`);
      if (bq) { assign(bq.dataset.bring, bq.dataset.email || ``, Number($(`.who-form [name=wq]`, el)?.value) || 1); return; }
      const ub = e.target.closest(`[data-unbring]`);
      if (ub) { const list = shares(cur); list.splice(Number(ub.dataset.unbring), 1); repo.setBringers(cur, list); draw(); return; }
      const ns = e.target.closest(`[data-needstep]`);
      if (ns) { repo.saveLine({ id: cur.id, qty: Math.max(1, (Number(cur.qty) || 1) + Number(ns.dataset.needstep)) }); draw(); return; }
      const ws = e.target.closest(`[data-wstep]`);
      if (ws) { const list = shares(cur); const b = list[Number(ws.dataset.wstep)]; b.qty = Math.max(1, b.qty + Number(ws.dataset.d)); repo.setBringers(cur, list); draw(); return; }
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

/** Home screen: everything the signed-in person is bringing, per upcoming event (soonest first). */
export function myJobsHtml() {
  const repo = R(); const me = String(repo.user?.email || ``).toLowerCase(); if (!me) return ``;
  const blocks = [];
  // tasks given to me in inventories I can open (when I can't open the group's events)
  const seenEv = new Set(repo.liveEvents().map((e) => e.id));
  const k = known(); const today = ctx.todayStr();
  const mine = [];
  for (const [inv, list] of [[repo.hereId, repo.tasks], ...Object.keys(k.inv).filter((id) => id !== repo.hereId).map((id) => [id, xlocal(id)?.tasks || []])]) {
    for (const t of list || []) if (!t.deleted && String(t.email).toLowerCase() === me && !seenEv.has(t.eventId) && (!t.eventDate || String(t.eventDate) >= today)) mine.push({ ...t, inv });
  }
  const byEv = new Map(); for (const t of mine) { if (!byEv.has(t.eventId)) byEv.set(t.eventId, []); byEv.get(t.eventId).push(t); }
  for (const ts of [...byEv.values()].sort((a, b) => String(a[0].eventDate || `9999`).localeCompare(String(b[0].eventDate || `9999`)))) {
    const w = whenText(ts[0].eventDate);
    blocks.push(`<div class="job-card">
      <div class="jc-head"><b>${esc(ts[0].eventName)}</b><span>${esc(w.rel || w.main)}</span></div>
      <ul>${ts.map((t) => `<li class="${t.done ? `ok` : ``}"><b>${esc(t.name)}${Number(t.qty) > 1 ? ` ×${esc(t.qty)}` : ``}</b>${t.todo ? `<small>${esc(t.todo)}</small>` : ``}
        <button type="button" class="btn small ${t.done ? `text` : `ghost`} job-done" data-taskdone="${esc(t.inv)}|${esc(t.id)}">${t.done ? `${icon(`check`)} Done` : `Mark done`}</button></li>`).join(``)}</ul></div>`);
  }
  for (const ev of splitEvents().upcoming) {
    const p = peopleLists(ev).find((x) => x.email === me); if (!p) continue;
    freshen(otherInvs(ev));
    const w = whenText(ev.date);
    blocks.push(`<a class="job-card" href="#/event/${esc(ev.id)}">
      <div class="jc-head"><b>${esc(ev.name)}</b><span>${esc(w.rel || w.main)}</span></div>
      <ul>${p.rows.map((r) => `<li class="${r.ready ? `ok` : ``}"><b>${esc(r.name)}${r.qty > 1 ? ` ×${r.qty}` : ``}</b>${r.todo ? `<small>${esc(r.todo)}</small>` : ``}</li>`).join(``)}</ul></a>`);
  }
  return blocks.length ? `<section class="dash"><div class="dash-head"><h2>You’re bringing</h2><a class="link small" href="#/events">All events</a></div>
    <div class="cards">${blocks.join(``)}</div></section>` : ``;
}

/** Home screen: someone without group access marks their task done (or not). */
export function toggleTaskDone(key) {
  const repo = R(); const [inv, id] = key.split(`|`);
  const list = inv === repo.hereId ? repo.tasks : xlocal(inv)?.tasks || [];
  const t = list.find((x) => x.id === id); if (!t) return;
  const done = t.done ? `` : new Date().toISOString();
  repo.saveTask(inv, { id, done });
  if (inv !== repo.hereId) t.done = done; // the phone's copy of that inventory
  toast(done ? `Marked done: ${t.name}` : `Not done: ${t.name}`);
}

/** The signed-in person's part: what they're bringing to this event and what to do for each. */
function mineCard(ev) {
  const me = String(R().user?.email || ``).toLowerCase(); if (!me) return ``;
  const p = peopleLists(ev).find((x) => x.email === me); if (!p) return ``;
  return `<section class="mine-card"><div class="mc-head">${icon(`users`)}<b>You’re bringing</b></div>
    <ul>${p.rows.map((r) => `<li><b>${esc(r.name)}${r.qty > 1 ? ` ×${r.qty}` : ``}</b>${r.todo ? `<small>${esc(r.todo)}</small>` : ``}</li>`).join(``)}</ul></section>`;
}

/** Who's bringing a line: a row per person with their own count (− / +) and Google account, then a row to add someone. */
function whoBlock(line, canEdit) {
  const repo = R(); const sh = shares(line); const need = Number(line.qty) || 1;
  const assigned = sh.reduce((n, b) => n + b.qty, 0); const left = need - assigned;
  const accounts = repo.accounts(); const me = String(repo.user?.email || ``).toLowerCase();
  const sum = !sh.length ? `` : left > 0 ? `${assigned} of ${need} assigned · <b>${left} left</b>` : left < 0 ? `${assigned} assigned · ${-left} more than needed` : `All ${need} assigned`;
  const acctLabel = (email) => (email === me ? `you` : email);
  if (!canEdit) {
    return sh.length ? `<div class="who-rows">${sh.map((b) => `<div class="who-row"><span class="who-name">${icon(`users`)} <b>${esc(b.name)}</b>${b.email ? `<small>${esc(acctLabel(b.email))}</small>` : ``}</span><span class="who-n">${need > 1 ? `×${b.qty}` : ``}</span></div>`).join(``)}</div>
      ${need > 1 ? `<p class="who-sum">${sum}</p>` : ``}` : `<p class="fine">Nobody yet.</p>`;
  }
  const taken = new Set(sh.map((b) => b.name.toLowerCase())); const takenEmail = new Set(sh.map((b) => b.email).filter(Boolean));
  const names = repo.bringerNames(inventoryOnlyPeople());
  const quick = names.filter((n) => !taken.has(n.name.toLowerCase()) && !(n.email && takenEmail.has(n.email))).slice(0, 10);
  const start = Math.max(1, left > 0 ? left : need > 1 ? 1 : 1);
  const rows = sh.map((b, i) => `<div class="who-row">
      <span class="who-name">${icon(b.email ? `check` : `users`)} <b>${esc(b.name)}</b>
        ${b.email ? `<small>${esc(acctLabel(b.email))}${(() => { const a = accessMap().get(b.email); return a && !a.group && a.invs.length ? ` · ${esc(a.invs.map(invNameOf).join(`, `))} only` : ``; })()}${taskDone(line.id, b.email) ? ` · <b class="done-mark">✓ done</b>` : ``}</small>` : ``}</span>
      ${need > 1 || sh.length > 1 ? `<span class="stepper sm"><button type="button" class="icon-btn" data-wstep="${i}" data-d="-1" aria-label="Fewer">−</button><input type="number" min="1" inputmode="numeric" value="${b.qty}" data-wq="${i}" aria-label="How many ${esc(b.name)} brings"><button type="button" class="icon-btn" data-wstep="${i}" data-d="1" aria-label="More">+</button></span>` : ``}
      <button type="button" class="icon-btn un" data-unbring="${i}" aria-label="Remove ${esc(b.name)}">${icon(`x`)}</button>
    </div>`).join(``);
  const needRow = `<div class="need-row"><span>How many needed</span>
      <span class="stepper sm"><button type="button" class="icon-btn" data-needstep="-1" aria-label="One fewer">−</button><input type="number" min="1" inputmode="numeric" value="${need}" data-need aria-label="How many needed"><button type="button" class="icon-btn" data-needstep="1" aria-label="One more">+</button></span></div>`;
  return `${needRow}${sh.length ? `<div class="who-rows">${rows}</div>${need > 1 ? `<p class="who-sum">${sum}</p>` : ``}` : ``}
    ${`<form class="inline-new who-form">
      <input name="who" list="ev-people" placeholder="${sh.length ? `Someone else` : `Name or email`}" autocomplete="off" enterkeyhint="done">
      ${need > 1 ? `<input name="wq" type="number" min="1" inputmode="numeric" value="${start}" class="who-qty" aria-label="How many they bring">` : `<input name="wq" type="hidden" value="1">`}
      <button class="btn primary">Add</button></form>
    <datalist id="ev-people">${names.map((n) => `<option value="${esc(n.name)}">${esc(n.email || ``)}</option>`).join(``)}</datalist>
    ${quick.length ? `<div class="chips who-quick">${quick.map((n) => `<button type="button" class="chip" data-bring="${esc(n.name)}" data-email="${esc(n.email || ``)}">${icon(n.email ? `check` : `plus`)} ${esc(n.email === me ? `Me` : n.name)}${n.only ? ` <small>(${esc(n.only)} only)</small>` : ``}</button>`).join(``)}</div>` : ``}
    <p class="fine">${need > 1 ? `Set how many first, then tap a name or type one. ` : ``}${accounts.length ? `✓ = has access: they see what they’re bringing on their home screen${repo.group() ? ` (people with only one inventory see just their tasks, not the event)` : ``}. Anyone else gets their list by message.` : `They get their list by message (Share).`}</p>`}`;
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
      <button data-m="copy">${icon(`calendar`)} Copy for next time</button>
      ${repo.linesOf(ev.id).some((l) => repo.sourcesOf(l).some((y) => !y.off)) ? `<button data-m="reserve">${icon(`clock`)} Reserve its items</button>` : ``}
      ${secs.length ? `<button data-m="sections">${icon(`sheet`)} Rename a section</button>` : ``}
      <button data-m="delete" class="danger">${icon(`trash`)} Delete event</button></div>
      <p class="fine">Deleting the event only removes its list${ev._g ? ` for everyone in the group` : ``}. Nothing in any inventory changes.</p>`;
    el.onclick = async (e) => {
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `edit`) { const f = await eventForm(ev); if (f) { repo.saveEvent(f); toast(`Saved`); } }
      if (m === `sections`) renameSectionSheet(ev, secs);
      if (m === `copy`) copyFlow(ev);
      if (m === `reserve`) reserveForEvent(ev);
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
    const who = bringersText(l); const lineId = l.id;
    const parts = x.parts || [];
    const ready = parts.filter((p) => p.key === `ready`).reduce((n, p) => n + p.have, 0);
    let gap = need - ready;
    let unsure = false;
    for (const p of parts) {
      const inv = ev._g && p.invId !== repo.hereId ? invNameOf(p.invId) : ``;
      if (p.key === `out`) { g.back.push({ name, qty: p.have, detail: `${p.reserved ? `reserved for` : `with`} ${p.who || `someone`}${inv ? ` (${inv})` : ``}`, section, who, lineId }); gap -= p.have; }
      else if (p.key === `missing`) { g.find.push({ name, qty: p.have, detail: `marked missing${p.where || inv ? `, last in ${withInv(inv, p.where || ``)}` : ``}`, section, who, lineId }); gap -= p.have; }
      else if (p.key === `unknown`) { g.check.push({ name, qty: 0, detail: `in ${invNameOf(p.invId)}, not checked on this phone`, section, who, lineId }); unsure = true; }
    }
    if (!unsure && gap > 0) {
      const have = ready ? `have ${ready} of ${need}` : parts.length ? `none ready` : `not in any inventory`;
      const bs = repo.bringersOf(l);
      const covered = bs.some((b) => !b.qty) || bs.reduce((n, b) => n + b.qty, 0) >= gap;
      g.buy.push({ name, qty: gap, more: Boolean(ready), detail: have, section, who, lineId, nobody: !bs.length, partly: bs.length && !covered });
    }
  }
  const groups = [
    { key: `buy`, title: `To buy or borrow`, items: g.buy },
    { key: `back`, title: `To get back`, items: g.back },
    { key: `find`, title: `To find`, items: g.find },
    { key: `check`, title: `To check`, items: g.check },
  ].filter((x) => x.items.length);
  const nobody = g.buy.filter((it) => it.nobody).length;
  return { groups, open, total: lines.length, nobody };
}

/**
 * Each person's list: everything assigned to them, with what to do (buy or borrow, or where to pick it up).
 * Returns [{ name, rows: [{ name, qty, todo, section, ready }] }], plus lines still needed that nobody is bringing.
 */
export function peopleLists(ev) {
  const repo = R(); const map = new Map();
  for (const l of repo.linesOf(ev.id)) {
    const bs = shares(l); if (!bs.length) continue;
    const x = lineState(l); const name = lineName(l, x);
    for (const b of bs) {
      const k = b.email || b.name.trim().toLowerCase(); // the same account is one person, whatever they were called
      if (!map.has(k)) map.set(k, { name: b.name.trim(), email: b.email || ``, rows: [] });
      map.get(k).rows.push({ name, qty: b.qty, todo: todoText(ev, l, x), section: l.section || ``, ready: x.key === `ready` });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What bringing a line involves: "from School › Stage closet", "get it back from Ravi", "buy or borrow 4 more". */
function todoText(ev, l, x) {
  const parts = x.parts || []; const need = Number(l.qty) || 1; const bits = [];
  const here = (p) => (ev._g && p.invId !== R().hereId ? invNameOf(p.invId) : ``);
  const ready = parts.filter((p) => p.key === `ready`);
  if (ready.length) bits.push(`from ${ready.map((p) => withInv(here(p), p.where || ``) || `where it’s kept`).join(` + `)}`);
  for (const p of parts) {
    if (p.key === `out`) bits.push(`get it back from ${p.who || `whoever has it`}`);
    else if (p.key === `missing`) bits.push(`find it (marked missing)`);
    else if (p.key === `unknown`) bits.push(`from ${invNameOf(p.invId)}`);
  }
  const have = ready.reduce((n, p) => n + p.have, 0);
  if (!parts.length || (x.key === `none`)) bits.push(`buy or borrow`);
  else if (x.key === `short` && need > have) bits.push(`buy or borrow ${need - have} more`);
  return bits.join(` · `);
}

const neededLine = (it) => `${it.name}${it.qty > 1 || it.more ? ` ×${it.qty}${it.more ? ` more` : ``}` : ``}`;

function neededCard(ev) {
  const n = stillNeeded(ev);
  if (!n.total) return ``;
  if (!n.open) return `<section class="needed-card done">${icon(`check`)}<div><b>Everything on the list is ready</b><small>${n.total} item${n.total === 1 ? `` : `s`}, all in place.</small></div></section>`;
  return `<section class="needed-card">
    <div class="nc-head"><h2>Still needed</h2><span>${n.open} of ${n.total}</span></div>
    ${n.groups.map((g) => `<div class="nc-group nc-${g.key}"><div class="label-sm">${esc(g.title)}</div><ul>${g.items.map((it) => `<li data-line="${esc(it.lineId)}"><b>${esc(neededLine(it))}</b><small>${esc(it.detail)}</small>
        ${it.who ? `<small class="nc-who${it.partly ? ` partly` : ``}">${icon(`users`)} ${esc(it.who)}${it.partly ? ` · not all of it yet` : ``}</small>` : g.key === `buy` ? `<small class="nc-who nobody">${icon(`users`)} Nobody yet · tap to assign</small>` : ``}</li>`).join(``)}</ul></div>`).join(``)}
    ${peopleChips(ev)}
    <div class="row-actions left">
      <button type="button" class="btn primary" data-ev="needshare">${icon(`share`)} Share</button>
      <button type="button" class="btn ghost" data-ev="needprint">${icon(`print`)} Print</button>
    </div></section>`;
}

function peopleChips(ev) {
  const ppl = peopleLists(ev); if (!ppl.length) return ``;
  return `<div class="label-sm">Send each person their list</div><div class="chips nc-people">${ppl.map((p) => `<button type="button" class="chip" data-person-share="${esc(p.name)}">${icon(`share`)} ${esc(p.name)} <b>${p.rows.length}</b></button>`).join(``)}</div>`;
}

const header = (ev) => { const w = whenText(ev.date); return `${ev.name}${ev.date ? ` – ${w.main}` : ``}`; };

/** "Still needed" as text for WhatsApp or Messages. */
function shareNeeded(ev) {
  const n = stillNeeded(ev);
  const out = [header(ev), `Still needed: ${n.open} of ${n.total} on the list`, ``];
  for (const g of n.groups) {
    out.push(g.title.toUpperCase());
    for (const it of g.items) out.push(`• ${neededLine(it)} – ${it.detail}${it.who ? ` · ${it.who}` : g.key === `buy` ? ` · nobody yet` : ``}`);
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
    + n.groups.map((g) => `<h2>${esc(g.title)}</h2><table>${g.items.map((it) => `<tr><td class="box">☐</td><td><b>${esc(neededLine(it))}</b></td><td>${esc(it.detail)}</td><td>${esc(it.who || (g.key === `buy` ? `—` : ``))}</td><td class="sec">${esc(it.section)}</td></tr>`).join(``)}</table>`).join(``));
}

/** One person's list, as a message to them. */
function personText(ev, p, { reminder = false } = {}) {
  const first = p.name.split(/\s+/)[0];
  const w = whenText(ev.date);
  const out = reminder ? [`Reminder: ${ev.name} is ${w.rel === `today` || w.rel === `tomorrow` ? w.rel : `on ${w.main}${w.rel ? ` (${w.rel})` : ``}`}.`, ``, `${first}, here’s what you’re bringing:`, ``]
    : [header(ev), ``, `${first}, here’s what you’re bringing:`, ``];
  for (const r of p.rows) out.push(`• ${r.name}${r.qty > 1 ? ` ×${r.qty}` : ``}${r.todo ? ` – ${r.todo}` : ``}`);
  out.push(``, `Thank you!`, ``, ctx.shareSign);
  return out.join(`\n`);
}
const findPerson = (ev, name) => peopleLists(ev).find((x) => x.name.toLowerCase() === name.toLowerCase() || (x.email && x.email === name.toLowerCase()));
function sharePerson(ev, name, opts = {}) {
  const p = findPerson(ev, name); if (!p) return;
  return ctx.shareOut({ title: `${ev.name}: ${p.name}`, text: personText(ev, p, opts) });
}
/** Email their list straight to their Google account (opens the mail app). */
function emailPerson(ev, name, opts = {}) {
  const p = findPerson(ev, name); if (!p?.email) return;
  location.href = `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(`${opts.reminder ? `Reminder: ` : ``}${ev.name}: what you’re bringing`)}&body=${encodeURIComponent(personText(ev, p, opts))}`;
}

/** Everyone's lists on paper, one page per person, then what nobody is bringing yet. */
function printEveryone(ev) {
  const ppl = peopleLists(ev); const n = stillNeeded(ev);
  const nobody = (n.groups.find((g) => g.key === `buy`)?.items || []).filter((it) => it.nobody);
  const table = (rows) => `<table>${rows.map((r) => `<tr><td class="box">☐</td><td><b>${esc(r.name)}${r.qty > 1 ? ` ×${r.qty}` : ``}</b></td><td>${esc(r.todo || ``)}</td><td class="sec">${esc(r.section)}</td></tr>`).join(``)}</table>`;
  printPage(`${header(ev)}: who’s bringing what`, ppl.map((p) => `<div class="ps-person"><h2>${esc(p.name)}</h2>${table(p.rows)}</div>`).join(``)
    + (nobody.length ? `<div class="ps-person"><h2>Nobody assigned yet</h2>${table(nobody.map((it) => ({ name: it.name, qty: it.qty, todo: `buy or borrow`, section: it.section })))}</div>` : ``));
}

function printFull(ev) {
  printPage(header(ev), `<p class="ps-sub">${esc(summaryText(summaryOf(ev)))}</p>`
    + fullList(ev).map((g) => `<h2>${esc(g.label)}</h2><table>${g.rows.map((r) => `<tr><td class="box">☐</td><td><b>${esc(r.name)}${r.qty > 1 ? ` ×${r.qty}` : ``}</b>${r.note ? `<br><small>${esc(r.note)}</small>` : ``}</td>
        <td>${esc(r.where)}${r.parts.map((p) => `<br><small>${esc(p)}</small>`).join(``)}</td></tr>`).join(``)}</table>`).join(``));
}

function shareMenu(ev) {
  const n = stillNeeded(ev); const ppl = peopleLists(ev);
  sheet(`Share or print`, (el, close) => {
    el.innerHTML = `<div class="menu">
      <button data-s="full">${icon(`share`)} Share the full list</button>
      <button data-s="fullprint">${icon(`print`)} Print the full list</button>
      ${n.open ? `<button data-s="need">${icon(`share`)} Share what’s still needed <small>${n.open}</small></button>
      <button data-s="needprint">${icon(`print`)} Print what’s still needed</button>` : ``}
      ${ppl.length ? `<button data-s="people">${icon(`users`)} Send each person their list <small>${ppl.length}</small></button>
      <button data-s="peopleprint">${icon(`print`)} Print everyone’s lists</button>` : ``}
    </div><p class="fine">Shares as a message (WhatsApp, Messages, email). Printed lists have boxes to tick on the day.</p>`;
    el.onclick = (e) => {
      const k = e.target.closest(`[data-s]`)?.dataset.s; if (!k) return;
      close();
      setTimeout(() => ({ full: shareEvent, fullprint: printFull, need: shareNeeded, needprint: printNeeded, people: peopleSheet, peopleprint: printEveryone })[k](ev), 250); // after the sheet closes
    };
  });
}

/** Pick a person to send their list to (one message each). */
function peopleSheet(ev, opts = {}) {
  sheet(opts.reminder ? `Remind everyone` : `Send each person their list`, (el) => {
    const draw = () => {
      el.innerHTML = `<div class="person-list">${peopleLists(ev).map((p) => `<div class="pl-row">
          <div class="grow"><b>${esc(p.name)}</b><small>${esc(p.email ? `${p.email} · ` : ``)}${esc(p.rows.map((r) => r.name).join(`, `))}</small></div>
          <button type="button" class="btn small ghost" data-p="${esc(p.name)}">${icon(`share`)} Share</button>
          ${p.email ? `<button type="button" class="btn small ghost" data-mail="${esc(p.name)}">Email</button>` : ``}</div>`).join(``)}</div>
        <p class="fine">Share opens your share sheet (WhatsApp, Messages). Email goes to their Google account.</p>`;
    };
    el.onclick = (e) => {
      const b = e.target.closest(`[data-p]`); if (b) { b.classList.add(`sent`); sharePerson(ev, b.dataset.p, opts); return; }
      const m = e.target.closest(`[data-mail]`); if (m) { m.classList.add(`sent`); emailPerson(ev, m.dataset.mail, opts); }
    };
    draw();
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
  if (repo.afterOf(line)?.state === `kept-pending`) repo.setAfter(repo.eventLines.find((l) => l.id === line.id), { state: `kept` });
  return true;
}

/** An open Add sheet wants to show items that just arrived from another inventory. */
export function redrawOpenAddSheet() {
  const body = document.querySelector(`.sheet-wrap.open .sheet-body`);
  if (body?._redraw) body._redraw();
}
