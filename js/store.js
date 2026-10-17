// Data layer: in-memory state + local cache + outbox, with two backends:
//  - GoogleBackend: Sheet + Drive folder in the user's own Google account
//  - DemoBackend:   everything in this browser (for trying the app without Google setup)
import { CONFIG } from './config.js';
import { drive, sheets, userinfo, AuthError } from './google.js';
import { blobs } from './idb.js';
import { createInventory as createInventoryFiles, readDirectory, rememberInventory, changeAccess, setRoleRow, loadKnown, paranRoot, tidyIntoRoot, discover } from './inventories.js';

export const ITEM_COLS = [`id`, `name`, `purpose`, `category`, `tags`, `locationId`, `qty`, `status`, `lentTo`,
  `photoId`, `photoUrl`, `warranty`, `expiry`, `notes`, `addedBy`, `addedAt`, `updatedAt`, `updatedBy`, `deleted`, `thumb`,
  `dueAt`, `size`, `photos`, `price`, `store`, `boughtAt`, `receipt`]; // columns added later go AFTER thumb so older sheets stay aligned
// price/store/boughtAt: from a receipt (or typed). receipt: Drive id of the receipt photo (several items can share one).
// photos: JSON list of additional photos [{ pid, id, url, thumb }]. In memory the thumbs live in repo.thumbs.
const THUMB_COL = colLetterOf(ITEM_COLS.indexOf(`thumb`));
const BEFORE_THUMB = colLetterOf(ITEM_COLS.indexOf(`thumb`) - 1);
const AFTER_THUMB = [ITEM_COLS.indexOf(`thumb`) + 1, ITEM_COLS.length - 1].map(colLetterOf);
function colLetterOf(n) { let s = ``; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
export const LOC_COLS = [`id`, `name`, `parentId`, `kind`, `notes`, `createdBy`, `createdAt`, `deleted`];
export const MEMBER_COLS = [`email`, `role`, `photoFolderId`, `invitedBy`, `joinedAt`];
export const LOG_COLS = [`ts`, `itemId`, `action`, `detail`, `by`, `info`, `changes`];
// info: readable summary (what changed / pick-up date / moved from). changes: JSON { field: [before, after] } so an edit can be undone;
// on `added` it is { _ai: [fields AI suggested] } so AI may refine its own suggestions later but never what someone typed.
export const TRACKED_FIELDS = [`name`, `purpose`, `category`, `size`, `tags`, `qty`, `warranty`, `expiry`, `notes`, `price`, `store`, `boughtAt`];

// Events (graduation, Annual Day, a camping trip): what's needed, in sections, each line pointing at an item.
// date is YYYY-MM-DD (optional). A line with no itemId is something needed that isn't in the inventory yet.
// New columns go at the END of each list so older sheets stay aligned.
export const EVENT_COLS = [`id`, `name`, `date`, `notes`, `createdBy`, `createdAt`, `updatedAt`, `updatedBy`, `deleted`];
export const ELINE_COLS = [`id`, `eventId`, `section`, `itemId`, `name`, `qty`, `note`, `sort`, `updatedAt`, `updatedBy`, `deleted`, `invId`, `sources`, `bringers`, `got`, `after`];
// got: JSON [{ who, n }] — what arrived on the day, and who brought it (who '' = not said). after: JSON { state, note, to, at, by }
// once the event is over: back (in its place) | moved | missing | damaged | kept (added to the inventory) | gone (used up / returned).
// sources: JSON [{ inv, id, name, off }] — every item that counts toward this line (tablecloths in the school closet AND the
// storage unit). off = marked "not for this event".
// bringers: JSON [{ name, qty }] — who is bringing it (buying, borrowing, or taking it from where it's kept). qty 0 = all of it. itemId/invId mirror the first one, so older app versions still show something.
// invId: which inventory (spreadsheet id) the item is in. Group events (kept in the group's directory sheet) draw on every
// inventory in the group; an inventory's own events leave it empty (= this inventory).
// Tasks: an event assignment for someone who has access to this inventory but not to the group (so they can't open the
// group's events). Written by the organizer's app into an inventory they can open; they mark it done. id = lineId:email.
export const TASK_COLS = [`id`, `eventId`, `eventName`, `eventDate`, `lineId`, `email`, `name`, `qty`, `todo`, `section`, `done`, `updatedAt`, `updatedBy`, `deleted`];
export const TASK_TAB = { name: `Tasks`, cols: TASK_COLS };
export const EVENT_TABS = [
  { name: `Events`, cols: EVENT_COLS },
  { name: `EventLines`, cols: ELINE_COLS },
];

export const TABS = [
  { name: `Items`, cols: ITEM_COLS },
  { name: `Locations`, cols: LOC_COLS },
  { name: `Members`, cols: MEMBER_COLS },
  { name: `Log`, cols: LOG_COLS },
  ...EVENT_TABS,
  TASK_TAB,
];
const ROW_TAB = { item: [`Items`, ITEM_COLS], location: [`Locations`, LOC_COLS], event: [`Events`, EVENT_COLS], eline: [`EventLines`, ELINE_COLS], task: [`Tasks`, TASK_COLS] };

const colLetter = (n) => { let s = ``; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
export const lastCol = (cols) => colLetter(cols.length - 1);
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, ``).slice(0, 10);
export const now = () => new Date().toISOString();

export function rowsToObjects(values, cols) {
  if (!values || values.length < 2) return [];
  const header = values[0].map(String);
  const idx = cols.map((c) => header.indexOf(c));
  return values.slice(1).map((row) => {
    const o = {};
    cols.forEach((c, i) => { const v = idx[i] >= 0 ? row[idx[i]] : ``; o[c] = v === undefined || v === null ? `` : v; });
    return o;
  }).filter((o) => o.id || o.email || o.ts);
}
export const objectToRow = (o, cols) => cols.map((c) => (o[c] === undefined || o[c] === null ? `` : o[c]));

// ------------------------------------------------------------------ backends
class DemoBackend {
  kind = `demo`;
  async connect() {
    return { user: { email: `you@demo.local`, name: `Demo user` }, label: `Demo – saved in this browser only` };
  }
  async fetchAll() { return null; } // the local cache is the source of truth
  async fetchThumbs() { return null; }
  async writeOps() { /* nothing remote */ }
  async uploadPhoto(blob, itemId) {
    const photoId = `local-${itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await blobs.put(`photo:${photoId}`, blob);
    return { photoId, photoUrl: `` };
  }
  async photoObjectUrl(item) {
    if (!item.photoId) return null;
    const b = await blobs.get(`photo:${item.photoId}`);
    return b ? URL.createObjectURL(b) : null;
  }
  get canShare() { return false; }
  get cacheKey() { return `demo`; }
}

const SESSION_KEY = `paran.session`;
const PHOTO_LRU_KEY = `paran.photoLRU`;
const PHOTO_CACHE_MAX = 150;

class GoogleBackend {
  kind = `google`;
  user = null; sheetId = null; sheetName = null; photoFolderId = null; rootFolderId = null; isOwner = true;
  groupDirId = null; // set when this inventory belongs to a group (its directory sheet)
  canEdit = true;    // false when shared as "Can view" (Google enforces it; the app hides edit actions)

  get cacheKey() { return this.sheetId; }
  get canShare() { return this.isOwner; }
  prefKey() { return `paran.sheet.${this.user.email}`; }

  /** choice: undefined (auto), `create` / { create: true, name } (start a new inventory), or a spreadsheet id picked to join */
  async connect(choice) {
    const create = choice === `create` || choice?.create;
    if (!this.user) {
      const u = await userinfo();
      this.user = { email: u.email, name: u.name || u.email, picture: u.picture };
    }
    this.sheetId = choice && !create ? choice : create ? null : localStorage.getItem(this.prefKey());
    if (this.sheetId) {
      try { await this.inspectSheet(); }
      catch (e) { if (e instanceof AuthError || choice) throw e; this.sheetId = null; }
    }
    if (!this.sheetId) {
      const found = await drive.findTagged(`sheet`);
      if (found.length && !create) { this.sheetId = found[0].id; await this.inspectSheet(); }
      else if (create) await this.createInventory(choice?.name);
      else return { user: this.user, needsChoice: true };
    }
    localStorage.setItem(this.prefKey(), this.sheetId);
    await this.ensureHeaders();
    await this.ensureEventTabs().catch((e) => console.warn(`event tabs`, e)); // never blocks opening the inventory
    await this.ensurePhotoFolder();
    tidyIntoRoot(this.user).catch((e) => console.warn(`tidy`, e)); // older groups and inventories into the Paran folder
    this.saveSession();
    return { user: this.user, label: this.label() };
  }

  label() { return this.isOwner ? `Your Google Drive` : `Shared inventory`; }

  // Remember enough to reopen straight into the cached inventory, even before Google has re-issued a token.
  saveSession() {
    if (this.legacy) return;
    const { user, sheetId, sheetName, isOwner, rootFolderId, photoFolderId, sheetUrl, groupDirId, canEdit, inGroupName } = this;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user, sheetId, sheetName, isOwner, rootFolderId, photoFolderId, sheetUrl, groupDirId, canEdit, inGroupName }));
  }
  static savedSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || `null`); } catch { return null; } }
  resume() {
    const s = GoogleBackend.savedSession() || GoogleBackend.legacySession(); if (!s?.sheetId) return null;
    Object.assign(this, s);
    return { user: this.user, label: this.label() };
  }

  /** Installs from before sessions were saved: rebuild one from the keys they already have on the device. */
  static legacySession() {
    try {
      const key = Object.keys(localStorage).find((k) => k.startsWith(`paran.sheet.`) && localStorage.getItem(k));
      if (!key) return null;
      const email = key.slice(`paran.sheet.`.length);
      const sheetId = localStorage.getItem(key);
      if (!localStorage.getItem(`paran.cache.${sheetId}`)) return null; // nothing cached to show yet
      return { user: { email, name: email.split(`@`)[0] }, sheetId, isOwner: true, rootFolderId: null,
        photoFolderId: localStorage.getItem(`paran.photos.${email}.${sheetId}`), sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`, legacy: true };
    } catch { return null; }
  }

  /** After a resume, finish the one-time checks once we have a token. */
  async afterResume() {
    if (this.legacy) {
      const u = await userinfo();
      this.user = { email: u.email, name: u.name || u.email, picture: u.picture };
      await this.inspectSheet(); this.legacy = false;
    }
    else { await this.inspectSheet(); this.fresh = false; } // each open: name, owner, and whether this person can still edit
    await this.ensureHeaders(); await this.ensureEventTabs().catch((e) => console.warn(`event tabs`, e));
    await this.ensurePhotoFolder(); this.saveSession();
    tidyIntoRoot(this.user).catch((e) => console.warn(`tidy`, e));
  }

  async inspectSheet() {
    const m = await drive.meta(this.sheetId);
    this.sheetName = m.name || null;
    const owner = m.owners?.[0]?.emailAddress;
    this.isOwner = !owner || owner === this.user.email;
    this.canEdit = this.isOwner || m.capabilities?.canEdit !== false;
    this.inGroupName = m.appProperties?.groupName || ``; // set when the inventory is in a group (readable even without group access)
    this.rootFolderId = this.isOwner ? (m.parents?.[0] || null) : null;
    this.sheetUrl = `https://docs.google.com/spreadsheets/d/${this.sheetId}/edit`;
    const k = rememberInventory(this.user.email, this.sheetId, { name: this.sheetName, owner: this.isOwner, reachable: true });
    let g = k.inv[this.sheetId]?.groupId; this.groupDirId = (g && k.groups[g]?.dirId) || this.groupDirId || null;
    // The sheet says it's in a group this phone doesn't know yet (a new phone, or reopened after clearing): look for the
    // group's directory. Found = this person has the group; not found = they have this inventory only (asked again in an hour).
    const askKey = `paran.groupask.${this.user.email}.${this.sheetId}`;
    if (this.inGroupName && !this.groupDirId && Date.now() - Number(localStorage.getItem(askKey) || 0) > 3600_000) {
      try {
        const k2 = await discover(this.user);
        g = k2.inv[this.sheetId]?.groupId; this.groupDirId = (g && k2.groups[g]?.dirId) || null;
        if (!this.groupDirId) localStorage.setItem(askKey, String(Date.now()));
      } catch { /* offline: try next time */ }
    }
    // inventories that joined a group before the label existed: the owner's app adds it
    if (g && this.isOwner && k.groups[g]?.name && this.inGroupName !== k.groups[g].name) {
      drive.setProps(this.sheetId, { groupName: k.groups[g].name }).then(() => { this.inGroupName = k.groups[g].name; }).catch(() => {});
    }
  }

  async createInventory(name = CONFIG.SHEET_NAME) {
    const inv = await createInventoryFiles(this.user, name);
    this.sheetId = inv.sheetId; this.sheetName = inv.name; this.rootFolderId = inv.folderId; this.isOwner = true;
    this.sheetUrl = `https://docs.google.com/spreadsheets/d/${this.sheetId}/edit`;
  }

  /** Older sheets: add header cells for columns introduced since (they're always appended at the end). */
  async ensureHeaders() {
    if (!this.canEdit) return;
    const key = `paran.hdr.${this.sheetId}`;
    const ver = `${ITEM_COLS.length}.${LOG_COLS.length}`;
    if (localStorage.getItem(key) === ver) return;
    const r = await sheets.batchGet(this.sheetId, [`Items!1:1`, `Log!1:1`]);
    const updates = [];
    [[`Items`, ITEM_COLS], [`Log`, LOG_COLS]].forEach(([tab, cols], i) => {
      const header = (r.valueRanges[i]?.values?.[0] || []).map(String);
      const isPrefix = header.every((h, j) => h === cols[j]);
      if (header.length < cols.length && isPrefix) updates.push({ range: `${tab}!A1`, values: [cols] });
    });
    if (updates.length) await sheets.batchUpdateValues(this.sheetId, updates);
    localStorage.setItem(key, ver);
  }

  /**
   * Sheets made before Events existed: add the Events and EventLines tabs (and header cells for columns added since).
   * Returns true when the tabs are there. Viewers can't add tabs; they simply see no events until the owner opens the app.
   */
  ensureEventTabs(sheetId = this.sheetId) { return this.ensureTabs(sheetId, EVENT_TABS, `evtabs`); }
  ensureTaskTab(sheetId = this.sheetId) { return this.ensureTabs(sheetId, [TASK_TAB], `tasktab`); }
  async ensureTabs(sheetId, tabs, tag) {
    const key = `paran.${tag}.${sheetId}`;
    const ver = tabs.map((t) => t.cols.length).join(`.`);
    if (localStorage.getItem(key) === ver) return true;
    if (sheetId === this.sheetId && !this.canEdit) return false;
    const have = await sheets.tabTitles(sheetId);
    const missing = tabs.filter((t) => !have.includes(t.name));
    const present = tabs.filter((t) => have.includes(t.name));
    if (missing.length) {
      await sheets.addTabs(sheetId, missing.map((t) => t.name));
      await sheets.batchUpdateValues(sheetId, missing.map((t) => ({ range: `${t.name}!A1`, values: [t.cols] })));
    }
    if (present.length) {
      const r = await sheets.batchGet(sheetId, present.map((t) => `${t.name}!1:1`));
      const updates = [];
      present.forEach((t, i) => {
        const header = (r.valueRanges[i]?.values?.[0] || []).map(String);
        if (header.length < t.cols.length && header.every((h, j) => h === t.cols[j])) updates.push({ range: `${t.name}!A1`, values: [t.cols] });
      });
      if (updates.length) await sheets.batchUpdateValues(sheetId, updates);
    }
    localStorage.setItem(key, ver);
    return true;
  }

  async ensurePhotoFolder() {
    if (!this.canEdit) return; // viewers don't add photos
    const key = `paran.photos.${this.user.email}.${this.sheetId}`;
    this.photoFolderId = localStorage.getItem(key);
    if (this.photoFolderId) return;
    const role = `photos-${this.sheetId}`;
    const found = await drive.findTagged(role);
    if (found.length) this.photoFolderId = found[0].id;
    else {
      // the owner's photos sit in the inventory's folder; anyone else's in their own Paran folder
      const f = await drive.createFolder(
        this.isOwner ? `Photos` : `Photos – ${this.sheetName || `shared inventory`}`, this.isOwner ? this.rootFolderId : await paranRoot(this.user), role);
      this.photoFolderId = f.id;
      if (!this.isOwner) {
        // let everyone in this inventory open the full-size photos this member adds
        const r = await sheets.get(this.sheetId, `Members!A1:${lastCol(MEMBER_COLS)}`);
        const members = rowsToObjects(r.values, MEMBER_COLS);
        const people = new Set(members.map((m) => m.email));
        if (this.groupDirId) { // a group's inventory: everyone in the group, too
          try { (await readDirectory(this.groupDirId)).people.forEach((p) => people.add(p.email)); } catch { /* ignore */ }
        }
        for (const email of people) {
          if (email && email !== this.user.email) await drive.share(f.id, email, `reader`, false).catch(() => {});
        }
      }
    }
    localStorage.setItem(key, this.photoFolderId);
  }

  async fetchAll({ events = true, tasks = events } = {}) {
    // Make sure the Tasks tab exists first (once per sheet), so reading it isn't a failed request on every refresh.
    const tk = tasks ? this.ensureTaskTab().catch(() => false)
      .then(() => sheets.get(this.sheetId, `Tasks!A1:${lastCol(TASK_COLS)}`)).catch(() => null) : Promise.resolve(null);
    // Events come in a separate request: older sheets opened by a viewer may not have those tabs yet (null = unknown, keep what's cached).
    const evRanges = EVENT_TABS.map((t) => `${t.name}!A1:${lastCol(t.cols)}`);
    const ev = events ? sheets.batchGet(this.sheetId, evRanges).catch(() => null) : Promise.resolve(null);
    const gev = events && this.groupDirId ? sheets.batchGet(this.groupDirId, evRanges).catch(() => null) : Promise.resolve(null);
    const r = await sheets.batchGet(this.sheetId, [
      `Items!A1:${BEFORE_THUMB}`, // everything except the (large) thumb column…
      `Locations!A1:${lastCol(LOC_COLS)}`,
      `Members!A1:${lastCol(MEMBER_COLS)}`,
      `Log!A1:${lastCol(LOG_COLS)}`,
      `Items!${AFTER_THUMB[0]}1:${AFTER_THUMB[1]}`, // …plus columns added after it
    ]);
    const [left, locs, members, log, right] = r.valueRanges.map((v) => v.values || []);
    const items = left.map((row, i) => [...row, ...Array(Math.max(0, ITEM_COLS.indexOf(`thumb`) - row.length)).fill(``), ``, ...(right[i] || [])]);
    if (items[0]) items[0].splice(ITEM_COLS.indexOf(`thumb`), 1, `thumb`);
    const evr = await ev; const gevr = await gev; const tkr = await tk;
    return {
      tasks: tkr ? rowsToObjects(tkr.values || [], TASK_COLS) : null,
      groupEvents: gevr ? rowsToObjects(gevr.valueRanges[0]?.values || [], EVENT_COLS) : null,
      groupLines: gevr ? rowsToObjects(gevr.valueRanges[1]?.values || [], ELINE_COLS) : null,
      events: evr ? rowsToObjects(evr.valueRanges[0]?.values || [], EVENT_COLS) : null,
      eventLines: evr ? rowsToObjects(evr.valueRanges[1]?.values || [], ELINE_COLS) : null,
      log: rowsToObjects(log, LOG_COLS).slice(-5000),
      items: rowsToObjects(items, ITEM_COLS.filter((c) => c !== `thumb`)),
      locations: rowsToObjects(locs, LOC_COLS),
      members: rowsToObjects(members, MEMBER_COLS),
    };
  }

  async fetchThumbs() {
    const tc = THUMB_COL;
    const r = await sheets.batchGet(this.sheetId, [`Items!A:A`, `Items!${tc}:${tc}`]);
    const ids = r.valueRanges[0].values || [];
    const th = r.valueRanges[1].values || [];
    const map = {};
    for (let i = 1; i < ids.length; i++) if (ids[i]?.[0] && th[i]?.[0]) map[ids[i][0]] = th[i][0];
    return map;
  }

  async writeOps(ops) {
    const rowMaps = {};
    const rowMap = async (sheetId, tab) => {
      const k = `${sheetId}|${tab}`;
      if (!rowMaps[k]) {
        const r = await sheets.get(sheetId, `${tab}!A:A`);
        const m = {}; (r.values || []).forEach((row, i) => { if (i > 0 && row[0]) m[row[0]] = i + 1; });
        rowMaps[k] = m;
      }
      return rowMaps[k];
    };
    this.tabsOk ||= new Set();
    for (const op of ops) {
      if (op.kind === `log`) { await sheets.append(op.sheet || this.sheetId, `Log!A1`, [objectToRow(op.data, LOG_COLS)]); continue; }
      if (op.kind === `task`) {
        const target = op.sheet || this.sheetId;
        if (!this.tabsOk.has(`t:${target}`)) { if (await this.ensureTaskTab(target)) this.tabsOk.add(`t:${target}`); }
        const m = await rowMap(target, `Tasks`); const r = m[op.data.id];
        if (r) {
          await sheets.batchUpdateValues(target, Object.entries(op.data).filter(([f, v]) => TASK_COLS.includes(f) && v !== undefined)
            .map(([f, v]) => ({ range: `Tasks!${colLetterOf(TASK_COLS.indexOf(f))}${r}`, values: [[v ?? ``]] })));
        } else {
          const res = await sheets.append(target, `Tasks!A1`, [objectToRow(op.data, TASK_COLS)]);
          const match = /![A-Z]+(\d+)/.exec(res.updates?.updatedRange || ``); if (match) m[op.data.id] = Number(match[1]);
        }
        continue;
      }
      if (op.kind === `xitem`) { // a few fields of an item in another inventory of the group: only those cells, so its photo preview stays
        const m = await rowMap(op.sheet, `Items`); const r = m[op.data.id];
        if (!r) continue; // removed there meanwhile
        await sheets.batchUpdateValues(op.sheet, Object.entries(op.data.fields)
          .filter(([f]) => ITEM_COLS.includes(f)).map(([f, v]) => ({ range: `Items!${colLetterOf(ITEM_COLS.indexOf(f))}${r}`, values: [[v ?? ``]] })));
        continue;
      }
      if (op.kind === `member`) { await sheets.append(this.sheetId, `Members!A1`, [objectToRow(op.data, MEMBER_COLS)]); continue; }
      const target = op.sheet || this.sheetId; // group events go to the group's directory sheet
      if ((op.kind === `event` || op.kind === `eline`) && !this.tabsOk.has(target)) { if (await this.ensureEventTabs(target)) this.tabsOk.add(target); }
      const [tab, cols] = ROW_TAB[op.kind] || ROW_TAB.location;
      const m = await rowMap(target, tab);
      const row = objectToRow(op.data, cols);
      const r = m[op.data.id];
      if (r) await sheets.update(target, `${tab}!A${r}:${lastCol(cols)}${r}`, [row]);
      else {
        const res = await sheets.append(target, `${tab}!A1`, [row]);
        const match = /![A-Z]+(\d+)/.exec(res.updates?.updatedRange || ``);
        if (match) m[op.data.id] = Number(match[1]);
      }
    }
  }

  async uploadPhoto(blob, itemId, name = `${itemId}.jpg`) {
    const f = await drive.upload(blob, name, this.photoFolderId);
    return { photoId: f.id, photoUrl: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view` };
  }

  /** Full photo from this device's cache, else from Drive (then cached). Throws AuthError when a sign-in is needed. */
  photoObjectUrl(item) {
    if (!item.photoId) return Promise.resolve(null);
    // one download per photo even if the screen asks twice while it's loading
    this.inflight ||= new Map();
    if (!this.inflight.has(item.photoId)) {
      const p = this.loadPhoto(item).finally(() => this.inflight.delete(item.photoId));
      this.inflight.set(item.photoId, p);
    }
    return this.inflight.get(item.photoId).then((blob) => (blob ? URL.createObjectURL(blob) : null));
  }

  async loadPhoto(item) {
    const key = `photo:${item.photoId}`;
    const cached = await blobs.get(key).catch(() => null);
    if (cached) { touchLru(item.photoId); return cached; }
    let blob;
    try { blob = await drive.downloadBlob(item.photoId); }
    catch (e) { if (e instanceof AuthError) throw e; return null; } // e.g. a photo in another member's Drive
    await blobs.put(key, blob).catch(() => {});
    touchLru(item.photoId);
    return blob;
  }

  /** role: `writer` (Can edit) or `reader` (Can view: Google won't let them change anything). */
  async invite(email, role = `writer`) {
    await drive.share(this.sheetId, email, role === `reader` ? `reader` : `writer`, true);
    if (this.rootFolderId) await drive.share(this.rootFolderId, email, `reader`, false);
    drive.ownerOnlySharing(this.sheetId).catch(() => {});
    if (this.rootFolderId) drive.ownerOnlySharing(this.rootFolderId).catch(() => {});
    return { email, role: role === `reader` ? `viewer` : `member`, photoFolderId: ``, invitedBy: this.user.email, joinedAt: now() };
  }

  forgetSheet() { localStorage.removeItem(this.prefKey()); }
}

/** Read another inventory's items and places (for search across inventories). Nothing is written. */
export async function fetchInventory(sheetId) {
  const b = new GoogleBackend(); b.sheetId = sheetId;
  const d = await b.fetchAll({ events: false, tasks: true });
  const m = await sheets.get(sheetId, `Members!A1:${lastCol(MEMBER_COLS)}`).catch(() => null);
  return { items: d.items, locations: d.locations, tasks: d.tasks, members: m ? rowsToObjects(m.values || [], MEMBER_COLS) : null };
}

function touchLru(photoId) {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(PHOTO_LRU_KEY) || `[]`); } catch { /* ignore */ }
  list = [photoId, ...list.filter((x) => x !== photoId)];
  for (const old of list.splice(PHOTO_CACHE_MAX)) blobs.del(`photo:${old}`).catch(() => {});
  try { localStorage.setItem(PHOTO_LRU_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ repository
export class Repo extends EventTarget {
  items = []; locations = []; members = []; log = []; thumbs = {}; events = []; eventLines = []; tasks = [];
  outbox = []; syncing = false; status = `idle`; lastError = null;

  constructor(kind) {
    super();
    this.backend = kind === `google` ? new GoogleBackend() : new DemoBackend();
  }

  emit(type = `change`) { this.dispatchEvent(new Event(type)); }
  get key() { return `paran.cache.${this.backend.cacheKey}`; }

  async connect(choice) {
    const info = await this.backend.connect(choice);
    this.user = info.user;
    if (info.needsChoice) return info;
    this.label = info.label;
    this.loadCache();
    this.emit();
    if (this.backend.kind === `demo` && !this.items.length && !this.locations.length) this.seedDemo();
    this.refresh();
    return info;
  }

  /** Open from the saved session and local cache without any network call. Returns info or null. */
  resume() {
    if (this.backend.kind !== `google`) return null;
    const info = this.backend.resume(); if (!info) return null;
    this.user = info.user; this.label = info.label; this.needsResumeChecks = true;
    this.loadCache(); this.emit();
    return info;
  }

  loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(this.key) || `null`);
      if (c) Object.assign(this, { items: c.items || [], locations: c.locations || [], members: c.members || [], log: c.log || [], outbox: c.outbox || [], events: c.events || [], eventLines: c.eventLines || [], tasks: c.tasks || [] });
    } catch { /* ignore */ }
    blobs.get(`thumbs:${this.backend.cacheKey}`).then((t) => { if (t) { this.thumbs = { ...t, ...this.thumbs }; this.emit(); } });
  }

  saveCache() {
    const strip = this.items.map(({ thumb, ...rest }) => rest);
    try {
      localStorage.setItem(this.key, JSON.stringify({ items: strip, locations: this.locations, members: this.members, log: this.log.slice(-3000), outbox: this.outbox, events: this.events, eventLines: this.eventLines, tasks: this.tasks }));
    } catch (e) { console.warn(`cache save failed`, e); }
    blobs.put(`thumbs:${this.backend.cacheKey}`, this.thumbs).catch(() => {});
  }

  /** Pull latest from the backend, keeping any local edits still waiting in the outbox. */
  async refresh() {
    if (this.needsResumeChecks) {
      try { await this.backend.afterResume(); this.needsResumeChecks = false; this.user = this.backend.user; this.label = this.backend.label(); }
      catch (e) { this.handleError(e); return; }
    }
    await this.flush();
    if (!navigator.onLine) return;
    try {
      const data = await this.backend.fetchAll();
      if (data) {
        const pending = new Map(this.outbox.filter((o) => o.kind === `item` || o.kind === `location`).map((o) => [o.data.id, o.data]));
        this.items = data.items.map((i) => pending.get(i.id) || i);
        for (const [id, d] of pending) if (!this.items.find((i) => i.id === id) && `purpose` in d) this.items.push(d);
        this.locations = data.locations.map((l) => pending.get(l.id) || l);
        for (const [id, d] of pending) if (!this.locations.find((l) => l.id === id) && `kind` in d) this.locations.push(d);
        this.items.forEach((i) => this.absorbPhotoThumbs(i));
        this.members = data.members;
        // rows from a sheet, with local changes still waiting to be sent on top. Group rows are marked _g.
        const withPending = (rows, kind, group) => {
          const p = new Map(this.outbox.filter((o) => o.kind === kind && Boolean(o.sheet) === group).map((o) => [o.data.id, o.data]));
          const out = rows.map((x) => p.get(x.id) || x);
          for (const [id, d] of p) if (!out.some((x) => x.id === id)) out.push(d);
          return group ? out.map((x) => ({ ...x, _g: 1 })) : out.map(({ _g, ...x }) => x);
        };
        const mine = (list, g) => list.filter((x) => Boolean(x._g) === g);
        const inGroup = Boolean(this.backend.groupDirId);
        this.events = [
          ...(data.events ? withPending(data.events, `event`, false) : mine(this.events, false)),
          ...(!inGroup ? [] : data.groupEvents ? withPending(data.groupEvents, `event`, true) : mine(this.events, true)),
        ];
        this.eventLines = [
          ...(data.eventLines ? withPending(data.eventLines, `eline`, false) : mine(this.eventLines, false)),
          ...(!inGroup ? [] : data.groupLines ? withPending(data.groupLines, `eline`, true) : mine(this.eventLines, true)),
        ];
        if (data.tasks) { // with this phone's changes not yet sent on top
          const p = this.outbox.filter((o) => o.kind === `task` && o.sheet === this.hereId).map((o) => o.data);
          const t = data.tasks.map((x) => ({ ...x }));
          for (const d of p) { const cur = t.find((x) => x.id === d.id); if (cur) Object.assign(cur, Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined))); else t.push(d); }
          this.tasks = t;
        }
        const pendingLog = this.outbox.filter((o) => o.kind === `log` && !o.sheet).map((o) => o.data); // not other inventories' entries
        this.log = [...(data.log || []), ...pendingLog];
        this.saveCache(); this.emit();
        const t = await this.backend.fetchThumbs();
        if (t) { this.thumbs = { ...this.thumbs, ...t }; this.saveCache(); this.emit(); }
      }
      this.setStatus(this.outbox.length ? `pending` : `synced`);
    } catch (e) { this.handleError(e); }
  }

  setStatus(s, err = null) { this.status = s; this.lastError = err; this.emit(`status`); }

  handleError(e) {
    console.error(e);
    if (this.backend.kind === `google` && /permission|forbidden/i.test(e?.message || ``) && !this.checkingAccess) {
      // maybe access was changed to "Can view": ask Drive, then switch to view-only if so
      this.checkingAccess = true;
      this.backend.inspectSheet().then(() => {
        this.backend.saveSession();
        if (this.readOnly) { this.setStatus(`synced`); this.emit(`readonly`); this.emit(); }
        else this.setStatus(`error`, e);
      }).catch(() => this.setStatus(`error`, e)).finally(() => { this.checkingAccess = false; });
      return;
    }
    if (e instanceof AuthError) this.setStatus(`auth`, e);
    else this.setStatus(navigator.onLine ? `error` : `offline`, e);
  }

  /** Shared with this person as "Can view". */
  get readOnly() { return this.backend.kind === `google` && this.backend.canEdit === false; }

  queue(op) {
    if (this.readOnly) { this.emit(`readonly`); return; } // nothing is changed or queued
    this.outbox.push(op); this.saveCache(); this.flush();
  }

  async flush() {
    if (this.syncing || !this.outbox.length || this.readOnly) return;
    if (!navigator.onLine) { this.setStatus(`offline`); return; }
    this.syncing = true; this.setStatus(`syncing`);
    try {
      while (this.outbox.length) {
        const op = this.outbox[0];
        if (op.kind === `photo`) await this.flushPhoto(op);
        else if (op.kind === `receipt`) await this.flushReceipt(op);
        else if (op.kind === `xphoto`) await this.flushExtraPhoto(op);
        else if (op.sheet) { // a group event row (the group's directory sheet), or an item change in another inventory of the group
          try { await this.backend.writeOps([op]); }
          catch (e) {
            if (e instanceof AuthError || !/permission|forbidden|not found|caller does not have/i.test(e?.message || ``)) throw e;
            // Google refused (no edit access to the group): drop it so this inventory's own changes still go through
            console.warn(`group event not saved`, e); this.emit(`groupdenied`);
          }
        } else {
          const data = op.kind === `item` ? { ...op.data, thumb: this.thumbs[op.data.id] || ``, photos: this.photosForSheet(op.data.photos) } : op.data;
          await this.backend.writeOps([{ ...op, data }]);
        }
        this.outbox.shift(); this.saveCache();
      }
      this.setStatus(`synced`);
    } catch (e) { this.handleError(e); }
    finally { this.syncing = false; }
  }

  async flushPhoto(op) {
    const blob = await blobs.get(`pending:${op.itemId}`);
    if (blob) {
      const { photoId, photoUrl } = await this.backend.uploadPhoto(blob, op.itemId);
      const item = this.items.find((i) => i.id === op.itemId);
      if (item) {
        item.photoId = photoId; item.photoUrl = photoUrl;
        // make sure the photo reference reaches the sheet even if the item row was already written
        this.outbox.splice(1, 0, { kind: `item`, data: { ...item } });
      }
      await blobs.del(`pending:${op.itemId}`);
      this.emit();
    }
  }

  /** A receipt photo: kept on the phone until uploaded, then every item from it points at the one Drive file. */
  async queueReceipt(rid, blob) {
    await blobs.put(`pending:r:${rid}`, blob);
    this.outbox.push({ kind: `receipt`, rid }); this.saveCache(); this.flush();
  }
  async flushReceipt(op) {
    const blob = await blobs.get(`pending:r:${op.rid}`);
    if (blob) {
      const { photoId } = await this.backend.uploadPhoto(blob, `receipt-${op.rid}`, `receipt-${op.rid}.jpg`);
      for (const item of this.items.filter((i) => i.receipt === `p:${op.rid}`)) {
        item.receipt = photoId;
        this.outbox.splice(1, 0, { kind: `item`, data: { ...item } });
      }
      await blobs.put(`photo:${photoId}`, blob).catch(() => {}); // keep it on this phone too
      await blobs.del(`pending:r:${op.rid}`);
      this.emit();
    }
  }
  receiptUrl(item) {
    const r = item?.receipt; if (!r) return Promise.resolve(null);
    if (r.startsWith(`p:`)) return blobs.get(`pending:r:${r.slice(2)}`).then((b) => (b ? URL.createObjectURL(b) : null));
    return blobs.get(`photo:${r}`).then((b) => (b ? URL.createObjectURL(b) : this.backend.photoObjectUrl({ photoId: r })));
  }

  async flushExtraPhoto(op) {
    const blob = await blobs.get(`pending:x:${op.pid}`);
    const item = this.items.find((i) => i.id === op.itemId);
    const list = item ? this.photosOf(item) : [];
    const entry = list.find((p) => p.pid === op.pid);
    if (blob && entry) {
      const { photoId, photoUrl } = await this.backend.uploadPhoto(blob, op.itemId, `${op.itemId}-${op.pid}.jpg`);
      entry.id = photoId; entry.url = photoUrl;
      item.photos = JSON.stringify(list);
      this.outbox.splice(1, 0, { kind: `item`, data: { ...item } });
    }
    if (blob) await blobs.del(`pending:x:${op.pid}`);
    this.emit();
  }

  // ---------------- extra photos (close-up, scale)
  static parsePhotos(v) {
    try { const a = typeof v === `string` ? JSON.parse(v || `[]`) : (v || []); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  photosOf(item) { return Repo.parsePhotos(item?.photos); }
  /** Sheet value: the list plus each photo's small preview, so everyone in the inventory sees them. */
  photosForSheet(v) {
    const list = Repo.parsePhotos(v);
    return list.length ? JSON.stringify(list.map((p) => ({ ...p, thumb: this.thumbs[`x:${p.pid}`] || `` }))) : ``;
  }
  /** Coming from the sheet: move previews into the thumbs store so the cache stays small. */
  absorbPhotoThumbs(item) {
    const list = Repo.parsePhotos(item.photos);
    for (const p of list) if (p.thumb) { this.thumbs[`x:${p.pid}`] = p.thumb; delete p.thumb; }
    item.photos = list.length ? JSON.stringify(list) : ``;
  }
  static MAX_EXTRA_PHOTOS = 5; // + the main photo = 6; their previews must fit one sheet cell
  async addExtraPhoto(itemId, { photo, thumb }, { log = true } = {}) {
    const item = this.items.find((i) => i.id === itemId); if (!item) return null;
    const list = this.photosOf(item);
    if (list.length >= Repo.MAX_EXTRA_PHOTOS) return null;
    const pid = uid();
    list.push({ pid, id: ``, url: `` });
    this.thumbs[`x:${pid}`] = thumb;
    await blobs.put(`pending:x:${pid}`, photo);
    await this.saveItem({ id: itemId, photos: JSON.stringify(list) }, { logAction: log ? `edited` : null, info: `Photo added`, noLog: !log });
    this.outbox.push({ kind: `xphoto`, itemId, pid });
    this.saveCache(); this.flush();
    return pid;
  }
  async removeExtraPhoto(itemId, pid) {
    const item = this.items.find((i) => i.id === itemId); if (!item) return;
    const gone = this.photosOf(item).find((p) => p.pid === pid);
    const list = this.photosOf(item).filter((p) => p.pid !== pid);
    if (gone) delete this.thumbs[`x:${gone.pid}`];
    await this.saveItem({ id: itemId, photos: list.length ? JSON.stringify(list) : `` }, { logAction: `edited`, info: `Photo removed` });
  }
  extraPhotoUrl(entry) {
    return blobs.get(`pending:x:${entry.pid}`).then((b) => (b ? URL.createObjectURL(b) : entry.id ? this.backend.photoObjectUrl({ photoId: entry.id }) : null));
  }

  // ---------------- queries
  locById(id) { return this.locations.find((l) => l.id === id && !l.deleted); }
  pathOf(locId) {
    const parts = []; let l = this.locById(locId); let guard = 0;
    while (l && guard++ < 20) { parts.unshift(l); l = this.locById(l.parentId); }
    return parts;
  }
  pathText(locId) { return this.pathOf(locId).map((l) => l.name).join(` › `); }
  childrenOf(parentId) {
    return this.locations.filter((l) => !l.deleted && (l.parentId || ``) === (parentId || ``)).sort((a, b) => a.name.localeCompare(b.name));
  }
  descendantIds(locId) {
    const out = new Set([locId]); let added = true;
    while (added) { added = false; for (const l of this.locations) if (!l.deleted && out.has(l.parentId) && !out.has(l.id)) { out.add(l.id); added = true; } }
    return out;
  }
  activeItems() { return this.items.filter((i) => !i.deleted); }
  itemsIn(locId, deep = false) {
    const ids = deep ? this.descendantIds(locId) : new Set([locId]);
    return this.activeItems().filter((i) => ids.has(i.locationId));
  }
  categories() { return [...new Set(this.activeItems().map((i) => i.category).filter(Boolean))].sort(); }

  // ---------------- mutations
  async saveItem(fields, { photo, thumb, logAction, detail, info, noLog = false, aiFields = [] } = {}) {
    const existing = fields.id && this.items.find((i) => i.id === fields.id);
    const before = existing ? { ...existing } : null;
    const item = existing ? { ...existing, ...fields } : {
      id: uid(), name: ``, purpose: ``, category: ``, tags: ``, locationId: ``, qty: 1, status: `home`, lentTo: ``, dueAt: ``, size: ``, photos: ``,
      photoId: ``, photoUrl: ``, warranty: ``, expiry: ``, notes: ``, addedBy: this.user.email, addedAt: now(),
      deleted: ``, ...fields,
    };
    item.updatedAt = now(); item.updatedBy = this.user.email;
    if (thumb) this.thumbs[item.id] = thumb;
    if (existing) Object.assign(existing, item); else this.items.unshift(item);
    if (photo) await blobs.put(`pending:${item.id}`, photo);
    this.outbox.push({ kind: `item`, data: { ...item } });
    if (photo) this.outbox.push({ kind: `photo`, itemId: item.id });
    const action = logAction || (existing ? `edited` : `added`);
    if (!noLog) {
      const entry = { ts: now(), itemId: item.id, action, detail: detail ?? this.logDetail(action, item), by: this.user.email,
        info: info ?? this.logInfo(action, before, item, Boolean(photo)), changes: this.changesJson(before, item, aiFields) };
      this.log.push(entry);
      this.outbox.push({ kind: `log`, data: entry });
    }
    this.saveCache(); this.emit(); this.flush();
    return item;
  }

  /** Exact before/after of the descriptive fields (kept whole, up to 4,000 characters each) so they can be restored. */
  changesJson(before, item, aiFields) {
    if (!before) return aiFields.length ? JSON.stringify({ _ai: aiFields }) : ``;
    const cut = (v) => String(v ?? ``).slice(0, 4000);
    const ch = {};
    for (const f of TRACKED_FIELDS) if (String(before[f] ?? ``) !== String(item[f] ?? ``)) ch[f] = [cut(before[f]), cut(item[f])];
    return Object.keys(ch).length ? JSON.stringify(ch) : ``;
  }
  static parseChanges(v) { try { const o = JSON.parse(v || `{}`); return o && typeof o === `object` ? o : {}; } catch { return {}; } }

  /** Was this field last set by AI (so AI may refine it), rather than typed by a person? */
  fieldSetByAi(itemId, field) {
    for (const e of this.itemHistory(itemId)) { // newest first
      const ch = Repo.parseChanges(e.changes);
      if (field in ch) return /^(AI\b|Updated by AI)/.test(e.info || ``);
      if (e.action === `added`) return Array.isArray(ch._ai) && ch._ai.includes(field);
    }
    return false;
  }

  /** Extra context for the history: what an edit changed, where a move came from, a pick-up date. */
  logInfo(action, before, item, newPhoto) {
    if (action === `moved` && before && before.locationId !== item.locationId) return `from ${this.pathText(before.locationId) || `no location`}`;
    if (action === `reserved` && item.dueAt) return `due ${item.dueAt}`;
    if (action !== `edited` || !before) return ``;
    const short = (v) => { const t = String(v ?? ``).replace(/\s+/g, ` `).trim(); return t ? (t.length > 40 ? `${t.slice(0, 39)}…` : t) : `empty`; };
    const labels = { name: `Name`, purpose: `What it’s for`, category: `Category`, size: `Size`, tags: `Search words`, qty: `How many`, warranty: `Warranty`, expiry: `Expires`, notes: `Notes` };
    const changes = Object.entries(labels)
      .filter(([k]) => String(before[k] ?? ``) !== String(item[k] ?? ``))
      .map(([k, label]) => `${label}: ${short(before[k])} → ${short(item[k])}`);
    if (before.locationId !== item.locationId) changes.push(`Place: ${short(this.pathText(before.locationId))} → ${short(this.pathText(item.locationId))}`);
    if (newPhoto) changes.push(`New photo`);
    return changes.join(` · `);
  }

  /** Everything that happened to one item, newest first. */
  itemHistory(itemId) {
    return this.log.filter((e) => e.itemId === itemId).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  }

  logDetail(action, item) {
    if (action === `moved` || action === `added`) return this.pathText(item.locationId);
    if (action === `lent`) return item.lentTo;
    return ``;
  }

  moveItem(item, locationId) {
    const keep = item.status === `reserved`; // a saved item stays saved for its person when moved
    return this.saveItem({ id: item.id, locationId, ...(keep ? {} : { status: `home`, lentTo: `` }) }, { logAction: `moved` });
  }
  reserveItem(item, to, dueAt = ``) { return this.saveItem({ id: item.id, status: `reserved`, lentTo: to.trim(), dueAt }, { logAction: `reserved`, detail: to.trim() }); }
  pickUp(item) { return this.saveItem({ id: item.id, status: `lent`, dueAt: `` }, { logAction: `lent`, detail: item.lentTo }); }
  cancelReservation(item) { return this.saveItem({ id: item.id, status: `home`, lentTo: ``, dueAt: `` }, { logAction: `unreserved`, detail: item.lentTo }); }
  lendItem(item, to) { return this.saveItem({ id: item.id, status: `lent`, lentTo: to.trim(), dueAt: `` }, { logAction: `lent`, detail: to.trim() }); }
  returnItem(item) { return this.saveItem({ id: item.id, status: `home`, lentTo: `` }, { logAction: `returned`, detail: item.lentTo || `` }); }
  markMissing(item) { return this.saveItem({ id: item.id, status: `missing` }, { logAction: `missing` }); }
  markFound(item) { return this.saveItem({ id: item.id, status: `home` }, { logAction: `found` }); }
  deleteItem(item) { return this.saveItem({ id: item.id, deleted: now() }, { logAction: `removed` }); }

  saveLocation(fields) {
    const existing = fields.id && this.locations.find((l) => l.id === fields.id);
    const loc = existing ? { ...existing, ...fields } : {
      id: uid(), name: ``, parentId: ``, kind: `room`, notes: ``, createdBy: this.user.email, createdAt: now(), deleted: ``, ...fields,
    };
    if (existing) Object.assign(existing, loc); else this.locations.push(loc);
    this.queue({ kind: `location`, data: { ...loc } });
    this.emit();
    return loc;
  }
  deleteLocation(loc) { return this.saveLocation({ id: loc.id, deleted: now() }); }

  /** Owner only. action: `writer` | `reader` | `remove` | `owner` (offer ownership; they accept in Google Drive). */
  async setAccess(email, action) {
    const b = this.backend;
    const files = [{ id: b.sheetId, kind: `sheet` }, { id: b.rootFolderId, kind: `folder` }];
    if (action === `owner`) files.push({ id: b.photoFolderId, kind: `folder` });
    await changeAccess(files, email, action);
    const role = action === `remove` ? `removed` : action === `reader` ? `viewer` : action === `owner` ? `pending-owner` : `member`;
    await setRoleRow(b.sheetId, `Members`, email, role);
    this.members = this.members.map((m) => (m.email === email ? { ...m, role } : m));
    this.saveCache(); this.emit();
  }

  async invite(email, role = `writer`) {
    const member = await this.backend.invite(email, role);
    this.members.push(member);
    this.queue({ kind: `member`, data: member });
    this.emit();
  }

  photoObjectUrl(item) {
    return blobs.get(`pending:${item.id}`).then((b) => (b ? URL.createObjectURL(b) : this.backend.photoObjectUrl(item)));
  }

  exportCsv() {
    const cols = [`name`, `purpose`, `category`, `size`, `tags`, `location`, `qty`, `status`, `lentTo`, `dueAt`, `warranty`, `expiry`, `price`, `store`, `boughtAt`, `notes`, `photoUrl`, `addedBy`, `addedAt`];
    const esc = (v) => `"${String(v ?? ``).replace(/"/g, `""`)}"`;
    const lines = [cols.join(`,`)];
    for (const i of this.activeItems()) lines.push(cols.map((c) => esc(c === `location` ? this.pathText(i.locationId) : i[c])).join(`,`));
    return new Blob([lines.join(`\n`)], { type: `text/csv` });
  }

  // ---------------- people you lend to (derived from lends; no separate list to maintain)
  static personKey(name) { return String(name || ``).trim().toLowerCase().replace(/\s+/g, ` `); }

  /**
   * Lend periods incl. reservations: [{ itemId, name, key, savedAt, lentAt, returnedAt, cancelledAt, how }], oldest first.
   * A reservation that's picked up becomes the same period (savedAt → lentAt → returnedAt).
   */
  lendPeriods() {
    const openLend = new Map(); const openRes = new Map(); const out = [];
    const mk = (e, extra) => ({ itemId: e.itemId, name: String(e.detail), key: Repo.personKey(e.detail), savedAt: null, lentAt: null, returnedAt: null, cancelledAt: null, ...extra });
    const sorted = [...this.log].filter((e) => e.ts && e.itemId).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    for (const e of sorted) {
      const id = e.itemId; const k = Repo.personKey(e.detail);
      if (e.action === `reserved` && e.detail) {
        const r = openRes.get(id); if (r) r.cancelledAt = e.ts;
        const due = /due (\d{4}-\d{2}-\d{2})/.exec(e.info || ``)?.[1] || ``;
        const p = mk(e, { savedAt: e.ts, dueAt: due }); out.push(p); openRes.set(id, p);
      } else if (e.action === `unreserved`) {
        const r = openRes.get(id); if (r) { r.cancelledAt = e.ts; openRes.delete(id); }
      } else if (e.action === `lent` && e.detail) {
        const cur = openLend.get(id); if (cur) cur.returnedAt = e.ts;
        const r = openRes.get(id); let p;
        if (r && r.key === k) { p = r; p.lentAt = e.ts; p.name = String(e.detail); }
        else { if (r) r.cancelledAt = e.ts; p = mk(e, { lentAt: e.ts }); out.push(p); }
        openRes.delete(id); openLend.set(id, p);
      } else if ([`returned`, `moved`, `found`, `removed`].includes(e.action)) {
        const cur = openLend.get(id); if (cur) { cur.returnedAt = e.ts; cur.how = e.action; openLend.delete(id); }
        if (e.action === `removed`) { const r = openRes.get(id); if (r) { r.cancelledAt = e.ts; openRes.delete(id); } }
      }
    }
    // current state without matching log entries (older data): show as open
    for (const it of this.activeItems()) {
      if (!it.lentTo) continue;
      const fake = { itemId: it.id, detail: it.lentTo };
      if (it.status === `lent` && !out.some((p) => p.itemId === it.id && p.lentAt && !p.returnedAt)) out.push(mk(fake, { lentAt: it.updatedAt || `` }));
      if (it.status === `reserved` && !out.some((p) => p.itemId === it.id && p.savedAt && !p.lentAt && !p.cancelledAt)) out.push(mk(fake, { savedAt: it.updatedAt || `` }));
    }
    return out;
  }

  /** Everyone you've lent to or saved things for: [{ key, name, holding, saved, lastAt, total }], most relevant first. */
  people() {
    const map = new Map();
    for (const p of this.lendPeriods()) {
      const e = map.get(p.key) || { key: p.key, name: p.name, holding: [], saved: [], lastAt: ``, total: 0 };
      if (p.lentAt) e.total++;
      const at = p.lentAt || p.savedAt || ``;
      if (String(at) >= String(e.lastAt)) { e.lastAt = at; e.name = p.name; } // latest spelling wins
      map.set(p.key, e);
    }
    for (const it of this.activeItems()) {
      if (!it.lentTo) continue;
      const e = map.get(Repo.personKey(it.lentTo)); if (!e) continue;
      if (it.status === `lent`) e.holding.push(it);
      if (it.status === `reserved`) e.saved.push(it);
    }
    const busy = (p) => p.holding.length + p.saved.length > 0;
    return [...map.values()].sort((a, b) => busy(b) - busy(a) || String(b.lastAt).localeCompare(String(a.lastAt)));
  }

  personHistory(key) {
    const name = (id) => this.items.find((i) => i.id === id)?.name || `Removed item`;
    return this.lendPeriods().filter((p) => p.key === key)
      .map((p) => ({ ...p, itemName: name(p.itemId), item: this.items.find((i) => i.id === p.itemId && !i.deleted) }))
      .sort((a, b) => String(b.lentAt || b.savedAt).localeCompare(String(a.lentAt || a.savedAt)));
  }

  // ---------------- events: what's needed, where it is now, who has it
  // Two kinds: a group's events (in the group's directory sheet, marked _g, lines may point into any inventory of the group)
  // and an inventory's own events (in its sheet; lines point into this inventory).
  get hereId() { return this.backend.kind === `google` ? this.backend.sheetId : `demo`; }
  get groupDirId() { return this.backend.kind === `google` ? this.backend.groupDirId || `` : ``; }
  /** The group this inventory belongs to: { id, name, dirId, owner, people } or null. */
  group() {
    if (!this.groupDirId) return null;
    const k = loadKnown(this.user.email); const gid = k.inv[this.hereId]?.groupId;
    return gid && k.groups[gid] ? { id: gid, ...k.groups[gid] } : null;
  }
  /** Can this person change the group's events? Group viewers can't. */
  get groupReadOnly() {
    const g = this.group(); if (!g) return true;
    if (g.owner) return false;
    const me = (g.people || []).find((p) => String(p.email).toLowerCase() === String(this.user.email).toLowerCase());
    return me ? me.role === `viewer` : this.readOnly;
  }
  canEditEvent(ev) { return ev?._g ? !this.groupReadOnly : !this.readOnly; }

  liveEvents() { return this.events.filter((e) => e.id && !e.deleted); }
  eventById(id) { return this.events.find((e) => e.id === id && !e.deleted); }
  linesOf(eventId) {
    return this.eventLines.filter((l) => l.eventId === eventId && !l.deleted)
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
  }
  /** Sections in the order they first appear. Lines without a section come under `` (shown as "Other"). */
  sectionsOf(eventId) { return [...new Set(this.linesOf(eventId).map((l) => l.section || ``))]; }
  /** Which inventory a line's item is in. */
  lineInv(line) { return line.invId || this.hereId; }

  /** opts.group: a new event for the whole group (needs a group). Existing events keep where they live. */
  saveEvent(fields, { group = false } = {}) {
    const existing = fields.id && this.events.find((e) => e.id === fields.id);
    const isGroup = existing ? Boolean(existing._g) : group && Boolean(this.groupDirId);
    if (isGroup ? this.groupReadOnly : this.readOnly) { this.emit(`readonly`); return null; }
    const ev = existing ? { ...existing, ...fields } : {
      id: uid(), name: ``, date: ``, notes: ``, createdBy: this.user.email, createdAt: now(), deleted: ``, ...fields, ...(isGroup ? { _g: 1 } : {}),
    };
    ev.updatedAt = now(); ev.updatedBy = this.user.email;
    if (existing) Object.assign(existing, ev); else this.events.push(ev);
    this.writeEventRow(`event`, ev);
    this.emit();
    return ev;
  }
  deleteEvent(ev) { return this.saveEvent({ id: ev.id, deleted: now() }); }

  /** Queue an event or line row for the sheet it belongs to (group rows go to the directory). */
  writeEventRow(kind, row) {
    const { _g, ...data } = row;
    if (_g) { this.outbox.push({ kind, data, sheet: this.groupDirId }); this.saveCache(); this.flush(); }
    else this.queue({ kind, data });
  }

  saveLine(fields, { quiet = false } = {}) {
    const existing = fields.id && this.eventLines.find((l) => l.id === fields.id);
    const ev = this.events.find((e) => e.id === (existing?.eventId || fields.eventId));
    if (!this.canEditEvent(ev)) { this.emit(`readonly`); return null; }
    const line = existing ? { ...existing, ...fields } : {
      id: uid(), eventId: ``, section: ``, itemId: ``, invId: ``, sources: ``, name: ``, qty: 1, note: ``, sort: Date.now(), deleted: ``, ...fields, ...(ev?._g ? { _g: 1 } : {}),
    };
    line.updatedAt = now(); line.updatedBy = this.user.email;
    if (existing) Object.assign(existing, line); else this.eventLines.push(line);
    this.writeEventRow(`eline`, line);
    if (!quiet) this.emit();
    return line;
  }
  deleteLine(line) { return this.saveLine({ id: line.id, deleted: now() }); }

  /** Add several lines to one section in one go. entries: [{ itemId?, invId?, name?, qty?, sources? }] */
  addLines(eventId, section, entries) {
    const ev = this.eventById(eventId);
    const base = Date.now();
    const out = entries.map((e, i) => {
      const src = e.sources || (e.itemId ? [{ inv: ev?._g ? (e.invId || this.hereId) : ``, id: e.itemId, name: e.name || `` }] : []);
      const first = src[0];
      return this.saveLine({
        eventId, section, itemId: first?.id || ``, invId: first?.inv || ``, name: e.name || first?.name || ``, qty: e.qty || 1, sort: base + i,
        sources: src.length > 1 ? JSON.stringify(src) : ``,
      }, { quiet: true });
    });
    this.emit();
    return out.filter(Boolean);
  }

  /** Rename a section: every line in it moves to the new name. */
  renameSection(eventId, from, to) {
    for (const l of this.linesOf(eventId)) if ((l.section || ``) === from) this.saveLine({ id: l.id, section: to }, { quiet: true });
    this.emit();
  }

  /** This inventory's data, in the shape lineState expects of any inventory. */
  hereData() { return { items: this.items, pathText: (id) => this.pathText(id), thumbs: this.thumbs }; }

  // ---- on the day: what arrived, and who brought it
  gotOf(line) {
    try { const a = JSON.parse(line.got || `[]`); return Array.isArray(a) ? a.filter((g) => g && Number(g.n) > 0) : []; } catch { return []; }
  }
  gotTotal(line) { return this.gotOf(line).reduce((n, g) => n + Number(g.n), 0); }
  setGot(line, list) {
    const clean = list.map((g) => ({ who: String(g.who || ``), n: Math.max(0, Math.round(Number(g.n) || 0)) })).filter((g) => g.n > 0);
    return this.saveLine({ id: line.id, got: clean.length ? JSON.stringify(clean) : `` });
  }
  // ---- after: where each thing went
  afterOf(line) { try { const o = JSON.parse(line.after || `null`); return o && o.state ? o : null; } catch { return null; } }
  setAfter(line, obj) {
    return this.saveLine({ id: line.id, after: obj ? JSON.stringify({ ...obj, at: now(), by: this.user.email }) : `` });
  }

  /** Write a task into an inventory's Tasks tab (only the fields given; leave a field out to keep what's there, e.g. done). */
  saveTask(invId, fields) {
    const row = { ...fields, updatedAt: now(), updatedBy: this.user.email };
    if (invId === this.hereId) { const t = this.tasks.find((x) => x.id === row.id); if (t) Object.assign(t, row); else this.tasks.push({ ...row }); }
    this.outbox.push({ kind: `task`, sheet: invId, data: row });
    this.saveCache(); this.flush();
    return row;
  }

  /**
   * Change an item that lives in another inventory of the group (reserve it for an event, put it back, move it, mark it missing).
   * item: that inventory's item object on this phone (it's updated in place, so screens show the change at once).
   * The change goes to that inventory's sheet (only the changed cells) with a History entry there, like any other edit.
   */
  updateElsewhere(invId, item, fields, log = null) {
    if (!invId || invId === this.hereId) throw new Error(`updateElsewhere is for other inventories`);
    const ts = now();
    const patch = { ...fields, updatedAt: ts, updatedBy: this.user.email };
    Object.assign(item, patch);
    try { // that inventory's copy on this phone, so it reads right before the next fetch (and offline)
      const key = `paran.cache.${invId}`; const c = JSON.parse(localStorage.getItem(key) || `null`);
      const it = c?.items?.find((i) => i.id === item.id);
      if (it) { Object.assign(it, patch); localStorage.setItem(key, JSON.stringify(c)); }
    } catch { /* storage full: the sheet still gets it */ }
    this.outbox.push({ kind: `xitem`, sheet: invId, data: { id: item.id, fields: patch } });
    if (log) this.outbox.push({ kind: `log`, sheet: invId, data: { ts, itemId: item.id, action: log.action, detail: log.detail || ``, by: this.user.email, info: log.info || ``, changes: `` } });
    this.saveCache(); this.flush(); this.emit();
  }

  /** Copy an event for next time: same sections, items, quantities and notes (and, if asked, who brings what). */
  copyEvent(ev, { name, date = ``, notes = ev.notes || ``, keepPeople = false } = {}) {
    const copy = this.saveEvent({ name: name || ev.name, date, notes }, { group: Boolean(ev._g) });
    if (!copy) return null;
    const base = Date.now();
    this.linesOf(ev.id).forEach((l, i) => this.saveLine({
      eventId: copy.id, section: l.section || ``, itemId: l.itemId || ``, invId: l.invId || ``, sources: l.sources || ``, name: l.name || ``,
      qty: l.qty || 1, note: l.note || ``, sort: base + i, bringers: keepPeople ? l.bringers || `` : ``,
    }, { quiet: true }));
    this.emit();
    return copy;
  }

  /** Who's bringing a line: [{ name, qty, email }]. qty 0 only on older entries (= the rest). email = their Google account, if linked. */
  bringersOf(line) {
    try { const a = JSON.parse(line.bringers || `[]`); return Array.isArray(a) ? a.filter((b) => b && String(b.name || ``).trim()) : []; } catch { return []; }
  }
  setBringers(line, list) {
    const clean = list.map((b) => ({ name: String(b.name).trim(), qty: Math.max(0, Number(b.qty) || 0), ...(b.email ? { email: String(b.email).trim().toLowerCase() } : {}) }))
      .filter((b) => b.name);
    return this.saveLine({ id: line.id, bringers: clean.length ? JSON.stringify(clean) : `` });
  }

  /** Google accounts with access here: [{ email, role }], not removed. */
  accounts() { // in a group: the group's people (access is the group's); otherwise this inventory's people
    const g = this.group();
    const src = g ? (g.people || []) : this.members;
    const map = new Map();
    for (const p of src) if (p.email && p.role !== `removed`) map.set(p.email.toLowerCase(), { email: p.email.toLowerCase(), role: p.role });
    return [...map.values()];
  }
  /** "ravi.kumar@gmail.com" -> "Ravi Kumar" (unless they've been called something else on an event). */
  static nameFromEmail(email) {
    return String(email || ``).split(`@`)[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(` `) || email;
  }

  /**
   * People to offer when assigning: [{ name, email }]. Accounts with access first (named as they were last called on an
   * event, else from their email), then other names used on events, then people you lend to.
   */
  bringerNames(extra = []) { // extra: [{ email, only }] people with access to just one inventory of the group
    const byEmail = new Map(); const byName = new Map();
    for (const l of [...this.eventLines].filter((x) => !x.deleted).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))) {
      for (const b of this.bringersOf(l)) {
        if (b.email) byEmail.set(b.email.toLowerCase(), b.name);
        byName.set(Repo.personKey(b.name), { name: b.name, email: b.email || byName.get(Repo.personKey(b.name))?.email || `` });
      }
    }
    const out = []; const seen = new Set();
    const me = String(this.user?.email || ``).toLowerCase();
    for (const a of [...this.accounts().sort((x, y) => (x.email === me) - (y.email === me)), ...extra]) {
      if (seen.has(a.email)) continue;
      const name = byEmail.get(a.email) || (a.email === me && this.user?.name && !this.user.name.includes(`@`) ? this.user.name : Repo.nameFromEmail(a.email));
      out.push({ name, email: a.email, ...(a.only ? { only: a.only } : {}) }); seen.add(Repo.personKey(name)); seen.add(a.email);
    }
    for (const [k, v] of byName) if (!seen.has(k) && !(v.email && seen.has(v.email))) { out.push(v); seen.add(k); }
    for (const p of this.people()) if (!seen.has(p.key)) { out.push({ name: p.name, email: `` }); seen.add(p.key); }
    return out;
  }
  /** The Google account a typed name or email belongs to, if any. */
  accountFor(text, extra = []) {
    const t = String(text || ``).trim().toLowerCase(); if (!t) return ``;
    if (t.includes(`@`)) return [...this.accounts(), ...extra].some((a) => a.email === t) ? t : ``;
    return this.bringerNames(extra).find((p) => p.email && Repo.personKey(p.name) === Repo.personKey(t))?.email || ``;
  }
  /** Lines in an event that this signed-in person is bringing. */
  myLines(eventId) {
    const me = String(this.user?.email || ``).toLowerCase(); if (!me) return [];
    return this.linesOf(eventId).filter((l) => this.bringersOf(l).some((b) => String(b.email || ``).toLowerCase() === me));
  }

  /** The items a line draws on: [{ inv, id, name, off }]. inv '' = this inventory. Older lines have just itemId/invId. */
  sourcesOf(line) {
    let list = [];
    try { list = JSON.parse(line.sources || `[]`); } catch { /* ignore */ }
    if (!Array.isArray(list)) list = [];
    if (!list.length && line.itemId) list = [{ inv: line.invId || ``, id: line.itemId, name: line.name || `` }];
    return list.filter((x) => x && x.id);
  }
  srcInv(src) { return src.inv || this.hereId; }
  /** Replace a line's items. The first one in use is mirrored into itemId/invId. */
  setSources(line, list, extra = {}) {
    const first = list.find((x) => !x.off) || list[0];
    return this.saveLine({ id: line.id, sources: list.length ? JSON.stringify(list) : ``, itemId: first?.id || ``, invId: first?.inv || ``, ...extra });
  }

  /** One item behind a line: { src, invId, key: ready|out|missing|gone|unknown, item, have, where, who, thumbs } */
  sourceState(src, data, forEvent = ``) {
    const invId = this.srcInv(src);
    const d = data(invId);
    if (!d) return { src, invId, key: `unknown`, have: 0 };
    const item = d.items.find((i) => i.id === src.id && !(i.deleted === true || (i.deleted && i.deleted !== `FALSE`)));
    if (!item) return { src, invId, key: `gone`, have: 0 };
    const base = { src, invId, item, have: Number(item.qty) || 1, thumbs: d.thumbs, where: d.pathText(item.locationId) };
    if (item.status === `missing`) return { ...base, key: `missing` };
    // reserved for this very event: it's set aside for it, so it counts as ready
    if (item.status === `reserved` && forEvent && Repo.personKey(item.lentTo) === Repo.personKey(forEvent)) return { ...base, key: `ready`, held: true };
    if (item.status === `lent` || item.status === `reserved`) return { ...base, key: `out`, who: item.lentTo, reserved: item.status === `reserved` };
    return { ...base, key: `ready` };
  }

  /**
   * Is this line ready for the event? Counts every item it draws on (except ones marked not for this event).
   * key: ready | short (fewer than needed) | out (some lent or reserved) | missing | none (nothing in an inventory)
   *      | unknown (an inventory it draws on isn't on this phone yet)
   * data(invId): { items, pathText(locId), thumbs } for an inventory, or null when there's no copy on this phone.
   */
  lineState(line, data = (id) => (id === this.hereId ? this.hereData() : null)) {
    const all = this.sourcesOf(line);
    const used = all.filter((x) => !x.off);
    const off = all.length - used.length;
    if (!used.length) return { key: `none`, text: all.length ? `Nothing picked for this event` : `Not in inventory yet`, item: null, parts: [], off };
    const evName = this.events.find((e) => e.id === line.eventId)?.name || ``;
    const parts = used.map((x) => this.sourceState(x, data, evName));
    const need = Number(line.qty) || 1;
    const shown = parts.find((p) => p.item) || parts[0];
    const base = { item: shown.item || null, invId: shown.invId, thumbs: shown.thumbs, parts, off, need };
    if (parts.length === 1) { // one item: say exactly what's going on with it
      const p = parts[0];
      if (p.key === `unknown`) return { ...base, key: `unknown`, text: `Not checked yet` };
      if (p.key === `gone`) return { ...base, key: `none`, text: `No longer in the inventory` };
      if (p.key === `missing`) return { ...base, key: `missing`, text: `Marked missing` };
      if (p.key === `out`) return { ...base, key: `out`, text: `${p.reserved ? `Reserved for` : `With`} ${p.who || `someone`}`, who: p.who };
      if (need > p.have) return { ...base, key: `short`, text: `Need ${need}, have ${p.have}${p.where ? ` · ${p.where}` : ``}`, where: p.where, have: p.have };
      return { ...base, key: `ready`, text: p.where || `Place not set`, where: p.where, have: p.have };
    }
    const sum = (k) => parts.filter((p) => p.key === k).reduce((n, p) => n + p.have, 0);
    const ready = sum(`ready`); const out = parts.filter((p) => p.key === `out`); const outQty = sum(`out`);
    const unknown = parts.filter((p) => p.key === `unknown`).length;
    const places = parts.filter((p) => p.key === `ready`).length;
    if (ready >= need) return { ...base, key: `ready`, have: ready, text: `${ready} ready${places > 1 ? ` in ${places} places` : ``}${ready > need ? ` (need ${need})` : ``}` };
    if (unknown) return { ...base, key: `unknown`, have: ready, text: `${ready} of ${need} ready so far · ${unknown} not checked` };
    if (out.length) return { ...base, key: `out`, have: ready, who: out[0].who, text: `${ready} of ${need} ready · ${outQty} with ${[...new Set(out.map((p) => p.who || `someone`))].join(`, `)}` };
    if (parts.some((p) => p.key === `missing`)) return { ...base, key: `missing`, have: ready, text: `${ready} of ${need} ready · some marked missing` };
    if (!ready && parts.every((p) => p.key === `gone`)) return { ...base, key: `none`, text: `No longer in the inventory` };
    return { ...base, key: `short`, have: ready, text: `Need ${need}, have ${ready}` };
  }

  /** Counts for an event: { total, ready, short, out, missing, none, unknown } */
  eventSummary(eventId, data) {
    const s = { total: 0, ready: 0, short: 0, out: 0, missing: 0, none: 0, unknown: 0 };
    for (const l of this.linesOf(eventId)) { s.total++; s[this.lineState(l, data).key]++; }
    return s;
  }

  /** Upcoming (or undated) events that need this item (of this inventory), unless it's marked not for that event. */
  eventsForItem(itemId, today = new Date().toISOString().slice(0, 10)) {
    const ids = new Set(this.eventLines.filter((l) => !l.deleted && this.sourcesOf(l).some((x) => x.id === itemId && !x.off && this.srcInv(x) === this.hereId)).map((l) => l.eventId));
    return this.liveEvents().filter((e) => ids.has(e.id) && (!e.date || String(e.date) >= today))
      .sort((a, b) => String(a.date || `9999`).localeCompare(String(b.date || `9999`)));
  }

  // ---------------- demo seed
  seedDemoEvent() {
    const find = (name) => this.items.find((i) => i.name === name)?.id || ``;
    const d = new Date(Date.now() + 12 * 86400000);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, `0`)}-${String(d.getDate()).padStart(2, `0`)}`;
    const ev = this.saveEvent({ name: `Diwali party`, date, notes: `Backyard, about 30 people` });
    this.addLines(ev.id, `Decor`, [{ itemId: find(`Christmas lights (warm white)`), qty: 4 }, { name: `Diyas (clay lamps)`, qty: 20 }]);
    this.addLines(ev.id, `Setup`, [{ itemId: find(`Extension cord 25 ft`), qty: 2 }, { itemId: find(`Pressure washer`) }, { name: `Folding tables`, qty: 4 }]);
    const cloths = this.items.filter((i) => i.name === `Tablecloths (white)`).map((i) => ({ inv: ``, id: i.id, name: i.name }));
    if (cloths.length) this.addLines(ev.id, `Setup`, [{ name: `Tablecloths (white)`, qty: 24, sources: cloths }]);
  }

  seedDemo() {
    const L = (name, parentId, kind) => this.saveLocation({ name, parentId, kind });
    const home = L(`Home`, ``, `place`);
    const garage = L(`Garage`, home.id, `room`);
    const bin = L(`Blue bin – tools`, garage.id, `container`);
    const shelf = L(`Metal shelf`, garage.id, `container`);
    const kitchen = L(`Kitchen`, home.id, `room`);
    const drawer = L(`Junk drawer`, kitchen.id, `container`);
    const storage = L(`Storage unit`, ``, `place`);
    const bigBox = L(`Box 3 – holiday`, storage.id, `container`);
    const S = (name, purpose, category, tags, locationId, extra = {}) => this.saveItem({ name, purpose, category, tags, locationId, ...extra }, { logAction: `added` });
    S(`Plumber’s tape`, `Seal threads when fixing a leaky faucet or shower head`, `Tools`, `plumbing, leak, teflon`, bin.id);
    S(`Stud finder`, `Find wall studs before hanging TVs or shelves`, `Tools`, `wall, mounting, drilling`, bin.id);
    S(`Extension cord 25 ft`, `Outdoor lights, pressure washer`, `Electrical`, `outdoor, power`, shelf.id, { qty: 2 });
    S(`Car jump starter`, `Dead car battery`, `Car`, `battery, emergency`, shelf.id, { warranty: `2027-05-01` });
    S(`Spare house keys`, `Lockout backup, give to house sitter`, `Keys`, `keys, backup`, drawer.id);
    S(`Christmas lights (warm white)`, `Front porch and tree`, `Holiday`, `christmas, decor, lights`, bigBox.id, { qty: 4 })
      .then((it) => this.reserveItem(it, `Kumar`, new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)));
    S(`Tablecloths (white)`, `Covering banquet tables`, `Party`, `linen, table cover`, shelf.id, { qty: 12 });
    S(`Tablecloths (white)`, `Covering banquet tables`, `Party`, `linen, table cover`, bigBox.id, { qty: 8 });
    S(`Pressure washer`, `Driveway and deck cleaning`, `Outdoor`, `cleaning, deck`, garage.id).then((pw) => this.lendItem(pw, `Ravi`));
    this.seedDemoEvent();
    this.setStatus(`synced`);
  }
}
