import { CONFIG } from './config.js';
import { googleConfigured, pickerConfigured, signIn, signOut, hasValidToken, tokenTimeLeft, pickSpreadsheet, AuthError } from './google.js';
import { Repo } from './store.js';
import { search, findDuplicates } from './search.js';
import { processPhoto, cropItem } from './image.js';
import { aiReady, aiSettings, saveAiSettings, disableAi, analyzePhoto, verifyKey, aiUsageToday, AiError } from './ai.js';
import { esc, $, $$, toast, sheet, confirmSheet, promptSheet, icon, timeAgo } from './ui.js';

const MODE_KEY = `stash.mode`;
const RECENT_LOC_KEY = `stash.recentLocs`;
let repo = null;
let findState = { q: ``, filter: `` };

const app = $(`#app`);
const KIND_ICON = { place: `home`, room: `room`, container: `box` };
const STATUS_LABEL = { lent: `Lent out`, missing: `Missing`, reserved: `Saved for`, home: `` };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, `0`)}-${String(d.getDate()).padStart(2, `0`)}`; };
const isoDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, `0`)}-${String(d.getDate()).padStart(2, `0`)}`; };
/** "by Fri, Oct 16", "today", "2 days late" for a YYYY-MM-DD pick-up date. */
function dueText(due) {
  if (!due) return { text: ``, late: false };
  const days = Math.round((new Date(`${due}T00:00`) - new Date(`${todayStr()}T00:00`)) / 86400000);
  if (days < 0) return { text: `${-days} day${days === -1 ? `` : `s`} late`, late: true };
  if (days === 0) return { text: `pick up today`, late: false };
  if (days === 1) return { text: `pick up tomorrow`, late: false };
  return { text: `pick up by ${new Date(`${due}T00:00`).toLocaleDateString(undefined, { weekday: `short`, month: `short`, day: `numeric` })}`, late: false };
}

// ============================================================ boot
async function boot() {
  if (`serviceWorker` in navigator && location.protocol !== `file:`) navigator.serviceWorker.register(`./sw.js`).catch(() => {});
  window.addEventListener(`hashchange`, () => { if (sel.on) selStop(); render(); });
  installSelectionGestures();
  window.addEventListener(`online`, () => repo?.refresh());
  document.addEventListener(`visibilitychange`, () => { if (!document.hidden) repo?.refresh(); });

  const mode = localStorage.getItem(MODE_KEY);
  if (mode === `demo`) return start(`demo`);
  if (mode === `google` && googleConfigured()) {
    if (resumeGoogle()) return;            // open instantly from the phone's copy, sync when Google says OK
    if (hasValidToken()) return start(`google`);
    return renderReconnect();
  }
  renderWelcome();
}

async function start(kind, { interactive = false, choice } = {}) {
  try {
    if (kind === `google` && (interactive || !hasValidToken())) await signIn();
    renderLoading(kind === `google` ? `Opening your inventory…` : `Loading…`);
    repo = new Repo(kind);
    const info = await repo.connect(choice);
    if (info.needsChoice) return renderChoice(info.user);
    localStorage.setItem(MODE_KEY, kind);
    repo.addEventListener(`change`, onRepoChange);
    repo.addEventListener(`status`, renderStatus);
    renderShell();
    render();
    if (kind === `google`) installQuietRenew();
  } catch (e) {
    console.error(e);
    renderWelcome(e.message || String(e));
  }
}

/** Reopen straight into the inventory from the saved session; no sign-in screen. */
function resumeGoogle() {
  const r = new Repo(`google`);
  if (!r.resume()) return false;
  repo = r;
  repo.addEventListener(`change`, onRepoChange);
  repo.addEventListener(`status`, renderStatus);
  renderShell(); render();
  if (hasValidToken()) repo.refresh();
  else repo.setStatus(navigator.onLine ? `auth` : `offline`);
  installQuietRenew();
  return true;
}

// ---- quiet renew: Google tokens last ~1 hour and a browser app can't refresh them in the background
// without a server. So the first tap after (or just before) expiry renews it, using the saved account
// as a hint: the Google popup usually opens and closes by itself, no account picker, no consent screen.
let renewing = null; let lastRenewFail = 0;
function needsRenew() { return repo?.backend.kind === `google` && navigator.onLine && tokenTimeLeft() < 5 * 60_000; }
async function renewNow({ quiet = true } = {}) {
  if (renewing) return renewing;
  renewing = (async () => {
    try {
      await signIn({ silent: true, hint: repo.user?.email || `` });
      await repo.refresh();
      if (!quiet) toast(`Synced`);
      return true;
    } catch (e) {
      lastRenewFail = Date.now();
      if (!quiet) toast(`Couldn’t reach Google: ${e.message}`);
      repo.setStatus(`auth`);
      return false;
    } finally { renewing = null; }
  })();
  return renewing;
}
let quietInstalled = false;
function installQuietRenew() {
  if (quietInstalled) return; quietInstalled = true;
  document.addEventListener(`click`, (e) => {
    if (!needsRenew() || renewing || Date.now() - lastRenewFail < 120_000) return;
    if (e.target.closest(`#status`)) return; // the status pill handles its own tap
    renewNow(); // inside a user gesture, so the browser allows Google's popup
  }, true);
}

function onRepoChange() {
  const r = route().name;
  if (r === `find`) { renderResults(); return; }
  if (r === `add` || r === `edit`) return; // never wipe a form mid-edit
  if (document.querySelector(`.sheet-wrap.open`)) return; // a sheet is open; its owner redraws
  render();
}

// ============================================================ pre-app screens
function renderWelcome(error) {
  const g = googleConfigured();
  app.innerHTML = `
  <main class="welcome">
    <div class="brand-mark">${icon(`box`)}</div>
    <h1>${esc(CONFIG.APP_NAME)}</h1>
    <p class="lead">Know what you have, where it is, and what it’s for.</p>
    <ul class="points">
      <li>${icon(`camera`)}<span>Snap, name, pick a spot. Done in seconds.</span></li>
      <li>${icon(`search`)}<span>Search by what you need it for, not just its name.</span></li>
      <li>${icon(`cloud`)}<span>Your data lives in <b>your own Google Drive</b>. Nothing is stored anywhere else.</span></li>
    </ul>
    ${error ? `<p class="error-box">${icon(`alert`)} ${esc(error)}</p>` : ``}
    <div class="stack">
      ${g ? `<button class="btn primary big" id="gsign">${googleG()} Continue with Google</button>`
        : `<p class="note">Google sign-in isn’t set up yet. Add your OAuth Client ID in <code>js/config.js</code> (see README).</p>`}
      <button class="btn ghost big" id="demo">Try it without an account</button>
      <p class="fine">Demo data stays in this browser only.</p>
    </div>
  </main>`;
  $(`#gsign`)?.addEventListener(`click`, () => start(`google`, { interactive: true }));
  $(`#demo`).addEventListener(`click`, () => start(`demo`));
}

function renderReconnect() {
  app.innerHTML = `
  <main class="welcome">
    <div class="brand-mark">${icon(`box`)}</div>
    <h1>Welcome back</h1>
    <p class="lead">Sign in again to open your inventory.</p>
    <div class="stack"><button class="btn primary big" id="gsign">${googleG()} Continue with Google</button>
    <button class="btn ghost" id="switch">Use demo instead</button></div>
  </main>`;
  $(`#gsign`).onclick = () => start(`google`, { interactive: true });
  $(`#switch`).onclick = () => { localStorage.setItem(MODE_KEY, `demo`); start(`demo`); };
}

function renderChoice(user) {
  app.innerHTML = `
  <main class="welcome">
    <h1>Hi ${esc((user.name || ``).split(` `)[0] || `there`)}</h1>
    <p class="lead">Start a new inventory, or join one a family member shared with you.</p>
    <div class="choice-grid">
      <button class="choice" id="create">${icon(`plus`)}<b>Start a new inventory</b><span>Creates a “${esc(CONFIG.ROOT_FOLDER_NAME)}” folder and sheet in your Drive.</span></button>
      <button class="choice" id="join" ${pickerConfigured() ? `` : `disabled`}>${icon(`users`)}<b>Join a shared inventory</b>
        <span>${pickerConfigured() ? `Pick the “${esc(CONFIG.SHEET_NAME)}” sheet someone shared with you.` : `Needs API_KEY and APP_ID in js/config.js.`}</span></button>
    </div>
  </main>`;
  $(`#create`).onclick = () => start(`google`, { choice: `create` });
  $(`#join`).onclick = async () => {
    try {
      const id = await pickSpreadsheet();
      if (id) start(`google`, { choice: id });
    } catch (e) { toast(e.message); }
  };
}

function renderLoading(msg) {
  app.innerHTML = `<main class="welcome"><div class="spinner"></div><p class="muted">${esc(msg)}</p></main>`;
}

const googleG = () => `<svg class="g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

// ============================================================ shell + routing
function renderShell() {
  app.innerHTML = `
    <header class="topbar">
      <a href="#/" class="logo">${icon(`box`)}<span>${esc(CONFIG.APP_NAME)}</span></a>
      <button class="status" id="status" type="button"></button>
    </header>
    <main id="view" class="view"></main>
    <nav class="tabbar">
      <a href="#/" data-tab="find">${icon(`search`)}<span>Find</span></a>
      <a href="#/places" data-tab="places">${icon(`place`)}<span>Places</span></a>
      <a href="#/add" class="fab" data-tab="add" aria-label="Add item">${icon(`plus`)}</a>
      <a href="#/more" data-tab="more">${icon(`more`)}<span>More</span></a>
    </nav>`;
  $(`#status`).onclick = onStatusClick;
  renderStatus();
}

function renderStatus() {
  const el = $(`#status`); if (!el || !repo) return;
  const s = repo.status;
  const pending = repo.outbox.length;
  const map = {
    synced: [`ok`, `Saved`], idle: [`ok`, `Saved`], syncing: [`busy`, `Saving…`],
    pending: [`warn`, `${pending} to save`], offline: [`warn`, pending ? `Offline · ${pending} waiting` : `Offline`],
    auth: [`warn`, pending ? `${pending} waiting · tap to sync` : `Tap to sync`], error: [`bad`, `Sync issue`],
  };
  const [cls, label] = repo.backend.kind === `demo` ? [`demo`, `Demo`] : (map[s] || map.idle);
  el.className = `status ${cls}`;
  el.innerHTML = `<i></i>${esc(label)}`;
}

async function onStatusClick() {
  if (repo.backend.kind === `demo`) return toast(`Demo mode: data stays in this browser. Sign in with Google from More.`);
  if (repo.status === `auth` || needsRenew()) { await renewNow({ quiet: false }); return; }
  if (repo.status === `error`) return toast(`Sync failed: ${repo.lastError?.message || `unknown error`}`, { action: `Retry`, onAction: () => repo.refresh() });
  repo.refresh();
}

function route() {
  const h = location.hash.replace(/^#\/?/, ``);
  const [path, qs] = h.split(`?`);
  const parts = path.split(`/`).filter(Boolean);
  const params = new URLSearchParams(qs || ``);
  if (!parts.length) return { name: `find`, params };
  return { name: parts[0], id: parts[1], params };
}

function render() {
  if (!repo || !$(`#view`)) return;
  const r = route();
  const tab = { find: `find`, item: `find`, edit: `add`, add: `add`, places: `places`, place: `places`, more: `more` }[r.name] || `find`;
  $$(`.tabbar a`).forEach((a) => a.classList.toggle(`active`, a.dataset.tab === tab));
  const view = $(`#view`);
  view.onclick = null;
  window.scrollTo(0, 0);
  const screens = { find: viewFind, item: viewItem, add: viewEdit, edit: viewEdit, places: viewPlace, place: viewPlace, more: viewMore };
  (screens[r.name] || viewFind)(view, r);
}

// ============================================================ shared bits
function thumbHtml(item, cls = `thumb`) {
  const t = repo.thumbs[item.id];
  return t ? `<img class="${cls}" src="${t}" alt="" loading="lazy">` : `<div class="${cls} ph">${icon(`photo`)}</div>`;
}

function itemCard(item) {
  const path = repo.pathText(item.locationId);
  const due = item.status === `reserved` ? dueText(item.dueAt) : { text: `` };
  const badge = item.status === `reserved`
    ? `<span class="badge reserved${due.late ? ` late` : ``}">Saved for ${esc(item.lentTo || `someone`)}${due.text ? ` · ${esc(due.text)}` : ``}</span>`
    : STATUS_LABEL[item.status] ? `<span class="badge ${esc(item.status)}">${esc(STATUS_LABEL[item.status])}${item.status === `lent` && item.lentTo ? ` · ${esc(item.lentTo)}` : ``}</span>` : ``;
  const cls = `${sel.on ? ` selectable` : ``}${sel.ids.has(item.id) ? ` selected` : ``}`;
  return `<a class="card${cls}" href="#/item/${esc(item.id)}" data-id="${esc(item.id)}">
    <span class="sel-tick" aria-hidden="true">${icon(`check`)}</span>
    ${thumbHtml(item)}
    <div class="card-main">
      <div class="card-title">${esc(item.name)}${Number(item.qty) > 1 ? ` <span class="qty">×${esc(item.qty)}</span>` : ``}</div>
      <div class="card-path">${icon(`place`)}${path ? esc(path) : `<i>No location yet</i>`}</div>
      ${item.purpose ? `<div class="card-purpose">${esc(item.purpose)}</div>` : ``}
      ${badge}
    </div></a>`;
}

function crumbs(locId, { link = true } = {}) {
  const parts = repo.pathOf(locId);
  if (!parts.length) return `<span class="muted">No location</span>`;
  return parts.map((l) => (link ? `<a href="#/place/${esc(l.id)}">${esc(l.name)}</a>` : `<span>${esc(l.name)}</span>`)).join(`<span class="sep">›</span>`);
}

function rememberLoc(id) {
  if (!id) return;
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_LOC_KEY) || `[]`).filter((x) => x !== id);
    list.unshift(id); localStorage.setItem(RECENT_LOC_KEY, JSON.stringify(list.slice(0, 6)));
  } catch { /* ignore */ }
}
function recentLocs() {
  try { return JSON.parse(localStorage.getItem(RECENT_LOC_KEY) || `[]`).filter((id) => repo.locById(id)); } catch { return []; }
}

function kindFor(parentId) {
  const depth = parentId ? repo.pathOf(parentId).length : 0;
  return depth === 0 ? `place` : depth === 1 ? `room` : `container`;
}

/** Location picker as a bottom sheet. Resolves with a location id or null. */
function pickLocation(startId = ``, title = `Where does it live?`, { exclude = null } = {}) {
  return new Promise((resolve) => {
    let current = startId ? (repo.locById(startId)?.parentId || ``) : ``;
    if (exclude?.has(current)) current = ``;
    let done = false;
    const ok = (l) => !exclude || !exclude.has(l.id);
    sheet(title, (el, close) => {
      const finish = (id) => { done = true; rememberLoc(id); resolve(id); close(); };
      el.innerHTML = `<label class="search sm">${icon(`search`)}<input data-q type="search" placeholder="Search places" autocomplete="off" enterkeyhint="search"></label><div class="pk-body"></div>`;
      const qEl = $(`[data-q]`, el); const body = $(`.pk-body`, el);
      const draw = () => {
        const q = qEl.value.trim().toLowerCase();
        if (q) {
          const terms = q.split(/\s+/);
          const hits = repo.locations.filter((l) => !l.deleted && ok(l))
            .map((l) => ({ l, path: repo.pathText(l.id) }))
            .filter(({ path }) => terms.every((t) => path.toLowerCase().includes(t)))
            .sort((a, b) => a.path.length - b.path.length).slice(0, 25);
          const here = repo.locById(current);
          body.innerHTML = `<div class="list">${hits.map(({ l, path }) => `<div class="list-row">
              <button type="button" class="list-main" data-pick="${esc(l.id)}">${icon(KIND_ICON[l.kind] || `box`)}<span>${esc(path)}</span></button></div>`).join(``)
              || `<p class="muted pad">No place matches “${esc(qEl.value.trim())}”.</p>`}</div>
            <div class="row-actions"><button type="button" class="btn ghost" data-create="${esc(qEl.value.trim())}">${icon(`plus`)} New “${esc(qEl.value.trim())}”${here ? ` in ${esc(here.name)}` : ``}</button></div>`;
          return;
        }
        const kids = repo.childrenOf(current).filter(ok);
        const here = repo.locById(current);
        const recents = !current ? recentLocs().filter((id) => ok({ id })) : [];
        body.innerHTML = `
          ${recents.length ? `<div class="label-sm">Recent</div><div class="chips">${recents.map((id) => `<button type="button" class="chip" data-pick="${esc(id)}">${esc(repo.pathText(id))}</button>`).join(``)}</div>` : ``}
          <div class="picker-crumbs"><button type="button" class="link" data-go="">All places</button>${repo.pathOf(current).map((l) => `<span class="sep">›</span><button type="button" class="link" data-go="${esc(l.id)}">${esc(l.name)}</button>`).join(``)}</div>
          <div class="list">
            ${kids.map((l) => `<div class="list-row">
                <button type="button" class="list-main" data-pick="${esc(l.id)}">${icon(KIND_ICON[l.kind] || `box`)}<span>${esc(l.name)}</span></button>
                ${repo.childrenOf(l.id).filter(ok).length ? `<button type="button" class="icon-btn" data-go="${esc(l.id)}" aria-label="Open ${esc(l.name)}">${icon(`chevron`)}</button>` : ``}
              </div>`).join(``) || `<p class="muted pad">Nothing inside yet.</p>`}
          </div>
          <div class="row-actions">
            <button type="button" class="btn ghost" data-new>${icon(`plus`)} New ${current ? `spot in ${esc(here?.name || ``)}` : `place`}</button>
            ${current ? `<button type="button" class="btn primary" data-pick="${esc(current)}">Put in ${esc(here?.name || ``)}</button>` : ``}
          </div>`;
      };
      qEl.addEventListener(`input`, draw);
      body.addEventListener(`click`, async (e) => {
        const b = e.target.closest(`button`); if (!b) return;
        if (b.dataset.pick !== undefined) return finish(b.dataset.pick);
        if (b.dataset.go !== undefined) { current = b.dataset.go; return draw(); }
        if (b.dataset.create !== undefined) {
          const loc = repo.saveLocation({ name: b.dataset.create, parentId: current, kind: kindFor(current) });
          return finish(loc.id);
        }
        if (b.dataset.new !== undefined) {
          const name = await inlineName(body, current ? `e.g. Blue bin, Top shelf, Drawer 2` : `e.g. Home, Storage unit, Office`);
          if (name) { const loc = repo.saveLocation({ name, parentId: current, kind: kindFor(current) }); current = loc.id; }
          draw();
        }
      });
      draw();
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

// ============================================================ Moving (single, bulk, undo)
/** Move items and offer Undo. Moving a lent item means it's back home. */
async function moveWithUndo(items, toId) {
  const moving = items.filter((i) => i && (i.locationId !== toId || i.status === `lent`));
  if (!moving.length) { toast(`Already there`); return; }
  const prev = moving.map((i) => ({ id: i.id, locationId: i.locationId, status: i.status, lentTo: i.lentTo }));
  for (const it of moving) await repo.moveItem(it, toId);
  rememberLoc(toId);
  const label = moving.length === 1 ? moving[0].name : `${moving.length} items`;
  toast(`Moved ${label} to ${repo.pathText(toId)}`, {
    action: `Undo`, ms: 7000,
    onAction: async () => {
      for (const p of prev) {
        const it = repo.items.find((i) => i.id === p.id); if (!it) continue;
        await repo.saveItem({ id: p.id, locationId: p.locationId, status: p.status === `lent` ? `home` : p.status }, { logAction: `moved` });
        if (p.status === `lent`) await repo.lendItem(it, p.lentTo);
      }
      toast(`Move undone`);
    },
  });
}

async function moveSpot(loc) {
  const id = await pickLocation(loc.parentId, `Move ${loc.name} into…`, { exclude: repo.descendantIds(loc.id) });
  if (!id || id === loc.parentId) return;
  const before = loc.parentId;
  repo.saveLocation({ id: loc.id, parentId: id });
  const n = repo.itemsIn(loc.id, true).length;
  toast(`Moved ${loc.name}${n ? ` and its ${n} item${n > 1 ? `s` : ``}` : ``} to ${repo.pathText(id)}`, {
    action: `Undo`, ms: 7000, onAction: () => { repo.saveLocation({ id: loc.id, parentId: before }); toast(`Move undone`); },
  });
}

/** From a place: pick items elsewhere and bring them here. */
function bringItemsSheet(loc) {
  const chosen = new Set();
  sheet(`Bring items to ${loc.name}`, (el, close) => {
    el.innerHTML = `<label class="search sm">${icon(`search`)}<input data-q type="search" placeholder="Search your items" autocomplete="off" enterkeyhint="search"></label>
      <div class="bring-list"></div>
      <div class="row-actions sticky-actions"><button type="button" class="btn primary full" data-go disabled>Select items</button></div>`;
    const qEl = $(`[data-q]`, el); const listEl = $(`.bring-list`, el); const go = $(`[data-go]`, el);
    const upd = () => { const n = chosen.size; go.disabled = !n; go.textContent = n ? `Move ${n} here` : `Select items`; };
    const draw = () => {
      const pool = repo.activeItems().filter((i) => i.locationId !== loc.id);
      const q = qEl.value.trim();
      const list = q ? search(pool, q, (id) => repo.pathText(id)) : [...pool].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      listEl.innerHTML = list.slice(0, 80).map((i) => `<label class="bring-row">
          <input type="checkbox" data-id="${esc(i.id)}" ${chosen.has(i.id) ? `checked` : ``}>
          ${thumbHtml(i, `thumb sm`)}
          <div><b>${esc(i.name)}</b><small>${esc(repo.pathText(i.locationId) || `No location`)}${i.status === `lent` ? ` · lent to ${esc(i.lentTo)}` : ``}</small></div>
        </label>`).join(``) || `<p class="muted pad">${q ? `No items match “${esc(q)}”.` : `Everything is already here.`}</p>`;
      upd();
    };
    listEl.addEventListener(`change`, (e) => { const id = e.target.dataset.id; if (!id) return; if (e.target.checked) chosen.add(id); else chosen.delete(id); upd(); });
    qEl.addEventListener(`input`, draw);
    go.onclick = async () => {
      const items = [...chosen].map((id) => repo.items.find((i) => i.id === id)).filter(Boolean);
      close(); await moveWithUndo(items, loc.id);
    };
    draw();
  });
}

// ---- selection mode (Find results and places): tap "Select" or long-press a card
const sel = { on: false, ids: new Set() };
let suppressClick = false;
function selStart(id) { sel.on = true; if (id) sel.ids.add(id); refreshSel(); }
function selStop() { sel.on = false; sel.ids.clear(); refreshSel(); }
const visibleIds = () => $$(`#view .card[data-id]`).map((c) => c.dataset.id);
function refreshSel() {
  $$(`.card[data-id]`).forEach((c) => { c.classList.toggle(`selectable`, sel.on); c.classList.toggle(`selected`, sel.ids.has(c.dataset.id)); });
  $$(`[data-select-toggle]`).forEach((b) => { b.textContent = sel.on ? `Done` : `Select`; });
  let bar = $(`#selbar`);
  if (!sel.on) { bar?.remove(); document.body.classList.remove(`selecting`); return; }
  if (!bar) { bar = document.createElement(`div`); bar.id = `selbar`; bar.className = `selbar`; document.body.appendChild(bar); bar.onclick = onSelBar; }
  document.body.classList.add(`selecting`);
  const n = sel.ids.size; const vis = visibleIds(); const all = vis.length && vis.every((id) => sel.ids.has(id));
  bar.innerHTML = `<button type="button" class="btn text" data-s="cancel">Cancel</button>
    <span class="sel-count"><b>${n}</b> selected</span>
    <button type="button" class="btn text" data-s="all">${all ? `None` : `All`}</button>
    <button type="button" class="btn primary" data-s="move" ${n ? `` : `disabled`}>${icon(`move`)} Move</button>`;
}
async function onSelBar(e) {
  const s = e.target.closest(`[data-s]`)?.dataset.s; if (!s) return;
  if (s === `cancel`) return selStop();
  if (s === `all`) {
    const vis = visibleIds(); const all = vis.every((id) => sel.ids.has(id));
    vis.forEach((id) => (all ? sel.ids.delete(id) : sel.ids.add(id))); return refreshSel();
  }
  if (s === `move`) {
    const items = [...sel.ids].map((id) => repo.items.find((i) => i.id === id)).filter(Boolean);
    const common = items.every((i) => i.locationId === items[0]?.locationId) ? items[0]?.locationId : ``;
    const id = await pickLocation(common, `Move ${items.length} item${items.length > 1 ? `s` : ``} to…`);
    if (!id) return;
    selStop(); await moveWithUndo(items, id);
  }
}
function installSelectionGestures() {
  let timer = null, start = null;
  document.addEventListener(`click`, (e) => {
    const toggle = e.target.closest(`[data-select-toggle]`);
    if (toggle) { e.preventDefault(); return sel.on ? selStop() : selStart(); }
    const card = e.target.closest(`#view .card[data-id]`); if (!card) return;
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; return; }
    if (sel.on) {
      e.preventDefault(); e.stopPropagation();
      const id = card.dataset.id; if (sel.ids.has(id)) sel.ids.delete(id); else sel.ids.add(id);
      refreshSel();
    }
  }, true);
  document.addEventListener(`pointerdown`, (e) => {
    const card = e.target.closest(`#view .card[data-id]`); if (!card || sel.on) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 800);
      navigator.vibrate?.(15); selStart(card.dataset.id);
    }, 450);
  });
  const cancel = () => { clearTimeout(timer); start = null; };
  document.addEventListener(`pointerup`, cancel); document.addEventListener(`pointercancel`, cancel);
  document.addEventListener(`pointermove`, (e) => { if (start && (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10)) cancel(); });
  document.addEventListener(`contextmenu`, (e) => { if (e.target.closest(`#view .card[data-id]`)) e.preventDefault(); });
}

function inlineName(container, placeholder) {
  return new Promise((resolve) => {
    const row = document.createElement(`form`);
    row.className = `inline-new`;
    row.innerHTML = `<input placeholder="${esc(placeholder)}" required><button class="btn primary">Add</button>`;
    container.querySelector(`.row-actions`).replaceWith(row);
    const input = row.querySelector(`input`); input.focus();
    row.onsubmit = (e) => { e.preventDefault(); resolve(input.value.trim()); };
    input.addEventListener(`keydown`, (e) => { if (e.key === `Escape`) resolve(null); });
  });
}

// ============================================================ People you lend to
const fmtDate = (iso) => {
  if (!iso) return ``;
  const d = new Date(iso); if (isNaN(d)) return ``;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: `short`, day: `numeric`, ...(sameYear ? {} : { year: `numeric` }) });
};
const daysBetween = (a, b = new Date().toISOString()) => {
  if (!a) return null;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
};
const dayText = (n) => (n === null ? `` : n === 0 ? `today` : n === 1 ? `1 day` : `${n} days`);
const initials = (name) => String(name || `?`).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join(``).toUpperCase();

/**
 * Lend now or save for later. Free-text name with a dropdown of people you've lent to before.
 * Resolves { name, mode: 'now'|'later', dueAt } or null.
 */
function lendSheet(item, { mode: startMode = `now` } = {}) {
  return new Promise((resolve) => {
    let done = false; let mode = startMode; let picked = ``;
    const people = repo.people();
    sheet(item.name, (el, close) => {
      const finish = (v) => { done = true; resolve(v); close(); };
      el.innerHTML = `<form class="stack lend-form" autocomplete="off">
          <div class="seg" role="tablist">
            <button type="button" data-mode="now" role="tab">${icon(`lend`)} Lend now</button>
            <button type="button" data-mode="later" role="tab">${icon(`clock`)} Save for later</button>
          </div>
          <label class="field"><span data-wholabel></span>
            <input name="who" placeholder="Type a name" required autocomplete="off" autocapitalize="words" enterkeyhint="done"></label>
          <div class="suggest" role="listbox"></div>
          <div class="field" data-duebox hidden><span>Pick up by <small>(optional)</small></span>
            <div class="chips" data-quick>
              <button type="button" class="chip" data-due="${isoDay(0)}">Today</button>
              <button type="button" class="chip" data-due="${isoDay(1)}">Tomorrow</button>
              <button type="button" class="chip" data-due="${isoDay(3)}">In 3 days</button>
              <button type="button" class="chip" data-due="${isoDay(7)}">Next week</button>
            </div>
            <input type="date" name="due" min="${todayStr()}">
          </div>
          <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn primary" data-ok></button></div>
        </form>`;
      const input = $(`[name=who]`, el); const box = $(`.suggest`, el); const due = $(`[name=due]`, el);
      const drawMode = () => {
        $$(`[data-mode]`, el).forEach((b) => b.classList.toggle(`on`, b.dataset.mode === mode));
        $(`[data-wholabel]`, el).textContent = mode === `now` ? `Who has it?` : `Who is it for?`;
        $(`[data-duebox]`, el).hidden = mode !== `later`;
        $(`[data-ok]`, el).textContent = mode === `now` ? `Lend` : `Save for them`;
      };
      const drawQuick = () => $$(`[data-due]`, el).forEach((c) => c.classList.toggle(`on`, c.dataset.due === due.value));
      const draw = () => {
        const q = Repo.personKey(input.value);
        const list = (q ? people.filter((p) => p.key.includes(q)).sort((a, b) => (b.key.startsWith(q) - a.key.startsWith(q))) : people)
          .filter((p) => p.key !== q || !picked); // hide the exact match once chosen
        box.innerHTML = list.slice(0, 6).map((p) => `<button type="button" class="suggest-row" data-name="${esc(p.name)}" role="option">
            <span class="avatar sm">${esc(initials(p.name))}</span><span>${esc(p.name)}</span>
            <small>${[p.holding.length ? `has ${p.holding.length}` : ``, p.saved.length ? `${p.saved.length} saved` : ``].filter(Boolean).join(` · `) || `lent ${p.total}×`}</small></button>`).join(``);
        box.hidden = !list.length;
        if (!q && list.length) box.insertAdjacentHTML(`afterbegin`, `<div class="label-sm">People you’ve lent to</div>`);
      };
      const submit = (nameRaw) => {
        const typed = String(nameRaw || ``).trim(); if (!typed) { input.focus(); return; }
        const same = people.find((p) => p.key === Repo.personKey(typed));
        finish({ name: same ? same.name : typed, mode, dueAt: mode === `later` ? due.value : `` }); // reuse existing spelling
      };
      el.addEventListener(`click`, (e) => {
        const m = e.target.closest(`[data-mode]`); if (m) { mode = m.dataset.mode; drawMode(); return; }
        const d = e.target.closest(`[data-due]`); if (d) { due.value = due.value === d.dataset.due ? `` : d.dataset.due; drawQuick(); }
      });
      due.addEventListener(`input`, drawQuick);
      input.addEventListener(`input`, () => { picked = ``; draw(); });
      box.onclick = (e) => {
        const b = e.target.closest(`[data-name]`); if (!b) return;
        if (mode === `now`) return submit(b.dataset.name); // one tap to lend
        input.value = b.dataset.name; picked = b.dataset.name; draw(); // saving: still lets you set a date
      };
      $(`[data-no]`, el).onclick = () => finish(null);
      $(`form`, el).onsubmit = (e) => { e.preventDefault(); submit(input.value); };
      drawMode(); draw();
      setTimeout(() => input.focus(), 250);
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

/** Lend or save an item, asking first if it's already saved for someone else. */
async function lendOrSave(item, opts) {
  const res = await lendSheet(item, opts); if (!res) return;
  const savedFor = item.status === `reserved` ? item.lentTo : ``;
  if (savedFor && Repo.personKey(savedFor) !== Repo.personKey(res.name)) {
    const ok = await confirmSheet(`Saved for ${savedFor}`, `${item.name} is saved for ${savedFor}. ${res.mode === `now` ? `Lend it to ${res.name}` : `Save it for ${res.name}`} instead?`, `Yes, ${res.mode === `now` ? `lend` : `save`} to ${res.name}`);
    if (!ok) return;
  }
  if (res.mode === `now`) {
    if (savedFor && Repo.personKey(savedFor) === Repo.personKey(res.name)) await repo.pickUp(item);
    else await repo.lendItem(item, res.name);
    toast(`Lent to ${res.name}`);
  } else {
    await repo.reserveItem(item, res.name, res.dueAt);
    toast(`Saved for ${res.name}${res.dueAt ? ` · ${dueText(res.dueAt).text}` : ``}`);
  }
}

// ---------------- full-screen photo, inside the app (no Drive page, no second login)
function photoViewer(item) {
  const wrap = document.createElement(`div`);
  wrap.className = `viewer`;
  wrap.innerHTML = `<button type="button" class="viewer-x" aria-label="Close">${icon(`x`)}</button>
    <div class="viewer-stage">${repo.thumbs[item.id] ? `<img src="${repo.thumbs[item.id]}" alt="${esc(item.name)}">` : `<div class="spinner"></div>`}</div>
    <div class="viewer-bar"><b>${esc(item.name)}</b><span class="viewer-note"></span></div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add(`open`));
  const close = () => { wrap.classList.remove(`open`); setTimeout(() => wrap.remove(), 200); document.removeEventListener(`keydown`, onKey); };
  const onKey = (e) => { if (e.key === `Escape`) close(); };
  document.addEventListener(`keydown`, onKey);
  wrap.addEventListener(`click`, (e) => { if (e.target === wrap || e.target.closest(`.viewer-x`) || e.target.classList.contains(`viewer-stage`)) close(); });
  const note = $(`.viewer-note`, wrap); const stage = $(`.viewer-stage`, wrap);
  const show = (url) => { stage.innerHTML = `<img src="${url}" alt="${esc(item.name)}">`; note.textContent = ``; };
  const load = () => repo.photoObjectUrl(item).then((url) => {
    if (url) return show(url);
    if (!repo.thumbs[item.id]) stage.innerHTML = `<p class="muted">No photo yet.</p>`;
    else if (item.photoUrl) note.innerHTML = `Preview only. The full photo is in ${esc((item.addedBy || `another member`).split(`@`)[0])}’s Drive. <a href="${esc(item.photoUrl)}" target="_blank" rel="noopener">Open in Drive</a>`;
  }).catch((err) => {
    if (!(err instanceof AuthError)) return;
    note.innerHTML = `<button type="button" class="btn small primary" data-load>Load full photo</button>`;
    $(`[data-load]`, note).onclick = async (ev) => { ev.stopPropagation(); note.textContent = `Loading…`; if (await renewNow()) load(); else note.textContent = `Couldn’t reach Google. Showing preview.`; };
  });
  load();
}

// ---------------- item history
const fmtWhen = (iso) => {
  const d = new Date(iso); if (isNaN(d)) return ``;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { month: `short`, day: `numeric`, ...(sameYear ? {} : { year: `numeric` }), hour: `numeric`, minute: `2-digit` });
};
const whoName = (email) => (!email || email === repo.user.email ? `` : (repo.members.find((m) => m.email === email)?.email || email).split(`@`)[0]);
const ACTION_ICON = { added: `plus`, moved: `move`, lent: `lend`, returned: `ret`, reserved: `clock`, unreserved: `x`, missing: `alert`, found: `check`, removed: `trash`, edited: `edit` };

/** One log entry → { icon, title, note }. `prev` is the entry before it (older), to spot pickups. */
function describeEntry(e, prev) {
  const due = /due (\d{4}-\d{2}-\d{2})/.exec(e.info || ``)?.[1];
  const person = (n) => `<button type="button" class="person-link" data-person="${esc(Repo.personKey(n))}">${esc(n)}</button>`;
  switch (true) {
    case e.action === `added`: return { title: `Added${e.detail ? ` to ${esc(e.detail)}` : ``}` };
    case e.action === `moved`: return { title: `Moved to ${esc(e.detail || `no location`)}`, note: e.info ? esc(e.info.replace(/^from /, `From `)) : `` };
    case e.action === `lent`: {
      const picked = prev?.action === `reserved` && Repo.personKey(prev.detail) === Repo.personKey(e.detail);
      return { title: `${picked ? `Picked up by` : `Lent to`} ${person(e.detail)}` };
    }
    case e.action === `returned`: return { title: e.detail ? `Returned by ${person(e.detail)}` : `Back home` };
    case e.action === `reserved`: return { title: `Saved for ${person(e.detail)}`, note: due ? `Pick up by ${esc(new Date(`${due}T00:00`).toLocaleDateString(undefined, { weekday: `short`, month: `short`, day: `numeric` }))}` : `` };
    case e.action === `unreserved`: return { title: `No longer saved for ${e.detail ? person(e.detail) : `them`}` };
    case e.action === `missing`: return { title: `Marked missing` };
    case e.action === `found`: return { title: `Found` };
    case e.action === `removed`: return { title: `Removed from inventory` };
    case e.action === `edited`: return { title: `Edited`, note: esc(e.info || ``) };
    case /^qty\+\d+$/.test(e.action): return { title: `Added ${esc(e.action.slice(4))} more`, icon: `plus` };
    default: return { title: esc(e.action) };
  }
}

function itemHistoryHtml(item) {
  const hist = repo.itemHistory(item.id);
  if (!hist.length) return ``;
  const SHOW = 5;
  const rows = hist.map((e, i) => {
    const d = describeEntry(e, hist[i + 1]);
    const who = whoName(e.by);
    return `<div class="ih-row${i >= SHOW ? ` extra` : ``}">
      <span class="ih-ic">${icon(d.icon || ACTION_ICON[e.action] || `edit`)}</span>
      <div><div class="ih-title">${d.title}</div>${d.note ? `<div class="ih-note">${d.note}</div>` : ``}
        <small>${esc(fmtWhen(e.ts))}${who ? ` · by ${esc(who)}` : ``}</small></div></div>`;
  }).join(``);
  return `<div class="label-sm">History</div><div class="ih">${rows}</div>
    ${hist.length > SHOW ? `<button type="button" class="btn ghost small" data-hist-all>Show all ${hist.length}</button>` : ``}`;
}

function historyState(h) {
  if (h.lentAt && !h.returnedAt) return `open`;
  if (h.savedAt && !h.lentAt && !h.cancelledAt) return `saved`;
  if (h.cancelledAt && !h.lentAt) return `cancelled`;
  return ``;
}
function historyText(h) {
  const parts = [];
  if (h.savedAt) parts.push(`Saved ${fmtDate(h.savedAt)}${h.dueAt ? ` (by ${fmtDate(`${h.dueAt}T12:00`)})` : ``}`);
  if (h.lentAt) {
    const lateBy = h.dueAt ? Math.round((new Date(String(h.lentAt).slice(0, 10) + `T00:00`) - new Date(`${h.dueAt}T00:00`)) / 86400000) : 0;
    parts.push(`${h.savedAt ? `picked up` : `lent`} ${fmtDate(h.lentAt)}${lateBy > 0 ? ` (${dayText(lateBy)} late)` : ``}`);
  }
  if (h.cancelledAt && !h.lentAt) parts.push(`cancelled ${fmtDate(h.cancelledAt)}`);
  else if (h.savedAt && !h.lentAt) {
    const d = dueText(h.item?.dueAt); parts.push(d.text ? `waiting, ${d.text}` : `waiting for pickup`);
  } else if (h.returnedAt) {
    const n = daysBetween(h.lentAt, h.returnedAt);
    parts.push(`${h.how && h.how !== `returned` ? `closed` : `returned`} ${fmtDate(h.returnedAt)} (${n === 0 ? `same day` : dayText(n)})`);
  } else if (h.lentAt) parts.push(`still out, ${dayText(daysBetween(h.lentAt))}`);
  const s = parts.join(` → `);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Person card: what they have now + lend/return history. */
function personSheet(key) {
  const person = repo.people().find((p) => p.key === key);
  if (!person) return toast(`No lending history for that name yet`);
  sheet(`Borrower`, (el, close) => {
    const draw = () => {
      const p = repo.people().find((x) => x.key === key) || { ...person, holding: [], saved: [] };
      const hist = repo.personHistory(key);
      const sinceOf = (id) => hist.find((h) => h.itemId === id && h.lentAt && !h.returnedAt)?.lentAt;
      const borrowed = hist.filter((h) => h.lentAt).length;
      const summary = [p.holding.length ? `Has ${p.holding.length} item${p.holding.length > 1 ? `s` : ``} now` : `Has nothing of yours now`,
        p.saved.length ? `${p.saved.length} saved` : ``, borrowed ? `borrowed ${borrowed} time${borrowed === 1 ? `` : `s`}` : ``].filter(Boolean).join(` · `);
      el.innerHTML = `
        <div class="person-head"><span class="avatar">${esc(initials(p.name))}</span>
          <div><b>${esc(p.name)}</b><small>${esc(summary)}</small></div></div>
        ${p.saved.length ? `<div class="label-sm">Saved for ${esc(p.name)}</div>
          <div class="list">${p.saved.map((it) => { const d = dueText(it.dueAt); return `<div class="list-row hold-row">
              ${thumbHtml(it, `thumb sm`)}
              <button type="button" class="hold-main" data-open="${esc(it.id)}"><b>${esc(it.name)}</b><small class="${d.late ? `late` : ``}">${esc(d.text || `no pick-up date`)} · ${esc(repo.pathText(it.locationId) || `no location`)}</small></button>
              <button type="button" class="icon-btn" data-unsave="${esc(it.id)}" aria-label="Cancel">${icon(`x`)}</button>
              <button type="button" class="btn ghost small" data-pick="${esc(it.id)}">Picked up</button>
            </div>`; }).join(``)}</div>
          ${p.saved.length > 1 ? `<div class="row-actions"><button type="button" class="btn primary" data-pickall>Picked up everything</button></div>` : ``}` : ``}
        ${p.holding.length ? `<div class="label-sm">Has now</div>
          <div class="list">${p.holding.map((it) => `<div class="list-row hold-row">
              ${thumbHtml(it, `thumb sm`)}
              <button type="button" class="hold-main" data-open="${esc(it.id)}"><b>${esc(it.name)}</b><small>since ${esc(fmtDate(sinceOf(it.id)) || `unknown`)}${sinceOf(it.id) ? ` · ${dayText(daysBetween(sinceOf(it.id)))}` : ``}</small></button>
              <button type="button" class="btn ghost small" data-back="${esc(it.id)}">Got it back</button>
            </div>`).join(``)}</div>
          ${p.holding.length > 1 ? `<div class="row-actions"><button type="button" class="btn primary" data-all>Got everything back</button></div>` : ``}` : ``}
        <div class="label-sm">History</div>
        ${hist.length ? `<div class="timeline">${hist.map((h) => `<div class="tl-row ${historyState(h)}">
            <i></i>
            <div><button type="button" class="link-plain" ${h.item ? `data-open="${esc(h.itemId)}"` : `disabled`}>${esc(h.itemName)}</button>
              <small>${esc(historyText(h))}</small></div>
          </div>`).join(``)}</div>` : `<p class="muted">No history yet.</p>`}`;
    };
    el.onclick = async (e) => {
      const b = e.target.closest(`button`); if (!b) return;
      if (b.dataset.open) { close(); location.hash = `#/item/${b.dataset.open}`; return; }
      if (b.dataset.back) {
        const it = repo.items.find((i) => i.id === b.dataset.back);
        if (it) { await repo.returnItem(it); toast(`${it.name} is back`); draw(); }
        return;
      }
      if (b.dataset.pick) {
        const it = repo.items.find((i) => i.id === b.dataset.pick);
        if (it) { await repo.pickUp(it); toast(`${it.name} is now lent to ${it.lentTo}`); draw(); }
        return;
      }
      if (b.dataset.unsave) {
        const it = repo.items.find((i) => i.id === b.dataset.unsave);
        if (it) { await repo.cancelReservation(it); toast(`No longer saved for ${person.name}`); draw(); }
        return;
      }
      if (b.hasAttribute(`data-pickall`)) {
        const p = repo.people().find((x) => x.key === key);
        for (const it of p?.saved || []) await repo.pickUp(it);
        toast(`${person.name} picked up everything`); draw(); return;
      }
      if (b.hasAttribute(`data-all`)) {
        const p = repo.people().find((x) => x.key === key);
        for (const it of p?.holding || []) await repo.returnItem(it);
        toast(`Everything is back from ${person.name}`); draw();
      }
    };
    draw();
  }, { onClose: () => render() });
}

// ============================================================ Find
function viewFind(view) {
  const cats = repo.categories();
  const lent = repo.activeItems().filter((i) => i.status === `lent`).length;
  const saved = repo.activeItems().filter((i) => i.status === `reserved`).length;
  { // drop a filter whose chip no longer exists (e.g. the last saved item was picked up)
    const f = findState.filter;
    const counts = { lent, missing: repo.activeItems().filter((i) => i.status === `missing`).length, reserved: saved };
    if ((f in counts && !counts[f]) || (f.startsWith(`cat:`) && !cats.includes(f.slice(4)))) findState.filter = ``;
  }
  const missing = repo.activeItems().filter((i) => i.status === `missing`).length;
  view.innerHTML = `
    <div class="search-wrap">
      <label class="search">${icon(`search`)}<input id="q" type="search" placeholder="What do you need? e.g. fix a leak" value="${esc(findState.q)}" autocomplete="off" enterkeyhint="search"></label>
    </div>
    <div class="chips scroll" id="filters">
      ${lent ? `<button class="chip" data-f="lent">Lent out · ${lent}</button>` : ``}
      ${saved ? `<button class="chip" data-f="reserved">Saved for someone · ${saved}</button>` : ``}
      ${missing ? `<button class="chip" data-f="missing">Missing · ${missing}</button>` : ``}
      ${cats.map((c) => `<button class="chip" data-f="cat:${esc(c)}">${esc(c)}</button>`).join(``)}
    </div>
    <div id="results"></div>`;
  const q = $(`#q`);
  q.addEventListener(`input`, () => { findState.q = q.value; renderResults(); });
  $(`#results`).addEventListener(`click`, (e) => { const b = e.target.closest(`[data-person]`); if (b) personSheet(b.dataset.person); });
  $(`#filters`).addEventListener(`click`, (e) => {
    const b = e.target.closest(`[data-f]`); if (!b) return;
    findState.filter = findState.filter === b.dataset.f ? `` : b.dataset.f;
    renderResults();
  });
  renderResults();
}

function renderResults() {
  const box = $(`#results`); if (!box) return;
  const sig = [`lent`, `missing`, `reserved`].map((st) => repo.activeItems().some((i) => i.status === st)).join() + repo.categories().join();
  if (box.dataset.sig && box.dataset.sig !== sig) { box.dataset.sig = ``; return viewFind($(`#view`)); } // chips changed
  box.dataset.sig = sig;
  $$(`#filters [data-f]`).forEach((b) => b.classList.toggle(`on`, b.dataset.f === findState.filter));
  let list = repo.activeItems();
  const f = findState.filter;
  if (f === `lent` || f === `missing` || f === `reserved`) list = list.filter((i) => i.status === f);
  else if (f.startsWith(`cat:`)) list = list.filter((i) => i.category === f.slice(4));
  const q = findState.q.trim();
  if (q) list = search(list, q, (id) => repo.pathText(id));
  else list = [...list].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  if (!repo.activeItems().length) {
    box.innerHTML = `<div class="empty">${icon(`box`, `big`)}<h3>Nothing here yet</h3><p>Add the first thing you always end up hunting for.</p><a class="btn primary" href="#/add">${icon(`plus`)} Add an item</a></div>`;
    return;
  }
  if (q && !list.length) {
    box.innerHTML = `<div class="empty"><h3>No match for “${esc(q)}”</h3><p>Looks like you don’t have it logged. Maybe you don’t have one, or it hasn’t been added yet.</p><a class="btn ghost" href="#/add?name=${encodeURIComponent(q)}">${icon(`plus`)} Add “${esc(q)}”</a></div>`;
    return;
  }
  const heading = q || f ? `${list.length} found` : `Recently updated`;
  const field = f === `lent` ? `holding` : f === `reserved` ? `saved` : ``;
  const holders = field ? repo.people().filter((p) => p[field].length) : [];
  box.innerHTML = (holders.length ? `<div class="label-sm">${field === `holding` ? `Who has your things` : `Waiting to pick up`}</div>
      <div class="people-strip">${holders.map((p) => `<button type="button" class="person-chip" data-person="${esc(p.key)}">
        <span class="avatar sm">${esc(initials(p.name))}</span><span>${esc(p.name)}</span><b>${p[field].length}</b></button>`).join(``)}</div>` : ``)
    + `<div class="list-head"><div class="label-sm">${esc(heading)}</div><button type="button" class="link small" data-select-toggle>${sel.on ? `Done` : `Select`}</button></div><div class="cards">${list.slice(0, q || f ? 200 : 30).map(itemCard).join(``)}</div>`;
}

// ============================================================ Item detail
function viewItem(view, r) {
  const item = repo.items.find((i) => i.id === r.id && !i.deleted);
  if (!item) { view.innerHTML = `<div class="empty"><h3>Item not found</h3><a class="btn ghost" href="#/">Back</a></div>`; return; }
  const personBtn = `<button type="button" class="person-link" data-person="${esc(Repo.personKey(item.lentTo))}">${esc(item.lentTo || `someone`)}</button>`;
  const due = dueText(item.dueAt);
  const status = item.status === `lent` ? `<div class="banner lent">${icon(`lend`)} Lent to ${personBtn}</div>`
    : item.status === `reserved` ? `<div class="banner reserved${due.late ? ` late` : ``}">${icon(`clock`)}<div class="grow"><span>Saved for ${personBtn}</span>${due.text ? `<small>${esc(due.text)}</small>` : ``}</div>
        <button type="button" class="btn text small" data-a="unsave">Cancel</button></div>`
    : item.status === `missing` ? `<div class="banner missing">${icon(`alert`)} Marked missing</div>` : ``;
  const tags = String(item.tags || ``).split(`,`).map((t) => t.trim()).filter(Boolean);
  view.innerHTML = `
    <div class="detail">
      <a class="back" href="#/">${icon(`back`)} Find</a>
      <div class="hero">${thumbHtml(item, `hero-img`)}</div>
      <h1>${esc(item.name)}${Number(item.qty) > 1 ? ` <span class="qty">×${esc(item.qty)}</span>` : ``}</h1>
      ${status}
      <div class="where"><div class="label-sm">Where</div><div class="crumbs">${crumbs(item.locationId)}</div></div>
      ${item.purpose ? `<div class="block"><div class="label-sm">What it’s for</div><p>${esc(item.purpose)}</p></div>` : ``}
      <div class="facts">
        ${item.category ? `<div><span>Category</span><b>${esc(item.category)}</b></div>` : ``}
        ${item.warranty ? `<div><span>Warranty until</span><b>${esc(item.warranty)}</b></div>` : ``}
        ${item.expiry ? `<div><span>Expires</span><b>${esc(item.expiry)}</b></div>` : ``}
        <div><span>Added</span><b>${esc(timeAgo(item.addedAt))}${item.addedBy && item.addedBy !== repo.user.email ? ` by ${esc(item.addedBy.split(`@`)[0])}` : ``}</b></div>
      </div>
      ${tags.length ? `<div class="chips">${tags.map((t) => `<a class="chip" href="#/?q" data-tag="${esc(t)}">${esc(t)}</a>`).join(``)}</div>` : ``}
      ${item.notes ? `<div class="block"><div class="label-sm">Notes</div><p class="pre">${esc(item.notes)}</p></div>` : ``}
      <div class="actions-grid">
        <button class="act" data-a="move">${icon(`move`)}Move</button>
        ${item.status === `lent` ? `<button class="act" data-a="return">${icon(`ret`)}Got it back</button>`
          : item.status === `reserved` ? `<button class="act hi" data-a="pickup">${icon(`check`)}Picked up</button>`
          : `<button class="act" data-a="lend">${icon(`lend`)}Lend / Save</button>`}
        ${item.status === `missing` ? `<button class="act" data-a="found">${icon(`check`)}Found it</button>` : `<button class="act" data-a="missing">${icon(`alert`)}Can’t find</button>`}
        <a class="act" href="#/edit/${esc(item.id)}">${icon(`edit`)}Edit</a>
      </div>
      ${itemHistoryHtml(item)}
      <button class="btn text danger full" data-a="delete">${icon(`trash`)} Remove from inventory</button>
    </div>`;

  // Show the full-size photo when this device can read it (own photos / demo).
  // Full-size photo from the phone's cache or Drive; tap to view it full screen.
  repo.photoObjectUrl(item).then((url) => {
    if (!url) return;
    const img = $(`.hero-img`, view);
    if (img?.tagName === `IMG`) img.src = url; else $(`.hero`, view).innerHTML = `<img class="hero-img" src="${url}" alt="">`;
  }).catch(() => { /* not signed in right now: thumbnail stays */ });
  if (repo.thumbs[item.id] || item.photoId) $(`.hero`, view).classList.add(`zoomable`);

  view.onclick = async (e) => {
    const tag = e.target.closest(`[data-tag]`);
    if (tag) { e.preventDefault(); findState = { q: tag.dataset.tag, filter: `` }; location.hash = `#/`; return; }
    const who = e.target.closest(`[data-person]`);
    if (who) { personSheet(who.dataset.person); return; }
    if (e.target.closest(`.hero.zoomable`)) { photoViewer(item); return; }
    if (e.target.closest(`[data-hist-all]`)) { $(`.ih`, view).classList.add(`all`); e.target.closest(`[data-hist-all]`).remove(); return; }
    const b = e.target.closest(`[data-a]`); if (!b) return;
    const a = b.dataset.a;
    if (a === `move`) {
      const id = await pickLocation(item.locationId, `Move to…`);
      if (id) await moveWithUndo([item], id);
    } else if (a === `lend`) {
      await lendOrSave(item);
    } else if (a === `pickup`) {
      await repo.pickUp(item); toast(`Lent to ${item.lentTo}`);
    } else if (a === `unsave`) {
      const who = item.lentTo; const was = item.dueAt;
      await repo.cancelReservation(item);
      toast(`No longer saved for ${who}`, { action: `Undo`, ms: 6000, onAction: () => repo.reserveItem(item, who, was) });
    } else if (a === `return`) { await repo.returnItem(item); toast(`Back home`); }
    else if (a === `missing`) { await repo.markMissing(item); toast(`Marked missing`); }
    else if (a === `found`) { await repo.markFound(item); toast(`Found`); }
    else if (a === `delete`) {
      if (await confirmSheet(`Remove “${item.name}”?`, `It will be hidden from the app. The row stays in your sheet, marked as removed.`, `Remove`, true)) {
        await repo.deleteItem(item); toast(`Removed`); location.hash = `#/`;
      }
    }
  };
}

// ============================================================ Add / Edit
function viewEdit(view, r) {
  const editing = r.name === `edit` ? repo.items.find((i) => i.id === r.id) : null;
  const item = editing || {
    name: r.params.get(`name`) || ``, purpose: ``, category: ``, tags: ``, qty: 1, warranty: ``, expiry: ``, notes: ``,
    locationId: r.params.get(`loc`) || recentLocs()[0] || ``,
  };
  let locationId = item.locationId;
  let photo = null, thumb = null;
  const cats = repo.categories();

  view.innerHTML = `
    <form class="form" id="f" autocomplete="off">
      <h1>${editing ? `Edit item` : `Add an item`}</h1>
      <label class="photo-pick" id="pp">
        <input type="file" accept="image/*" capture="environment" id="photo" hidden>
        <div class="pp-view">${editing && repo.thumbs[editing.id] ? `<img src="${repo.thumbs[editing.id]}" alt="">` : `<div class="pp-empty">${icon(`camera`)}<span>Take a photo</span></div>`}</div>
        <div class="pp-busy" hidden><div class="spinner"></div><span>Identifying…</span></div>
      </label>
      <div id="aiRow"></div>
      <label class="field"><span>What is it?</span><input name="name" required value="${esc(item.name)}" placeholder="e.g. Stud finder"></label>
      <label class="field"><span>What’s it for?</span><textarea name="purpose" rows="2" placeholder="e.g. Finding studs before hanging shelves or a TV">${esc(item.purpose)}</textarea></label>
      <div class="field"><span>Where is it?</span>
        <button type="button" class="loc-btn" id="loc">${icon(`place`)}<span id="locText"></span>${icon(`chevron`)}</button></div>
      <div class="two">
        <label class="field"><span>Category</span><input name="category" list="cats" value="${esc(item.category)}" placeholder="Tools"></label>
        <label class="field"><span>How many</span><input name="qty" type="number" min="0" inputmode="numeric" value="${esc(item.qty || 1)}"></label>
      </div>
      <datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join(``)}</datalist>
      <label class="field"><span>Tags <small>(comma separated, helps search)</small></span><input name="tags" value="${esc(item.tags)}" placeholder="plumbing, leak"></label>
      <details ${item.warranty || item.expiry || item.notes ? `open` : ``}>
        <summary>More details</summary>
        <div class="two">
          <label class="field"><span>Warranty until</span><input name="warranty" type="date" value="${esc(item.warranty)}"></label>
          <label class="field"><span>Expires</span><input name="expiry" type="date" value="${esc(item.expiry)}"></label>
        </div>
        <label class="field"><span>Notes</span><textarea name="notes" rows="3" placeholder="Model number, where you bought it, manual link…">${esc(item.notes)}</textarea></label>
      </details>
      <div class="form-actions">
        ${editing ? `` : `<button type="submit" class="btn ghost" data-again>Save &amp; add another</button>`}
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`;

  const setLocText = () => { $(`#locText`).innerHTML = locationId ? crumbs(locationId, { link: false }) : `<span class="muted">Choose a place</span>`; };
  setLocText();
  $(`#loc`).onclick = async () => { const id = await pickLocation(locationId); if (id) { locationId = id; setLocText(); } };

  let shot = null; // { canvas, aiImage } of the current photo, for AI + crops
  const drawAiRow = () => {
    const row = $(`#aiRow`); if (!row) return;
    if (!aiReady()) {
      row.innerHTML = editing ? `` : `<a class="ai-setup" href="#/more?ai=1">${icon(`spark`)}<span>Let AI fill in the details from your photo</span><b>Set up</b></a>`;
      return;
    }
    const s = aiSettings();
    row.innerHTML = `<div class="ai-row">
        <label class="switch"><input type="checkbox" id="aiAuto" ${s.auto ? `checked` : ``}><i></i><span>${icon(`spark`)} Identify with AI when I take a photo</span></label>
        ${shot ? `<button type="button" class="btn ghost small" id="aiRun">${icon(`spark`)} Suggest details</button>` : ``}
      </div>`;
    $(`#aiAuto`).onchange = (e) => saveAiSettings({ auto: e.target.checked });
    const run = $(`#aiRun`); if (run) run.onclick = () => runAi();
  };

  const busy = (on) => { $(`#pp`).classList.toggle(`busy`, on); $(`#pp .pp-busy`).hidden = !on; };

  async function runAi() {
    if (!shot) return;
    busy(true);
    try {
      const items = await analyzePhoto(await shot.aiImage(), { categories: cats, location: locationId ? repo.pathText(locationId) : `` });
      if (!items.length) { toast(`AI couldn’t recognize anything. Fill in the details yourself.`); return; }
      if (items.length === 1) { applySuggestion(items[0]); return; }
      const choice = await reviewItems(items, shot.canvas, locationId);
      if (choice?.single) {
        const { photo: p, thumb: t } = await cropItem(shot.canvas, choice.single.box);
        photo = p; thumb = t; $(`#pp .pp-view`).innerHTML = `<img src="${thumb}" alt="">`;
        applySuggestion(choice.single);
      } else if (choice?.added) {
        location.hash = `#/place/${choice.locationId}`;
      }
    } catch (err) {
      toast(err instanceof AiError ? err.message : `AI suggestion failed. Fill in the details yourself.`, { ms: 5000 });
    } finally { busy(false); }
  }

  function applySuggestion(sug) {
    const f = $(`#f`); let n = 0;
    const set = (name, value) => {
      const el = f.elements[name];
      if (!el || !value) return;
      const untouched = !el.value || (name === `qty` && String(el.value) === `1`);
      if (!untouched) return; // never overwrite what the user typed
      el.value = value; el.classList.add(`suggested`); n++;
      el.addEventListener(`input`, () => el.classList.remove(`suggested`), { once: true });
    };
    set(`name`, sug.name); set(`purpose`, sug.purpose); set(`category`, sug.category);
    set(`tags`, sug.tags); if (sug.qty > 1) set(`qty`, sug.qty);
    if (sug.notes) { set(`notes`, sug.notes); f.querySelector(`details`).open = true; }
    if (n) toast(`AI filled ${n} field${n > 1 ? `s` : ``}. Check them before saving.`);
    else toast(`AI had nothing to add to what you typed.`);
  }

  $(`#photo`).addEventListener(`change`, async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    $(`#pp`).classList.add(`busy`);
    try {
      const p = await processPhoto(file);
      ({ photo, thumb } = p); shot = p;
      $(`#pp .pp-view`).innerHTML = `<img src="${thumb}" alt="">`;
      drawAiRow();
    } catch { toast(`Couldn’t read that photo`); return; }
    finally { $(`#pp`).classList.remove(`busy`); }
    if (aiReady() && aiSettings().auto) runAi();
    else if (!$(`input[name=name]`).value) $(`input[name=name]`).focus();
  });
  drawAiRow();

  let again = false;
  $$(`button[type=submit]`, view).forEach((b) => b.addEventListener(`click`, () => { again = b.hasAttribute(`data-again`); }));
  let saving = false;
  const lock = (on) => { saving = on; $$(`button[type=submit]`, view).forEach((b) => { b.disabled = on; }); };
  const next = (id) => {
    if (again) location.hash = `#/add?loc=${encodeURIComponent(locationId)}&t=${Date.now()}`;
    else location.hash = id ? `#/item/${id}` : `#/`;
  };

  $(`#f`).addEventListener(`submit`, async (e) => {
    e.preventDefault();
    if (saving) return; // a double tap must not create two items
    lock(true);
    try {
      const fd = new FormData(e.target);
      const fields = Object.fromEntries([...fd.entries()].filter(([k]) => k !== `photo`).map(([k, v]) => [k, String(v).trim()]));
      fields.locationId = locationId;
      fields.qty = Number(fields.qty) || 1;
      if (editing) fields.id = editing.id;

      if (!editing) {
        const dups = findDuplicates(repo.activeItems(), fields.name, { locationId });
        if (dups.length) {
          const choice = await duplicatePrompt(fields, dups);
          if (!choice) { lock(false); return; } // back to the form
          if (choice.action === `open`) { location.hash = `#/item/${choice.item.id}`; return; }
          if (choice.action === `move` || choice.action === `more`) {
            const it = choice.item;
            const patch = { id: it.id };
            if (choice.action === `move`) { patch.locationId = locationId; patch.status = `home`; patch.lentTo = ``; }
            else patch.qty = (Number(it.qty) || 1) + fields.qty;
            const attach = photo && !it.photoId && !repo.thumbs[it.id]; // give it the photo if it had none
            await repo.saveItem(patch, { ...(attach ? { photo, thumb } : {}), logAction: choice.action === `move` ? `moved` : `qty+${fields.qty}` });
            rememberLoc(locationId);
            toast(choice.action === `move` ? `Moved ${it.name} to ${repo.pathText(locationId)}` : `${it.name} is now ×${patch.qty}`);
            return next(again ? null : it.id);
          }
          // choice.action === `new`: fall through and save as a separate item
        }
      }

      const saved = await repo.saveItem(fields, { photo, thumb });
      rememberLoc(locationId);
      toast(editing ? `Saved` : `Added ${saved.name}`, editing ? {} : { action: `View`, onAction: () => { location.hash = `#/item/${saved.id}`; } });
      next(editing ? saved.id : null);
    } catch (err) {
      console.error(err); toast(`Couldn’t save: ${err.message || err}`); lock(false);
    }
  });
}

/** "You may already have this". Resolves { action: open|move|more|new, item } or null (go back). */
function duplicatePrompt(fields, dups) {
  return new Promise((resolve) => {
    let done = false;
    const top = dups[0];
    sheet(top.samePlace ? `Already here?` : `Already have it?`, (el, close) => {
      const finish = (v) => { done = true; resolve(v); close(); };
      el.innerHTML = `
        <p class="muted">${top.samePlace
          ? `There’s already something similar in <b>${esc(repo.pathText(fields.locationId))}</b>.`
          : `You may already have this.`}</p>
        <div class="dup-list">
          ${dups.map((d, i) => `<div class="dup-row">
            <div class="dup-item">${thumbHtml(d.item)}<div><b>${esc(d.item.name)}</b>${Number(d.item.qty) > 1 ? ` <span class="qty">×${esc(d.item.qty)}</span>` : ``}
              <small>${icon(`place`)}${esc(repo.pathText(d.item.locationId) || `No location`)}${d.samePlace ? ` · same place` : ``}</small>
              ${d.item.status === `lent` ? `<small class="warn">Lent to ${esc(d.item.lentTo || `someone`)}</small>` : ``}</div></div>
            <div class="dup-actions">
              <button type="button" class="btn ghost small" data-act="open" data-i="${i}">Open it</button>
              ${!d.samePlace && fields.locationId ? `<button type="button" class="btn ghost small" data-act="move" data-i="${i}">Same one, it’s here now</button>` : ``}
              <button type="button" class="btn ghost small" data-act="more" data-i="${i}">I have another (+${esc(fields.qty)})</button>
            </div>
          </div>`).join(``)}
        </div>
        <div class="row-actions">
          <button type="button" class="btn ghost" data-back>Back to edit</button>
          <button type="button" class="btn primary" data-new>Save as a new item</button>
        </div>`;
      el.onclick = (e) => {
        const b = e.target.closest(`button`); if (!b) return;
        if (b.hasAttribute(`data-back`)) return finish(null);
        if (b.hasAttribute(`data-new`)) return finish({ action: `new` });
        if (b.dataset.act) finish({ action: b.dataset.act, item: dups[Number(b.dataset.i)].item });
      };
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

/**
 * Several items found in one photo: let the user review, rename and untick, then add them all.
 * Resolves { added, locationId } | { single: suggestion } | null.
 */
function reviewItems(items, canvas, startLoc) {
  return new Promise((resolve) => {
    let done = false;
    let locationId = startLoc;
    const hereDup = (it) => locationId && findDuplicates(repo.activeItems(), it.name, { locationId }).find((d) => d.samePlace);
    const ticked = new Set(items.map((_, i) => i).filter((i) => !hereDup(items[i])));
    const finish = (v) => { done = true; resolve(v); };
    sheet(`Found ${items.length} items`, async (el, close) => {
      const crops = await Promise.all(items.map((it) => cropItem(canvas, it.box)));
      const draw = () => {
        el.innerHTML = `
          <p class="muted small">Suggested by AI. Untick anything you don’t want and fix names before adding.</p>
          <div class="review-list">
            ${items.map((it, i) => `<div class="review-row">
              <label class="tick"><input type="checkbox" data-i="${i}" ${ticked.has(i) ? `checked` : ``}></label>
              <img src="${crops[i].thumb}" alt="">
              <div class="review-main">
                <input class="review-name suggested" data-name="${i}" value="${esc(it.name)}">
                ${hereDup(it) ? `<small class="here-tag">Already here: ${esc(hereDup(it).item.name)}</small>` : ``}
                <small>${esc(it.purpose)}</small>
                ${it.qty > 1 ? `<small>×${it.qty}</small>` : ``}
              </div>
              <button type="button" class="icon-btn" data-one="${i}" aria-label="Edit just this one">${icon(`edit`)}</button>
            </div>`).join(``)}
          </div>
          <div class="field"><span>Where are they?</span>
            <button type="button" class="loc-btn" data-loc>${icon(`place`)}<span>${locationId ? crumbs(locationId, { link: false }) : `<span class="muted">Choose a place</span>`}</span>${icon(`chevron`)}</button></div>
          <div class="row-actions"><button type="button" class="btn primary full" data-add>Add selected</button></div>`;
        updateCount();
      };
      const selected = () => [...ticked].sort((a, b) => a - b);
      const updateCount = () => { const n = selected().length; const b = $(`[data-add]`, el); b.textContent = n ? `Add ${n} item${n > 1 ? `s` : ``}` : `Nothing selected`; b.disabled = !n; };
      el.addEventListener(`change`, (e) => {
        if (!e.target.matches(`[data-i]`)) return;
        const i = Number(e.target.dataset.i);
        if (e.target.checked) ticked.add(i); else ticked.delete(i);
        updateCount();
      });
      el.addEventListener(`input`, (e) => {
        if (e.target.matches(`[data-name]`)) { items[Number(e.target.dataset.name)].name = e.target.value; e.target.classList.remove(`suggested`); }
      });
      el.addEventListener(`click`, async (e) => {
        const b = e.target.closest(`button`); if (!b) return;
        if (b.dataset.one !== undefined) { finish({ single: items[Number(b.dataset.one)] }); close(); return; }
        if (b.hasAttribute(`data-loc`)) {
          // keep the review sheet; stack the picker on top
          const id = await pickLocation(locationId, `Where are they?`);
          if (id) { locationId = id; items.forEach((it, i) => { if (hereDup(it)) ticked.delete(i); }); draw(); }
          return;
        }
        if (b.hasAttribute(`data-add`)) {
          if (!locationId) { const id = await pickLocation(``, `Where are they?`); if (!id) return; locationId = id; }
          const picks = selected();
          b.disabled = true; b.textContent = `Adding…`;
          for (const i of picks) {
            const it = items[i];
            if (!it.name.trim()) continue;
            await repo.saveItem({ name: it.name.trim(), purpose: it.purpose, category: it.category, tags: it.tags, qty: it.qty, notes: it.notes, locationId },
              { photo: crops[i].photo, thumb: crops[i].thumb });
          }
          rememberLoc(locationId);
          toast(`Added ${picks.length} item${picks.length > 1 ? `s` : ``} to ${repo.pathText(locationId)}`);
          finish({ added: picks.length, locationId }); close();
        }
      });
      draw();
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

// ============================================================ Places
function viewPlace(view, r) {
  const loc = r.id ? repo.locById(r.id) : null;
  if (r.id && !loc) { view.innerHTML = `<div class="empty"><h3>Place not found</h3><a class="btn ghost" href="#/places">All places</a></div>`; return; }
  const kids = repo.childrenOf(loc?.id || ``);
  const items = loc ? repo.itemsIn(loc.id) : [];
  const count = (id) => repo.itemsIn(id, true).length;
  view.innerHTML = `
    <div class="place">
      ${loc ? `<div class="crumbs top"><a href="#/places">All places</a><span class="sep">›</span>${crumbs(loc.id)}</div>` : ``}
      <div class="place-head">
        <h1>${loc ? `${icon(KIND_ICON[loc.kind] || `box`)} ${esc(loc.name)}` : `Places`}</h1>
        ${loc ? `<button class="icon-btn" data-a="menu" aria-label="Place options">${icon(`more`)}</button>` : ``}
      </div>
      ${kids.length ? `<div class="label-sm">${loc ? `Inside` : `Your places`}</div>
        <div class="list">${kids.map((k) => `<a class="list-row link-row" href="#/place/${esc(k.id)}">${icon(KIND_ICON[k.kind] || `box`)}<span>${esc(k.name)}</span><small>${count(k.id)}</small>${icon(`chevron`)}</a>`).join(``)}</div>`
        : loc ? `` : `<div class="empty"><h3>No places yet</h3><p>Start with a place like Home or Storage unit, then add rooms and containers inside it.</p></div>`}
      <div class="row-actions left">
        <button class="btn ghost" data-a="new">${icon(`plus`)} ${loc ? `Add spot inside` : `Add a place`}</button>
        ${loc ? `<a class="btn primary" href="#/add?loc=${esc(loc.id)}">${icon(`plus`)} Add item here</a>` : ``}
      </div>
      ${loc ? `<div class="row-actions left move-actions">
          <button class="btn ghost small" data-a="bring">${icon(`ret`)} Bring items here</button>
          <button class="btn ghost small" data-a="movespot">${icon(`move`)} Move this ${esc(loc.kind === `place` ? `place` : `spot`)}</button>
        </div>` : ``}
      ${loc ? `<div class="list-head"><div class="label-sm">Items here ${items.length ? `· ${items.length}` : ``}</div>${items.length ? `<button type="button" class="link small" data-select-toggle>${sel.on ? `Done` : `Select`}</button>` : ``}</div>
        ${items.length ? `<div class="cards">${items.map(itemCard).join(``)}</div>` : `<p class="muted">Nothing logged directly in ${esc(loc.name)}.</p>`}` : ``}
    </div>`;

  view.onclick = async (e) => {
    const b = e.target.closest(`[data-a]`); if (!b) return;
    if (b.dataset.a === `new`) {
      const name = await promptSheet(loc ? `New spot in ${loc.name}` : `New place`, {
        label: `Name`, placeholder: loc ? `e.g. Top shelf, Blue bin, Drawer 2` : `e.g. Home, Storage unit, Office`, okLabel: `Add` });
      if (name) { repo.saveLocation({ name, parentId: loc?.id || ``, kind: kindFor(loc?.id || ``) }); toast(`Added ${name}`); }
    }
    if (b.dataset.a === `menu`) placeMenu(loc);
    if (b.dataset.a === `bring`) bringItemsSheet(loc);
    if (b.dataset.a === `movespot`) moveSpot(loc);
  };
}

function placeMenu(loc) {
  sheet(loc.name, (el, close) => {
    el.innerHTML = `<div class="menu">
      <button data-m="rename">${icon(`edit`)} Rename</button>
      <button data-m="move">${icon(`move`)} Move inside another place</button>
      <button data-m="qr">${icon(`qr`)} Print QR label</button>
      <button data-m="delete" class="danger">${icon(`trash`)} Delete place</button></div>`;
    el.onclick = async (e) => {
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `rename`) {
        const name = await promptSheet(`Rename`, { label: `Name`, value: loc.name });
        if (name) repo.saveLocation({ id: loc.id, name });
      } else if (m === `move`) {
        moveSpot(loc);
      } else if (m === `qr`) printLabel(loc);
      else if (m === `delete`) {
        const n = repo.itemsIn(loc.id, true).length + repo.descendantIds(loc.id).size - 1;
        if (n) return toast(`Move or remove what’s inside first`);
        if (await confirmSheet(`Delete ${loc.name}?`, `This place is empty.`, `Delete`, true)) { repo.deleteLocation(loc); location.hash = loc.parentId ? `#/place/${loc.parentId}` : `#/places`; }
      }
    };
  });
}

async function printLabel(loc) {
  const url = `${location.origin}${location.pathname}#/place/${loc.id}`;
  let svg = ``;
  try {
    await new Promise((res, rej) => {
      if (window.qrcode) return res();
      const s = document.createElement(`script`);
      s.src = `https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js`;
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
    const qr = window.qrcode(0, `M`); qr.addData(url); qr.make();
    svg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch { return toast(`QR needs a connection the first time`); }
  const items = repo.itemsIn(loc.id, true);
  const w = window.open(``, `_blank`);
  if (!w) return toast(`Allow pop-ups to print labels`);
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(loc.name)} label</title>
    <style>body{font-family:system-ui,sans-serif;margin:24px;color:#111}.label{display:flex;gap:16px;align-items:center;border:2px dashed #999;padding:16px;width:fit-content;border-radius:12px}
    .label svg{width:140px;height:140px}.n{font-size:22px;font-weight:700}.p{color:#555;font-size:13px;margin-top:4px}ul{columns:2;font-size:13px;color:#333;max-width:640px}
    @media print{button{display:none}}</style></head><body>
    <div class="label">${svg}<div><div class="n">${esc(loc.name)}</div><div class="p">${esc(repo.pathText(loc.id))}</div><div class="p">Scan to see what’s inside</div></div></div>
    ${items.length ? `<h3>Inside (${items.length})</h3><ul>${items.map((i) => `<li>${esc(i.name)}</li>`).join(``)}</ul>` : ``}
    <p><button onclick="print()">Print</button></p></body></html>`);
  w.document.close();
}

/** Explicit opt-in for AI suggestions: explains the data flow, needs a checkbox + a working key. */
function aiConsent(keyOnly = false) {
  return new Promise((resolve) => {
    let done = false;
    sheet(keyOnly ? `Change API key` : `AI suggestions`, (el, close) => {
      el.innerHTML = `<form class="stack consent">
        ${keyOnly ? `` : `<div class="consent-points">
          <p>${icon(`camera`)}<span>When you use it, a reduced copy of the photo is sent <b>from this phone directly to Google Gemini</b>, using your own API key. Stash has no server and never sees it.</span></p>
          <p>${icon(`alert`)}<span>On Gemini’s <b>free tier</b>, Google may use what you send to improve its products, and people at Google may review it. Don’t photograph IDs, documents or anything private with AI on. Paid-tier keys aren’t used that way.</span></p>
          <p>${icon(`check`)}<span>You always review suggestions before anything is saved. Nothing you typed gets overwritten.</span></p>
          <p>${icon(`cloud`)}<span>The free tier allows a few hundred photos a day (check your limits in Google AI Studio). One photo of a bin can list many items.</span></p>
        </div>`}
        <ol class="key-steps">
          <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in.</li>
          <li>Tap <b>Create API key</b>, then copy it.</li>
          <li>Paste it below. It’s stored only on this device, not in your Sheet.</li>
        </ol>
        <label class="field"><span>Gemini API key</span><input name="key" autocomplete="off" spellcheck="false" placeholder="AIza…" required></label>
        ${keyOnly ? `` : `<label class="check"><input type="checkbox" name="agree" required><span>I understand that photos I choose to analyze are sent to Google Gemini.</span></label>`}
        <p class="error-box" hidden></p>
        <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn primary">${keyOnly ? `Save key` : `Verify &amp; turn on`}</button></div>
      </form>`;
      const form = $(`form`, el); const err = $(`.error-box`, el);
      $(`[data-no]`, el).onclick = () => { done = true; resolve(false); close(); };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const key = form.elements.key.value.trim();
        const btn = form.querySelector(`button.primary`); btn.disabled = true; btn.textContent = `Checking key…`; err.hidden = true;
        try {
          const model = await verifyKey(key);
          saveAiSettings({ enabled: true, key, model, consentAt: aiSettings().consentAt || new Date().toISOString() });
          done = true; resolve(true); close();
          toast(keyOnly ? `Key updated` : `AI suggestions are on`);
        } catch (ex) {
          err.textContent = ex.message || String(ex); err.hidden = false;
          btn.disabled = false; btn.innerHTML = keyOnly ? `Save key` : `Verify &amp; turn on`;
        }
      };
    }, { onClose: () => { if (!done) resolve(false); } });
  });
}

// ============================================================ More
function viewMore(view, r) {
  const g = repo.backend.kind === `google`;
  const total = repo.activeItems().length;
  const places = repo.locations.filter((l) => !l.deleted).length;
  view.innerHTML = `
    <div class="more">
      <h1>More</h1>
      <div class="account">
        ${repo.user.picture ? `<img src="${esc(repo.user.picture)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar">${esc((repo.user.name || `?`)[0])}</div>`}
        <div><b>${esc(repo.user.name)}</b><small>${esc(repo.user.email)}</small><small class="where-data">${icon(g ? `cloud` : `alert`)} ${esc(repo.label)}</small></div>
      </div>
      <div class="stats"><div><b>${total}</b><span>items</span></div><div><b>${places}</b><span>places</span></div>
        <div><b>${repo.activeItems().filter((i) => i.status === `lent`).length}</b><span>lent out</span></div></div>

      ${g ? `<div class="label-sm">Household</div>
      <div class="list">
        ${repo.members.map((m) => `<div class="list-row">${icon(`users`)}<span>${esc(m.email)}</span><small>${esc(m.role)}</small></div>`).join(``)}
      </div>
      ${repo.backend.canShare ? `<form class="inline-new" id="invite"><input type="email" placeholder="Family member’s Google email" required><button class="btn primary">Invite</button></form>
        <p class="fine">They get edit access to the sheet and can view photos. They open ${esc(CONFIG.APP_NAME)}, sign in, and choose “Join a shared inventory”.</p>` : `<p class="fine">This inventory is shared with you. The owner can invite others.</p>`}` : ``}

      ${(() => { const ppl = repo.people(); return ppl.length ? `<div class="label-sm">People you lend to</div>
        <div class="menu">${ppl.slice(0, 30).map((p) => `<button data-person="${esc(p.key)}"><span class="avatar sm">${esc(initials(p.name))}</span>
          <span class="grow">${esc(p.name)}</span><small class="${p.holding.length + p.saved.length ? `warn` : ``}">${[p.holding.length ? `has ${p.holding.length}` : ``, p.saved.length ? `${p.saved.length} saved` : ``].filter(Boolean).join(` · `) || `all returned`}</small></button>`).join(``)}</div>` : ``; })()}

      <div class="label-sm" id="ai">AI suggestions</div>
      ${aiReady() ? `<div class="menu">
          <div class="menu-info">${icon(`spark`)}<div><b>On</b><small>Model: ${esc(aiSettings().model)}</small><small>${aiUsageToday()} photo${aiUsageToday() === 1 ? `` : `s`} analyzed today on this device · resets 3 AM ET</small></div></div>
          <label class="menu-switch"><span>Identify automatically when I take a photo</span><span class="switch"><input type="checkbox" data-aiauto ${aiSettings().auto ? `checked` : ``}><i></i></span></label>
          <button data-m="aikey">${icon(`edit`)} Change API key</button>
          <button data-m="aioff" class="danger">${icon(`x`)} Turn off and remove key</button>
        </div>`
        : `<div class="ai-card">${icon(`spark`)}<div><b>Fill in details from a photo</b><p>Gemini can name what’s in a photo, say what it’s for, and list several items from one shot of a bin or shelf. Off until you turn it on.</p>
          <button class="btn primary" data-m="aion">Set up AI suggestions</button></div></div>`}

      <div class="label-sm">Your data</div>
      <div class="menu">
        ${g ? `<a href="${esc(repo.backend.sheetUrl)}" target="_blank" rel="noopener">${icon(`sheet`)} Open the Google Sheet</a>` : ``}
        <button data-m="csv">${icon(`download`)} Export as CSV (Excel)</button>
        <button data-m="sync">${icon(`cloud`)} Sync now</button>
      </div>

      <div class="label-sm">Account</div>
      <div class="menu">
        ${g ? `<button data-m="signout">${icon(`out`)} Sign out</button>`
          : `${googleConfigured() ? `<button data-m="google">${googleG()} Switch to Google Drive</button>` : ``}
             <button data-m="reset" class="danger">${icon(`trash`)} Clear demo data</button>`}
      </div>
      <p class="fine center">${esc(CONFIG.APP_NAME)} stores nothing on any server. ${g ? `Everything is in your Drive folder “${esc(CONFIG.ROOT_FOLDER_NAME)}”.` : ``}</p>
    </div>`;

  $(`#invite`)?.addEventListener(`submit`, async (e) => {
    e.preventDefault();
    const input = e.target.querySelector(`input`);
    const btn = e.target.querySelector(`button`); btn.disabled = true;
    try { await repo.invite(input.value.trim()); toast(`Invited ${input.value.trim()}`); input.value = ``; }
    catch (err) { toast(`Couldn’t invite: ${err.message}`); }
    finally { btn.disabled = false; }
  });
  $(`[data-aiauto]`, view)?.addEventListener(`change`, (e) => saveAiSettings({ auto: e.target.checked }));
  if (r?.params?.get(`ai`) === `1` && !aiReady()) setTimeout(() => aiConsent().then((ok) => ok && render()), 50);

  view.onclick = async (e) => {
    const who = e.target.closest(`[data-person]`);
    if (who) { personSheet(who.dataset.person); return; }
    const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
    if (m === `aion` || m === `aikey`) { if (await aiConsent(m === `aikey`)) render(); return; }
    if (m === `aioff`) {
      if (await confirmSheet(`Turn off AI suggestions?`, `The API key is removed from this device. Items already added keep their details.`, `Turn off`, true)) { disableAi(); render(); toast(`AI suggestions off`); }
      return;
    }
    if (m === `csv`) {
      const a = document.createElement(`a`);
      a.href = URL.createObjectURL(repo.exportCsv());
      a.download = `stash-inventory-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    }
    if (m === `sync`) { await repo.refresh(); toast(repo.status === `synced` ? `Up to date` : `Sync: ${repo.status}`); }
    if (m === `signout`) {
      if (repo.outbox.length && !(await confirmSheet(`Sign out?`, `${repo.outbox.length} change(s) haven’t reached Google yet and will be lost.`, `Sign out anyway`, true))) return;
      signOut(); [MODE_KEY, `stash.session`].forEach((k) => localStorage.removeItem(k)); location.hash = ``; location.reload();
    }
    if (m === `google`) { localStorage.removeItem(MODE_KEY); start(`google`, { interactive: true }); }
    if (m === `reset` && await confirmSheet(`Clear demo data?`, `Removes everything stored in this browser.`, `Clear`, true)) {
      localStorage.removeItem(`stash.cache.demo`); localStorage.removeItem(MODE_KEY); location.hash = ``; location.reload();
    }
  };
}

boot();
