// Events: graduation, Annual Day, Pongal, a camping trip. What's needed (in sections), where each thing is now,
// and who has it. Events live in the inventory's own sheet (Events + EventLines tabs) and sync like everything else.
import { esc, $, $$, toast, sheet, confirmSheet, icon } from './ui.js';
import { search } from './search.js';

let ctx = null; // { repo(), thumbHtml(item, cls), goBack(fallback), shareOut({title,text}), shareSign, todayStr() }
export function initEvents(c) { ctx = c; }
const R = () => ctx.repo();

const SUGGESTED_SECTIONS = [`Stage`, `Decor`, `AV`, `Food`, `Supplies`];
const STATE_LABEL = { ready: `Ready`, short: `Short`, out: `With someone`, missing: `Missing`, none: `Not in inventory` };
const STATE_ORDER = [`ready`, `short`, `out`, `missing`, `none`];

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
  return bits.join(` · `);
}
function readyBar(s) {
  if (!s.total) return `<div class="ready-bar empty"></div>`;
  return `<div class="ready-bar" role="img" aria-label="${esc(summaryText(s))}">${STATE_ORDER.filter((k) => s[k]).map((k) => `<i class="st-${k}" style="flex:${s[k]}"></i>`).join(``)}</div>`;
}

/** Card used on the Events list and the Find dashboard. */
export function eventCard(ev) {
  const w = whenText(ev.date); const s = R().eventSummary(ev.id);
  return `<a class="event-card${w.past ? ` past` : ``}" href="#/event/${esc(ev.id)}">
    <div class="ev-date">${w.day ? `<b>${esc(w.day)}</b><span>${esc(w.month)}</span>` : icon(`calendar`)}</div>
    <div class="ev-main"><b>${esc(ev.name)}</b>
      <small>${esc(w.main)}${w.rel ? ` · ${esc(w.rel)}` : ``}</small>
      ${readyBar(s)}
      <small class="ev-sum">${esc(summaryText(s))}</small></div>
    ${icon(`chevron`)}</a>`;
}

// ------------------------------------------------------------ Events list
export function viewEvents(view) {
  const { upcoming, past } = splitEvents();
  view.innerHTML = `<div class="events">
    <div class="more-head"><a class="back" href="#/more">${icon(`back`)} More</a></div>
    <div class="page-head"><h1>Events</h1><button type="button" class="btn primary small edit-only" data-ev="new">${icon(`plus`)} New event</button></div>
    <p class="muted small">List what an event needs, see where each thing is right now and who has it.</p>
    ${upcoming.length ? `<div class="label-sm">Coming up</div><div class="cards">${upcoming.map(eventCard).join(``)}</div>`
      : `<div class="empty">${icon(`calendar`, `big`)}<h3>No events yet</h3>
        <p>Graduation, Annual Day, Pongal, a camping trip: anything you gather the same things for.</p>
        <button type="button" class="btn primary edit-only" data-ev="new">${icon(`plus`)} New event</button></div>`}
    ${past.length ? `<div class="label-sm">Past</div><div class="cards">${past.map(eventCard).join(``)}</div>` : ``}
  </div>`;
  view.onclick = async (e) => {
    if (e.target.closest(`[data-ev="new"]`)) {
      const f = await eventForm(); if (!f) return;
      const ev = R().saveEvent(f); if (!ev) return;
      location.hash = `#/event/${ev.id}`;
    }
  };
}

/** Name, date, notes. Resolves the fields, or null. */
function eventForm(ev = null) {
  return new Promise((resolve) => {
    let answered = false;
    sheet(ev ? `Edit event` : `New event`, (el, close) => {
      el.innerHTML = `<form class="stack">
        <label class="field"><span>Name</span><input name="name" required value="${esc(ev?.name || ``)}" placeholder="e.g. Graduation ceremony, Pongal, Camping trip"></label>
        <label class="field"><span>Date <small>(optional)</small></span><input name="date" type="date" value="${esc(ev?.date || ``)}"></label>
        <label class="field"><span>Notes <small>(optional)</small></span><input name="notes" value="${esc(ev?.notes || ``)}" placeholder="e.g. School gym, about 200 people"></label>
        <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn primary">${ev ? `Save` : `Create`}</button></div></form>`;
      const f = $(`form`, el);
      if (!ev) setTimeout(() => f.elements.name.focus(), 250);
      $(`[data-no]`, el).onclick = () => { answered = true; resolve(null); close(); };
      f.onsubmit = (e) => {
        e.preventDefault(); answered = true;
        resolve({ ...(ev ? { id: ev.id } : {}), name: f.elements.name.value.trim(), date: f.elements.date.value, notes: f.elements.notes.value.trim() });
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
  const st = evView[ev.id] ||= { by: `section`, filter: `` };
  const lines = repo.linesOf(ev.id);
  const s = repo.eventSummary(ev.id);
  if (st.filter && !s[st.filter]) st.filter = ``;
  const w = whenText(ev.date);
  const shown = lines.map((l) => ({ l, x: repo.lineState(l) })).filter(({ x }) => !st.filter || x.key === st.filter);

  const groups = st.by === `place` ? byPlace(shown) : bySection(shown, repo.sectionsOf(ev.id));
  view.innerHTML = `<div class="detail event">
    <div class="detail-top">
      <button type="button" class="back" data-a="back">${icon(`back`)} Back</button>
      <div class="detail-tools">
        <button type="button" class="icon-btn" data-ev="share" aria-label="Share the list">${icon(`share`)}</button>
        <button type="button" class="icon-btn edit-only" data-ev="menu" aria-label="More actions">${icon(`more`)}</button>
      </div>
    </div>
    <h1>${esc(ev.name)}</h1>
    <p class="ev-when">${icon(`calendar`)}<span>${esc(w.main)}${w.rel ? ` · ${esc(w.rel)}` : ``}</span></p>
    ${ev.notes ? `<p class="muted">${esc(ev.notes)}</p>` : ``}
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
      ${groups.map((g) => `<section class="ev-group">
        <div class="ev-ghead"><h2>${esc(g.label)}</h2><span>${esc(g.sub)}</span>
          ${g.section !== undefined ? `<button type="button" class="icon-btn edit-only" data-addto="${esc(g.section)}" aria-label="Add to ${esc(g.label)}">${icon(`plus`)}</button>` : ``}</div>
        <div class="elines">${g.rows.map(({ l, x }) => lineRow(l, x, st.by === `place` ? (l.section || ``) : ``)).join(``)}</div>
      </section>`).join(``) || `<p class="muted pad">Nothing ${esc((STATE_LABEL[st.filter] || ``).toLowerCase())} right now.</p>`}
      <div class="row-actions left edit-only"><button type="button" class="btn ghost" data-ev="add">${icon(`plus`)} Add items</button></div>`
      : `<div class="empty">${icon(`box`, `big`)}<h3>What does ${esc(ev.name)} need?</h3>
        <p>Add things from your inventory, grouped in sections like Stage, Decor or Food. Things you don’t have logged yet can go on the list too.</p>
        <button type="button" class="btn primary edit-only" data-ev="add">${icon(`plus`)} Add items</button></div>`}
  </div>`;

  view.onclick = async (e) => {
    const t = e.target;
    if (t.closest(`[data-a="back"]`)) return ctx.goBack(`#/events`);
    const f = t.closest(`[data-filter]`); if (f) { st.filter = f.dataset.filter; return viewEvent(view, r); }
    const by = t.closest(`[data-by]`); if (by) { st.by = by.dataset.by; return viewEvent(view, r); }
    const add = t.closest(`[data-addto]`); if (add) return addItemsSheet(ev, add.dataset.addto);
    const ln = t.closest(`[data-line]`); if (ln) { const line = repo.eventLines.find((x) => x.id === ln.dataset.line); if (line) lineSheet(ev, line); return; }
    const a = t.closest(`[data-ev]`)?.dataset.ev; if (!a) return;
    if (a === `add`) return addItemsSheet(ev, ``);
    if (a === `share`) return shareEvent(ev);
    if (a === `menu`) return eventMenu(ev);
  };
}

function lineRow(l, x, sectionNote) {
  const name = x.item?.name || l.name || `Unnamed`;
  const pic = x.item ? ctx.thumbHtml(x.item, `thumb sm`) : `<div class="thumb sm ph">${icon(`plus`)}</div>`;
  const state = sectionNote && (x.key === `ready` || x.key === `short`) ? (x.key === `short` ? x.text.split(` · `)[0] : ``) : x.text;
  const sub = [state, sectionNote].filter(Boolean).join(` · `);
  return `<button type="button" class="eline st-${x.key}" data-line="${esc(l.id)}">
    ${pic}
    <span class="el-main"><b>${esc(name)}${Number(l.qty) > 1 ? ` <span class="qty">×${esc(l.qty)}</span>` : ``}</b>
      <small class="el-state">${esc(sub || STATE_LABEL[x.key])}</small>
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

/** Group by where to go and get each thing: its place, the person who has it, or what still needs sorting out. */
function byPlace(rows) {
  const repo = R(); const map = new Map();
  const put = (key, label, sort, row) => { if (!map.has(key)) map.set(key, { label, sort, rows: [] }); map.get(key).rows.push(row); };
  for (const row of rows) {
    const { x } = row;
    if (x.key === `ready` || x.key === `short`) {
      const parts = repo.pathOf(x.item.locationId);
      put(`p:${x.item.locationId}`, parts.map((p) => p.name).join(` › `) || `Place not set`, `0${parts.map((p) => p.name).join(` › `) || `~`}`, row);
    } else if (x.key === `out`) put(`o:${String(x.who || ``).toLowerCase()}`, `${x.text.startsWith(`Reserved`) ? `Reserved for` : `With`} ${x.who || `someone`}`, `1${x.who}`, row);
    else if (x.key === `missing`) put(`m`, `Missing`, `2`, row);
    else put(`n`, `Not in inventory yet`, `3`, row);
  }
  return [...map.values()].sort((a, b) => a.sort.localeCompare(b.sort)).map((g) => ({ ...g, sub: `${g.rows.length} item${g.rows.length === 1 ? `` : `s`}` }));
}

// ------------------------------------------------------------ Add items to an event
function addItemsSheet(ev, startSection) {
  const repo = R();
  const sections = repo.sectionsOf(ev.id).filter(Boolean);
  let section = startSection || sections[sections.length - 1] || ``;
  const extra = new Set(section && !sections.includes(section) ? [section] : []); // sections typed in this sheet
  const chosen = new Set(); const named = []; // inventory items; free-text things not in the inventory yet
  const already = new Set(repo.linesOf(ev.id).map((l) => l.itemId).filter(Boolean));
  sheet(`Add to ${ev.name}`, (el, close) => {
    el.innerHTML = `<div class="label-sm first">Section</div><div class="chips sec-chips"></div>
      <label class="search sm">${icon(`search`)}<input data-q type="search" placeholder="Search your items, or type something new" autocomplete="off" enterkeyhint="search"></label>
      <div class="named"></div>
      <div class="bring-list"></div>
      <div class="row-actions sticky-actions"><button type="button" class="btn primary full" data-go disabled>Pick items</button></div>`;
    const qEl = $(`[data-q]`, el); const listEl = $(`.bring-list`, el); const go = $(`[data-go]`, el);
    const secEl = $(`.sec-chips`, el); const namedEl = $(`.named`, el);
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
      const pool = repo.activeItems();
      const q = qEl.value.trim();
      const list = q ? search(pool, q, (id) => repo.pathText(id)) : [...pool].sort((a, b) => a.name.localeCompare(b.name));
      const newRow = q && !named.some((t) => t.toLowerCase() === q.toLowerCase())
        ? `<button type="button" class="bring-row new-need" data-name="${esc(q)}">${icon(`plus`)}<div><b>Add “${esc(q)}”</b><small>Not in the inventory yet, but needed</small></div></button>` : ``;
      listEl.innerHTML = newRow + (list.slice(0, 80).map((i) => {
        const on = already.has(i.id);
        return `<label class="bring-row${on ? ` done` : ``}">
          <input type="checkbox" data-id="${esc(i.id)}" ${chosen.has(i.id) ? `checked` : ``} ${on ? `disabled` : ``}>
          ${ctx.thumbHtml(i, `thumb sm`)}
          <div><b>${esc(i.name)}${Number(i.qty) > 1 ? ` <span class="qty">×${esc(i.qty)}</span>` : ``}</b><small>${on ? `Already on the list` : esc(repo.pathText(i.locationId) || `No location`)}${!on && i.status === `lent` ? ` · with ${esc(i.lentTo)}` : ``}</small></div>
        </label>`;
      }).join(``) || (q ? `` : `<p class="muted pad">Your inventory is empty. Type what’s needed above.</p>`));
      upd();
    };
    secEl.addEventListener(`click`, async (e) => {
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
    listEl.addEventListener(`change`, (e) => { const id = e.target.dataset.id; if (!id) return; if (e.target.checked) chosen.add(id); else chosen.delete(id); upd(); });
    qEl.addEventListener(`input`, draw);
    qEl.addEventListener(`keydown`, (e) => { // Enter on a new name adds it to the list
      if (e.key !== `Enter`) return; e.preventDefault();
      const q = qEl.value.trim(); if (!q) return;
      const hits = search(repo.activeItems(), q, (id) => repo.pathText(id));
      if (!hits.length) { named.push(q); qEl.value = ``; draw(); }
    });
    go.onclick = () => {
      const entries = [...[...chosen].map((itemId) => ({ itemId })), ...named.map((name) => ({ name }))];
      close(); // first, so the event page redraws with the new lines
      const added = repo.addLines(ev.id, section, entries);
      if (added.length) toast(`Added ${added.length} to ${section || ev.name}`);
    };
    drawSections(); draw();
  });
}

// ------------------------------------------------------------ One line: quantity, note, section, link, remove
function lineSheet(ev, line) {
  const repo = R();
  const x = repo.lineState(line);
  const name = x.item?.name || line.name || `Item`;
  const canEdit = !repo.readOnly;
  sheet(name, (el, close) => {
    const sections = [...new Set([...repo.sectionsOf(ev.id).filter(Boolean)])];
    el.innerHTML = `<div class="el-banner st-${x.key}"><span class="el-dot"></span><div>${x.key === `none` ? `<b>${esc(x.text)}</b>` : `<b>${esc(STATE_LABEL[x.key])}</b><small>${esc(x.text)}</small>`}</div></div>
      ${canEdit ? `<form class="stack line-form">
        <div class="two">
          <label class="field"><span>How many needed</span><input name="qty" type="number" min="1" inputmode="numeric" value="${esc(line.qty || 1)}"></label>
          <label class="field"><span>Section</span><input name="section" list="ev-secs" value="${esc(line.section || ``)}" placeholder="No section"></label>
        </div>
        <datalist id="ev-secs">${sections.map((s) => `<option value="${esc(s)}">`).join(``)}</datalist>
        <label class="field"><span>Note <small>(optional)</small></span><input name="note" value="${esc(line.note || ``)}" placeholder="e.g. the tall one, check batteries"></label>
        <div class="row-actions"><button class="btn primary">Save</button></div></form>` : (line.note ? `<p class="muted">${esc(line.note)}</p>` : ``)}
      <div class="menu">
        ${x.item ? `<button data-l="open">${icon(`box`)} Open ${esc(x.item.name)}</button>` : ``}
        ${canEdit && !x.item ? `<button data-l="add">${icon(`plus`)} Add “${esc(name)}” to the inventory</button>` : ``}
        ${canEdit ? `<button data-l="link">${icon(`search`)} ${x.item ? `Use a different item` : `It’s already in the inventory`}</button>` : ``}
        ${canEdit ? `<button data-l="remove" class="danger">${icon(`trash`)} Remove from ${esc(ev.name)}</button>` : ``}
      </div>`;
    const form = $(`.line-form`, el);
    if (form) form.onsubmit = (e) => {
      e.preventDefault();
      repo.saveLine({ id: line.id, qty: Math.max(1, Number(form.elements.qty.value) || 1), section: form.elements.section.value.trim(), note: form.elements.note.value.trim() });
      close(); toast(`Saved`);
    };
    el.addEventListener(`click`, async (e) => {
      const a = e.target.closest(`[data-l]`)?.dataset.l; if (!a) return;
      if (a === `open`) { close(); location.hash = `#/item/${x.item.id}`; return; }
      if (a === `add`) { close(); location.hash = `#/add?name=${encodeURIComponent(name)}&eline=${encodeURIComponent(line.id)}`; return; }
      if (a === `link`) {
        close();
        const id = await pickItem(`Which item is “${name}”?`, line.name || x.item?.name || ``);
        if (id) { repo.saveLine({ id: line.id, itemId: id }); toast(`Linked to ${repo.items.find((i) => i.id === id)?.name || `item`}`); }
        return;
      }
      if (a === `remove`) {
        close();
        repo.deleteLine(line);
        toast(`Removed ${name}`, { action: `Undo`, ms: 6000, onAction: () => repo.saveLine({ id: line.id, deleted: `` }) });
      }
    });
  });
}

/** Pick one inventory item. Resolves its id, or null. */
function pickItem(title, query = ``) {
  const repo = R();
  return new Promise((resolve) => {
    let done = false;
    sheet(title, (el, close) => {
      el.innerHTML = `<label class="search sm">${icon(`search`)}<input data-q type="search" value="${esc(query)}" placeholder="Search your items" autocomplete="off" enterkeyhint="search"></label><div class="bring-list"></div>`;
      const qEl = $(`[data-q]`, el); const listEl = $(`.bring-list`, el);
      const draw = () => {
        const q = qEl.value.trim(); const pool = repo.activeItems();
        const list = q ? search(pool, q, (id) => repo.pathText(id)) : [...pool].sort((a, b) => a.name.localeCompare(b.name));
        listEl.innerHTML = list.slice(0, 60).map((i) => `<button type="button" class="bring-row" data-pick="${esc(i.id)}">${ctx.thumbHtml(i, `thumb sm`)}
          <div><b>${esc(i.name)}</b><small>${esc(repo.pathText(i.locationId) || `No location`)}</small></div></button>`).join(``)
          || `<p class="muted pad">${q ? `Nothing matches “${esc(q)}”.` : `Your inventory is empty.`}</p>`;
      };
      qEl.addEventListener(`input`, draw);
      listEl.addEventListener(`click`, (e) => { const b = e.target.closest(`[data-pick]`); if (b) { done = true; resolve(b.dataset.pick); close(); } });
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
      <p class="fine">Deleting the event only removes its list. Nothing in the inventory changes.</p>`;
    el.onclick = async (e) => {
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `edit`) { const f = await eventForm(ev); if (f) { repo.saveEvent(f); toast(`Saved`); } }
      if (m === `sections`) renameSectionSheet(ev, secs);
      if (m === `delete` && await confirmSheet(`Delete ${ev.name}?`, `Its list of ${repo.linesOf(ev.id).length} item(s) goes too. Nothing in the inventory changes.`, `Delete`, true)) {
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
        if (to && to !== from) { repo.renameSection(ev.id, from, to); toast(`Renamed to ${to}`); }
        close();
      };
    };
  });
}

/** The list as text for WhatsApp or email: section by section, with where each thing is. */
function shareEvent(ev) {
  const repo = R(); const w = whenText(ev.date); const s = repo.eventSummary(ev.id);
  const mark = { ready: `✓`, short: `!`, out: `→`, missing: `✗`, none: `○` };
  const out = [`${ev.name}${ev.date ? ` – ${w.main}` : ``}`, summaryText(s), ``];
  for (const g of bySection(repo.linesOf(ev.id).map((l) => ({ l, x: repo.lineState(l) })), repo.sectionsOf(ev.id))) {
    out.push(g.label.toUpperCase());
    for (const { l, x } of g.rows) out.push(`${mark[x.key]} ${x.item?.name || l.name}${Number(l.qty) > 1 ? ` ×${l.qty}` : ``} – ${x.text}${l.note ? ` (${l.note})` : ``}`);
    out.push(``);
  }
  out.push(ctx.shareSign);
  return ctx.shareOut({ title: ev.name, text: out.join(`\n`) });
}

/** Item page: the upcoming events that need this item. */
export function neededForHtml(item) {
  const evs = R().eventsForItem(item.id); if (!evs.length) return ``;
  return `<div class="block needed-for"><div class="label-sm">Needed for</div><div class="chips">${evs.map((e) => {
    const w = whenText(e.date);
    return `<a class="chip ev-chip" href="#/event/${esc(e.id)}">${icon(`calendar`)} ${esc(e.name)}${w.rel ? ` · ${esc(w.rel)}` : ``}</a>`;
  }).join(``)}</div></div>`;
}

/** After "Add to the inventory" from an event line: point the line at the new item. */
export function linkLineToItem(lineId, itemId) {
  const repo = R();
  const line = repo.eventLines.find((l) => l.id === lineId && !l.deleted);
  if (!line || !itemId) return false;
  repo.saveLine({ id: line.id, itemId });
  return true;
}
