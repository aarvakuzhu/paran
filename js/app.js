import { CONFIG } from './config.js';
import { googleConfigured, pickerConfigured, signIn, signOut, hasValidToken, tokenTimeLeft, pickSheets, AuthError } from './google.js';
import { chooseTemplate } from './templates.js';
import { seedPlaces, paranRoot, loadKnown, saveKnown, rememberInventory, discover, cachedCount, remoteCount, createInventory, createGroup, addToGroup, inviteToGroup, renameInventory, identify, readDirectory, groupAccess } from './inventories.js';
import { Repo } from './store.js';
import { XFRESH_MS, xmem, xlocal, xfetch, xpath } from './xinv.js';
import { blobs } from './idb.js';
import { search, findDuplicates } from './search.js';
import { processPhoto, processExtraPhoto, shrinkForAi, cropItem } from './image.js';
import { aiReady, aiSettings, saveAiSettings, disableAi, analyzePhoto, describeItem, scanPhotos, verifyKey, aiUsageToday, AiError, SIZES, aiTally, aiScore } from './ai.js';
import { esc, $, $$, toast, sheet, confirmSheet, promptSheet, icon, timeAgo } from './ui.js';
import { captureScan } from './scan.js';
import { initReceipts, scanReceipt, moneyText } from './receipt.js';
import { count as statCount, snapshot as statSnapshot, statsOn, setStatsOn, statsData, addFeedback, feedbackList, clearFeedback } from './stats.js';
import { searchHelp, topicsFor, topicById } from './help.js';
import { scanLabel } from './qrscan.js';
import { initEvents, viewEvents, viewEvent, eventCard, splitEvents, neededForHtml, linkLineToItem, redrawOpenAddSheet, myJobsHtml, toggleTaskDone } from './events.js';

const MODE_KEY = `paran.mode`;
const RECENT_LOC_KEY = `paran.recentLocs`;
let repo = null;
let findState = { q: ``, filter: `` };

const app = $(`#app`);
const KIND_ICON = { place: `home`, room: `room`, container: `box` };
const STATUS_LABEL = { lent: `Lent`, missing: `Missing`, reserved: `Reserved`, home: `` };
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

// ============================================================ updates
// The app opens from the copy on the phone. When a new version has finished downloading in the background,
// offer a reload (or apply it silently if the app was only just opened).
const bootedAt = Date.now();
function registerServiceWorker() {
  if (!(`serviceWorker` in navigator) || location.protocol === `file:`) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register(`./sw.js`, { updateViaCache: `none` }).then((reg) => {
    document.addEventListener(`visibilitychange`, () => { if (!document.hidden) reg?.update().catch(() => {}); });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener(`controllerchange`, () => {
    if (!hadController || reloading) return; // first install: nothing to update
    const busy = document.querySelector(`.sheet-wrap.open, .viewer`) || [`add`, `edit`].includes(route().name);
    if (Date.now() - bootedAt < 4000 && !busy) { reloading = true; location.reload(); return; }
    toast(`A new version of Paran is ready`, { action: `Reload`, ms: 15000, onAction: () => { reloading = true; location.reload(); } });
  });
}

// ============================================================ boot
async function boot() {
  registerServiceWorker();
  initEvents({
    repo: () => repo, thumbHtml, goBack, shareOut, shareSign: SHARE_SIGN, todayStr, invName, switchTo, pickLocation,
    openGroupInventories: (gid) => (gid ? openGroupInventories(gid) : Promise.resolve()), putInGroup,
    aiSetup: () => aiConsent(false), scanReceipt: (o) => scanReceipt(o),
    redraw: () => { // another inventory's items arrived: refresh whatever shows events
      if (document.querySelector(`.sheet-wrap.open`)) return redrawOpenAddSheet();
      const n = route().name;
      if (n === `find`) { if (!findState.q.trim() && !findState.filter) renderResults(); } else if (n === `events` || n === `event`) render();
    },
  });
  initReceipts({ repo: () => repo, aiSetup: () => aiConsent(false), pickLocation, todayStr, invName,
    done: () => { if ([`add`].includes(route().name)) location.hash = `#/`; else render(); } });
  window.addEventListener(`hashchange`, () => { if (sel.on) selStop(); render(); });
  installSelectionGestures();
  window.addEventListener(`online`, () => repo?.refresh());
  window.addEventListener(`offline`, () => { if (!repo) return; if (repo.backend.kind === `google`) repo.setStatus(`offline`); if (route().name === `find`) renderResults(); }); // search shows the offline note at once
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
  repo.addEventListener(`readonly`, onReadOnly);
    repo.addEventListener(`groupdenied`, onGroupDenied);
    renderShell();
    if (choice?.template) { location.hash = `#/places`; render(); await applyTemplate(choice.template); }
    else if (choice === `create` || choice?.create) location.hash = `#/setup`; // brand-new inventory: start by naming your places
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
  repo.addEventListener(`readonly`, onReadOnly);
  repo.addEventListener(`groupdenied`, onGroupDenied);
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

let roToastAt = 0;
function onReadOnly() {
  renderStatus(); document.body.classList.add(`readonly`);
  if (Date.now() - roToastAt > 4000) { roToastAt = Date.now(); toast(`You can view ${invName()}, but not change it. Ask its owner for edit access.`, { ms: 5000 }); }
}
function onGroupDenied() {
  toast(`Google didn’t let you change ${repo.group()?.name || `the group`}’s events. Ask the group’s owner for edit access.`, { ms: 6000 });
  repo.refresh();
}
const roleLabel = (role) => (role === `owner` ? `Owner` : role === `viewer` ? `Can view` : role === `pending-owner` ? `Owner (waiting to accept)` : `Can edit`);
const roleSelect = () => `<select name="role" aria-label="Access"><option value="writer">Can edit</option><option value="reader">Can view</option></select>`;

function onRepoChange() {
  statsSnapshot(); // the first one waits for data from Google; then at most every 10 minutes
  const r = route().name;
  if (r === `find`) { renderResults(); return; }
  if (r === `add` || r === `edit`) return; // never wipe a form mid-edit
  if (document.querySelector(`.sheet-wrap.open`)) return; // a sheet is open; its owner redraws
  render();
}

// ============================================================ pre-app screens
function renderWelcome(error) {
  window.__paranStarted = true; // something is on screen: the startup watchdog in index.html stands down
  const g = googleConfigured();
  app.innerHTML = `
  <main class="welcome">
    <div class="brand-mark">${icon(`box`)}</div>
    <h1>${esc(CONFIG.APP_NAME)}</h1>
    <p class="lead">Know what you have, where it is, and what it’s for.</p>
    <ul class="points">
      <li>${icon(`camera`)}<span>Snap, name, pick a place. Done in seconds.</span></li>
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
  window.__paranStarted = true; // something is on screen: the startup watchdog in index.html stands down
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
  window.__paranStarted = true; // something is on screen: the startup watchdog in index.html stands down
  app.innerHTML = `
  <main class="welcome">
    <h1>Hi ${esc((user.name || ``).split(` `)[0] || `there`)}</h1>
    <p class="lead">Start a new inventory, or join one someone shared with you.</p>
    <div class="choice-grid">
      <button class="choice" id="create">${icon(`plus`)}<b>Start a new inventory</b><span>Creates a folder and sheet in your Drive. You can add more inventories, or a group, later.</span></button>
      <button class="choice" id="join" ${pickerConfigured() ? `` : `disabled`}>${icon(`users`)}<b>Open one shared with you</b>
        <span>${pickerConfigured() ? `Pick the inventory sheet, or a group’s “directory” sheet, someone shared with you.` : `Needs API_KEY and APP_ID in js/config.js.`}</span></button>
    </div>
  </main>`;
  $(`#create`).onclick = async () => {
    const t = await chooseTemplate(app);
    if (!t) return renderChoice(user);
    if (t.empty) return start(`google`, { choice: { create: true, name: t.name } });
    start(`google`, { choice: { create: true, name: t.inventories[0].name, template: t } });
  };
  $(`#join`).onclick = async () => {
    try {
      const first = await joinFlow(user);
      if (first) start(`google`, { choice: first });
    } catch (e) { toast(e.message); }
  };
}

function renderLoading(msg) {
  window.__paranStarted = true; // something is on screen: the startup watchdog in index.html stands down
  app.innerHTML = `<main class="welcome"><div class="spinner"></div><p class="muted">${esc(msg)}</p></main>`;
}

const googleG = () => `<svg class="g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

// ============================================================ shell + routing
function renderShell() {
  window.__paranStarted = true; // something is on screen: the startup watchdog in index.html stands down
  app.innerHTML = `
    <header class="topbar">
      ${repo.backend.kind === `google`
        ? `<button type="button" class="logo inv-switch" id="invsw" aria-label="Switch inventory">${icon(`box`)}<span id="invname"></span>${icon(`chevron`, `down`)}</button>`
        : `<a href="#/" class="logo">${icon(`box`)}<span>${esc(CONFIG.APP_NAME)}</span></a>`}
      <button type="button" class="icon-btn help-btn" id="helpbtn" aria-label="Help">?</button>
      <button class="status" id="status" type="button"></button>
    </header>
    <main id="view" class="view"></main>
    <nav class="tabbar">
      <a href="#/" data-tab="find">${icon(`search`)}<span>Find</span></a>
      <a href="#/places" data-tab="places">${icon(`place`)}<span>Places</span></a>
      <a href="#/add" class="fab" data-tab="add" aria-label="Add item">${icon(`plus`)}</a>
      <a href="#/out" data-tab="out">${icon(`lend`)}<span>Out</span><b class="tab-badge" hidden></b></a>
      <a href="#/more" data-tab="more">${icon(`more`)}<span>More</span></a>
    </nav>`;
  $(`#status`).onclick = onStatusClick;
  $(`#helpbtn`).onclick = () => helpSheet();
  $(`#invsw`)?.addEventListener(`click`, inventoriesSheet);
  renderStatus();
}

function renderStatus() {
  const el = $(`#status`); if (!el || !repo) return;
  const s = repo.status;
  const pending = repo.outbox.length;
  const map = {
    synced: [`ok`, `Saved`], idle: [`ok`, `Saved`], syncing: [`busy`, `Saving…`],
    pending: [`warn`, `${pending} to save`], offline: [`warn`, pending ? `Offline · ${pending} waiting` : `Offline`],
    auth: [`warn`, pending ? `${pending} waiting · tap to sync` : `Tap to sync`], error: [`bad`, `Not saved yet`],
  };
  const [cls, label] = repo.backend.kind === `demo` ? [`demo`, `Demo`]
    : repo.readOnly && [`synced`, `idle`].includes(s) ? [`demo`, `View only`] : (map[s] || map.idle);
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

// In-app navigation history, so Back returns to where you came from (a place, Out, a search…).
const navStack = [];
let lastHash = null;
function goBack(fallback = `#/`) {
  navStack.pop(); // current screen
  const prev = navStack.pop();
  location.hash = prev ?? fallback;
}

function render() {
  if (!repo || !$(`#view`)) return;
  statsSnapshot(); // at most every 10 minutes
  const r = route();
  const routeChanged = location.hash !== lastHash;
  if (routeChanged) {
    lastHash = location.hash;
    if (navStack[navStack.length - 1] !== location.hash) navStack.push(location.hash);
    if (navStack.length > 30) navStack.shift();
  }
  const tab = { find: `find`, item: `find`, edit: `add`, add: `add`, places: `places`, place: `places`, out: `out`, more: `more`, setup: `places`, group: `places`, events: `more`, event: `more` }[r.name] || `find`;
  const nm = $(`#invname`); if (nm) nm.textContent = invName();
  $$(`.tabbar a`).forEach((a) => a.classList.toggle(`active`, a.dataset.tab === tab));
  document.body.classList.toggle(`readonly`, Boolean(repo.readOnly)); // "Can view": edit actions are hidden
  if (repo.readOnly && [`add`, `edit`, `setup`].includes(r.name)) { toast(`You can view ${invName()}, not change it`); location.replace(`#/`); return; }
  document.body.classList.toggle(`focus-mode`, r.name === `add` || r.name === `edit` || r.name === `setup`); // no tab bar while filling a form
  if (routeChanged && (r.name === `add` || r.name === `edit`)) $$(`#toasts .toast`).forEach((t) => t.remove()); // an Undo from another screen doesn't belong here
  updateOutBadge();
  const view = $(`#view`);
  const y = window.scrollY;
  view.onclick = null; view.onsubmit = null;
  const screens = { find: viewFind, item: viewItem, add: viewEdit, edit: viewEdit, places: viewPlace, place: viewPlace, out: viewOut, more: viewMore, setup: viewSetup, group: viewGroup, events: viewEvents, event: viewEvent };
  (screens[r.name] || viewFind)(view, r);
  window.scrollTo(0, routeChanged ? 0 : y); // a background sync must not jump the page to the top
}

function updateOutBadge() {
  const b = $(`.tab-badge`); if (!b || !repo) return;
  const late = repo.activeItems().filter((i) => attentionReason(i)?.urgent).length;
  b.hidden = !late; b.textContent = late;
}

// ============================================================ shared bits
function thumbHtml(item, cls = `thumb`) {
  const t = repo.thumbs[item.id];
  return t ? `<img class="${cls}" src="${t}" alt="" loading="lazy">` : `<div class="${cls} ph">${icon(`photo`)}</div>`;
}

/** Card for an item. The location is the answer people came for, so it's the most visible line. */
function itemCard(item, { reason } = {}) {
  const parts = repo.pathOf(item.locationId);
  const near = parts.slice(-2).map((l) => l.name).join(` › `);           // "Garage › Blue bin"
  const far = parts.length > 2 ? parts.slice(0, -2).map((l) => l.name).join(` › `) : ``; // "Home"
  const due = item.status === `reserved` ? dueText(item.dueAt) : { text: `` };
  const badge = item.status === `reserved`
    ? `<span class="badge reserved${due.late ? ` late` : ``}">Reserved · ${esc(item.lentTo || `someone`)}${due.text ? ` · ${esc(due.text)}` : ``}</span>`
    : STATUS_LABEL[item.status] ? `<span class="badge ${esc(item.status)}">${esc(STATUS_LABEL[item.status])}${item.status === `lent` && item.lentTo ? ` · ${esc(item.lentTo)}` : ``}</span>` : ``;
  const cls = `${sel.on ? ` selectable` : ``}${sel.ids.has(item.id) ? ` selected` : ``}`;
  return `<a class="card${cls}" href="#/item/${esc(item.id)}" data-id="${esc(item.id)}">
    <span class="sel-tick" aria-hidden="true">${icon(`check`)}</span>
    ${thumbHtml(item)}
    <div class="card-main">
      <div class="card-title">${esc(item.name)}${Number(item.qty) > 1 ? ` <span class="qty">×${esc(item.qty)}</span>` : ``}</div>
      <div class="card-path">${icon(`place`)}<span>${near ? esc(near) : `<i>No location yet</i>`}${far ? `<small> · ${esc(far)}</small>` : ``}</span></div>
      ${reason ? `<div class="card-reason ${reason.urgent ? `urgent` : ``}">${esc(reason.text)}</div>`
        : item.purpose ? `<div class="card-purpose">${esc(item.purpose)}</div>` : ``}
      ${reason ? `` : badge}
    </div></a>`;
}

// ---- what deserves attention on the dashboard and the Out tab
const LONG_LENT_DAYS = 30;
let lentMemo = { key: ``, map: new Map() };
function lentSinceMap() {
  const key = `${repo.log.length}:${repo.items.length}:${repo.outbox.length}`;
  if (lentMemo.key !== key) {
    const map = new Map();
    for (const p of repo.lendPeriods()) if (p.lentAt && !p.returnedAt) map.set(p.itemId, p.lentAt);
    lentMemo = { key, map };
  }
  return lentMemo.map;
}
/** { text, urgent, rank } or null. Lower rank = show first. */
function attentionReason(item) {
  if (item.status === `reserved` && item.dueAt) {
    const d = dueText(item.dueAt);
    if (d.late) return { text: `Pick-up ${d.text} · ${item.lentTo}`, urgent: true, rank: 0 };
    if (/today|tomorrow/.test(d.text)) return { text: `${d.text.replace(/^pick up/, `Pick-up`)} · ${item.lentTo}`, urgent: false, rank: 1 };
  }
  if (item.status === `lent`) {
    const since = lentSinceMap().get(item.id); const n = since ? daysBetween(since) : null;
    if (n !== null && n >= LONG_LENT_DAYS) return { text: `With ${item.lentTo} for ${n} days`, urgent: false, rank: 2 };
  }
  if (item.status === `missing`) return { text: `Marked missing`, urgent: false, rank: 3 };
  return null;
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
function pickLocation(startId = ``, title = `Where does it live?`, { exclude = null, inside = null } = {}) {
  return new Promise((resolve) => {
    let current = inside ?? (startId ? (repo.locById(startId)?.parentId || ``) : ``);
    if (exclude?.has(current)) current = ``;
    let done = false;
    const ok = (l) => !exclude || !exclude.has(l.id);
    sheet(title, (el, close) => {
      const finish = (id) => { done = true; rememberLoc(id); resolve(id); close(); };
      el.innerHTML = `<label class="search sm">${icon(`search`)}<input data-q type="search" placeholder="Search places" autocomplete="off" enterkeyhint="search">
        <button type="button" class="icon-btn search-qr" data-scanpick aria-label="Scan a label">${icon(`qr`)}</button></label><div class="pk-body"></div>`;
      const qEl = $(`[data-q]`, el); const body = $(`.pk-body`, el);
      $(`[data-scanpick]`, el).addEventListener(`click`, async (e) => {
        e.preventDefault();
        const loc = await scanToPlace(title, `Point at the label on the box or shelf.`);
        if (loc && ok(loc)) finish(loc.id);
        else if (loc) toast(`Can’t put it there`);
      });
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
            <button type="button" class="btn ghost" data-new>${icon(`plus`)} New place${current ? ` in ${esc(here?.name || ``)}` : ``}</button>
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
    <button type="button" class="btn ghost" data-s="share" ${n ? `` : `disabled`} aria-label="Share">${icon(`share`)}<span>Share</span></button>
    <button type="button" class="btn primary" data-s="move" ${n ? `` : `disabled`}>${icon(`move`)} Move</button>`;
}
async function onSelBar(e) {
  const s = e.target.closest(`[data-s]`)?.dataset.s; if (!s) return;
  if (s === `cancel`) return selStop();
  if (s === `all`) {
    const vis = visibleIds(); const all = vis.every((id) => sel.ids.has(id));
    vis.forEach((id) => (all ? sel.ids.delete(id) : sel.ids.add(id))); return refreshSel();
  }
  if (s === `share`) {
    const items = [...sel.ids].map((id) => repo.items.find((i) => i.id === id)).filter(Boolean);
    if (await shareSelection(items)) selStop();
    return;
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
            <button type="button" data-mode="later" role="tab">${icon(`clock`)} Reserve</button>
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
        $(`[data-ok]`, el).textContent = mode === `now` ? `Lend` : `Reserve`;
      };
      const drawQuick = () => $$(`[data-due]`, el).forEach((c) => c.classList.toggle(`on`, c.dataset.due === due.value));
      const draw = () => {
        const q = Repo.personKey(input.value);
        const list = (q ? people.filter((p) => p.key.includes(q)).sort((a, b) => (b.key.startsWith(q) - a.key.startsWith(q))) : people)
          .filter((p) => p.key !== q || !picked); // hide the exact match once chosen
        box.innerHTML = list.slice(0, 6).map((p) => `<button type="button" class="suggest-row" data-name="${esc(p.name)}" role="option">
            <span class="avatar sm">${esc(initials(p.name))}</span><span>${esc(p.name)}</span>
            <small>${[p.holding.length ? `has ${p.holding.length}` : ``, p.saved.length ? `${p.saved.length} reserved` : ``].filter(Boolean).join(` · `) || `lent ${p.total}×`}</small></button>`).join(``);
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
    const ok = await confirmSheet(`Reserved for ${savedFor}`, `${item.name} is reserved for ${savedFor}. ${res.mode === `now` ? `Lend it to ${res.name}` : `Reserve it for ${res.name}`} instead?`, `Yes, ${res.mode === `now` ? `lend to` : `reserve for`} ${res.name}`);
    if (!ok) return;
  }
  if (res.mode === `now`) {
    if (savedFor && Repo.personKey(savedFor) === Repo.personKey(res.name)) await repo.pickUp(item);
    else await repo.lendItem(item, res.name);
    toast(`Lent to ${res.name}`);
  } else {
    await repo.reserveItem(item, res.name, res.dueAt);
    toast(`Reserved for ${res.name}${res.dueAt ? ` · ${dueText(res.dueAt).text}` : ``}`);
  }
}

// ---------------- full-screen photo, inside the app (no Drive page, no second login)
const SIZE_HINT = { Pocket: `keys, cables`, 'Hand-held': `drill, book`, Shoebox: `fits in a shoebox`, 'Carry-on': `suitcase-sized`, Large: `needs two hands`, Furniture: `needs two people` };
const MAX_PHOTOS = 6; // main + 5 more

/** Row of additional photos + an "add more" tile. `tiles` = [{ key, thumb }] */
function photoRowHtml(tiles, { canAdd = true } = {}) {
  return `<div class="pstrip">${tiles.map((t) => `<button type="button" class="ptile" data-view="${esc(t.key)}">${t.thumb ? `<img src="${t.thumb}" alt="Photo">` : `<span class="ph">${icon(`photo`)}</span>`}</button>`).join(``)}
    ${canAdd ? `<label class="ptile add"><input type="file" accept="image/*" multiple hidden data-xadd>${icon(`plus`)}<b>${tiles.length ? `More` : `More photos`}</b><small>other sides, labels, size</small></label>` : ``}</div>`;
}
function itemPhotoRowHtml(item) {
  const xs = repo.photosOf(item);
  return photoRowHtml(xs.map((p) => ({ key: p.pid, thumb: repo.thumbs[`x:${p.pid}`] })), { canAdd: xs.length + 1 < MAX_PHOTOS });
}
/** Up to 6 of the item's photos, reduced for AI (skips any this device can't read). */
async function itemAiImages(item, { skipCover = false } = {}) {
  const out = [];
  const add = async (getUrl) => { try { const url = await getUrl(); if (url) out.push(await shrinkForAi(await (await fetch(url)).blob())); } catch { /* skip */ } };
  if (!skipCover && (item.photoId || repo.thumbs[item.id])) await add(() => repo.photoObjectUrl(item));
  for (const p of repo.photosOf(item)) { if (out.length >= MAX_PHOTOS) break; await add(() => repo.extraPhotoUrl(p)); }
  return out;
}
const specLine = (r) => [r.model, r.details].filter(Boolean).join(` · `);

/** Saved item: look at all its photos and fill in what's missing. Never overwrites what's there; Undo restores. */
async function aiMergeIntoItem(itemId) {
  if (!aiReady() || !aiSettings().auto) return;
  const item = repo.items.find((i) => i.id === itemId); if (!item) return;
  try {
    const imgs = await itemAiImages(item); if (!imgs.length) return;
    toast(`Looking at ${imgs.length} photo${imgs.length > 1 ? `s` : ``}…`, { ms: 15000 });
    const r = await describeItem(imgs, item, { categories: repo.categories() });
    const cur = repo.items.find((i) => i.id === itemId); if (!cur) return;
    const patch = {}; const before = {}; const said = [];
    const mayChange = (k) => !String(cur[k] ?? ``).trim() || repo.fieldSetByAi(itemId, k); // empty, or AI's own earlier guess
    const fill = (k, v, label) => { if (v && mayChange(k) && String(cur[k] ?? ``) !== v) { patch[k] = v; before[k] = cur[k] || ``; said.push(label); } };
    fill(`purpose`, r.purpose, `what it’s for`); fill(`category`, r.category, `category`); fill(`size`, r.size, `size (${r.size})`); fill(`tags`, r.tags, `search words`);
    const line = specLine(r);
    if (line && !String(cur.notes || ``).toLowerCase().includes((r.model || line).toLowerCase())) {
      before.notes = cur.notes || ``; patch.notes = cur.notes ? `${cur.notes}\n${line}` : line; said.push(r.model ? `model ${r.model}` : `specs`);
    }
    if (!said.length) { toast(`AI found nothing new in the photos`); return; }
    await repo.saveItem({ id: itemId, ...patch }, { info: `Updated by AI (${imgs.length} photo${imgs.length > 1 ? `s` : ``}): ${said.join(`, `)}` });
    toast(`AI updated ${said.join(`, `)}. You can restore earlier text from History.`, { action: `Undo`, ms: 9000, onAction: () => repo.saveItem({ id: itemId, ...before }, { info: `Undid the AI update` }) });
  } catch (err) { toast(err instanceof AiError ? err.message : `AI couldn’t read the photos this time`, { ms: 5000 }); }
}

// ---------------- full-screen photos, inside the app (no Drive page, no second login); swipe between them
function photoViewer(item, startKey = `main`) {
  const slides = [];
  if (repo.thumbs[item.id] || item.photoId) slides.push({ key: `main`, label: `Photo`, thumb: repo.thumbs[item.id], load: () => repo.photoObjectUrl(item), url: item.photoUrl });
  for (const p of repo.photosOf(item)) {
    slides.push({ key: p.pid, pid: p.pid, label: `Photo`, thumb: repo.thumbs[`x:${p.pid}`], load: () => repo.extraPhotoUrl(p), url: p.url, removable: true });
  }
  if (!slides.length) return;
  let idx = Math.max(0, slides.findIndex((x) => x.key === startKey));
  const wrap = document.createElement(`div`);
  wrap.className = `viewer`;
  wrap.innerHTML = `<button type="button" class="viewer-x" aria-label="Close">${icon(`x`)}</button>
    <div class="viewer-stage"></div>
    ${slides.length > 1 ? `<button type="button" class="viewer-nav prev" aria-label="Previous">${icon(`back`)}</button><button type="button" class="viewer-nav next" aria-label="Next">${icon(`chevron`)}</button>` : ``}
    <div class="viewer-bar"><div class="viewer-cap"></div><span class="viewer-note"></span>
      ${slides.length > 1 ? `<div class="viewer-dots">${slides.map((_, i) => `<i data-i="${i}"></i>`).join(``)}</div>` : ``}</div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add(`open`));
  const stage = $(`.viewer-stage`, wrap); const note = $(`.viewer-note`, wrap); const cap = $(`.viewer-cap`, wrap);
  const close = () => { wrap.classList.remove(`open`); setTimeout(() => wrap.remove(), 200); document.removeEventListener(`keydown`, onKey); };
  const go = (d) => { idx = (idx + d + slides.length) % slides.length; show(); };
  const onKey = (e) => { if (e.key === `Escape`) close(); if (e.key === `ArrowRight`) go(1); if (e.key === `ArrowLeft`) go(-1); };
  document.addEventListener(`keydown`, onKey);
  let token = 0;
  const show = () => {
    const sl = slides[idx]; const my = ++token;
    stage.innerHTML = sl.thumb ? `<img src="${sl.thumb}" alt="${esc(item.name)} – ${esc(sl.label)}">` : `<div class="spinner"></div>`;
    cap.innerHTML = `<b>${esc(item.name)}</b>${slides.length > 1 ? ` · ${idx + 1} of ${slides.length}` : ``}${sl.removable ? ` <button type="button" class="link-light" data-remove>Remove</button>` : ``}`;
    note.textContent = ``;
    $$(`.viewer-dots i`, wrap).forEach((d, i) => d.classList.toggle(`on`, i === idx));
    sl.load().then((url) => {
      if (my !== token) return;
      if (url) { stage.innerHTML = `<img src="${url}" alt="${esc(item.name)} – ${esc(sl.label)}">`; return; }
      if (!sl.thumb) stage.innerHTML = `<p class="muted">Not uploaded yet.</p>`;
      else if (sl.url) note.innerHTML = `Preview only. The full photo is in ${esc((item.addedBy || `another member`).split(`@`)[0])}’s Drive. <a href="${esc(sl.url)}" target="_blank" rel="noopener">Open in Drive</a>`;
    }).catch((err) => {
      if (my !== token || !(err instanceof AuthError)) return;
      note.innerHTML = `<button type="button" class="btn small primary" data-load>Load full photo</button>`;
      $(`[data-load]`, note).onclick = async (ev) => { ev.stopPropagation(); note.textContent = `Loading…`; if (await renewNow()) show(); else note.textContent = `Couldn’t reach Google. Showing preview.`; };
    });
  };
  wrap.addEventListener(`click`, async (e) => {
    if (e.target.closest(`.viewer-nav.prev`)) return go(-1);
    if (e.target.closest(`.viewer-nav.next`)) return go(1);
    const dot = e.target.closest(`.viewer-dots i`); if (dot) { idx = Number(dot.dataset.i); return show(); }
    if (e.target.closest(`[data-remove]`)) {
      const sl = slides[idx];
      if (await confirmSheet(`Remove this photo?`, `The item keeps its other photos.`, `Remove`, true)) { close(); await repo.removeExtraPhoto(item.id, sl.pid); toast(`Photo removed`); }
      return;
    }
    if (e.target === wrap || e.target.closest(`.viewer-x`) || e.target.classList.contains(`viewer-stage`)) close();
  });
  let sx = null; // swipe left/right
  stage.addEventListener(`touchstart`, (e) => { if (e.touches.length === 1) sx = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener(`touchend`, (e) => { if (sx === null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 50 && slides.length > 1) go(dx < 0 ? 1 : -1); });
  show();
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
    case e.action === `returned`: return { title: e.detail ? `Returned by ${person(e.detail)}` : `Returned` };
    case e.action === `reserved`: return { title: `Reserved for ${person(e.detail)}`, note: due ? `Pick up by ${esc(new Date(`${due}T00:00`).toLocaleDateString(undefined, { weekday: `short`, month: `short`, day: `numeric` }))}` : `` };
    case e.action === `unreserved`: return { title: `No longer reserved for ${e.detail ? person(e.detail) : `them`}` };
    case e.action === `missing`: return { title: `Marked missing` };
    case e.action === `found`: return { title: `Found` };
    case e.action === `removed`: return { title: `Removed from inventory` };
    case e.action === `edited`: return { title: `Edited`, note: esc(e.info || ``) };
    case /^qty\+\d+$/.test(e.action): return { title: `Added ${esc(e.action.slice(4))} more`, icon: `plus` };
    default: return { title: esc(e.action) };
  }
}

const FIELD_LABEL = { name: `Name`, purpose: `What it’s for`, category: `Category`, size: `Size`, tags: `Search words`, qty: `How many`, warranty: `Warranty until`, expiry: `Expires`, notes: `Notes`, price: `Price`, store: `Bought at`, boughtAt: `Bought on` };

function itemHistoryHtml(item) {
  const hist = repo.itemHistory(item.id);
  if (!hist.length) return ``;
  const SHOW = 5;
  const rows = hist.map((e, i) => {
    const d = describeEntry(e, hist[i + 1]);
    const who = whoName(e.by);
    const ch = Repo.parseChanges(e.changes); delete ch._ai;
    const fields = Object.keys(ch).filter((f) => FIELD_LABEL[f]);
    const diff = fields.length ? `<div class="ih-diff">${fields.map((f) => `<div class="ih-change">
        <div class="ih-field">${esc(FIELD_LABEL[f])}</div>
        <div class="ih-old">${ch[f][0] ? esc(ch[f][0]) : `<i>empty</i>`}</div>
        <div class="ih-new">${ch[f][1] ? esc(ch[f][1]) : `<i>empty</i>`}</div>
        <button type="button" class="btn ghost small" data-useold="${esc(e.ts)}" data-field="${f}">Restore</button></div>`).join(``)}
      ${fields.length > 1 ? `<button type="button" class="link small" data-useold="${esc(e.ts)}" data-field="*">Restore all</button>` : ``}</div>` : ``;
    const title = fields.length && /^(AI\b|Updated by AI)/.test(e.info || ``) ? `${icon(`spark`)} ${esc(e.info.split(`:`)[0].replace(/^AI from (.+)$/, `Updated by AI ($1)`))}` : d.title;
    return `<div class="ih-row${i >= SHOW ? ` extra` : ``}">
      <span class="ih-ic">${icon(d.icon || ACTION_ICON[e.action] || `edit`)}</span>
      <div><div class="ih-title">${title}</div>${diff || (d.note ? `<div class="ih-note">${d.note}</div>` : ``)}
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
  if (h.savedAt) parts.push(`Reserved ${fmtDate(h.savedAt)}${h.dueAt ? ` (by ${fmtDate(`${h.dueAt}T12:00`)})` : ``}`);
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
  sheet(person.name, (el, close) => {
    const draw = () => {
      const p = repo.people().find((x) => x.key === key) || { ...person, holding: [], saved: [] };
      const hist = repo.personHistory(key);
      const sinceOf = (id) => hist.find((h) => h.itemId === id && h.lentAt && !h.returnedAt)?.lentAt;
      const borrowed = hist.filter((h) => h.lentAt).length;
      const summary = [p.holding.length ? `Has ${p.holding.length} item${p.holding.length > 1 ? `s` : ``} now` : `Has nothing of yours now`,
        p.saved.length ? `${p.saved.length} reserved` : ``, borrowed ? `borrowed ${borrowed} time${borrowed === 1 ? `` : `s`}` : ``].filter(Boolean).join(` · `);
      el.innerHTML = `
        <div class="person-head"><span class="avatar">${esc(initials(p.name))}</span>
          <div><b>${esc(p.name)}</b><small>${esc(summary)}</small></div></div>
        ${p.saved.length ? `<div class="label-sm">Reserved for ${esc(p.name)}</div>
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
        if (it) { await repo.returnItem(it); toast(`${it.name} returned`); draw(); }
        return;
      }
      if (b.dataset.pick) {
        const it = repo.items.find((i) => i.id === b.dataset.pick);
        if (it) { await repo.pickUp(it); toast(`${it.name} is now lent to ${it.lentTo}`); draw(); }
        return;
      }
      if (b.dataset.unsave) {
        const it = repo.items.find((i) => i.id === b.dataset.unsave);
        if (it) { await repo.cancelReservation(it); toast(`No longer reserved for ${person.name}`); draw(); }
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

// ============================================================ Find (landing dashboard + search)
function viewFind(view) {
  const cats = repo.categories();
  { // drop a filter whose chip no longer exists
    const f = findState.filter;
    if ([`lent`, `reserved`, `missing`].includes(f) && !repo.activeItems().some((i) => i.status === f)) findState.filter = ``;
    if (f.startsWith(`cat:`) && !cats.includes(f.slice(4))) findState.filter = ``;
  }
  const first = (repo.user?.name || ``).split(` `)[0];
  const hr = new Date().getHours();
  const hello = `${hr < 12 ? `Good morning` : hr < 18 ? `Good afternoon` : `Good evening`}${first ? `, ${first}` : ``}`;
  view.innerHTML = `
    <div class="find-top" id="find-top">
      <div class="hello"><small>${esc(hello)}</small><h1>Your things</h1></div>
      <div class="search-wrap">
        <label class="search">${icon(`search`)}<input id="q" type="search" placeholder="Search, e.g. fix a leak" value="${esc(findState.q)}" autocomplete="off" enterkeyhint="search">
          <button type="button" class="icon-btn search-qr" id="scanlabel" aria-label="Scan a box or shelf label">${icon(`qr`)}</button></label>
      </div>
      <div class="chips scroll scopes" id="scopes"></div>
      ${cats.length ? `<div class="chips scroll" id="filters">${cats.map((c) => `<button class="chip" data-f="cat:${esc(c)}">${esc(c)}</button>`).join(``)}</div>` : `<div id="filters"></div>`}
    </div>
    <div id="results"></div>`;
  const q = $(`#q`); const top = $(`#find-top`);
  // Category chips only while searching, so the landing page stays calm.
  const searching = () => top.classList.toggle(`searching`, document.activeElement === q || Boolean(findState.q.trim() || findState.filter.startsWith(`cat:`)));
  q.addEventListener(`focus`, searching);
  q.addEventListener(`blur`, () => setTimeout(searching, 250)); // let a chip tap land first
  q.addEventListener(`input`, () => { findState.q = q.value; if (!q.value.trim()) xdrop.clear(); renderResults(); countSearchSoon(q.value); });
  $(`#scopes`).addEventListener(`click`, (e) => {
    const c = e.target.closest(`[data-scope]`); if (!c) return;
    const id = c.dataset.scope; if (xdrop.has(id)) xdrop.delete(id); else xdrop.add(id);
    renderResults();
  });
  $(`#scanlabel`).addEventListener(`click`, (e) => { e.preventDefault(); scanLabelFlow(); });
  $(`#results`).addEventListener(`click`, async (e) => {
    const xc = e.target.closest(`[data-xinv]`);
    if (xc) { e.preventDefault(); return switchTo(xc.dataset.xinv, { hash: `#/item/${xc.dataset.xitem}` }); }
    const xo = e.target.closest(`[data-xopen]`);
    if (xo) { e.preventDefault(); await openGroupInventories(xo.dataset.xopen); return renderResults(); }
    const td = e.target.closest(`[data-taskdone]`); if (td) { e.preventDefault(); toggleTaskDone(td.dataset.taskdone); return renderResults(); }
    const p = e.target.closest(`[data-person]`); if (p) { e.preventDefault(); return personSheet(p.dataset.person); }
    const s = e.target.closest(`[data-show]`); if (s) { e.preventDefault(); findState.filter = s.dataset.show; renderResults(); return window.scrollTo(0, 0); }
    const q2 = e.target.closest(`[data-quick]`);
    if (q2) {
      e.preventDefault();
      const it = repo.items.find((x) => x.id === q2.dataset.id); if (!it) return;
      if (q2.dataset.quick === `return`) { await repo.returnItem(it); toast(`${it.name} returned`); }
      else if (q2.dataset.quick === `pickup`) { await repo.pickUp(it); toast(`Lent to ${it.lentTo}`); }
      else if (q2.dataset.quick === `found`) { await repo.markFound(it); toast(`Found`); }
      renderResults();
    }
  });
  $(`#filters`).addEventListener(`click`, (e) => {
    const b = e.target.closest(`[data-f]`); if (!b) return;
    findState.filter = findState.filter === b.dataset.f ? `` : b.dataset.f;
    renderResults(); searching();
  });
  searching();
  renderResults();
}

/** A soft colour per word, so tiles without photos still look intentional (and differ from each other). */
const TINTS = [150, 35, 265, 12, 205, 60, 330, 95];
function tintOf(text) {
  let h = 7; for (const ch of String(text || ``)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}
function tileImg(item, cls) {
  const t = repo.thumbs[item.id];
  return t ? `<img class="${cls}" src="${t}" alt="" loading="lazy">`
    : `<div class="${cls} tint" style="--h:${tintOf(item.id || item.name)}">${icon(`box`)}</div>`;
}

function renderResults() {
  const box = $(`#results`); if (!box) return;
  const sig = repo.categories().join();
  if (box.dataset.sig && box.dataset.sig !== sig) { box.dataset.sig = ``; return viewFind($(`#view`)); } // chips changed
  box.dataset.sig = sig;
  $$(`#filters [data-f]`).forEach((b) => b.classList.toggle(`on`, b.dataset.f === findState.filter));
  const all = repo.activeItems();
  const f = findState.filter; const q = findState.q.trim();
  $(`#find-top`)?.classList.toggle(`busy`, Boolean(q || f));

  if (!all.length) {
    const noPlaces = !repo.locations.some((l) => !l.deleted);
    box.innerHTML = `<div class="empty">${icon(`box`, `big`)}<h3>Nothing here yet</h3>
      ${noPlaces ? `<p>Start by telling Paran where you keep things. It takes 30 seconds.</p><a class="btn primary" href="#/setup">${icon(`place`)} Set up your places</a>`
        : `<p>Add the first thing you always end up hunting for.</p><a class="btn primary" href="#/add">${icon(`plus`)} Add an item</a>`}</div>`;
    return;
  }

  if (q || f) { // search / filter results
    let list = all;
    if ([`lent`, `missing`, `reserved`].includes(f)) list = list.filter((i) => i.status === f);
    else if (f.startsWith(`cat:`)) list = list.filter((i) => i.category === f.slice(4));
    list = q ? search(list, q, (id) => repo.pathText(id))
      : f === `recent` ? [...list].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
      : [...list].sort((a, b) => a.name.localeCompare(b.name));
    const cross = q && !f && crossReady();
    if (q && !list.length && !cross) {
      box.innerHTML = `<div class="empty"><h3>No match for “${esc(q)}”</h3><p>Looks like you don’t have it logged. Maybe you don’t have one, or it hasn’t been added yet.</p><a class="btn ghost" href="#/add?name=${encodeURIComponent(q)}">${icon(`plus`)} Add “${esc(q)}”</a></div>`;
      return;
    }
    if (cross) { // every inventory: this one first, then the rest as they come in
      const hereOff = xdrop.has(repo.backend.sheetId);
      box.innerHTML = `<div id="xstatus"></div>
        ${hereOff ? `` : `<div class="list-head"><div class="label-sm">${esc(invName())} · ${list.length ? `${list.length} found` : `no match`}</div>${list.length ? `<button type="button" class="link small" data-select-toggle>${sel.on ? `Done` : `Select`}</button>` : ``}</div>
        ${list.length ? `<div class="cards">${list.slice(0, 300).map((i) => itemCard(i)).join(``)}</div>` : ``}`}
        <div id="xresults"></div>`;
      crossSearch(q, hereOff ? 0 : list.length, list.length);
      return;
    }
    if ($(`#scopes`)) $(`#scopes`).innerHTML = ``;
    const title = !q && f === `all` ? `All items · ${list.length}` : !q && f === `recent` ? `Recently added` : `${list.length} found`;
    const back = !q && (f === `all` || f === `recent`) ? `<button type="button" class="link small" data-show="">${icon(`back`)} Home</button>` : ``;
    box.innerHTML = `<div class="list-head"><div class="label-sm">${back}${esc(title)}</div><button type="button" class="link small" data-select-toggle>${sel.on ? `Done` : `Select`}</button></div>
      <div class="cards">${list.slice(0, 300).map((i) => itemCard(i)).join(``)}</div>`;
    return;
  }

  // ---- dashboard (cards)
  const attention = all.map((i) => ({ i, r: attentionReason(i) })).filter((x) => x.r).sort((a, b) => a.r.rank - b.r.rank);
  const out = repo.people().filter((p) => p.holding.length || p.saved.length);
  const outCount = all.filter((i) => i.status === `lent` || i.status === `reserved`).length;
  const late = attention.filter((x) => x.r.urgent).length;
  const placeCount = repo.locations.filter((l) => !l.deleted).length;
  const recent = [...all].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt))).slice(0, 10);
  const live = repo.locations.filter((l) => !l.deleted);
  let rooms = live.filter((l) => l.parentId && !repo.locById(l.parentId)?.parentId); // second level: Garage, Kitchen…
  if (rooms.filter((l) => repo.itemsIn(l.id, true).length).length < 2) rooms = live.filter((l) => !l.parentId); // only top-level places so far
  rooms = rooms.map((l) => ({ l, items: repo.itemsIn(l.id, true) })).filter((x) => x.items.length).sort((a, b) => b.items.length - a.items.length).slice(0, 6);
  const mosaic = (items, l) => {
    const pick = [...items.filter((i) => repo.thumbs[i.id]), ...items.filter((i) => !repo.thumbs[i.id])].slice(0, 3);
    while (pick.length < 3) pick.push(null);
    return pick.map((i, k) => (i ? tileImg(i, `m${k}`) : `<div class="m${k} tint" style="--h:${tintOf(`${l.id}${k}`)}"></div>`)).join(``);
  };
  const soon = splitEvents().upcoming.slice(0, 2);
  const quick = (i) => i.status === `lent` ? [`return`, `Got it back`] : i.status === `reserved` ? [`pickup`, `Picked up`] : i.status === `missing` ? [`found`, `Found it`] : null;
  const personLine = (p) => {
    const lateN = [...p.holding, ...p.saved].filter((i) => attentionReason(i)?.urgent).length;
    const bits = [];
    if (p.holding.length) bits.push(`${p.holding.length} item${p.holding.length > 1 ? `s` : ``}`);
    if (p.saved.length) bits.push(p.holding.length ? `${p.saved.length} reserved` : (dueText(p.saved[0].dueAt).text ? `Reserved · ${dueText(p.saved[0].dueAt).text}` : `${p.saved.length} reserved`));
    if (lateN) bits.push(`${lateN} late`);
    return bits.join(` · `);
  };
  box.innerHTML = `
    <div class="stats">
      <button type="button" class="stat" data-show="all"><b>${all.length}</b><span>Item${all.length === 1 ? `` : `s`}</span></button>
      <a class="stat${late ? ` warn` : ``}" href="#/out"><b>${outCount}</b><span>Out${late ? ` · ${late} late` : ``}</span></a>
      <a class="stat" href="#/places"><b>${placeCount}</b><span>Place${placeCount === 1 ? `` : `s`}</span></a>
    </div>
    ${attention.length ? `<div class="alerts">${attention.slice(0, 3).map(({ i, r }) => { const a = quick(i); return `
      <a class="alert-card${r.urgent ? ` urgent` : ``}" href="#/item/${esc(i.id)}">${tileImg(i, `thumb sm`)}
        <div><b>${esc(i.name)}</b><small>${esc(r.text)}</small></div>
        ${a ? `<button type="button" class="btn small ghost" data-quick="${a[0]}" data-id="${esc(i.id)}">${a[1]}</button>` : ``}</a>`; }).join(``)}
      ${attention.length > 3 ? `<a class="link small" href="#/out">See all ${attention.length}</a>` : ``}</div>` : ``}
    ${myJobsHtml()}
    ${soon.length ? `<section class="dash"><div class="dash-head"><h2>Coming up</h2><a class="link small" href="#/events">All events</a></div>
      <div class="cards">${soon.map(eventCard).join(``)}</div></section>` : ``}
    ${rooms.length ? `<section class="dash"><div class="dash-head"><h2>Places</h2><a class="link small" href="#/places">All places</a></div>
      <div class="place-tiles">${rooms.map(({ l, items }) => `<a class="place-tile" href="#/place/${esc(l.id)}">
        <div class="mosaic">${mosaic(items, l)}</div>
        <div class="pt-name"><b>${esc(l.name)}</b><span>${items.length} item${items.length === 1 ? `` : `s`}</span></div></a>`).join(``)}</div></section>` : ``}
    ${out.length ? `<section class="dash"><div class="dash-head"><h2>Out now</h2><a class="link small" href="#/out">See all</a></div>
      <div class="hscroll">${out.map((p) => `<button type="button" class="person-card" data-person="${esc(p.key)}">
        <span class="avatar">${esc(initials(p.name))}</span><span><b>${esc(p.name)}</b><small>${esc(personLine(p))}</small></span></button>`).join(``)}</div></section>` : ``}
    <section class="dash"><div class="dash-head"><h2>Recently added</h2><button type="button" class="link small" data-show="recent">See all</button></div>
      <div class="hscroll">${recent.map((i) => { const parts = repo.pathOf(i.locationId).slice(-2).map((l) => l.name).join(` › `); return `
        <a class="item-tile" href="#/item/${esc(i.id)}">${tileImg(i, `it-img`)}
          <div class="it-name"><b>${esc(i.name)}</b><span>${esc(parts || `No location yet`)}</span></div></a>`; }).join(``)}</div></section>`;
}

// ============================================================ First-run setup: places in 30 seconds
const SETUP_TOP = [`Home`, `Storage unit`, `Office`, `Car`, `Cabin`];
const SETUP_ROOMS = {
  Home: [`Garage`, `Kitchen`, `Basement`, `Attic`, `Living room`, `Bedroom`, `Kids’ room`, `Office`, `Closet`, `Laundry`, `Bathroom`, `Shed`],
  'Storage unit': [`Shelf 1`, `Shelf 2`, `Boxes`],
  Office: [`Desk`, `Cabinet`, `Supply closet`],
  Car: [`Trunk`, `Glovebox`],
  Cabin: [`Kitchen`, `Bedroom`, `Shed`],
};
function viewSetup(view) {
  const existingTop = repo.childrenOf(``);
  const picked = new Map(); // top name -> Set(rooms)
  if (!existingTop.length) picked.set(`Home`, new Set([`Garage`, `Kitchen`]));
  else existingTop.forEach((l) => picked.set(l.name, new Set()));
  const extraTop = existingTop.map((l) => l.name).filter((n) => !SETUP_TOP.includes(n));
  const has = (top, room) => { const t = existingTop.find((l) => l.name.toLowerCase() === top.toLowerCase()); return Boolean(t && repo.childrenOf(t.id).some((c) => c.name.toLowerCase() === room.toLowerCase())); };
  const draw = () => {
    const tops = [...SETUP_TOP, ...extraTop, ...[...picked.keys()].filter((k) => !SETUP_TOP.includes(k) && !extraTop.includes(k))];
    const n = [...picked.entries()].reduce((sum, [top, rooms]) => sum + (existingTop.some((l) => l.name === top) ? 0 : 1) + [...rooms].filter((r) => !has(top, r)).length, 0);
    view.innerHTML = `<div class="setup">
      <div class="form-head"><button type="button" class="back" data-a="cancel">${icon(`x`)} ${existingTop.length ? `Close` : `Skip for now`}</button></div>
      <h1>Where do you keep things?</h1>
      <p class="muted">Tap what applies. You can rename, move or add more any time.</p>
      <div class="chips big">${tops.map((t) => `<button type="button" class="chip ${picked.has(t) ? `on` : ``}" data-top="${esc(t)}">${picked.has(t) ? icon(`check`) : ``}${esc(t)}</button>`).join(``)}
        <button type="button" class="chip add" data-addtop>${icon(`plus`)} Other</button></div>
      ${[...picked.keys()].map((top) => { const rooms = [...new Set([...(SETUP_ROOMS[top] || []), ...picked.get(top)])]; return `
        <div class="label-sm">Inside ${esc(top)}</div>
        <div class="chips">${rooms.map((r) => { const done = has(top, r); const on = done || picked.get(top).has(r); return `<button type="button" class="chip ${on ? `on` : ``}" data-top-of="${esc(top)}" data-room="${esc(r)}" ${done ? `disabled title="Already added"` : ``}>${on ? icon(`check`) : ``}${esc(r)}</button>`; }).join(``)}
          <button type="button" class="chip add" data-addroom="${esc(top)}">${icon(`plus`)} Other</button></div>`; }).join(``)}
      <div class="form-actions"><button type="button" class="btn primary big" data-a="create" ${n ? `` : `disabled`}>${n ? `Add ${n} place${n > 1 ? `s` : ``}` : `Pick at least one`}</button></div>
    </div>`;
  };
  view.onclick = async (e) => {
    const b = e.target.closest(`button`); if (!b) return;
    if (b.dataset.a === `cancel`) return goBack(`#/places`);
    if (b.dataset.top) { const t = b.dataset.top; if (picked.has(t)) { if (!existingTop.some((l) => l.name === t)) picked.delete(t); } else picked.set(t, new Set()); return draw(); }
    if (b.dataset.room) { const set = picked.get(b.dataset.topOf); if (set.has(b.dataset.room)) set.delete(b.dataset.room); else set.add(b.dataset.room); return draw(); }
    if (b.hasAttribute(`data-addtop`)) { const name = await promptSheet(`Another place`, { label: `Name`, placeholder: `e.g. Parents’ house, Boat`, okLabel: `Add` }); if (name) picked.set(name, new Set()); return draw(); }
    if (b.dataset.addroom) { const name = await promptSheet(`Inside ${b.dataset.addroom}`, { label: `Name`, placeholder: `e.g. Pantry, Workbench`, okLabel: `Add` }); if (name) picked.get(b.dataset.addroom).add(name); return draw(); }
    if (b.dataset.a === `create`) {
      let made = 0; let firstRoom = null;
      for (const [top, rooms] of picked) {
        let t = existingTop.find((l) => l.name.toLowerCase() === top.toLowerCase());
        if (!t) { t = repo.saveLocation({ name: top, parentId: ``, kind: `place` }); made++; }
        for (const r of rooms) {
          if (repo.childrenOf(t.id).some((c) => c.name.toLowerCase() === r.toLowerCase())) continue;
          const room = repo.saveLocation({ name: r, parentId: t.id, kind: `room` }); made++; firstRoom ||= room;
        }
      }
      if (firstRoom) rememberLoc(firstRoom.id);
      toast(`Added ${made} place${made === 1 ? `` : `s`}. Now add something you always hunt for.`);
      location.hash = `#/places`;
    }
  };
  draw();
}

// ============================================================ Out (lent + reserved, by person)
function viewOut(view) {
  const people = repo.people();
  const active = people.filter((p) => p.holding.length || p.saved.length);
  const past = people.filter((p) => !p.holding.length && !p.saved.length);
  const late = repo.activeItems().filter((i) => attentionReason(i)?.urgent);
  const nOut = active.reduce((n, p) => n + p.holding.length + p.saved.length, 0);
  const since = lentSinceMap();
  view.innerHTML = `
    <div class="out">
      <h1>Out</h1>
      <p class="muted">${nOut ? `${nOut} item${nOut > 1 ? `s` : ``} with ${active.length} ${active.length > 1 ? `people` : `person`}` : `Nothing is lent or reserved right now.`}</p>
      ${late.length ? `<div class="label-sm">Overdue pick-ups</div><div class="cards">${late.map((i) => itemCard(i, { reason: attentionReason(i) })).join(``)}</div>` : ``}
      ${active.length ? `<div class="label-sm">By person</div><div class="person-cards">${active.map((p) => {
        const items = [...p.holding, ...p.saved];
        const oldest = p.holding.map((i) => since.get(i.id)).filter(Boolean).sort()[0];
        const lateN = p.saved.filter((i) => dueText(i.dueAt).late).length;
        return `<button type="button" class="person-card" data-person="${esc(p.key)}">
          <span class="avatar">${esc(initials(p.name))}</span>
          <div class="pc-main"><b>${esc(p.name)}</b>
            <small>${[p.holding.length ? `has ${p.holding.length}` : ``, p.saved.length ? `${p.saved.length} reserved` : ``].filter(Boolean).join(` · `)}${oldest ? ` · oldest ${dayText(daysBetween(oldest))}` : ``}${lateN ? ` · <em>${lateN} pick-up late</em>` : ``}</small>
            <span class="pc-items">${items.slice(0, 4).map((i) => esc(i.name)).join(`, `)}${items.length > 4 ? ` +${items.length - 4}` : ``}</span></div>
          ${icon(`chevron`)}</button>`; }).join(``)}</div>`
        : `<div class="empty">${icon(`lend`, `big`)}<p>Use <b>Lend or reserve</b> on any item to keep track of who has it.</p></div>`}
      ${past.length ? `<div class="label-sm">Past borrowers</div><div class="chips">${past.map((p) => `<button type="button" class="chip" data-person="${esc(p.key)}">${esc(p.name)}</button>`).join(``)}</div>` : ``}
    </div>`;
  view.onclick = (e) => { const b = e.target.closest(`[data-person]`); if (b) { e.preventDefault(); personSheet(b.dataset.person); } };
}

// ============================================================ Item detail
function viewItem(view, r) {
  const item = repo.items.find((i) => i.id === r.id && !i.deleted);
  if (!item) { view.innerHTML = `<div class="empty"><h3>Item not found</h3><a class="btn ghost" href="#/">Back</a></div>`; return; }
  const personBtn = `<button type="button" class="person-link" data-person="${esc(Repo.personKey(item.lentTo))}">${esc(item.lentTo || `someone`)}</button>`;
  const due = dueText(item.dueAt);
  const status = item.status === `lent` ? `<div class="banner lent">${icon(`lend`)}<div class="grow"><span>Lent to ${personBtn}</span>${lentSinceText(item)}</div></div>`
    : item.status === `reserved` ? `<div class="banner reserved${due.late ? ` late` : ``}">${icon(`clock`)}<div class="grow"><span>Reserved for ${personBtn}</span>${due.text ? `<small>${esc(due.text)}</small>` : ``}</div>
        <button type="button" class="btn text small" data-a="unsave">Cancel reservation</button></div>`
    : item.status === `missing` ? `<div class="banner missing">${icon(`alert`)} Marked missing</div>` : ``;
  const tags = String(item.tags || ``).split(`,`).map((t) => t.trim()).filter(Boolean);
  const hasPhoto = Boolean(repo.thumbs[item.id] || item.photoId);
  // the two things people do most, front and centre
  const second = item.status === `lent` ? `<button class="btn primary big" data-a="return">${icon(`ret`)} Got it back</button>`
    : item.status === `reserved` ? `<button class="btn primary big" data-a="pickup">${icon(`check`)} Picked up</button>`
    : item.status === `missing` ? `<button class="btn primary big" data-a="found">${icon(`check`)} Found it</button>`
    : `<button class="btn ghost big" data-a="lend">${icon(`lend`)} Lend or reserve</button>`;
  view.innerHTML = `
    <div class="detail">
      <div class="detail-top">
        <button type="button" class="back" data-a="back">${icon(`back`)} Back</button>
        <div class="detail-tools">
          <button type="button" class="icon-btn" data-a="share" aria-label="Share">${icon(`share`)}</button>
          <a class="icon-btn" href="#/edit/${esc(item.id)}" aria-label="Edit">${icon(`edit`)}</a>
          <button type="button" class="icon-btn" data-a="menu" aria-label="More actions">${icon(`more`)}</button>
        </div>
      </div>
      ${hasPhoto ? `<div class="hero zoomable">${thumbHtml(item, `hero-img`)}</div>`
        : `<label class="add-photo"><input type="file" accept="image/*" capture="environment" hidden data-addphoto>${icon(`camera`)}<span>Add a photo</span></label>`}
      ${hasPhoto ? itemPhotoRowHtml(item) : ``}
      <h1>${esc(item.name)}${Number(item.qty) > 1 ? ` <span class="qty">×${esc(item.qty)}</span>` : ``}</h1>
      ${status}
      <div class="where"><div class="label-sm">Where</div><div class="crumbs">${crumbs(item.locationId)}</div></div>
      <div class="main-actions">
        <button class="btn ghost big" data-a="move">${icon(`move`)} Move</button>
        ${second}
      </div>
      ${neededForHtml(item)}
      ${item.purpose ? `<div class="block"><div class="label-sm">What it’s for</div><p>${esc(item.purpose)}</p></div>` : ``}
      <div class="facts">
        ${item.size ? `<div><span>Size</span><b>${esc(item.size)}</b></div>` : ``}
        ${item.category ? `<div><span>Category</span><b>${esc(item.category)}</b></div>` : ``}
        ${item.warranty ? `<div><span>Warranty until</span><b>${esc(item.warranty)}</b></div>` : ``}
        ${item.expiry ? `<div><span>Expires</span><b>${esc(item.expiry)}</b></div>` : ``}
        ${item.boughtAt || item.store || item.price ? `<div><span>Bought</span><b>${esc([item.boughtAt, item.store, moneyText(item.price)].filter(Boolean).join(` · `))}</b>${item.receipt ? ` <button type="button" class="link small" data-a="receipt">Receipt</button>` : ``}</div>` : ``}
        <div><span>Added</span><b>${esc(timeAgo(item.addedAt))}${item.addedBy && item.addedBy !== repo.user.email ? ` by ${esc(item.addedBy.split(`@`)[0])}` : ``}</b></div>
      </div>
      ${tags.length ? `<div class="chips">${tags.map((t) => `<a class="chip" href="#/?q" data-tag="${esc(t)}">${esc(t)}</a>`).join(``)}</div>` : ``}
      ${item.notes ? `<div class="block"><div class="label-sm">Notes</div><p class="pre">${esc(item.notes)}</p></div>` : ``}
      ${itemHistoryHtml(item)}
    </div>`;

  // Full-size photo from the phone's cache or Drive; tap to view it full screen.
  if (hasPhoto) repo.photoObjectUrl(item).then((url) => {
    if (!url) return;
    const img = $(`.hero-img`, view);
    if (img?.tagName === `IMG`) img.src = url; else $(`.hero`, view).innerHTML = `<img class="hero-img" src="${url}" alt="">`;
  }).catch(() => { /* not signed in right now: thumbnail stays */ });

  $(`[data-xadd]`, view)?.addEventListener(`change`, async (e) => {
    const files = [...(e.target.files || [])]; if (!files.length) return;
    let added = 0; let capped = false;
    for (const file of files) {
      if (repo.photosOf(repo.items.find((i) => i.id === item.id)).length + 1 >= MAX_PHOTOS) { capped = true; break; }
      try { if (await repo.addExtraPhoto(item.id, await processExtraPhoto(file))) added++; } catch { toast(`Couldn’t read one of the photos`); }
    }
    const capNote = capped ? ` (${MAX_PHOTOS} is the most per item)` : ``;
    if (added) { toast(`${added} photo${added > 1 ? `s` : ``} added${capNote}`); aiMergeIntoItem(item.id); }
    else if (capped) toast(`An item can have up to ${MAX_PHOTOS} photos`);
  });

  $(`[data-addphoto]`, view)?.addEventListener(`change`, async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const { photo, thumb } = await processPhoto(file); await repo.saveItem({ id: item.id }, { photo, thumb, logAction: `edited`, info: `New photo` }); toast(`Photo added`); aiMergeIntoItem(item.id); }
    catch { toast(`Couldn’t read that photo`); }
  });

  view.onclick = async (e) => {
    const tag = e.target.closest(`[data-tag]`);
    if (tag) { e.preventDefault(); findState = { q: tag.dataset.tag, filter: `` }; location.hash = `#/`; return; }
    const who = e.target.closest(`[data-person]`);
    if (who) { personSheet(who.dataset.person); return; }
    if (e.target.closest(`.hero.zoomable`)) { photoViewer(item, `main`); return; }
    const pv = e.target.closest(`[data-view]`); if (pv) { photoViewer(item, pv.dataset.view); return; }
    const uo = e.target.closest(`[data-useold]`);
    if (uo) { location.hash = `#/edit/${item.id}?restore=${encodeURIComponent(uo.dataset.useold)}&f=${uo.dataset.field}`; return; }
    if (e.target.closest(`[data-hist-all]`)) { $(`.ih`, view).classList.add(`all`); e.target.closest(`[data-hist-all]`).remove(); return; }
    const b = e.target.closest(`[data-a]`); if (!b) return;
    const a = b.dataset.a;
    if (a === `back`) goBack(`#/`);
    else if (a === `receipt`) {
      const url = await repo.receiptUrl(item).catch(() => null);
      if (!url) { toast(`The receipt isn’t on this phone yet. Try again when online.`); return; }
      sheet(`Receipt`, (el) => { el.innerHTML = `<img class="receipt-img" src="${url}" alt="Receipt">`; });
    }
    else if (a === `menu`) itemMenu(item);
    else if (a === `share`) shareItem(item);
    else if (a === `move`) {
      const id = await pickLocation(item.locationId, `Move to…`);
      if (id) await moveWithUndo([item], id);
    } else if (a === `lend`) {
      await lendOrSave(item);
    } else if (a === `pickup`) {
      await repo.pickUp(item); toast(`Lent to ${item.lentTo}`);
    } else if (a === `unsave`) {
      const who = item.lentTo; const was = item.dueAt;
      await repo.cancelReservation(item);
      toast(`No longer reserved for ${who}`, { action: `Undo`, ms: 6000, onAction: () => repo.reserveItem(item, who, was) });
    } else if (a === `return`) { await repo.returnItem(item); toast(`Returned`); }
    else if (a === `found`) { await repo.markFound(item); toast(`Found`); }
  };
}

function lentSinceText(item) {
  const since = repo.lendPeriods().filter((p) => p.itemId === item.id && p.lentAt && !p.returnedAt).pop()?.lentAt;
  return since ? `<small>since ${esc(fmtDate(since))} · ${dayText(daysBetween(since))}</small>` : ``;
}

/** Less frequent item actions. */
function itemMenu(item) {
  sheet(item.name, (el, close) => {
    el.innerHTML = `<div class="menu">
      <a href="#/edit/${esc(item.id)}" data-m="edit">${icon(`edit`)} Edit details</a>
      ${item.status === `lent` || item.status === `reserved` ? `` : `<button data-m="lend">${icon(`lend`)} Lend or reserve</button>`}
      ${item.status === `missing` ? `<button data-m="found">${icon(`check`)} Found it</button>` : `<button data-m="missing">${icon(`alert`)} Mark as missing</button>`}
      <button data-m="delete" class="danger">${icon(`trash`)} Remove from inventory</button></div>`;
    el.onclick = async (e) => {
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `lend`) await lendOrSave(item);
      if (m === `missing`) { await repo.markMissing(item); toast(`Marked missing`); }
      if (m === `found`) { await repo.markFound(item); toast(`Found`); }
      if (m === `delete` && await confirmSheet(`Remove “${item.name}”?`, `It will be hidden from the app. The row stays in your sheet, marked as removed.`, `Remove`, true)) {
        await repo.deleteItem(item); toast(`Removed`); goBack(`#/`);
      }
    };
  });
}

// ============================================================ Add / Edit
function viewEdit(view, r) {
  const editing = r.name === `edit` ? repo.items.find((i) => i.id === r.id) : null;
  const item = editing || {
    name: r.params.get(`name`) || ``, purpose: ``, category: ``, tags: ``, qty: Number(r.params.get(`qty`)) || 1, warranty: ``, expiry: ``, notes: ``,
    locationId: r.params.get(`loc`) || recentLocs()[0] || ``,
  };
  let locationId = item.locationId;
  let photo = null, thumb = null;
  const aiSug = {}; // what AI put in each field (the latest suggestion), to count what was kept when saving
  const cats = repo.categories();

  view.innerHTML = `
    <form class="form" id="f" autocomplete="off">
      <div class="form-head"><button type="button" class="back" data-cancel>${icon(`x`)} Cancel</button></div>
      <h1>${editing ? `Edit item` : `Add an item`}</h1>
      ${editing ? `` : `<button type="button" class="receipt-entry" data-receipt>${icon(`sheet`)}<span><b>Bought a few things?</b><small>Scan the receipt: everything on it becomes an item, with price and date</small></span>${icon(`chevron`)}</button>`}
      <label class="photo-pick" id="pp">
        <input type="file" accept="image/*" capture="environment" id="photo" hidden>
        <div class="pp-view">${editing && repo.thumbs[editing.id] ? `<img src="${repo.thumbs[editing.id]}" alt="">` : `<div class="pp-empty">${icon(`camera`)}<span>Take a photo</span></div>`}</div>
        <div class="pp-busy" hidden><div class="spinner"></div><span>Reading photos…</span></div>
      </label>
      <div id="xstrip"></div>
      <div id="aiRow"></div>
      <label class="field"><span>What is it?</span><input name="name" required value="${esc(item.name)}" placeholder="e.g. Stud finder"></label>
      <div class="field qty-field"><span>How many?</span>
        <div class="stepper"><button type="button" class="icon-btn" data-step="-1" aria-label="One fewer">−</button>
          <input name="qty" type="number" min="1" inputmode="numeric" value="${esc(Math.max(1, Number(item.qty) || 1))}" aria-label="How many">
          <button type="button" class="icon-btn" data-step="1" aria-label="One more">+</button></div></div>
      <label class="field"><span>What’s it for?</span><textarea name="purpose" rows="2" placeholder="e.g. Finding studs before hanging shelves or a TV">${esc(item.purpose)}</textarea></label>
      <div class="field"><span>Where is it?</span>
        <button type="button" class="loc-btn" id="loc">${icon(`place`)}<span id="locText"></span>${icon(`chevron`)}</button></div>
      <div class="field"><span>How big is it? <small>(optional)</small></span>
        <input type="hidden" name="size" value="${esc(item.size || ``)}">
        <div class="chips size-chips" id="sizes">${SIZES.map((z) => `<button type="button" class="chip${item.size === z ? ` on` : ``}" data-size="${esc(z)}">${esc(z)}<small>${esc(SIZE_HINT[z])}</small></button>`).join(``)}</div></div>
      <details ${editing && (item.category || item.tags || item.warranty || item.expiry || item.notes || item.price || item.store) ? `open` : ``}>
        <summary>More details <small>category, notes, dates, price</small></summary>
        <label class="field"><span>Category</span><input name="category" list="cats" value="${esc(item.category)}" placeholder="Tools"></label>
        <datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join(``)}</datalist>
        <label class="field"><span>Search words <small>(optional)</small></span><input name="tags" value="${esc(item.tags)}" placeholder="e.g. plumbing, teflon"></label>
        <div class="two">
          <label class="field"><span>Warranty until</span><input name="warranty" type="date" value="${esc(item.warranty)}"></label>
          <label class="field"><span>Expires</span><input name="expiry" type="date" value="${esc(item.expiry)}"></label>
        </div>
        <div class="two">
          <label class="field"><span>Price</span><input name="price" inputmode="decimal" value="${esc(item.price || ``)}" placeholder="e.g. 24.99"></label>
          <label class="field"><span>Bought on</span><input name="boughtAt" type="date" value="${esc(item.boughtAt || ``)}"></label>
        </div>
        <label class="field"><span>Bought at</span><input name="store" value="${esc(item.store || ``)}" placeholder="e.g. Costco, Amazon"></label>
        <label class="field"><span>Notes</span><textarea name="notes" rows="3" placeholder="Model number, where you bought it, manual link…">${esc(item.notes)}</textarea></label>
      </details>
      <div class="form-actions">
        ${editing ? `` : `<button type="submit" class="btn ghost" data-again>Save &amp; add another</button>`}
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`;

  $(`[data-cancel]`, view).onclick = () => goBack(editing ? `#/item/${editing.id}` : `#/`);
  const rcpt = $(`[data-receipt]`, view); if (rcpt) rcpt.onclick = () => scanReceipt();
  $(`.stepper`, view).addEventListener(`click`, (e) => { // − / + without opening the keyboard
    const b = e.target.closest(`[data-step]`); if (!b) return;
    const input = $(`.stepper input`, view);
    input.value = Math.max(1, (Number(input.value) || 1) + Number(b.dataset.step));
    input.dispatchEvent(new Event(`input`, { bubbles: true })); // same as typing: it's their number now, not AI's
  });
  const setLocText = () => { $(`#locText`).innerHTML = locationId ? crumbs(locationId, { link: false }) : `<span class="muted">Choose a place</span>`; };
  setLocText();
  $(`#loc`).onclick = async () => { const id = await pickLocation(locationId); if (id) { locationId = id; setLocText(); } };

  let shot = null; // { canvas, aiImage } of the current photo, for AI + crops

  // size chips (one tap, tap again to clear)
  const sizeInput = () => $(`#f`).elements.size;
  const drawSizes = () => $$(`#sizes [data-size]`, view).forEach((b) => b.classList.toggle(`on`, b.dataset.size === sizeInput().value));
  $(`#sizes`).onclick = (e) => {
    const b = e.target.closest(`[data-size]`); if (!b) return;
    sizeInput().value = sizeInput().value === b.dataset.size ? `` : b.dataset.size;
    $(`#sizes`).classList.remove(`suggested`); drawSizes();
  };

  // more photos of the same item: saved straight away when editing, kept until Save when adding
  const pendingExtras = []; // [{ key, photo, thumb, aiImage }]
  const drawStrip = () => {
    const box = $(`#xstrip`); if (!box) return;
    const coverTaken = Boolean(photo || (editing && (repo.thumbs[editing.id] || editing.photoId)));
    if (!coverTaken) { box.innerHTML = ``; return; } // the big photo area comes first
    if (editing) box.innerHTML = itemPhotoRowHtml(repo.items.find((i) => i.id === editing.id) || editing);
    else box.innerHTML = photoRowHtml(pendingExtras.map((p) => ({ key: p.key, thumb: p.thumb })), { canAdd: pendingExtras.length + 1 < MAX_PHOTOS });
    $(`[data-xadd]`, box)?.addEventListener(`change`, async (e) => {
      const files = [...(e.target.files || [])]; if (!files.length) return;
      for (const file of files) {
        const count = editing ? repo.photosOf(repo.items.find((i) => i.id === editing.id)).length : pendingExtras.length;
        if (count + 1 >= MAX_PHOTOS) { toast(`An item can have up to ${MAX_PHOTOS} photos`); break; }
        try {
          const x = await processExtraPhoto(file);
          if (editing) await repo.addExtraPhoto(editing.id, x);
          else pendingExtras.push({ key: `p${Date.now()}${Math.random()}`, ...x });
        } catch { toast(`Couldn’t read one of the photos`); }
      }
      drawStrip();
      if (aiReady() && aiSettings().auto) describeFromAllPhotos();
    });
    box.onclick = (e) => { // tap a pending photo to remove it before saving
      const t = e.target.closest(`[data-view]`); if (!t) return;
      if (editing) { photoViewer(repo.items.find((i) => i.id === editing.id), t.dataset.view); return; }
      const i = pendingExtras.findIndex((p) => p.key === t.dataset.view);
      if (i >= 0) confirmSheet(`Remove this photo?`, `It hasn’t been saved yet.`, `Remove`, true).then((ok) => { if (ok) { pendingExtras.splice(i, 1); drawStrip(); } });
    };
  };
  // AI looks at every photo of this item together and merges what it sees into the form
  async function describeFromAllPhotos() {
    busy(true);
    try {
      const imgs = editing ? [...(shot ? [await shot.aiImage()] : []), ...await itemAiImages(repo.items.find((i) => i.id === editing.id), { skipCover: Boolean(shot) })]
        : [...(shot ? [await shot.aiImage()] : []), ...await Promise.all(pendingExtras.map((p) => p.aiImage()))];
      if (!imgs.length) return;
      const f = $(`#f`);
      const current = Object.fromEntries([`name`, `purpose`, `category`, `notes`, `size`].map((k) => [k, f.elements[k]?.value || ``]));
      const r = await describeItem(imgs.slice(0, MAX_PHOTOS), current, { categories: cats });
      applySuggestion({ ...r, notes: specLine(r) }, { quietIfNone: true, mergeNotes: true });
    } catch (err) { toast(err instanceof AiError ? err.message : `AI couldn’t read the photos this time`, { ms: 5000 }); }
    finally { busy(false); }
  }
  const drawAiRow = () => {
    const row = $(`#aiRow`); if (!row) return;
    if (!aiReady()) {
      let hidden = false; try { hidden = localStorage.getItem(`paran.aiPromoHidden`) === `1`; } catch { /* ignore */ }
      row.innerHTML = editing || hidden ? `` : `<div class="ai-setup"><a href="#/more?ai=1">${icon(`spark`)}<span>Let AI suggest details from your photos</span><b>Set up</b></a>
        <button type="button" class="icon-btn" data-hidepromo aria-label="Don’t show again">${icon(`x`)}</button></div>`;
      const x = row.querySelector(`[data-hidepromo]`);
      if (x) x.onclick = () => { try { localStorage.setItem(`paran.aiPromoHidden`, `1`); } catch { /* ignore */ } row.innerHTML = ``; toast(`You can turn AI on any time in More`); };
      return;
    }
    const s = aiSettings();
    row.innerHTML = `<div class="ai-row">
        <label class="switch"><input type="checkbox" id="aiAuto" ${s.auto ? `checked` : ``}><i></i><span>${icon(`spark`)} Suggest details from photos</span></label>
        ${shot ? `<button type="button" class="btn ghost small" id="aiRun">${icon(`spark`)} Suggest now</button>` : ``}
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

  function applySuggestion(sug, { quietIfNone = false, mergeNotes = false } = {}) {
    const f = $(`#f`); let n = 0;
    if (sug.size && (!sizeInput().value || $(`#sizes`).classList.contains(`suggested`)) && sizeInput().value !== sug.size) { sizeInput().value = sug.size; drawSizes(); $(`#sizes`).classList.add(`suggested`); aiSug.size = sug.size; n++; }
    if (mergeNotes && sug.notes) { // keep what's in Notes; add the model/specs line if it isn't there yet
      const el = f.elements.notes;
      if (el.value && !el.classList.contains(`suggested`) && !el.value.toLowerCase().includes(sug.notes.toLowerCase())) { el.value = `${el.value}\n${sug.notes}`; n++; }
      if (el.value && !el.classList.contains(`suggested`)) sug = { ...sug, notes: `` };
    }
    const set = (name, value) => {
      const el = f.elements[name];
      if (!el || !value) return;
      const untouched = !el.value || el.classList.contains(`suggested`) || (name === `qty` && String(el.value) === `1`);
      if (!untouched || el.value === String(value)) return; // never overwrite what the user typed
      el.value = value; el.classList.add(`suggested`); aiSug[name] = String(value); n++;
      el.addEventListener(`input`, () => el.classList.remove(`suggested`), { once: true });
    };
    set(`name`, sug.name); set(`purpose`, sug.purpose); set(`category`, sug.category);
    set(`tags`, sug.tags); if (sug.qty > 1) set(`qty`, sug.qty);
    if (sug.notes) set(`notes`, sug.notes);
    if (f.querySelector(`details .suggested`)) f.querySelector(`details`).open = true; // never hide what AI filled
    if (n) toast(`AI filled ${n} field${n > 1 ? `s` : ``}. Check them before saving.`);
    else if (!quietIfNone) toast(`AI had nothing to add to what you typed.`);
  }

  $(`#photo`).addEventListener(`change`, async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    $(`#pp`).classList.add(`busy`);
    try {
      const p = await processPhoto(file);
      ({ photo, thumb } = p); shot = p;
      $(`#pp .pp-view`).innerHTML = `<img src="${thumb}" alt="">`;
      drawAiRow(); drawStrip();
    } catch { toast(`Couldn’t read that photo`); return; }
    finally { $(`#pp`).classList.remove(`busy`); }
    if (aiReady() && aiSettings().auto) (pendingExtras.length || editing ? describeFromAllPhotos() : runAi()); // one photo may show many items; several photos show one
    else if (!$(`input[name=name]`).value) $(`input[name=name]`).focus();
  });
  drawAiRow(); drawStrip();

  // "Restore" from History: put the earlier value(s) back into the form. Nothing changes until Save.
  if (editing && r.params.get(`restore`)) {
    const entry = repo.log.find((x) => x.itemId === editing.id && x.ts === r.params.get(`restore`));
    const ch = Repo.parseChanges(entry?.changes); delete ch._ai;
    const want = r.params.get(`f`);
    const keys = Object.keys(ch).filter((k) => FIELD_LABEL[k] && (want === `*` || k === want));
    const f = $(`#f`); let first = null;
    for (const k of keys) {
      const old = ch[k][0];
      if (k === `size`) { sizeInput().value = old; drawSizes(); $(`#sizes`).classList.add(`restored`); first ||= $(`#sizes`); continue; }
      const el = f.elements[k]; if (!el) continue;
      el.value = old; el.classList.remove(`suggested`); el.classList.add(`restored`); first ||= el;
      el.addEventListener(`input`, () => el.classList.remove(`restored`), { once: true });
      el.closest(`details`)?.setAttribute(`open`, ``);
    }
    if (keys.length) {
      $(`h1`, view).insertAdjacentHTML(`afterend`, `<div class="restore-note">${icon(`ret`)}<span>Earlier ${esc(keys.map((k) => FIELD_LABEL[k].toLowerCase()).join(`, `))} from ${esc(fmtWhen(entry.ts))} restored. Tap <b>Save</b> to keep it, or Cancel.</span></div>`);
      setTimeout(() => first?.scrollIntoView({ block: `center`, behavior: `smooth` }), 150);
    } else toast(`That earlier version isn’t available any more`);
  }

  let again = false;
  $$(`button[type=submit]`, view).forEach((b) => b.addEventListener(`click`, () => { again = b.hasAttribute(`data-again`); }));
  let saving = false;
  const lock = (on) => { saving = on; $$(`button[type=submit]`, view).forEach((b) => { b.disabled = on; }); };
  const eline = r.params.get(`eline`); // came from an event's "Add to the inventory": link that line to what gets saved
  const next = (id) => {
    if (eline && !editing) { linkLineToItem(eline, id); return goBack(`#/events`); }
    if (again) { navStack.pop(); location.hash = `#/add?loc=${encodeURIComponent(locationId)}&t=${Date.now()}`; return; } // replace this form
    if (editing) return goBack(`#/item/${editing.id}`);
    if (id) { navStack.pop(); location.hash = `#/item/${id}`; return; }
    goBack(`#/`); // back to where Add was started (a place, Find…)
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
          if (choice.action === `open`) { if (eline) return next(choice.item.id); location.hash = `#/item/${choice.item.id}`; return; }
          if (choice.action === `move` || choice.action === `more`) {
            const it = choice.item;
            const patch = { id: it.id };
            if (choice.action === `move`) { patch.locationId = locationId; patch.status = `home`; patch.lentTo = ``; }
            else patch.qty = (Number(it.qty) || 1) + fields.qty;
            const attach = photo && !it.photoId && !repo.thumbs[it.id]; // give it the photo if it had none
            await repo.saveItem(patch, { ...(attach ? { photo, thumb } : {}), logAction: choice.action === `move` ? `moved` : `qty+${fields.qty}` });
            rememberLoc(locationId);
            toast(choice.action === `move` ? `Moved ${it.name} to ${repo.pathText(locationId)}` : `${it.name} is now ×${patch.qty}`);
            return next(again && !eline ? null : it.id);
          }
          // choice.action === `new`: fall through and save as a separate item
        }
      }

      const aiFields = editing ? [] : [...$$(`#f .suggested`, view).map((el) => el.name), ...($(`#sizes`).classList.contains(`suggested`) ? [`size`] : [])].filter(Boolean);
      const saved = await repo.saveItem(fields, { photo, thumb, aiFields });
      if (!editing && Object.keys(aiSug).length) repo.logAi(`photo`, aiTally([{ taken: true, sug: aiSug, fin: fields }], [`name`, `qty`, `purpose`, `category`, `tags`, `size`, `notes`]), saved.name);
      for (const x of pendingExtras) await repo.addExtraPhoto(saved.id, x, { log: false });
      rememberLoc(locationId);
      toast(editing ? `Saved` : `Added ${saved.name}`, editing ? {} : { action: `View`, onAction: () => { location.hash = `#/item/${saved.id}`; } });
      next(editing || eline ? saved.id : null);
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
              ${!d.samePlace && fields.locationId ? `<button type="button" class="btn ghost small" data-act="move" data-i="${i}">It moved here</button>` : ``}
              <button type="button" class="btn ghost small" data-act="more" data-i="${i}">I have another (+${esc(fields.qty)})</button>
            </div>
          </div>`).join(``)}
        </div>
        <div class="row-actions">
          <button type="button" class="btn ghost" data-back>Keep editing</button>
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
function reviewItems(items, canvas, startLoc, { scan = false } = {}) {
  const canvases = Array.isArray(canvas) ? canvas : [canvas];
  const asSuggested = items.map((it) => ({ name: it.name, qty: it.qty })); // to count what was kept
  return new Promise((resolve) => {
    let done = false;
    let locationId = startLoc;
    const spot = new Map(); // item index -> a different place than the one for everything
    const locOf = (i) => spot.get(i) || locationId;
    const hereDup = (it) => locationId && findDuplicates(repo.activeItems(), it.name, { locationId }).find((d) => d.samePlace);
    const ticked = new Set(items.map((_, i) => i).filter((i) => !hereDup(items[i])));
    const finish = (v) => { done = true; resolve(v); };
    sheet(`Found ${items.length} item${items.length === 1 ? `` : `s`}`, async (el, close) => {
      el.innerHTML = `<p class="muted small">Cutting out photos…</p>`;
      const crops = await Promise.all(items.map((it) => cropItem(canvases[it.photo || 0] || canvases[0], it.box)));
      const hasInside = () => locationId && repo.childrenOf(locationId).length;
      const draw = () => {
        el.innerHTML = `
          <p class="muted small">Suggested by AI. Untick anything you don’t want and fix names before adding.${scan ? ` Something missing? Add it yourself after, or scan again closer.` : ``}</p>
          ${items.length > 4 ? `<div class="review-tools"><button type="button" class="link small" data-all>${ticked.size === items.length ? `Untick all` : `Tick all`}</button></div>` : ``}
          <div class="review-list">
            ${items.map((it, i) => `<div class="review-row">
              <label class="tick"><input type="checkbox" data-i="${i}" ${ticked.has(i) ? `checked` : ``}></label>
              <img src="${crops[i].thumb}" alt="">
              <div class="review-main">
                <input class="review-name suggested" data-name="${i}" value="${esc(it.name)}">
                ${hereDup(it) ? `<small class="here-tag">Already here: ${esc(hereDup(it).item.name)}</small>` : ``}
                <small>${esc(it.purpose)}</small>
                ${it.qty > 1 ? `<small>×${it.qty}</small>` : ``}
                ${spot.has(i) || hasInside() ? `<button type="button" class="spot-btn${spot.has(i) ? ` set` : ``}" data-spot="${i}">${icon(`place`)}${esc(spot.has(i) ? repo.pathOf(spot.get(i)).slice(-2).map((l) => l.name).join(` › `) : `Put somewhere inside`)}</button>` : ``}
              </div>
              ${scan ? `` : `<button type="button" class="icon-btn" data-one="${i}" aria-label="Edit just this one">${icon(`edit`)}</button>`}
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
        if (b.hasAttribute(`data-all`)) { if (ticked.size === items.length) ticked.clear(); else items.forEach((_, i) => ticked.add(i)); draw(); return; }
        if (b.dataset.spot !== undefined) {
          const i = Number(b.dataset.spot);
          const id = await pickLocation(locOf(i), `Where is “${items[i].name}”?`, { inside: locationId });
          if (id) { if (id === locationId) spot.delete(i); else spot.set(i, id); draw(); }
          return;
        }
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
          let n = 0;
          for (const i of picks) {
            const it = items[i];
            if (!it.name.trim()) continue;
            b.textContent = `Adding ${++n} of ${picks.length}…`;
            const renamed = it.name.trim() !== asSuggested[i].name;
            await repo.saveItem({ name: it.name.trim(), purpose: it.purpose, category: it.category, tags: it.tags, qty: it.qty, notes: it.notes, size: it.size || ``, locationId: locOf(i) },
              { photo: crops[i].photo, thumb: crops[i].thumb, info: scan ? `AI scan` : `AI from photo`, aiFields: [`name`, `purpose`, `category`, `tags`, `size`, `notes`].filter((k) => it[k] && !(k === `name` && renamed)) });
          }
          repo.logAi(scan ? `scan` : `photo`, aiTally(items.map((it, i) => ({ taken: picks.includes(i) && Boolean(it.name.trim()), sug: asSuggested[i], fin: { name: it.name.trim(), qty: it.qty } })), [`name`, `qty`]), repo.pathText(locationId));
          rememberLoc(locationId);
          toast(`Added ${n} item${n === 1 ? `` : `s`} to ${repo.pathText(locationId)}`);
          finish({ added: picks.length, locationId }); close();
        }
      });
      draw();
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

// ============================================================ Places
// Which rooms are expanded on a place page, remembered per place on this device.
const OPEN_KEY = `paran.openRooms`;
function openRooms(placeId) {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || `{}`)[placeId] || []); } catch { return new Set(); }
}
function saveOpenRooms(placeId, set) {
  try { const all = JSON.parse(localStorage.getItem(OPEN_KEY) || `{}`); all[placeId] = [...set]; localStorage.setItem(OPEN_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

function viewPlace(view, r) {
  const loc = r.id ? repo.locById(r.id) : null;
  if (r.id && !loc) { view.innerHTML = `<div class="empty"><h3>Place not found</h3><a class="btn ghost" href="#/places">All places</a></div>`; return; }
  const kids = repo.childrenOf(loc?.id || ``);
  const count = (id) => repo.itemsIn(id, true).length;
  const total = loc ? count(loc.id) : 0;
  const direct = loc ? repo.itemsIn(loc.id) : [];
  // everything inside, grouped by the place directly below this one
  const groups = loc ? kids.map((k) => ({ k, items: repo.itemsIn(k.id, true) })).filter((g) => g.items.length) : [];
  const sortByName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const addInsideRow = `<button type="button" class="list-row link-row add-row" data-a="new">${icon(`plus`)}<span>${loc ? `Add a place inside ${esc(loc.name)}` : `Add a place`}</span></button>`;

  view.innerHTML = `
    <div class="place">
      ${loc ? `<div class="crumbs top"><a href="#/places">All places</a><span class="sep">›</span>${crumbs(loc.id)}</div>` : ``}
      <div class="place-head">
        <h1>${loc ? `${icon(KIND_ICON[loc.kind] || `box`)} ${esc(loc.name)}` : `Places`}</h1>
        ${!loc ? `<button class="btn ghost small" data-a="scanlabel">${icon(`qr`)} Scan label</button>` : ``}
        ${loc ? `<div class="detail-tools">
            ${loc.kind === `container` ? `<button class="btn ghost small" data-a="qr">${icon(`qr`)} QR label</button>` : ``}
            <button class="icon-btn" data-a="share" aria-label="Share what’s here">${icon(`share`)}</button>
            <button class="icon-btn" data-a="menu" aria-label="Place options">${icon(`more`)}</button></div>` : ``}
      </div>
      ${loc ? `<div class="place-add"><a class="btn primary" href="#/add?loc=${esc(loc.id)}">${icon(`plus`)} Add item here</a>
        <button type="button" class="btn ghost" data-a="scan">${icon(`spark`)} Scan many</button></div>` : ``}
      ${!loc ? (kids.length ? `<div class="label-sm">Your places</div>
        <div class="list">${kids.map((k) => `<a class="list-row link-row" href="#/place/${esc(k.id)}">${icon(KIND_ICON[k.kind] || `box`)}<span>${esc(k.name)}</span><small>${count(k.id) || ``}</small>${icon(`chevron`)}</a>`).join(``)}${addInsideRow}</div>
        <a class="link small setup-link" href="#/setup">${icon(`plus`)} Quick-add rooms and places</a>`
        : `<div class="empty"><h3>No places yet</h3><p>Tell Paran where you keep things: a home or building and its rooms, a storage unit, a car…</p>
            <a class="btn primary" href="#/setup">${icon(`place`)} Set up your places</a></div>`) : ``}
      ${loc ? (() => {
        const open = openRooms(loc.id);
        const allOpen = kids.length && kids.filter((k) => count(k.id)).every((k) => open.has(k.id));
        const room = (k) => {
          const n = count(k.id); const isOpen = n && open.has(k.id);
          const subs = repo.childrenOf(k.id).length;
          return `<section class="room${isOpen ? ` open` : ``}">
            <div class="room-row">
              <button type="button" class="room-toggle" ${n ? `data-toggle="${esc(k.id)}" aria-expanded="${isOpen ? `true` : `false`}"` : `data-open="${esc(k.id)}"`}>
                <span class="caret">${n ? icon(`chevron`) : ``}</span>${icon(KIND_ICON[k.kind] || `box`)}
                <span class="room-name">${esc(k.name)}<small>${n ? itemsWord(n) : `Empty`}${subs ? ` · ${subs} place${subs > 1 ? `s` : ``} inside` : ``}</small></span>
              </button>
              <a class="icon-btn room-open" href="#/place/${esc(k.id)}" aria-label="Open ${esc(k.name)}">${icon(`chevron`)}</a>
            </div>
            ${isOpen ? `<div class="cards">${sortByName(repo.itemsIn(k.id, true)).map((i) => itemCard(i)).join(``)}</div>` : ``}
          </section>`;
        };
        return `
        <div class="list-head"><div class="label-sm">Inside ${esc(loc.name)}${total ? ` · ${itemsWord(total)}` : ``}</div>
          <div class="head-links">${groups.length > 1 ? `<button type="button" class="link small" data-a="${allOpen ? `collapse` : `expand`}">${allOpen ? `Collapse all` : `Expand all`}</button>` : ``}
          ${direct.length || kids.some((k) => open.has(k.id) && count(k.id)) ? `<button type="button" class="link small" data-select-toggle>${sel.on ? `Done` : `Select`}</button>` : ``}</div></div>
        ${direct.length ? `${kids.length ? `<div class="group-head">Directly in ${esc(loc.name)}</div>` : ``}<div class="cards">${sortByName(direct).map((i) => itemCard(i)).join(``)}</div>` : ``}
        ${kids.length ? `<div class="rooms">${kids.map(room).join(``)}</div>` : ``}
        ${!total && !kids.length ? `<p class="muted">Nothing here yet.</p>` : ``}
        <div class="list add-list">${addInsideRow}</div>`;
      })() : ``}
    </div>`;

  view.onclick = async (e) => {
    const t = e.target.closest(`[data-toggle]`);
    if (t && loc) {
      const open = openRooms(loc.id); const id = t.dataset.toggle;
      if (open.has(id)) open.delete(id); else open.add(id);
      saveOpenRooms(loc.id, open); render(); return;
    }
    const o = e.target.closest(`[data-open]`); if (o) { location.hash = `#/place/${o.dataset.open}`; return; }
    const b = e.target.closest(`[data-a]`); if (!b) return;
    if ((b.dataset.a === `expand` || b.dataset.a === `collapse`) && loc) {
      saveOpenRooms(loc.id, new Set(b.dataset.a === `expand` ? kids.filter((k) => count(k.id)).map((k) => k.id) : []));
      render(); return;
    }
    if (b.dataset.a === `new`) {
      const name = await promptSheet(loc ? `New place in ${loc.name}` : `New place`, {
        label: `Name`, placeholder: loc ? `e.g. Top shelf, Blue bin, Drawer 2` : `e.g. Home, Storage unit, Office`, okLabel: `Add` });
      if (name) { repo.saveLocation({ name, parentId: loc?.id || ``, kind: kindFor(loc?.id || ``) }); toast(`Added ${name}`); }
    }
    if (b.dataset.a === `menu`) placeMenu(loc);
    if (b.dataset.a === `qr`) printLabel(loc);
    if (b.dataset.a === `scan`) scanPlace(loc.id);
    if (b.dataset.a === `share`) sharePlace(loc);
    if (b.dataset.a === `scanlabel`) scanLabelFlow();
  };
}

// ============================================================ Share with anyone (a copy via the phone's share sheet)
const SHARE_SIGN = `Shared from Paran`;
// Where this inventory lives, using the sheet's real name (older pilot inventories are still called "Stash").
/** Phone share sheet → files if supported → text only → clipboard → a sheet to copy from. */
async function shareOut({ title, text, file, files }) {
  const list = files || (file ? [file] : []);
  const data = { title, text };
  try {
    if (list.length && navigator.canShare?.({ files: list })) { await navigator.share({ ...data, files: list }); return true; }
    if (navigator.share && !list.length) { await navigator.share(data); return true; }
    if (navigator.share && list.length > 1 && navigator.canShare?.({ files: [list[0]] })) {
      toast(`This phone can’t share that many photos at once. Try fewer.`, { ms: 5000 }); return false;
    }
    if (navigator.share) { await navigator.share(data); return true; }
  } catch (e) {
    if (e?.name === `AbortError`) return false; // they closed the share sheet
  }
  for (const f of list) { // desktop: save the pictures, copy the text
    const a = document.createElement(`a`); a.href = URL.createObjectURL(f); a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const saved = list.length ? `${list.length > 1 ? `${list.length} pictures` : `Picture`} saved and text copied` : `Copied. Paste it into a message.`;
  try { await navigator.clipboard.writeText(text); toast(saved); return true; }
  catch {
    sheet(`Copy this`, (el) => { el.innerHTML = `<textarea class="share-copy" rows="10" readonly>${esc(text)}</textarea>`; const t = $(`textarea`, el); t.focus(); t.select(); });
    return true;
  }
}

const dataUrlToBlob = async (u) => (await fetch(u)).blob();
async function itemPhotoFile(item) {
  try {
    const url = item.photoId || repo.thumbs[item.id] ? await repo.photoObjectUrl(item).catch(() => null) : null;
    const blob = url ? await (await fetch(url)).blob() : repo.thumbs[item.id] ? await dataUrlToBlob(repo.thumbs[item.id]) : null;
    if (!blob) return null;
    return new File([blob], `${item.name.replace(/[^\w\- ]+/g, ``).trim() || `item`}.jpg`, { type: blob.type || `image/jpeg` });
  } catch { return null; }
}

function shareItem(item) {
  const hasPhoto = Boolean(item.photoId || repo.thumbs[item.id]);
  const opts = { photo: hasPhoto, where: true };
  let file = null; // fetched up front: phones only allow sharing straight from the tap
  const textOf = () => [
    `${item.name}${Number(item.qty) > 1 ? ` ×${item.qty}` : ``}`,
    item.purpose ? `For: ${item.purpose}` : ``,
    item.size ? `Size: ${item.size}` : ``,
    item.notes ? item.notes.split(`\n`)[0] : ``,
    opts.where && item.locationId ? `Where: ${repo.pathText(item.locationId)}` : ``,
  ].filter(Boolean).join(`\n`) + `\n\n${SHARE_SIGN}`;
  sheet(`Share ${item.name}`, (el, close) => {
    const draw = () => {
      el.innerHTML = `
        <div class="share-card">${opts.photo && hasPhoto ? thumbHtml(item, `share-thumb`) : ``}<pre class="share-preview">${esc(textOf())}</pre></div>
        ${hasPhoto ? `<label class="check"><input type="checkbox" data-o="photo" ${opts.photo ? `checked` : ``}><span>Include photo</span></label>` : ``}
        <label class="check"><input type="checkbox" data-o="where" ${opts.where ? `checked` : ``}><span>Include where it’s kept</span></label>
        <p class="fine">They get a copy to read. Nothing in your inventory is shared.</p>
        <div class="row-actions"><button type="button" class="btn ghost" data-copy>Copy text</button><button type="button" class="btn primary" data-go>${icon(`share`)} Share</button></div>`;
    };
    el.addEventListener(`change`, (e) => { const o = e.target.dataset.o; if (o) { opts[o] = e.target.checked; draw(); } });
    el.addEventListener(`click`, async (e) => {
      if (e.target.closest(`[data-copy]`)) {
        try { await navigator.clipboard.writeText(textOf()); toast(`Copied`); } catch { await shareOut({ title: item.name, text: textOf() }); }
        return;
      }
      if (e.target.closest(`[data-go]`)) {
        const ok = await shareOut({ title: item.name, text: textOf(), file: opts.photo ? file : null });
        if (ok) close();
      }
    });
    draw();
    if (hasPhoto) itemPhotoFile(item).then((f) => { file = f; });
  });
}

/** Everything inside a place, grouped by the spot directly below it. */
function placeGroups(loc) {
  const sortByName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const groups = [];
  const direct = repo.itemsIn(loc.id);
  if (direct.length) groups.push({ name: ``, items: sortByName(direct) });
  for (const k of repo.childrenOf(loc.id)) {
    const items = repo.itemsIn(k.id, true);
    if (items.length) groups.push({ name: k.name, items: sortByName(items) });
  }
  return groups;
}

const itemsWord = (n) => `${n} item${n === 1 ? `` : `s`}`;
function listText(head, groups, { purpose }) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const line = (i) => `• ${i.name}${Number(i.qty) > 1 ? ` ×${i.qty}` : ``}${purpose && i.purpose ? ` – ${i.purpose}` : ``}`;
  const parts = [head.text ? `${head.text} · ${itemsWord(total)}` : itemsWord(total)];
  for (const g of groups) {
    parts.push(``);
    if (g.name) parts.push(`${g.name}:`);
    g.items.forEach((i) => parts.push(line(i)));
  }
  parts.push(``, SHARE_SIGN);
  return parts.join(`\n`);
}

/** A picture of the list with photos, for messaging apps. */
async function listPicture(head, groups, { purpose }) {
  const MAX = 80;
  const W = 1080, PAD = 48, ROW = purpose ? 132 : 112, IMG = 88, HEAD = 64;
  let shown = 0; const rows = [];
  for (const g of groups) {
    if (shown >= MAX) break;
    if (g.name) rows.push({ head: g.name });
    for (const i of g.items) { if (shown >= MAX) break; rows.push({ item: i }); shown++; }
  }
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const H = PAD + 120 + rows.reduce((h, r) => h + (r.head ? HEAD : ROW), 0) + (total > shown ? 60 : 0) + 80;
  const c = document.createElement(`canvas`); c.width = W; c.height = H;
  const x = c.getContext(`2d`);
  const font = (w, s) => `${w} ${s}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  const fit = (t, max) => { if (x.measureText(t).width <= max) return t; while (t && x.measureText(`${t}…`).width > max) t = t.slice(0, -1); return `${t}…`; };
  x.fillStyle = `#fffdf9`; x.fillRect(0, 0, W, H);
  x.fillStyle = `#1d1b18`; x.font = font(700, 48); x.fillText(fit(head.title, W - PAD * 2), PAD, PAD + 44);
  x.fillStyle = `#5d5850`; x.font = font(400, 28);
  x.fillText(fit([...(head.sub ? [head.sub] : []), itemsWord(total)].join(` · `), W - PAD * 2), PAD, PAD + 90);
  const load = (src) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = src; });
  let y = PAD + 120;
  for (const r of rows) {
    if (r.head) {
      x.fillStyle = `#2f5d50`; x.font = font(700, 30); x.fillText(fit(r.head, W - PAD * 2), PAD, y + 44); y += HEAD; continue;
    }
    const i = r.item; const t = repo.thumbs[i.id];
    const iy = y + (ROW - IMG) / 2;
    x.save(); x.beginPath(); x.roundRect(PAD, iy, IMG, IMG, 14); x.clip();
    const im = t ? await load(t) : null;
    if (im) {
      const s = Math.max(IMG / im.width, IMG / im.height); const w = im.width * s, h = im.height * s;
      x.drawImage(im, PAD + (IMG - w) / 2, iy + (IMG - h) / 2, w, h);
    } else { x.fillStyle = `hsl(${tintOf(i.id || i.name)} 30% 84%)`; x.fillRect(PAD, iy, IMG, IMG); }
    x.restore();
    const tx = PAD + IMG + 28, tw = W - tx - PAD;
    x.fillStyle = `#1d1b18`; x.font = font(600, 34);
    x.fillText(fit(`${i.name}${Number(i.qty) > 1 ? `  ×${i.qty}` : ``}`, tw), tx, y + (purpose && i.purpose ? ROW / 2 - 6 : ROW / 2 + 12));
    if (purpose && i.purpose) { x.fillStyle = `#5d5850`; x.font = font(400, 27); x.fillText(fit(i.purpose, tw), tx, y + ROW / 2 + 34); }
    x.fillStyle = `#e2ddd4`; x.fillRect(tx, y + ROW - 1, W - tx - PAD, 1);
    y += ROW;
  }
  x.fillStyle = `#8f897f`; x.font = font(400, 26);
  if (total > shown) { x.fillText(`+ ${total - shown} more`, PAD, y + 40); y += 60; }
  x.fillText(SHARE_SIGN, PAD, H - PAD);
  const blob = await new Promise((r) => c.toBlob(r, `image/jpeg`, 0.86));
  return new File([blob], `${head.title.replace(/[^\w\- ]+/g, ``).trim() || `list`}.jpg`, { type: `image/jpeg` });
}

function sharePlace(loc) {
  const groups = placeGroups(loc);
  if (!groups.length) { toast(`Nothing in ${loc.name} yet`); return; }
  shareList({
    sheetTitle: `Share what’s in ${loc.name}`,
    head: { title: loc.name, sub: repo.pathOf(loc.id).slice(0, -1).map((l) => l.name).join(` › `), text: repo.pathText(loc.id) },
    groups: (byPlace) => (byPlace ? groups : [{ name: ``, items: groups.flatMap((g) => g.items).sort((a, b) => a.name.localeCompare(b.name)) }]),
    groupLabel: `Group by spot`,
  });
}

/** Selected items (Select mode): grouped by where each one is kept, or one plain list. */
function shareSelection(items) {
  const byLoc = new Map();
  for (const i of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = i.locationId ? repo.pathOf(i.locationId).slice(-2).map((l) => l.name).join(` › `) : `No location yet`;
    if (!byLoc.has(key)) byLoc.set(key, []);
    byLoc.get(key).push(i);
  }
  const grouped = [...byLoc.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({ name, items: list }));
  return shareList({
    sheetTitle: `Share ${itemsWord(items.length)}`,
    head: { title: items.length === 1 ? items[0].name : `${itemsWord(items.length)}`, sub: ``, text: `` },
    groups: (byPlace) => (byPlace ? grouped : [{ name: ``, items: grouped.flatMap((g) => g.items).sort((a, b) => a.name.localeCompare(b.name)) }]),
    groupLabel: `Include where they’re kept`,
    byPlace: false,
  });
}

function shareList({ sheetTitle, head, groups: groupsFor, groupLabel, byPlace = true }) {
  const opts = { as: `text`, purpose: false, byPlace };
  const total = groupsFor(true).reduce((n, g) => n + g.items.length, 0);
  const MAX_PHOTOS = 10;
  const withPhoto = groupsFor(false).flatMap((g) => g.items).filter((i) => i.photoId || repo.thumbs[i.id]);
  let pic = null, picKey = ``;
  let photos = null, photosLoading = false, photosDone = 0; // full photos, fetched before Share so the tap can share them
  return new Promise((resolve) => {
    let shared = false;
    sheet(sheetTitle, (el, close) => {
      const groups = () => groupsFor(opts.byPlace);
      const makePic = async () => {
        const key = `${opts.purpose}|${opts.byPlace}`;
        if (pic && picKey === key) return;
        picKey = key; pic = null; draw();
        const f = await listPicture(head, groups(), opts);
        if (picKey === key) { pic = f; draw(); }
      };
      const loadPhotos = async () => {
        if (photos || photosLoading) return;
        photosLoading = true; photosDone = 0; draw();
        const out = [];
        for (const i of withPhoto.slice(0, MAX_PHOTOS)) {
          const f = await itemPhotoFile(i); if (f) out.push(f);
          photosDone++; if (opts.as === `photos`) draw();
        }
        photos = out; photosLoading = false; draw();
      };
      const photosBody = () => {
        if (!withPhoto.length) return `<p class="muted pad">None of these have a photo yet.</p>`;
        const n = Math.min(withPhoto.length, MAX_PHOTOS);
        return `<div class="share-photos">${withPhoto.slice(0, MAX_PHOTOS).map((i) => thumbHtml(i, `sp-img`)).join(``)}</div>
          <p class="fine">${photos ? `${photos.length} full photo${photos.length === 1 ? `` : `s`} ready` : `Getting full photos… ${photosDone} of ${n}`}${withPhoto.length > MAX_PHOTOS ? ` · first ${MAX_PHOTOS} only` : ``}${withPhoto.length < total ? ` · ${total - withPhoto.length} without a photo` : ``}. The list is sent as the message.</p>`;
      };
      const draw = () => {
        const text = listText(head, groups(), opts);
        const ready = opts.as === `pic` ? Boolean(pic) : opts.as === `photos` ? Boolean(photos?.length) : true;
        el.innerHTML = `
          <div class="seg three" role="tablist">
            <button type="button" data-as="text" class="${opts.as === `text` ? `on` : ``}" role="tab">List</button>
            <button type="button" data-as="pic" class="${opts.as === `pic` ? `on` : ``}" role="tab">Picture</button>
            <button type="button" data-as="photos" class="${opts.as === `photos` ? `on` : ``}" role="tab">Photos</button>
          </div>
          ${opts.as === `text` ? `<pre class="share-preview list">${esc(text)}</pre>`
            : opts.as === `photos` ? photosBody()
            : pic ? `<img class="share-pic" src="${URL.createObjectURL(pic)}" alt="Preview">` : `<div class="share-pic wait"><div class="spinner"></div></div>`}
          <label class="check"><input type="checkbox" data-o="purpose" ${opts.purpose ? `checked` : ``}><span>Include what each is for</span></label>
          <label class="check"><input type="checkbox" data-o="byPlace" ${opts.byPlace ? `checked` : ``}><span>${esc(groupLabel)}</span></label>
          <p class="fine">${itemsWord(total)}. They get a copy to read. Nothing in your inventory is shared.</p>
          <div class="row-actions">${opts.as === `text` ? `<button type="button" class="btn ghost" data-copy>Copy text</button>` : ``}
            <button type="button" class="btn primary" data-go ${ready ? `` : `disabled`}>${icon(`share`)} Share</button></div>`;
      };
      el.addEventListener(`change`, (e) => { const o = e.target.dataset.o; if (o) { opts[o] = e.target.checked; draw(); if (opts.as === `pic`) makePic(); } });
      el.addEventListener(`click`, async (e) => {
        const as = e.target.closest(`[data-as]`);
        if (as) { opts.as = as.dataset.as; draw(); if (opts.as === `pic`) makePic(); if (opts.as === `photos`) loadPhotos(); return; }
        const text = listText(head, groups(), opts);
        if (e.target.closest(`[data-copy]`)) { try { await navigator.clipboard.writeText(text); toast(`Copied`); } catch { await shareOut({ title: head.title, text }); } return; }
        if (e.target.closest(`[data-go]`)) {
          const ok = opts.as === `pic`
            ? await shareOut({ title: head.title, text: head.text ? `${head.text} · ${itemsWord(total)}` : head.title, file: pic })
            : opts.as === `photos` ? await shareOut({ title: head.title, text, files: photos })
            : await shareOut({ title: head.title, text });
          if (ok) { shared = true; resolve(true); close(); }
        }
      });
      draw();
    }, { onClose: () => { if (!shared) resolve(false); } });
  });
}

// ============================================================ Scan a QR label (in the app)
/** The place a label points to, if it's in this inventory. */
function labelLoc(text) {
  const m = /#\/place\/([\w-]+)/.exec(String(text || ``));
  const loc = m && repo.locById(m[1]);
  return loc && !loc.deleted ? loc : null;
}
const labelVerdict = (t) => (labelLoc(t) ? true
  : /#\/place\//.test(t) ? `This label is from another inventory, or that place was removed.` : `That isn’t a Paran label.`);
async function scanToPlace(title, hint) {
  const text = await scanLabel({ title, hint, accept: labelVerdict });
  return text ? labelLoc(text) : null;
}

/** Scan from Find or Places: see what's inside, or put things away there. */
async function scanLabelFlow() {
  const loc = await scanToPlace(`Scan a label`, `Point at a box or shelf label.`);
  if (!loc) return;
  const n = repo.itemsIn(loc.id, true).length;
  sheet(loc.name, (el, close) => {
    el.innerHTML = `<p class="muted small">${esc(repo.pathText(loc.id))} · ${itemsWord(n)}</p>
      <div class="menu">
        <button data-m="open">${icon(`search`)} See what’s inside</button>
        ${repo.readOnly ? `` : `<button data-m="bring">${icon(`ret`)} Put items away here</button>
        <button data-m="add">${icon(`plus`)} Add a new item here</button>
        <button data-m="scan">${icon(`spark`)} Scan many into it</button>`}
      </div>`;
    el.onclick = (e) => {
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `open`) location.hash = `#/place/${loc.id}`;
      else if (m === `add`) location.hash = `#/add?loc=${loc.id}`;
      else if (m === `bring`) bringItemsSheet(loc);
      else if (m === `scan`) scanPlace(loc.id);
    };
  });
}

// ============================================================ Scan many: pan across a shelf, AI lists everything
const SCAN_MAX = 8;
async function scanPlace(locId) {
  if (!aiReady()) {
    const ok = await confirmSheet(`Scan many items at once`, `Pan your camera across a shelf or room, and AI lists everything it sees for you to review. This uses AI suggestions with your own free Gemini key.`, `Set up AI`);
    if (!ok || !(await aiConsent())) return;
  }
  let seen = false; try { seen = localStorage.getItem(`paran.scanNote`) === `1`; } catch { /* ignore */ }
  if (!seen) {
    const ok = await confirmSheet(`Before you scan`, `Wide photos of a room show more of your space than a single item. They go from this phone to Google Gemini, and on the free tier Google may use them to improve its products. Keep papers, screens and people out of the shot.`, `Start scanning`);
    if (!ok) return;
    try { localStorage.setItem(`paran.scanNote`, `1`); } catch { /* ignore */ }
  }
  const where = repo.pathText(locId);
  const shots = await captureScan({ max: SCAN_MAX, title: repo.locById(locId)?.name || `` });
  if (!shots?.length) return;
  const wait = document.createElement(`div`);
  wait.className = `scan-wait`;
  wait.innerHTML = `<div><div class="spinner"></div><b>Reading ${shots.length} photo${shots.length > 1 ? `s` : ``}…</b><small>This can take up to a minute.</small></div>`;
  document.body.appendChild(wait);
  let items;
  try {
    const blobs = await Promise.all(shots.map((c) => new Promise((r) => {
      const scale = Math.min(1, 1024 / Math.max(c.width, c.height));
      const d = document.createElement(`canvas`); d.width = Math.round(c.width * scale); d.height = Math.round(c.height * scale);
      d.getContext(`2d`).drawImage(c, 0, 0, d.width, d.height); d.toBlob(r, `image/jpeg`, 0.8);
    })));
    items = await scanPhotos(blobs, { categories: repo.categories(), location: where });
  } catch (err) {
    wait.remove();
    toast(err instanceof AiError ? err.message : `Scan failed. Try again, or add items one by one.`, { ms: 6000 });
    return;
  }
  wait.remove();
  if (!items.length) { toast(`AI couldn’t recognize anything. Try again closer, with more light.`, { ms: 5000 }); return; }
  const res = await reviewItems(items, shots, locId, { scan: true });
  if (res?.added) render();
}

function placeMenu(loc) {
  sheet(loc.name, (el, close) => {
    el.innerHTML = `<div class="menu">
      <button data-m="bring">${icon(`ret`)} Bring items here</button>
      <button data-m="share">${icon(`share`)} Share what’s here</button>
      <button data-m="new">${icon(`plus`)} Add a place inside</button>
      <button data-m="move">${icon(`move`)} Move ${esc(loc.name)} to another place</button>
      <button data-m="rename">${icon(`edit`)} Rename</button>
      <button data-m="qr">${icon(`qr`)} Print QR label</button>
      <button data-m="delete" class="danger">${icon(`trash`)} Remove place</button></div>`;
    el.onclick = async (e) => {
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `bring`) bringItemsSheet(loc);
      else if (m === `share`) sharePlace(loc);
      else if (m === `new`) {
        const name = await promptSheet(`New place in ${loc.name}`, { label: `Name`, placeholder: `e.g. Top shelf, Blue bin, Drawer 2`, okLabel: `Add` });
        if (name) { repo.saveLocation({ name, parentId: loc.id, kind: kindFor(loc.id) }); toast(`Added ${name}`); }
      } else if (m === `rename`) {
        const name = await promptSheet(`Rename`, { label: `Name`, value: loc.name });
        if (name) repo.saveLocation({ id: loc.id, name });
      } else if (m === `move`) {
        moveSpot(loc);
      } else if (m === `qr`) printLabel(loc);
      else if (m === `delete`) {
        const n = repo.itemsIn(loc.id, true).length + repo.descendantIds(loc.id).size - 1;
        if (n) return toast(`Move or remove what’s inside first`);
        if (await confirmSheet(`Remove ${loc.name}?`, `This place is empty.`, `Remove`, true)) { repo.deleteLocation(loc); location.hash = loc.parentId ? `#/place/${loc.parentId}` : `#/places`; }
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
    <div class="label">${svg}<div><div class="n">${esc(loc.name)}</div><div class="p">${esc(repo.pathText(loc.id))}</div><div class="p">Scan in Paran (QR button by the search bar) to see what’s inside</div></div></div>
    ${items.length ? `<h3>Inside (${items.length})</h3><ul>${items.map((i) => `<li>${esc(i.name)}</li>`).join(``)}</ul>` : ``}
    <p><button onclick="print()">Print</button></p></body></html>`);
  w.document.close();
}

/** Explicit opt-in for AI suggestions: explains the data flow, needs a checkbox + a working key. */
/**
 * Getting a Gemini key, written to be done rather than read: what you get (one line and an example), then three
 * steps with one button each. The step you're on is highlighted; coming back from AI Studio jumps to Paste.
 * Privacy is one plain line by the button, with the detail a tap away.
 */
function aiConsent(keyOnly = false) {
  // Google's key formats change (older keys start "AIza", newer ones don't), so only rule out what can't be a key:
  // too short or with spaces. Google itself says whether it works when it's checked on Turn on.
  const KEY_RE = /^[\x21-\x7e]{20,}$/;
  return new Promise((resolve) => {
    let done = false; let left = false; let step = () => {};
    const onBack = () => { if (!document.hidden && left) step(3); }; // back from AI Studio: on to Paste
    sheet(keyOnly ? `Change Gemini key` : `Name things from a photo`, (el, close) => {
      el.innerHTML = `<form class="stack keyflow">
        ${keyOnly ? `` : `<div class="ai-hook">
          <div class="ai-demo" aria-hidden="true">${icon(`camera`)}<span class="arrow">→</span>
            <span class="chip">Tablecloth ×15</span><span class="chip">Banner</span><span class="chip">Mic stand</span></div>
          <p>Snap a shelf or a bin and Paran lists what’s in it: names, what each is for, how many. Free with your own Google key, about a minute to get.</p>
        </div>`}
        <ol class="kf-steps">
          <li data-s="1"><span class="kf-n">1</span><div><b>Get a free key from Google</b>
            <a class="btn primary kf-go" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Open Google AI Studio ${icon(`ext`)}</a></div></li>
          <li data-s="2"><span class="kf-n">2</span><div><b>Tap “Create API key”, then Copy</b><small>Sign in with any Google account if asked.</small></div></li>
          <li data-s="3"><span class="kf-n">3</span><div><b>Come back and paste it here</b>
            <div class="kf-paste"><input name="key" autocomplete="off" spellcheck="false" placeholder="Paste your key" aria-label="Gemini key" required>
              <button type="button" class="btn ghost" data-paste>Paste</button></div></div></li>
        </ol>
        <p class="error-box" hidden></p>
        <button class="btn primary full kf-on" disabled>${keyOnly ? `Save key` : `Turn on`}</button>
        ${keyOnly ? `<p class="fine">Kept only on this phone.</p>` : `<p class="fine kf-note">${icon(`alert`)} Photos you analyze go from this phone straight to Google. With a free key Google may review them, so skip IDs and private papers. <button type="button" class="link small" data-more>More</button></p>
        <div class="kf-more" hidden>
          <p>Paran has no server and never sees your photos. A smaller copy is sent only when you ask for suggestions, using your key, which stays on this phone (not in your Sheet).</p>
          <p>You always check suggestions before anything is saved, and nothing you typed is overwritten.</p>
          <p>On the free tier Google may use what you send to improve its products. Paid keys aren’t used that way. The free tier covers a few hundred photos a day.</p>
          <p>Turning on means you agree that photos you choose to analyze are sent to Google Gemini.</p>
        </div>`}
      </form>`;
      const form = $(`form`, el); const err = $(`.error-box`, el); const input = form.elements.key; const on = $(`.kf-on`, el);
      step = (n) => $$(`.kf-steps li`, el).forEach((li) => { const i = Number(li.dataset.s); li.classList.toggle(`now`, i === n); li.classList.toggle(`did`, i < n); });
      const check = () => { const v = input.value.trim(); on.disabled = !KEY_RE.test(v); if (v) step(3); };
      step(1);
      $(`.kf-go`, el).onclick = () => { left = true; setTimeout(() => step(2), 300); };
      document.addEventListener(`visibilitychange`, onBack);
      input.oninput = check; input.onfocus = () => step(3);
      $(`[data-paste]`, el).onclick = async () => {
        try { input.value = (await navigator.clipboard.readText()).trim(); check(); if (on.disabled) { err.textContent = `That doesn’t look like a key yet. In AI Studio, tap Copy next to the key, then tap Paste here again.`; err.hidden = false; } else err.hidden = true; }
        catch { input.focus(); err.textContent = `Long-press the box and choose Paste.`; err.hidden = false; }
      };
      const more = $(`[data-more]`, el); if (more) more.onclick = () => { const m = $(`.kf-more`, el); m.hidden = !m.hidden; more.textContent = m.hidden ? `More` : `Less`; };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const key = input.value.trim();
        on.disabled = true; on.textContent = `Checking key…`; err.hidden = true;
        try {
          const model = await verifyKey(key);
          saveAiSettings({ enabled: true, key, model, consentAt: aiSettings().consentAt || new Date().toISOString() });
          done = true; resolve(true); close();
          toast(keyOnly ? `Key updated` : `AI is on. Try it: take a photo when you add something`);
        } catch (ex) {
          err.textContent = ex.message || String(ex); err.hidden = false;
          on.disabled = false; on.textContent = keyOnly ? `Save key` : `Turn on`;
        }
      };
    }, { onClose: () => { document.removeEventListener(`visibilitychange`, onBack); if (!done) resolve(false); } });
  });
}

// ============================================================ Help (? on every screen; catalog and search in help.js)
const helpScreen = () => { const r = route(); return r.name === `more` && r.id ? `more/${r.id}` : r.name; };
const POPULAR = [`start`, `find`, `add-item`, `share-inv`, `events-what`, `lend`];
const ITEM_Q = /^(where('?s| is| are)|find|lost|looking for|have i got|do i have)\b/i;

/** Help: topics for this screen first, then search in your own words; Take me there; did it help; tell us. */
function helpSheet(startQuery = ``) {
  const screen = helpScreen();
  let q = startQuery; let open = ``;
  sheet(`Help`, (el, close) => {
    el.innerHTML = `<div class="help">
      <label class="search sm">${icon(`search`)}<input data-hq type="search" value="${esc(q)}" placeholder="Ask in your own words, e.g. share with my family" autocomplete="off" enterkeyhint="search"></label>
      <div class="help-list"></div>
      <div class="help-tell"><button type="button" class="link small" data-tell>${icon(`edit`)} Can’t find it? Tell us what you were trying to do</button></div>
    </div>`;
    const list = $(`.help-list`, el); const input = $(`[data-hq]`, el);
    const card = (t) => `<div class="help-topic${open === t.id ? ` open` : ``}" data-topic="${esc(t.id)}">
      <button type="button" class="help-q" data-toggle="${esc(t.id)}">${esc(t.q)}${icon(`chevron`)}</button>
      ${open === t.id ? `<div class="help-a">
        <ol>${t.steps.map((x) => `<li>${esc(x)}</li>`).join(``)}</ol>
        ${t.who ? `<p class="fine">${esc(t.who)}</p>` : ``}
        <div class="help-acts">${t.go ? `<button type="button" class="btn primary small" data-go="${esc(t.id)}">Take me there</button>` : ``}
          <span class="help-was">Did this help? <button type="button" class="chip" data-yes="${esc(t.id)}">Yes</button><button type="button" class="chip" data-no="${esc(t.id)}">No</button></span></div>
        ${(t.related || []).length ? `<div class="help-rel">${t.related.map(topicById).filter(Boolean).map((r) => `<button type="button" class="link small" data-toggle="${esc(r.id)}">${esc(r.q)}</button>`).join(``)}</div>` : ``}
      </div>` : ``}</div>`;
    const draw = () => {
      const text = q.trim();
      if (!text) {
        const here = topicsFor(screen); const pop = POPULAR.map(topicById).filter((t) => t && !here.includes(t));
        list.innerHTML = `${here.length ? `<div class="label-sm">On this screen</div>${here.map(card).join(``)}` : ``}
          <div class="label-sm">${here.length ? `Also asked` : `Often asked`}</div>${pop.map(card).join(``)}`;
        return;
      }
      const hits = searchHelp(text, screen).slice(0, 5);
      const itemQ = ITEM_Q.test(text) || !hits.length;
      const what = text.replace(ITEM_Q, ``).replace(/[?.!]+$/, ``).trim().replace(/^((is|are|my|our|the|a|an|i|put|did|kept)\s+)+/i, ``).trim();
      list.innerHTML = `${itemQ && what ? `<button type="button" class="help-items" data-items="${esc(what)}">${icon(`search`)}<span>Search your things for “${esc(what)}”</span>${icon(`chevron`)}</button>` : ``}
        ${hits.length ? hits.map((h) => card(h.topic)).join(``) : `<p class="muted small pad">No help topic matches that yet. Tell us below what you were trying to do, so it gets added.</p>`}`;
    };
    let timer = 0;
    input.oninput = () => {
      q = input.value; open = ``; draw();
      clearTimeout(timer);
      timer = setTimeout(() => { const t = q.trim(); if (t.length > 2) { statCount(`help`); if (!searchHelp(t, screen).length) { statCount(`helpNone`); addFeedback({ q: t, screen }); } } }, 1500);
    };
    el.onclick = async (e) => {
      const b = e.target.closest(`button`); if (!b) return;
      const d = b.dataset;
      if (d.toggle) { open = open === d.toggle ? `` : d.toggle; draw(); $(`[data-topic="${CSS.escape(open)}"]`, el)?.scrollIntoView({ block: `nearest` }); return; }
      if (d.go) { const t = topicById(d.go); close(); helpGo(t); return; }
      if (d.yes || d.no) {
        const helpful = Boolean(d.yes); statCount(helpful ? `helpYes` : `helpNo`);
        addFeedback({ q: q.trim(), topic: d.yes || d.no, helpful, screen });
        b.parentElement.innerHTML = helpful ? `Thanks!` : `Thanks. <button type="button" class="link small" data-tell>Tell us what was missing</button>`;
        return;
      }
      if (d.items !== undefined) { // a question about their things: run the item search
        close(); findState.q = d.items; findState.filter = ``;
        if (route().name === `find`) { viewFind($(`#view`)); renderResults(); } else location.hash = `#/`;
        return;
      }
      if (d.tell !== undefined) {
        const text = await promptSheet(`Tell us`, { label: `What were you trying to do?`, value: q.trim(), placeholder: `e.g. Share the storage unit with my brother`, okLabel: `Save` });
        if (text) { addFeedback({ q: q.trim(), text, screen }); toast(`Thanks. It’s kept on this phone; More → Your activity has it to share with the Paran team.`, { ms: 6000 }); }
      }
    };
    draw();
  });
}

/** Take me there: open the screen, then point at the button (a soft pulse) if it's on it. */
function helpGo(t) {
  if (t.go) location.hash = t.go;
  if (!t.ui) return;
  setTimeout(() => {
    const el = document.querySelector(t.ui);
    if (!el) return;
    el.scrollIntoView({ block: `center`, behavior: `smooth` });
    el.classList.add(`help-spot`); setTimeout(() => el.classList.remove(`help-spot`), 3500);
  }, 350);
}

// ============================================================ Usage stats (kept on this phone; see stats.js)
let searchTimer = 0; let lastSearch = ``;
/** A search counts once the person stops typing for a moment (not every letter). */
function countSearchSoon(v) {
  clearTimeout(searchTimer);
  const q = v.trim().toLowerCase(); if (q.length < 2) return;
  searchTimer = setTimeout(() => { if (q !== lastSearch) { lastSearch = q; statCount(`search`); } }, 1500);
}
let appVersion = ``;
function askVersion() {
  const c = navigator.serviceWorker?.controller; if (!c || appVersion) return;
  navigator.serviceWorker.addEventListener(`message`, (e) => { if (e.data?.version) appVersion = e.data.version; });
  c.postMessage(`version`);
}
let lastSnap = 0;
/** What this phone looks like today: inventories, groups (members, viewers, items, events), AI on. Throttled. */
function statsSnapshot() {
  if (!repo || !statsOn() || Date.now() - lastSnap < 10 * 60_000) return;
  const google = repo.backend.kind === `google`;
  if (google && !repo.loadedAt) return; // wait until this inventory has loaded from Google
  lastSnap = Date.now(); askVersion();
  const k = google ? loadKnown(repo.user.email) : { inv: {}, groups: {} };
  const itemsOf = (id) => (id === repo.backend.sheetId ? repo.activeItems().length : cachedCount(id) || 0);
  const groups = Object.entries(k.groups).map(([gid, g]) => {
    const invs = Object.entries(k.inv).filter(([, i]) => i.groupId === gid).map(([id]) => id);
    return { id: gid, members: g.people || [], inventories: invs.length, items: invs.reduce((a, id) => a + itemsOf(id), 0),
      events: repo.group()?.id === gid ? repo.liveEvents().filter((e) => e._g).length : 0 };
  });
  setTimeout(() => statSnapshot({ version: appVersion, mode: repo.backend.kind, inventories: google ? Object.keys(k.inv).length : 1, aiOn: aiReady(), groups })
    .catch(() => {}), 1500); // the version answer arrives just after asking
}

let actPeriod = 7; // Your activity: 7, 30, or 0 (everything kept)
/** The usage counts, shown to the person themselves: what they did, when, how AI did, their groups now. */
function statsPage() {
  const s = statsData();
  const on = statsOn();
  const switchHtml = `<div class="menu">
      <label class="menu-switch"><span>Keep these counts on this phone</span><span class="switch"><input type="checkbox" data-stats ${on ? `checked` : ``}><i></i></span></label></div>
    <p class="fine">Only counts: how often you add, search, lend, plan events, use AI; how many people and inventories your groups have. Never names, emails, items, places, photos or what you searched for. They stay on this phone and aren’t sent anywhere. Turning this off deletes them.</p>`;
  if (!s) return switchHtml;
  const dates = [];
  const n = actPeriod || Math.max(1, Math.ceil((Date.now() - new Date(`${Object.keys(s.days).sort()[0] || todayStr()}T00:00`)) / 86400000) + 1);
  for (let i = n - 1; i >= 0; i--) dates.push(isoDay(-i));
  const days = dates.map((d) => [d, s.days[d]]);
  const sum = (key) => days.reduce((a, [, d]) => a + (d?.c?.[key] || 0), 0);
  const used = days.filter(([, d]) => d && Object.values(d.c || {}).some(Boolean)).length;
  const LABEL = { add: `Items added`, addMore: `Added more of one`, move: `Moved`, lend: `Lent or reserved`, return: `Got back`, edit: `Edited`, remove: `Removed`,
    search: `Searches`, event: `Events planned`, dayof: `Ticked on the day`, after: `Sorted after an event` };
  const activity = (d) => (d ? Object.entries(d.c || {}).filter(([k]) => k !== `open`).reduce((a, [, v]) => a + v, 0) + Object.values(d.ai || {}).reduce((a, x) => a + x.uses, 0) : 0);
  const peak = Math.max(1, ...days.map(([, d]) => activity(d)));
  const ai = {};
  for (const [, d] of days) for (const [kind, x] of Object.entries(d?.ai || {})) {
    const k = ACC_GROUP[kind] || kind; const a = ai[k] ||= { uses: 0, total: 0, score: 0 };
    a.uses += x.uses; const nm = x.fields?.name; if (nm) { a.total += nm[1]; a.score += nm[2]; }
  }
  const k = repo.backend.kind === `google` ? loadKnown(repo.user.email) : { inv: {}, groups: {} };
  const groups = Object.entries(k.groups).map(([gid, g]) => {
    const invs = Object.entries(k.inv).filter(([, i]) => i.groupId === gid).map(([id]) => id);
    const people = (g.people || []).filter((p) => p.role !== `removed`);
    const items = invs.reduce((a, id) => a + (id === repo.backend.sheetId ? repo.activeItems().length : cachedCount(id) || 0), 0);
    return { name: g.name, people: people.length, viewers: people.filter((p) => p.role === `viewer`).length, invs: invs.length, items };
  });
  const tiles = Object.keys(LABEL).filter((x) => sum(x));
  return `<div class="seg act-period">${[[7, `7 days`], [30, `30 days`], [0, `Everything kept`]].map(([v, l]) => `<button type="button" data-period="${v}" class="${actPeriod === v ? `on` : ``}">${l}</button>`).join(``)}</div>
    <div class="acc-card">
      <div class="acc-head"><b>You used Paran on ${used} of ${n} day${n === 1 ? `` : `s`}</b><small>${esc(niceDay(dates[0]))} to today</small></div>
      <div class="act-bars" aria-hidden="true">${days.map(([d, x]) => `<i title="${esc(d)}: ${activity(x)}" style="--h:${Math.round((activity(x) / peak) * 100)}%" class="${activity(x) ? `` : `none`}"></i>`).join(``)}</div>
      ${tiles.length ? `<div class="stat-grid">${tiles.map((x) => `<div><b>${sum(x)}</b><span>${esc(LABEL[x])}</span></div>`).join(``)}</div>` : `<p class="muted small">Nothing done in this time yet.</p>`}
    </div>
    ${Object.keys(ai).length ? `<div class="label-sm">AI</div><div class="acc-card">${Object.entries(ai).map(([label, a]) => `<div class="act-ai"><b>${esc(label)}</b><span>${a.uses} time${a.uses === 1 ? `` : `s`}${a.total ? ` · names ${Math.round((a.score / a.total) * 100)}% right` : ``}</span></div>`).join(``)}
      <a class="link small" href="#/more/ai">How accurate AI has been</a></div>` : ``}
    ${groups.length ? `<div class="label-sm">Your groups now</div><div class="acc-card">${groups.map((g) => `<div class="act-ai"><b>${esc(g.name)}</b><span>${g.people} ${g.people === 1 ? `person` : `people`}${g.viewers ? ` (${g.viewers} view only)` : ``} · ${g.invs} inventor${g.invs === 1 ? `y` : `ies`} · ${g.items} items</span></div>`).join(``)}</div>` : ``}
    ${feedbackHtml()}
    ${switchHtml}
    <details class="raw-wrap"><summary class="small">See exactly what’s kept</summary><pre class="stats-raw">${esc(JSON.stringify(s, null, 1))}</pre></details>`;
}
/** What people told Help (questions with no answer, yes/no on topics, notes). Kept here to share with the Paran team. */
function feedbackHtml() {
  const fb = feedbackList(); if (!fb.length) return ``;
  const line = (f) => f.text ? `“${f.text}”` : f.topic ? `${topicById(f.topic)?.q || f.topic}: ${f.helpful ? `helped` : `didn’t help`}${f.q ? ` (asked “${f.q}”)` : ``}` : `No topic found for “${f.q}”`;
  return `<div class="label-sm">Your help feedback</div><div class="acc-card">
    ${fb.slice(-5).reverse().map((f) => `<div class="act-ai"><span>${esc(line(f))}</span></div>`).join(``)}
    ${fb.length > 5 ? `<p class="fine">and ${fb.length - 5} more</p>` : ``}
    <div class="row-actions left"><button type="button" class="btn primary small" data-fbshare>Share with the Paran team</button><button type="button" class="btn ghost small" data-fbclear>Clear</button></div>
    <p class="fine">Kept on this phone. Share sends it from your phone (WhatsApp, email…) to whoever you choose.</p></div>`;
}
const feedbackText = () => [`Paran help feedback`, ...feedbackList().map((f) => `• ${f.ts.slice(0, 10)} [${f.screen || `?`}] ${f.text ? `Note: ${f.text}` : ``}${f.q ? ` Asked: ${f.q}` : ``}${f.topic ? ` Topic: ${f.topic} (${f.helpful === true ? `helped` : f.helpful === false ? `didn’t help` : `opened`})` : ``}`)].join(`\n`);

const niceDay = (iso) => { try { return new Date(`${iso}T00:00`).toLocaleDateString(undefined, { day: `numeric`, month: `short` }); } catch { return iso; } };

// ============================================================ How accurate AI has been
// Added up from the "ai" rows in History (one per use of AI: what it offered and what was kept) and from later edits
// to fields AI filled, across every inventory with a copy on this phone. Nothing is sent anywhere.
const ACC_FIELD = { name: `Names`, qty: `Counts`, purpose: `What it’s for`, category: `Categories`, tags: `Search words`, size: `Sizes`, notes: `Notes`,
  match: `Matched to what you have`, line: `Matched to event needs`, pick: `Matched to your items` };
const ACC_GROUP = { photo: `Photos`, scan: `Photos`, receipt: `Receipts`, plan: `Event lists` };
function aiAccuracy() {
  const logs = [repo.log];
  if (repo.backend.kind === `google`) {
    for (const id of Object.keys(loadKnown(repo.user.email).inv)) {
      if (id === repo.backend.sheetId) continue;
      try { const c = JSON.parse(localStorage.getItem(`paran.cache.${id}`) || `null`); if (c?.log?.length) logs.push(c.log); } catch { /* ignore */ }
    }
  }
  const acc = {}; let aiNamed = 0, renamed = 0, laterScore = 0;
  for (const log of logs) {
    const named = new Set();
    for (const e of [...log].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
      const ch = Repo.parseChanges(e.changes);
      if (e.action === `ai` && ch.ai) {
        const g = acc[ACC_GROUP[ch.ai] || ch.ai] ||= { uses: 0, n: 0, t: 0, f: {}, sum: { ok: 0, gap: 0 } };
        g.uses++; g.n += Number(ch.n) || 0; g.t += Number(ch.t) || 0;
        for (const [k, [kept, changed, score]] of Object.entries(ch.f || {})) {
          g.f[k] ||= [0, 0, 0]; g.f[k][0] += kept; g.f[k][1] += changed; g.f[k][2] += score ?? kept; // older rows: unchanged = right
        }
        if (ch.sum === `ok` || ch.sum === `gap`) g.sum[ch.sum]++;
      } else if (e.action === `added` && Array.isArray(ch._ai) && ch._ai.includes(`name`)) { named.add(e.itemId); aiNamed++; }
      else if (e.itemId && named.has(e.itemId) && `name` in ch) { renamed++; laterScore += aiScore(`name`, ch.name[0], ch.name[1]); named.delete(e.itemId); }
    }
  }
  return { acc, aiNamed, renamed, laterScore, inventories: logs.length };
}
function aiAccuracyHtml() {
  const { acc, aiNamed, renamed, laterScore, inventories } = aiAccuracy();
  const groups = Object.entries(acc);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const bar = (label, a, b) => `<div class="acc-row"><span>${esc(label)}</span><b>${a} of ${b}</b><small>${pct(a, b)}%</small><i style="--p:${pct(a, b)}%"></i></div>`;
  // weighted: how right it was on average; the count says how often it needed no change at all
  const wbar = (label, kept, total, score, as = `saved as suggested`) => `<div class="acc-row"><span>${esc(label)}</span><b>${pct(score, total)}% right</b><small></small>
    <i style="--p:${pct(score, total)}%"></i><em>${kept} of ${total} ${as}</em></div>`;
  return `<div class="label-sm">How accurate it’s been</div>
    ${groups.length ? `<div class="acc-card">${groups.map(([label, g]) => `<div class="acc-g">
        <div class="acc-head"><b>${esc(label)}</b><small>used ${g.uses} time${g.uses === 1 ? `` : `s`} · ${g.t} of ${g.n} suggestions added</small></div>
        ${Object.entries(g.f).map(([k, [kept, changed, score]]) => wbar(ACC_FIELD[k] || k, kept, kept + changed, score)).join(``)}
        ${g.sum.ok + g.sum.gap ? bar(`Receipts that added up`, g.sum.ok, g.sum.ok + g.sum.gap) : ``}
      </div>`).join(``)}
      ${aiNamed ? `<div class="acc-g">${wbar(`AI names, weeks later`, aiNamed - renamed, aiNamed, aiNamed - renamed + laterScore, `never renamed`)}</div>` : ``}
      </div>
      <p class="fine">From History in ${inventories} inventor${inventories === 1 ? `y` : `ies`} on this phone, counting everyone who uses ${inventories === 1 ? `it` : `them`}. “% right” gives part marks for small fixes (a word added, 9 instead of 10); a different item or a wrong match counts as 0. Nothing is sent anywhere.</p>`
    : `<p class="fine">Nothing yet. Each time AI suggests something (a photo, a receipt, an event list), what you keep or change is noted in the inventory’s History, and the numbers show here.</p>`}`;
}

// ============================================================ Search across inventories
// Inventories with a copy on this phone are searched at once; the rest are fetched in the background
// (online) and kept on the phone for next time. Offline, a banner says what wasn't checked.
const xdrop = new Set(); // inventories dropped from this search with their chip (cleared with the search)
let xrun = 0;
const crossReady = () => repo?.backend.kind === `google` && Object.keys(loadKnown(repo.user.email).inv).filter((id) => id !== repo.backend.sheetId).length > 0;

function xcard(invId, item, locations, thumbs) {
  const parts = xpath(locations, item.locationId);
  const near = parts.slice(-2).join(` › `); const far = parts.length > 2 ? parts.slice(0, -2).join(` › `) : ``;
  const t = thumbs?.[item.id];
  return `<a class="card xcard" href="#" data-xinv="${esc(invId)}" data-xitem="${esc(item.id)}">
    ${t ? `<img class="thumb" src="${t}" alt="" loading="lazy">` : `<div class="thumb tint" style="--h:${tintOf(item.id || item.name)}">${icon(`box`)}</div>`}
    <div class="card-main">
      <div class="card-title">${esc(item.name)}${Number(item.qty) > 1 ? ` <span class="qty">×${esc(item.qty)}</span>` : ``}</div>
      <div class="card-path">${icon(`place`)}<span>${near ? esc(near) : `<i>No location yet</i>`}${far ? `<small> · ${esc(far)}</small>` : ``}</span></div>
      ${item.purpose ? `<div class="card-purpose">${esc(item.purpose)}</div>` : ``}
      ${STATUS_LABEL[item.status] ? `<span class="badge ${esc(item.status)}">${esc(STATUS_LABEL[item.status])}${item.lentTo ? ` · ${esc(item.lentTo)}` : ``}</span>` : ``}
    </div></a>`;
}

async function crossSearch(q, hereCount, hereHits = hereCount) {
  const run = ++xrun;
  const k = loadKnown(repo.user.email);
  const ids = Object.keys(k.inv).filter((id) => id !== repo.backend.sheetId);
  const groupName = (id) => { const g = k.inv[id]?.groupId; return (g && k.groups[g]?.name) || ``; };
  const online = navigator.onLine;
  const draw = () => {
    if (run !== xrun || !$(`#xresults`)) return;
    const sections = []; const unchecked = []; const loading = []; const needTap = []; let total = 0;
    const chips = [[repo.backend.sheetId, invName(), hereHits]];
    for (const id of ids) {
      const inv = k.inv[id];
      if (inv.reachable === false) { needTap.push(id); continue; }
      const m = xlocal(id);
      if (!m?.items) { (online && !xmem[id]?.failed ? loading : unchecked).push(id); continue; }
      if (xmem[id]?.loading && online) loading.push(id);
      const hits = search(m.items, q, (locId) => xpath(m.locations, locId).join(` › `));
      chips.push([id, inv.name || `Inventory`, hits.length]);
      if (xdrop.has(id)) continue;
      total += hits.length;
      if (hits.length) sections.push(`<div class="list-head xhead"><div class="label-sm">${esc(inv.name || `Inventory`)}${groupName(id) ? ` <small>· ${esc(groupName(id))}</small>` : ``} · ${hits.length} found</div></div>
        <div class="cards">${hits.slice(0, 50).map((i) => xcard(id, i, m.locations, m.thumbs)).join(``)}</div>`);
    }
    // one chip per inventory with matches: tap to drop it from the results, tap again to bring it back
    const shown = chips.filter(([id, , n]) => n || xdrop.has(id));
    const sc = $(`#scopes`);
    if (sc) sc.innerHTML = shown.length > 1 || xdrop.size ? shown.map(([id, name, n]) => xdrop.has(id)
      ? `<button type="button" class="chip scope off" data-scope="${esc(id)}" aria-pressed="false">${icon(`plus`)}${esc(name)}</button>`
      : `<button type="button" class="chip scope" data-scope="${esc(id)}" aria-pressed="true">${esc(name)} <b>${n}</b>${icon(`x`)}</button>`).join(``) : ``;
    const st = $(`#xstatus`);
    if (st) st.innerHTML = !online
      ? `<div class="offline-banner">${icon(`alert`)}<div><b>You’re offline</b><span>Showing what’s on this phone.${unchecked.length ? ` Not checked: ${esc(unchecked.map((id) => k.inv[id].name || `Inventory`).join(`, `))}.` : ``}</span></div></div>`
      : loading.length ? `<div class="xloading">${icon(`cloud`)} Checking ${esc(loading.map((id) => k.inv[id].name || `Inventory`).join(`, `))}…</div>`
      : unchecked.length ? `<div class="xloading warn">${icon(`alert`)} Couldn’t check ${esc(unchecked.map((id) => k.inv[id].name || `Inventory`).join(`, `))} right now.</div>` : ``;
    $(`#xresults`).innerHTML = `${sections.length ? `<div class="label-sm xother">In your other inventories</div>${sections.join(``)}` : ``}
      ${needTap.length ? `<button type="button" class="xtap" data-xopen="${esc(k.inv[needTap[0]].groupId || ``)}">${icon(`plus`)} Include ${esc(needTap.map((id) => k.inv[id].name || `Inventory`).join(`, `))} <small>one tap to open on this phone</small></button>` : ``}
      ${!hereCount && !total && !loading.length && xdrop.size && shown.some(([id, , n]) => n && xdrop.has(id)) ? `<p class="muted pad center">Matches are in the inventories you hid. Tap a chip above to bring one back.</p>`
        : !hereCount && !total && !loading.length ? `<div class="empty"><h3>No match for “${esc(q)}”</h3><p>Not in any of your inventories${unchecked.length ? ` on this phone` : ``}.</p><a class="btn ghost" href="#/add?name=${encodeURIComponent(q)}">${icon(`plus`)} Add “${esc(q)}”</a></div>` : ``}`;
  };
  draw();
  if (!online) return;
  // lazy: only inventories with no copy here, or a copy older than 10 minutes, and each once per few minutes
  const stale = ids.filter((id) => k.inv[id].reachable !== false && !xmem[id]?.loading && (!xlocal(id)?.items || Date.now() - (xmem[id]?.at || 0) > XFRESH_MS));
  for (const id of stale) xfetch(id).then(() => { if (run === xrun) draw(); });
}

// ============================================================ Several inventories, and groups of them
const invName = () => (repo?.backend.kind === `google` ? repo.backend.sheetName || `Inventory` : CONFIG.APP_NAME);
const currentGroupId = () => { const k = loadKnown(repo.user.email); return k.inv[repo.backend.sheetId]?.groupId || ``; };

/** Open another inventory: the app reopens straight into it (from this phone's copy if it has one). */
async function switchTo(sheetId, { hash = `#/` } = {}) {
  if (sheetId === repo.backend.sheetId) { location.hash = hash; return; }
  if (repo.outbox.length) {
    await repo.flush();
    if (repo.outbox.length && !(await confirmSheet(`Some changes aren’t saved yet`,
      `${repo.outbox.length} change(s) in ${invName()} haven’t reached Google. They stay on this phone and are saved next time you open ${invName()}.`, `Switch anyway`))) return;
  }
  const k = loadKnown(repo.user.email); const inv = k.inv[sheetId] || {};
  const g = inv.groupId && k.groups[inv.groupId];
  localStorage.setItem(`paran.session`, JSON.stringify({
    user: repo.user, sheetId, sheetName: inv.name || ``, isOwner: Boolean(inv.owner), rootFolderId: null, photoFolderId: null,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`, groupDirId: g?.dirId || null, fresh: true,
  }));
  localStorage.setItem(`paran.sheet.${repo.user.email}`, sheetId);
  location.hash = hash; location.reload();
}

/** A sheet of choices; resolves with the chosen value, or null if closed. */
function chooseSheet(title, options, note = ``) {
  return new Promise((resolve) => {
    let done = false;
    sheet(title, (el, close) => {
      el.innerHTML = `${note ? `<p class="muted small">${esc(note)}</p>` : ``}<div class="menu">${options.map(([v, label, sub], i) =>
        `<button data-i="${i}">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ``}</button>`).join(``)}</div>`;
      el.onclick = (e) => { const b = e.target.closest(`[data-i]`); if (!b) return; done = true; resolve(options[Number(b.dataset.i)][0]); close(); };
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

function invRow(id, inv, count) {
  const cur = id === repo?.backend.sheetId;
  const n = count ?? cachedCount(id);
  const sub = inv.reachable === false ? `Tap to open it on this phone` : n == null ? `` : itemsWord(n);
  return `<button type="button" class="list-row inv-row${cur ? ` current` : ``}" data-inv="${esc(id)}">${icon(cur ? `check` : `box`)}
    <span><b>${esc(inv.name || `Inventory`)}</b>${sub ? `<small>${esc(sub)}${cur ? ` · open now` : ``}</small>` : cur ? `<small>Open now</small>` : ``}</span>${icon(`chevron`)}</button>`;
}

function inventoriesSheet() {
  const user = repo.user;
  sheet(`Your inventories`, (el, close) => {
    let k = loadKnown(user.email); let loading = true; const counts = {};
    if (!k.inv[repo.backend.sheetId]) k = rememberInventory(user.email, repo.backend.sheetId, { name: repo.backend.sheetName, owner: repo.backend.isOwner, reachable: true });
    const draw = () => {
      const groups = Object.entries(k.groups);
      const inGroup = (gid) => Object.entries(k.inv).filter(([, i]) => i.groupId === gid);
      const loose = Object.entries(k.inv).filter(([, i]) => !i.groupId || !k.groups[i.groupId]);
      el.innerHTML = `
        ${groups.map(([gid, g]) => `<div class="inv-group">
          <div class="inv-group-head"><span>${icon(`users`)} ${esc(g.name)}</span><button type="button" class="link small" data-group="${esc(gid)}">Group page</button></div>
          <div class="list">${inGroup(gid).map(([id, i]) => invRow(id, i, counts[id])).join(``) || `<p class="muted pad">No inventories in this group yet.</p>`}</div></div>`).join(``)}
        ${loose.length ? `<div class="inv-group">${groups.length ? `<div class="inv-group-head"><span>Not in a group</span></div>` : ``}
          <div class="list">${loose.map(([id, i]) => invRow(id, i, counts[id])).join(``)}</div></div>` : ``}
        ${loading ? `<p class="fine">${icon(`cloud`)} Checking your Google Drive…</p>` : ``}
        <div class="menu inv-actions">
          <button data-m="newinv">${icon(`plus`)} New inventory</button>
          <button data-m="newgroup">${icon(`users`)} New group <small>an organization, or your homes</small></button>
          <button data-m="join">${icon(`download`)} Open one shared with you</button>
        </div>`;
    };
    draw();
    discover(user).then((nk) => {
      k = nk; loading = false; draw();
      Object.entries(k.inv).filter(([id, i]) => cachedCount(id) == null && i.reachable !== false).slice(0, 8)
        .forEach(([id]) => remoteCount(id).then((n) => { counts[id] = n; draw(); }).catch(() => {}));
    }).catch(() => { loading = false; draw(); });
    el.onclick = async (e) => {
      const g = e.target.closest(`[data-group]`); if (g) { close(); location.hash = `#/group/${g.dataset.group}`; return; }
      const r = e.target.closest(`[data-inv]`);
      if (r) {
        const id = r.dataset.inv; const inv = k.inv[id] || {};
        close();
        if (inv.reachable === false) { const ok = await openGroupInventories(inv.groupId); if (ok.includes(id)) switchTo(id); return; }
        switchTo(id); return;
      }
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `newinv`) newInventoryFlow();
      if (m === `newgroup`) newGroupFlow();
      if (m === `join`) { const first = await joinFlow(user).catch((err) => { toast(err.message); return null; }); if (first) inventoriesSheet(); }
    };
  });
}

async function newInventoryFlow({ groupId } = {}) {
  const user = repo.user; const k = loadKnown(user.email);
  const name = await promptSheet(`New inventory`, { label: `Name`, placeholder: `e.g. Lake house, Office, School storage`, okLabel: `Next` });
  if (!name) return;
  let gid = groupId;
  const groups = Object.entries(k.groups);
  if (gid === undefined && groups.length) {
    gid = await chooseSheet(`Put “${name}” in a group?`, [[``, `No group`, `Only you, until you share it`], ...groups.map(([id, g]) => [id, g.name, `Everyone in the group can open it`])]);
    if (gid === null) return;
  }
  toast(`Creating ${name}…`, { ms: 8000 });
  try {
    const inv = await createInventory(user, name, gid || ``);
    switchTo(inv.sheetId, { hash: `#/setup` });
  } catch (e) {
    toast(gid && !k.groups[gid]?.owner ? `Only the group’s owner can add inventories to it for now.` : `Couldn’t create it: ${e.message}`, { ms: 6000 });
  }
}

/**
 * An inventory just joined a group. In a group, access is the group's, so offer to add the people this inventory was
 * shared with to the group, with the same access. "Not now" leaves them on the inventory only (People shows them).
 */
async function bringPeopleIntoGroup(gid) {
  const k = loadKnown(repo.user.email); const g = k.groups[gid]; if (!g?.owner) return;
  const inGroup = new Set((g.people || []).map((p) => p.email.toLowerCase()));
  const people = repo.members.filter((m) => m.role !== `removed` && m.role !== `owner` && m.email !== repo.user.email && !inGroup.has(m.email.toLowerCase()));
  if (!people.length) return;
  const list = people.map((m) => `${m.email} (${m.role === `viewer` ? `can view` : `can edit`})`).join(`, `);
  if (!(await confirmSheet(`Give ${people.length === 1 ? `them` : `${people.length} people`} all of ${g.name}?`,
    `${invName()} is shared with ${list}. They keep ${invName()} either way. Also give them the whole group (all its inventories and its events) with the same access?`, `Give whole group`))) return;
  let n = 0;
  for (const m of people) { try { await inviteToGroup(repo.user, gid, m.email, m.role === `viewer` ? `reader` : `writer`); n++; } catch (e) { toast(`Couldn’t add ${m.email}: ${e.message}`); } }
  if (n) toast(`${n} added to ${g.name}`);
}

/**
 * A starting template, once the first inventory exists (it's the open one): its places; then, for a group, the group
 * with it inside and the other inventories with their places.
 */
async function applyTemplate(t) {
  const addPlaces = (places) => { for (const p of places) { const top = repo.saveLocation({ name: p.name, parentId: ``, kind: `place` }); for (const r of p.rooms) repo.saveLocation({ name: r, parentId: top.id, kind: `room` }); } };
  addPlaces(t.inventories[0]?.places || []);
  if (t.group) {
    const g = await putInGroup({ name: t.group });
    if (!g) return;
    for (const inv of t.inventories.slice(1)) {
      try {
        toast(`Creating ${inv.name}…`, { ms: 6000 });
        const made = await createInventory(repo.user, inv.name, g.id);
        await seedPlaces(made.sheetId, repo.user, inv.places);
      } catch (e) { toast(`Couldn’t create ${inv.name}: ${e.message}`, { ms: 6000 }); }
    }
    toast(`${t.group} is ready: ${t.inventories.map((i) => i.name).join(`, `)}. Switch between them from the name at the top.`, { ms: 7000 });
  } else toast(`Your places are in. Now add something you always hunt for.`, { ms: 5000 });
  render();
}

/** Put the open inventory (which you own) into a group: an existing one of yours, or a new one. Resolves the group or null. */
async function putInGroup({ gid = ``, name = `` }) {
  const user = repo.user;
  try {
    if (!gid) { toast(`Creating ${name}…`, { ms: 8000 }); gid = (await createGroup(user, name)).id; }
    await addToGroup(user, { sheetId: repo.backend.sheetId, folderId: repo.backend.rootFolderId, name: invName() }, gid);
    const k = loadKnown(user.email);
    repo.backend.groupDirId = k.groups[gid]?.dirId || null; repo.backend.saveSession();
    await bringPeopleIntoGroup(gid);
    return { id: gid, ...k.groups[gid] };
  } catch (e) { toast(`Couldn’t set up the group: ${e.message}`); return null; }
}

async function newGroupFlow() {
  const user = repo.user;
  const name = await promptSheet(`New group`, { label: `Group name`, placeholder: `e.g. Our homes, Tamil School`, okLabel: `Create` });
  if (!name) return;
  toast(`Creating ${name}…`, { ms: 8000 });
  let g;
  try { g = await createGroup(user, name); } catch (e) { toast(`Couldn’t create the group: ${e.message}`); return; }
  if (repo.backend.isOwner && !currentGroupId() && await confirmSheet(`Add “${invName()}” to ${name}?`,
    `Its folder moves into the group’s folder in your Drive. People you invite to the group can then open it.`, `Add it`)) {
    try {
      await addToGroup(user, { sheetId: repo.backend.sheetId, folderId: repo.backend.rootFolderId, name: invName() }, g.id);
      repo.backend.groupDirId = g.dirId; repo.backend.saveSession();
      await bringPeopleIntoGroup(g.id);
    } catch (e) { toast(`Couldn’t move it: ${e.message}`); }
  }
  location.hash = `#/group/${g.id}`;
}

/** Pick what someone shared (inventories and/or group directories). Resolves with the first inventory id, or null. */
async function joinFlow(user) {
  const ids = await pickSheets({ title: `Pick the inventory or group directory shared with you` });
  if (!ids.length) return null;
  const k = loadKnown(user.email); let first = null; const groupsToOpen = []; let skipped = 0;
  for (const id of ids) {
    let f; try { f = await identify(id); } catch { skipped++; continue; }
    if (f.role === `sheet`) {
      k.inv[id] = { ...(k.inv[id] || {}), name: f.name, owner: f.owner === user.email, reachable: true };
      first ||= id;
    } else if (f.role === `directory`) {
      const gid = f.parents[0]; if (!gid) { skipped++; continue; }
      const dir = await readDirectory(id);
      k.groups[gid] = { ...(k.groups[gid] || {}), name: f.name.replace(/ – directory$/, ``), dirId: id, owner: f.owner === user.email, people: dir.people };
      for (const inv of dir.inventories) k.inv[inv.id] = { reachable: false, ...(k.inv[inv.id] || {}), name: inv.name, groupId: gid };
      groupsToOpen.push(gid);
    } else skipped++;
  }
  saveKnown(user.email, k);
  if (skipped) toast(`${skipped} file${skipped > 1 ? `s weren’t` : ` wasn’t`} a ${CONFIG.APP_NAME} inventory`);
  for (const gid of groupsToOpen) {
    const opened = await openGroupInventories(gid, { user });
    first ||= opened[0] || null;
  }
  return first;
}

/** Google only lets the app open files the person picks, so for a group they tick its inventories once. */
async function openGroupInventories(gid, { user = repo.user } = {}) {
  const k = loadKnown(user.email); const g = k.groups[gid];
  const waiting = Object.entries(k.inv).filter(([, i]) => i.groupId === gid && i.reachable === false);
  if (!waiting.length) return [];
  if (!(await confirmSheet(`Open the inventories in ${g?.name || `this group`}`,
    `${waiting.length} inventor${waiting.length > 1 ? `ies need` : `y needs`} one tap to open on this phone. Google will show them: tick ${waiting.length > 1 ? `all of them` : `it`} and tap Select.`, `Continue`))) return [];
  const ids = await pickSheets({ parentId: gid, title: `Tick the inventories in ${g?.name || `this group`}` });
  const k2 = loadKnown(user.email); const ok = [];
  for (const id of ids) { if (k2.inv[id]) { k2.inv[id].reachable = true; ok.push(id); } else { try { const f = await identify(id); if (f.role === `sheet`) { k2.inv[id] = { name: f.name, groupId: gid, reachable: true }; ok.push(id); } } catch { /* skip */ } } }
  saveKnown(user.email, k2);
  return ok;
}

function viewGroup(view, r) {
  const user = repo.user;
  let k = loadKnown(user.email); const gid = r.id;
  const counts = {};
  const draw = () => {
    const g = k.groups[gid];
    if (!g) { view.innerHTML = `<div class="empty"><h3>Group not found</h3><button class="btn ghost" data-a="list">Your inventories</button></div>`; return; }
    const invs = Object.entries(k.inv).filter(([, i]) => i.groupId === gid);
    const cur = repo.backend.sheetId;
    const canAddCurrent = repo.backend.isOwner && !k.inv[cur]?.groupId;
    const people = g.people || [];
    view.innerHTML = `<div class="place group">
      <div class="crumbs top"><button type="button" class="link" data-a="list">Your inventories</button></div>
      <div class="place-head"><h1>${icon(`users`)} ${esc(g.name)}</h1></div>
      <p class="muted small">A group keeps several inventories together, like an organization’s, or your homes. Sharing the group shares all of them.</p>
      <div class="label-sm">Inventories · ${invs.length}</div>
      <div class="list">${invs.map(([id, i]) => invRow(id, i, counts[id])).join(``) || `<p class="muted pad">None yet.</p>`}
        ${g.owner ? `<button type="button" class="list-row link-row add-row" data-a="newinv">${icon(`plus`)}<span>New inventory in ${esc(g.name)}</span></button>` : ``}
        ${g.owner && canAddCurrent ? `<button type="button" class="list-row link-row add-row" data-a="addcur">${icon(`move`)}<span>Add “${esc(invName())}” to this group</span></button>` : ``}
      </div>
      <div class="label-sm">People · ${people.length}</div>
      <div class="list">${people.filter((p) => p.role !== `removed`).map((p) => { const tap = g.owner && p.email !== user.email && p.role !== `owner`;
        return `<${tap ? `button type="button" data-gaccess="${esc(p.email)}"` : `div`} class="list-row${tap ? ` tap` : ``}">${icon(`users`)}<span>${esc(p.email)}</span><small>${roleLabel(p.role)}</small>${tap ? icon(`chevron`) : ``}</${tap ? `button` : `div`}>`; }).join(``)}</div>
      ${g.owner ? `<form class="inline-new invite-form" id="ginvite"><input type="email" placeholder="Their Google email" required>${roleSelect()}<button class="btn primary">Invite</button></form>
        <p class="fine">They can open every inventory in ${esc(g.name)}, including ones added later: <b>Can edit</b> to change things, <b>Can view</b> to search and browse only. They sign in to ${esc(CONFIG.APP_NAME)}, choose “Open one shared with you” and pick “${esc(g.name)} – directory”.</p>`
        : `<p class="fine">The group’s owner can invite people.</p>`}
    </div>`;
  };
  draw();
  const g0 = k.groups[gid];
  if (g0?.dirId) readDirectory(g0.dirId).then((dir) => {
    k = loadKnown(user.email); const g = k.groups[gid]; if (!g) return;
    g.people = dir.people;
    for (const inv of dir.inventories) k.inv[inv.id] = { reachable: false, ...(k.inv[inv.id] || {}), name: k.inv[inv.id]?.name || inv.name, groupId: gid };
    saveKnown(user.email, k);
    if (route().name === `group`) draw();
    Object.entries(k.inv).filter(([id, i]) => i.groupId === gid && cachedCount(id) == null && i.reachable !== false)
      .forEach(([id]) => remoteCount(id).then((n) => { counts[id] = n; if (route().name === `group`) draw(); }).catch(() => {}));
  }).catch(() => {});
  view.onclick = async (e) => {
    const ga = e.target.closest(`[data-gaccess]`);
    if (ga) { accessSheet({ email: ga.dataset.gaccess, role: (k.groups[gid]?.people || []).find((p) => p.email === ga.dataset.gaccess)?.role, scope: `group`, groupId: gid }); return; }
    const row = e.target.closest(`[data-inv]`);
    if (row) {
      const id = row.dataset.inv; const inv = k.inv[id] || {};
      if (inv.reachable === false) { const ok = await openGroupInventories(gid); k = loadKnown(user.email); draw(); if (ok.includes(id)) switchTo(id); return; }
      switchTo(id); return;
    }
    const a = e.target.closest(`[data-a]`)?.dataset.a; if (!a) return;
    if (a === `list`) inventoriesSheet();
    if (a === `newinv`) newInventoryFlow({ groupId: gid });
    if (a === `addcur`) {
      try {
        await addToGroup(user, { sheetId: repo.backend.sheetId, folderId: repo.backend.rootFolderId, name: invName() }, gid);
        repo.backend.groupDirId = k.groups[gid]?.dirId || null; repo.backend.saveSession();
        k = loadKnown(user.email); draw(); toast(`${invName()} is now in ${k.groups[gid].name}`);
        await bringPeopleIntoGroup(gid); k = loadKnown(user.email); draw();
      } catch (err) { toast(`Couldn’t move it: ${err.message}`); }
    }
  };
  view.onsubmit = async (e) => { // delegated: the page redraws when the directory arrives
    if (e.target.id !== `ginvite`) return;
    e.preventDefault();
    const input = e.target.querySelector(`input`); const btn = e.target.querySelector(`button`); btn.disabled = true;
    const role = e.target.querySelector(`select`)?.value || `writer`;
    try { await inviteToGroup(user, gid, input.value.trim(), role); toast(`Invited ${input.value.trim()} to ${k.groups[gid].name} (${role === `reader` ? `can view` : `can edit`})`); k = loadKnown(user.email); draw(); }
    catch (err) { toast(`Couldn’t invite: ${err.message}`); btn.disabled = false; }
  };
}

// ============================================================ More
// ============================================================ More: a short menu, each topic on its own page
function viewMore(view, r) {
  const g = repo.backend.kind === `google`;
  const page = r?.id || ``;
  const head = (title) => `<div class="more-head"><a class="back" href="#/more">${icon(`back`)} More</a></div><h1>${esc(title)}</h1>`;
  const members = repo.members.filter((m) => m.role !== `removed`);
  const myRole = repo.backend.isOwner ? `Owner` : repo.readOnly ? `Can view` : `Can edit`;
  const gid = g ? currentGroupId() : ``; const grp = gid && loadKnown(repo.user.email).groups[gid];

  if (page === `inventory` && g) {
    view.innerHTML = `<div class="more">${head(`Inventory`)}
      <div class="menu">
        <div class="menu-info">${icon(`box`)}<div><b>${esc(invName())}</b><small>${esc(myRole)}${grp ? ` · in ${esc(grp.name)}` : ``}</small></div></div>
        <button data-m="switch">${icon(`ret`)} Switch inventory</button>
        ${repo.backend.isOwner ? `<button data-m="rename">${icon(`edit`)} Rename this inventory</button>` : ``}
        ${grp ? `<a href="#/group/${esc(gid)}">${icon(`users`)} Group: ${esc(grp.name)}</a>` : ``}
      </div>
      <div class="label-sm">Add</div>
      <div class="menu">
        <button data-m="newinv">${icon(`plus`)} New inventory</button>
        <button data-m="newgroup">${icon(`users`)} New group <small>an organization, or your homes</small></button>
        <button data-m="join">${icon(`download`)} Open one shared with you</button>
      </div></div>`;
  } else if (page === `people` && g && grp) {
    // Two kinds of access: the whole group (all its inventories and its events), or just this inventory.
    const gp = (grp.people || []).filter((p) => p.role !== `removed`);
    const inGroup = new Set(gp.map((p) => p.email.toLowerCase()));
    const only = repo.members.filter((m) => m.role !== `removed` && !inGroup.has(m.email.toLowerCase()));
    const invOwner = repo.backend.canShare; const canInvite = grp.owner || invOwner;
    const rowFor = (email, role, kind) => { const tap = email !== repo.user.email && role !== `owner` && (kind === `group` ? grp.owner : invOwner);
      return `<${tap ? `button type="button" ${kind === `group` ? `data-gaccess` : `data-access`}="${esc(email)}"` : `div`} class="list-row${tap ? ` tap` : ``}">${icon(`users`)}<span>${esc(email)}${email === repo.user.email ? ` <small>(you)</small>` : ``}</span><small>${roleLabel(role)}</small>${tap ? icon(`chevron`) : ``}</${tap ? `button` : `div`}>`; };
    view.innerHTML = `<div class="more">${head(`People & access`)}
      <div class="label-sm first">Everyone in ${esc(grp.name)}</div>
      <p class="fine">All of <a href="#/group/${esc(gid)}">${esc(grp.name)}</a>’s inventories, and its events.</p>
      <div class="list">${gp.map((p) => rowFor(p.email, p.role, `group`)).join(``)}</div>
      <div class="label-sm">Only ${esc(invName())}</div>
      <p class="fine">Just this inventory. They don’t see ${esc(grp.name)}’s events, but anything they’re asked to bring shows on their home screen.</p>
      ${only.length ? `<div class="list">${only.map((m) => `<div class="only-row">${rowFor(m.email, m.role, `inv`)}${grp.owner && m.role !== `owner` ? `<button type="button" class="btn small ghost" data-togroup="${esc(m.email)}" data-role="${esc(m.role)}">Give whole group</button>` : ``}</div>`).join(``)}</div>` : `<p class="muted small pad">Nobody yet.</p>`}
      ${canInvite ? `<div class="label-sm">Invite</div>
        <form class="invite-form stack" id="pinvite"><input type="email" placeholder="Their Google email" required>
          <div class="inline-new">
            <select name="scope" aria-label="Access to">${grp.owner ? `<option value="group">Whole ${esc(grp.name)}</option>` : ``}${invOwner ? `<option value="inv">Only ${esc(invName())}</option>` : ``}</select>
            ${roleSelect()}<button class="btn primary">Invite</button></div></form>
        <p class="fine"><b>Can edit</b>: add, move, lend and change things. <b>Can view</b>: search and browse only. They open ${esc(CONFIG.APP_NAME)}, sign in, choose “Open one shared with you” and pick ${grp.owner ? `“${esc(grp.name)} – directory” (whole group) or ` : ``}“${esc(invName())}”.</p>`
        : `<p class="fine">The owner can invite people.</p>`}
    </div>`;
  } else if (page === `people` && g) {
    const owner = repo.backend.canShare;
    view.innerHTML = `<div class="more">${head(`People & access`)}
      <p class="muted small">Who can open ${esc(invName())}. ${owner ? `Tap someone to change what they can do.` : ``}</p>
      <div class="list">${members.map((m) => {
        const tappable = owner && m.email !== repo.user.email && m.role !== `owner`;
        return `<${tappable ? `button type="button" data-access="${esc(m.email)}"` : `div`} class="list-row${tappable ? ` tap` : ``}">${icon(`users`)}<span>${esc(m.email)}${m.email === repo.user.email ? ` <small>(you)</small>` : ``}</span><small>${roleLabel(m.role)}</small>${tappable ? icon(`chevron`) : ``}</${tappable ? `button` : `div`}>`;
      }).join(``)}</div>
      ${owner ? `<form class="inline-new invite-form" id="invite"><input type="email" placeholder="Their Google email" required>${roleSelect()}<button class="btn primary">Invite</button></form>
        <p class="fine"><b>Can edit</b>: add, move, lend and change things. <b>Can view</b>: search and browse only; Google won’t let them change anything. They open ${esc(CONFIG.APP_NAME)}, sign in, choose “Open one shared with you” and pick “${esc(invName())}”. Only you can share it onward.</p>`
        : repo.readOnly ? `<p class="fine">You can view this inventory. Ask its owner if you need to change things.</p>` : `<p class="fine">This inventory is shared with you. Its owner can invite others.</p>`}
    </div>`;
  } else if (page === `ai`) {
    view.innerHTML = `<div class="more">${head(`AI suggestions`)}
      ${aiReady() ? `<div class="menu">
          <div class="menu-info">${icon(`spark`)}<div><b>On</b><small>Model: ${esc(aiSettings().model)}</small><small>${aiUsageToday()} AI request${aiUsageToday() === 1 ? `` : `s`} today on this device (photos, receipts, lists) · resets 3 AM ET</small></div></div>
          <label class="menu-switch"><span>Suggest details from photos</span><span class="switch"><input type="checkbox" data-aiauto ${aiSettings().auto ? `checked` : ``}><i></i></span></label>
          <button data-m="aikey">${icon(`edit`)} Change Gemini key</button>
          <button data-m="aioff" class="danger">${icon(`x`)} Turn off and remove key</button>
        </div>`
        : `<div class="ai-card">${icon(`spark`)}<div><b>Name things from a photo</b><p>Snap a shelf or a bin and get the list of what’s in it. Free, about a minute to set up.</p>
          <button class="btn primary" data-m="aion">Set it up</button></div></div>`}
      ${aiAccuracyHtml()}
    </div>`;
  } else if (page === `stats`) {
    view.innerHTML = `<div class="more">${head(`Your activity`)}${statsPage()}</div>`;
  } else if (page === `data`) {
    // The sheets are the owner's: only owners get links to them. Data is spread over sheets, so each link says what's in it.
    const b = repo.backend; const grp = g ? repo.group() : null;
    const ownInv = g && b.isOwner; const ownGroup = Boolean(grp?.owner);
    let rootId = null; try { rootId = g ? localStorage.getItem(`paran.root.${repo.user.email}`) : null; } catch { /* ignore */ }
    if ((ownInv || ownGroup) && !rootId) paranRoot(repo.user).then(() => { if (route().name === `more`) render(); }).catch(() => {}); // new phone: find it
    const ext = (href, title, sub, ic = `sheet`) => `<a href="${esc(href)}" target="_blank" rel="noopener">${icon(ic)}<span class="menu-two"><b>${esc(title)}</b><small>${esc(sub)}</small></span></a>`;
    const owner = (repo.members || []).find((m) => m.role === `owner`)?.email;
    view.innerHTML = `<div class="more">${head(`Your data`)}
      ${ownInv || ownGroup ? `<div class="label-sm">In your Google Drive</div><div class="menu">
        ${ownInv ? ext(b.sheetUrl, `“${b.sheetName || invName()}” sheet`, `Items, places, people, history and tasks for this inventory`) : ``}
        ${ownGroup ? ext(`https://docs.google.com/spreadsheets/d/${grp.dirId}/edit`, `“${grp.name} – directory” sheet`, `The group’s events, its inventories and its people`) : ``}
        ${rootId ? ext(`https://drive.google.com/drive/folders/${rootId}`, `Your Paran folder`, `Every group and inventory you own, with their photos`, `cloud`) : ``}
      </div>
      <p class="fine">These are the real data: fine to look at, print or keep as a backup. Make changes in ${esc(CONFIG.APP_NAME)}, though; editing rows or columns by hand can confuse the app.</p>` : ``}
      <div class="menu">
        <button data-m="csv">${icon(`download`)} Download this inventory (CSV)</button>
        <button data-m="sync">${icon(`cloud`)} Refresh now</button>
      </div>
      <p class="fine">${esc(CONFIG.APP_NAME)} stores nothing on any server. ${!g ? `In demo mode, everything stays in this browser.`
        : ownInv ? `` : `${esc(invName())} is kept in ${owner ? esc(owner) : `its owner`}’s Google Drive; only the owner opens its sheet. You can download a copy.`}</p>
    </div>`;
  } else {
    const total = repo.activeItems().length;
    const places = repo.locations.filter((l) => !l.deleted).length;
    const row = (href, ic, title, sub) => `<a href="${href}" class="more-row">${icon(ic)}<span><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ``}</span>${icon(`chevron`)}</a>`;
    view.innerHTML = `
    <div class="more">
      <h1>More</h1>
      <div class="account">
        ${repo.user.picture ? `<img src="${esc(repo.user.picture)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar">${esc((repo.user.name || `?`)[0])}</div>`}
        <div><b>${esc(repo.user.name)}</b><small>${esc(repo.user.email)}</small><small class="where-data">${icon(g ? `cloud` : `alert`)} ${esc(repo.label)}</small></div>
      </div>
      <div class="stats"><div><b>${total}</b><span>items</span></div><div><b>${places}</b><span>places</span></div>
        <div><b>${repo.activeItems().filter((i) => i.status === `lent`).length}</b><span>lent out</span></div></div>
      <div class="menu more-menu">
        ${g ? row(`#/more/inventory`, `box`, invName(), `Switch, rename, add${grp ? ` · ${grp.name}` : ``}`) : ``}
        ${row(`#/events`, `calendar`, `Events`, (() => { const n = splitEvents().upcoming.length; return n ? `${n} coming up` : `What an event needs, and where it is`; })())}
        ${g ? (() => { const n = grp ? (grp.people || []).filter((p) => p.role !== `removed`).length : members.length;
          return row(`#/more/people`, `users`, `People & access`, `${n} ${n === 1 ? `person` : `people`}${grp ? ` in ${grp.name}` : ``} · you: ${myRole.toLowerCase()}`); })() : ``}
        ${row(`#/more/ai`, `spark`, `AI suggestions`, aiReady() ? `On` : `Off`)}
        ${row(`#/more/stats`, `clock`, `Your activity`, statsOn() ? `What you’ve done in Paran · kept on this phone` : `Off`)}
        ${row(`#/more/data`, `sheet`, `Your data`, g && (repo.backend.isOwner || repo.group()?.owner) ? `Google Sheets, download, refresh` : `Download, refresh`)}
        <button data-m="about" class="more-row">${icon(`info`)}<span><b>About ${esc(CONFIG.APP_NAME)}</b></span>${icon(`chevron`)}</button>
      </div>
      <div class="menu">
        ${g ? `<button data-m="signout">${icon(`out`)} Sign out</button>`
          : `${googleConfigured() ? `<button data-m="google">${googleG()} Sign in with Google</button>` : ``}
             <button data-m="reset" class="danger">${icon(`trash`)} Clear demo data</button>`}
      </div>
    </div>`;
  }

  view.onsubmit = async (e) => {
    if (e.target.id === `pinvite`) { // People page of an inventory in a group: invite to the group or just this inventory
      e.preventDefault();
      const input = e.target.querySelector(`input`); const role = e.target.querySelector(`select[name=role]`)?.value || `writer`;
      if (e.target.querySelector(`select[name=scope]`)?.value === `inv`) {
        const btn0 = e.target.querySelector(`button`); btn0.disabled = true;
        try { await repo.invite(input.value.trim(), role); toast(`Invited ${input.value.trim()} to ${invName()} only (${role === `reader` ? `can view` : `can edit`})`); render(); }
        catch (err) { toast(`Couldn’t invite: ${err.message}`); btn0.disabled = false; }
        return;
      }
      const btn = e.target.querySelector(`button`); btn.disabled = true;
      try { await inviteToGroup(repo.user, gid, input.value.trim(), role); toast(`Invited ${input.value.trim()} to ${grp.name} (${role === `reader` ? `can view` : `can edit`})`); render(); }
      catch (err) { toast(`Couldn’t invite: ${err.message}`); btn.disabled = false; }
      return;
    }
    if (e.target.id !== `invite`) return;
    e.preventDefault();
    const input = e.target.querySelector(`input`); const role = e.target.querySelector(`select`)?.value || `writer`;
    const btn = e.target.querySelector(`button`); btn.disabled = true;
    try { await repo.invite(input.value.trim(), role); toast(`Invited ${input.value.trim()} (${role === `reader` ? `can view` : `can edit`})`); input.value = ``; render(); }
    catch (err) { toast(`Couldn’t invite: ${err.message}`); }
    finally { btn.disabled = false; }
  };
  $(`[data-aiauto]`, view)?.addEventListener(`change`, (e) => saveAiSettings({ auto: e.target.checked }));
  $(`[data-fbshare]`, view)?.addEventListener(`click`, () => shareOut({ title: `Paran help feedback`, text: feedbackText() }));
  $(`[data-fbclear]`, view)?.addEventListener(`click`, async () => { if (await confirmSheet(`Clear help feedback?`, `What you told Help on this phone is deleted.`, `Clear`, true)) { clearFeedback(); render(); } });
  view.querySelectorAll(`[data-period]`).forEach((b) => b.addEventListener(`click`, () => { actPeriod = Number(b.dataset.period); render(); }));
  $(`[data-stats]`, view)?.addEventListener(`change`, (e) => { setStatsOn(e.target.checked); lastSnap = 0; if (e.target.checked) statsSnapshot(); setTimeout(render, 1700); });
  if (r?.params?.get(`ai`) === `1` && !aiReady()) setTimeout(() => aiConsent().then((ok) => ok && render()), 50);

  view.onclick = async (e) => {
    const who = e.target.closest(`[data-person]`);
    if (who) { personSheet(who.dataset.person); return; }
    const ga = e.target.closest(`[data-gaccess]`);
    if (ga) { accessSheet({ email: ga.dataset.gaccess, role: (grp?.people || []).find((p) => p.email === ga.dataset.gaccess)?.role, scope: `group`, groupId: gid }); return; }
    const tg = e.target.closest(`[data-togroup]`);
    if (tg) {
      tg.disabled = true;
      try { await inviteToGroup(repo.user, gid, tg.dataset.togroup, tg.dataset.role === `viewer` ? `reader` : `writer`); toast(`${tg.dataset.togroup} added to ${grp.name}`); render(); }
      catch (err) { toast(`Couldn’t add: ${err.message}`); tg.disabled = false; }
      return;
    }
    const acc = e.target.closest(`[data-access]`);
    if (acc) { accessSheet({ email: acc.dataset.access, role: members.find((m) => m.email === acc.dataset.access)?.role, scope: `inventory` }); return; }
    const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
    if (m === `aion` || m === `aikey`) { if (await aiConsent(m === `aikey`)) render(); return; }
    if (m === `aioff`) {
      if (await confirmSheet(`Turn off AI suggestions?`, `The API key is removed from this device. Items already added keep their details.`, `Turn off`, true)) { disableAi(); render(); toast(`AI suggestions off`); }
      return;
    }
    if (m === `about`) { aboutSheet(); return; }
    if (m === `switch`) { inventoriesSheet(); return; }
    if (m === `newinv`) { newInventoryFlow(); return; }
    if (m === `newgroup`) { newGroupFlow(); return; }
    if (m === `join`) { const first = await joinFlow(repo.user).catch((err) => { toast(err.message); return null; }); if (first) inventoriesSheet(); return; }
    if (m === `rename`) {
      const name = await promptSheet(`Rename inventory`, { label: `Name`, value: invName(), okLabel: `Rename` });
      if (!name || name === invName()) return;
      try {
        await renameInventory(repo.user, { sheetId: repo.backend.sheetId, folderId: repo.backend.rootFolderId }, name);
        repo.backend.sheetName = name; repo.backend.saveSession(); render(); toast(`Renamed to ${name}`);
      } catch (err) { toast(`Couldn’t rename: ${err.message}`); }
      return;
    }
    if (m === `csv`) {
      const a = document.createElement(`a`);
      a.href = URL.createObjectURL(repo.exportCsv());
      a.download = `paran-inventory-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    }
    if (m === `sync`) { await repo.refresh(); toast(repo.status === `synced` ? `Up to date` : `Sync: ${repo.status}`); }
    if (m === `signout`) {
      if (repo.outbox.length && !(await confirmSheet(`Sign out?`, `${repo.outbox.length} change(s) haven’t reached Google yet and will be lost.`, `Sign out anyway`, true))) return;
      signOut(); [MODE_KEY, `paran.session`].forEach((k) => localStorage.removeItem(k)); location.hash = ``; location.reload();
    }
    if (m === `google`) { localStorage.removeItem(MODE_KEY); start(`google`, { interactive: true }); }
    if (m === `reset` && await confirmSheet(`Clear demo data?`, `Removes everything stored in this browser.`, `Clear`, true)) {
      localStorage.removeItem(`paran.cache.demo`); localStorage.removeItem(MODE_KEY); location.hash = ``; location.reload();
    }
  };
}

/** Change what one person can do: in this inventory, or in a whole group. Owner only. */
function accessSheet({ email, role, scope, groupId = `` }) {
  const k = loadKnown(repo.user.email);
  const where = scope === `group` ? k.groups[groupId]?.name || `the group` : invName();
  sheet(email, (el, close) => {
    const opt = (v, label, sub, on) => `<button data-set="${v}" class="${on ? `on` : ``}">${icon(on ? `check` : `users`)}<span><b>${esc(label)}</b><small>${esc(sub)}</small></span></button>`;
    el.innerHTML = `<p class="muted small">Access to <b>${esc(where)}</b>${scope === `group` ? ` and every inventory in it` : ``}.</p>
      <div class="menu access-menu">
        ${opt(`writer`, `Can edit`, `Add, move, lend and change things`, role === `member` || role === `editor`)}
        ${opt(`reader`, `Can view`, `Search and browse only`, role === `viewer`)}
      </div>
      <div class="menu">
        ${scope === `inventory` && role !== `pending-owner` ? `<button data-set="owner">${icon(`out`)} Make them the owner…</button>` : ``}
        <button data-set="remove" class="danger">${icon(`x`)} Remove from ${esc(where)}</button>
      </div>`;
    el.onclick = async (e) => {
      const b = e.target.closest(`[data-set]`); if (!b) return;
      const action = b.dataset.set;
      if ((action === `writer` && (role === `member` || role === `editor`)) || (action === `reader` && role === `viewer`)) { close(); return; }
      if (action === `remove` && !(await confirmSheet(`Remove ${email}?`, `They can’t open ${where} any more. What’s already on their phone isn’t erased, but they won’t get anything new.`, `Remove`, true))) return;
      if (action === `owner` && !(await confirmSheet(`Make ${email} the owner?`,
        `Google will email them to accept ownership of “${where}”. Until they accept, you stay the owner. After that, they manage people and you can still edit. Photos you added stay in your Google Drive.`, `Send request`))) return;
      b.disabled = true;
      try {
        if (scope === `group`) await groupAccess(repo.user, groupId, email, action);
        else await repo.setAccess(email, action);
        close();
        toast(action === `remove` ? `${email} removed` : action === `owner` ? `Ownership offered to ${email}. They accept it in Google Drive.` : `${email} can ${action === `reader` ? `view` : `edit`} now`, { ms: 5000 });
        render();
      } catch (err) { toast(`Couldn’t change access: ${err.message}`, { ms: 5000 }); b.disabled = false; }
    };
  });
}

function aboutSheet() {
  sheet(`About ${CONFIG.APP_NAME}`, (el) => {
    el.innerHTML = `<div class="about">
      <div class="about-mark">${icon(`box`)}</div>
      <h3>Why “${esc(CONFIG.APP_NAME)}”</h3>
      <p>In Tamil homes, the <b>paran</b> (<span lang="ta">பரண்</span>) is the storage loft above the kitchen or hallway.
        Everything goes up there, and nobody remembers what’s in it.</p>
      <p>${esc(CONFIG.APP_NAME)} is that loft, except you can find things.</p>
      <h3>Your data stays yours</h3>
      <p>${repo.backend.kind === `google` ? `Everything lives in your own Google Drive.` : `In demo mode, everything stays in this browser.`} ${esc(CONFIG.APP_NAME)} has no server and never sees your inventory or photos.</p>
      <p class="fine center about-by">Made by AarvaKuzhu</p>
    </div>`;
  });
}

boot();
