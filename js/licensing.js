// Licensing client (Urimam): usage counts, the people an owner shares with, and what the app may do.
// Contract: Licensing project, licensing-interface.md. Everything here is off unless CONFIG.LICENSE_URL is set
// (`stub` runs an in-browser stand-in for testing).
//
// The model (decided 30 Oct 2026): a licence belongs to the owner and counts people only. Seats are the owner plus
// every distinct person who can open anything the owner shares in Paran (a group or a single inventory). Groups and
// inventories are only read here, never changed.
//
// Rules this file follows:
// - Never block the app on licensing. Calls run in the background; a failure changes nothing.
// - Fail open: an owner the server has never answered for is allowed everything. Once answered, the last verified
//   state stays in force until a newer one arrives (it never decays to "ok" on its own).
// - In `observe` mode nothing is applied; the app only records what it would have shown.
// - Never sent: item names, purposes, notes, tags, photos, place names, emails (people are sent as one-way hashes).
// - Usage counts come from stats.js (the same counts Your activity shows). AI feedback (per-field accuracy) is the
//   one optional part and is sent only when the person turns it on.
import { CONFIG } from './config.js';
import { blobs } from './idb.js';

const LS = `paran.lic.`;
const APP = CONFIG.LICENSE_APP_ID || `paran`;
const TIMEOUT_MS = 5000;
const FLUSH_EVERY_MS = 6 * 3600_000;
const ACCESS_EVERY_MS = 6 * 3600_000;
const UNKNOWN_RETRY_MS = 3600_000;     // an inventory whose owner hasn't reported yet: ask again in an hour
const KEYS_EVERY_MS = 7 * 86400_000;
const MAX_BATCHES = 40;                // ≈ 30 days of unsent batches, then the oldest are dropped
const BATCH_MAX_AGE_MS = 30 * 86400_000;
const DAY_MS = 86400_000;
const SESSION_RENEW_MS = 3600_000;     // confirm identity again when the licensing session has less than this left

const read = (k, d = null) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
const drop = (k) => { try { localStorage.removeItem(LS + k); } catch { /* ignore */ } };
const nowIso = () => new Date().toISOString();
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : `10000000-1000-4000-8000-100000000000`.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

export class LicError extends Error {
  constructor(code, status = 0, data = null) { super(data?.detail || code); this.code = code; this.status = status; this.data = data; }
}

// ------------------------------------------------------------------ small pure helpers (exported for tests)

/** "lic1:" + lowercased email, googlemail.com → gmail.com, hex SHA-256. Same on client and server. */
export async function emailHash(email) {
  let e = String(email || ``).trim().toLowerCase();
  if (e.endsWith(`@googlemail.com`)) e = `${e.slice(0, -`@googlemail.com`.length)}@gmail.com`;
  const buf = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(`lic1:${e}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, `0`)).join(``);
}

export const b64urlToBytes = (s) => {
  const b = atob(s.replace(/-/g, `+`).replace(/_/g, `/`) + `===`.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** Verify a compact ES256 JWS against a list of public JWKs. Returns the payload object, or null. */
export async function verifyJws(token, jwks) {
  try {
    const [h, p, s] = String(token).split(`.`);
    if (!h || !p || !s) return null;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    if (header.alg !== `ES256`) return null;
    const jwk = jwks.find((k) => k.kid === header.kid) || (jwks.length === 1 && !header.kid ? jwks[0] : null);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(`jwk`, { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: `ECDSA`, namedCurve: `P-256` }, false, [`verify`]);
    const ok = await crypto.subtle.verify({ name: `ECDSA`, hash: `SHA-256` }, key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
    return ok ? JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) : null;
  } catch { return null; }
}

/** `paran-v38` → 38; anything else → NaN. */
export const versionNumber = (v) => Number(/(\d+)\s*$/.exec(String(v || ``))?.[1] ?? NaN);

export function platform() {
  const ua = navigator.userAgent || ``;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return `ios`;
  if (/Android/.test(ua)) return `android`;
  if (/Windows|Macintosh|Linux|CrOS/.test(ua)) return `desktop`;
  return `other`;
}

/** What the app should do with a stored answer. Pure: used by the app and by tests. */
export function viewOf(stored) {
  if (!stored?.claims) {
    return { has: false, enforced: false, mode: null, plan: null, state: `ok`, graceEndsAt: null, decision: `allow`, reason: null,
      seats: { used: 0, cap: null, unknowable: false }, limits: {}, features: {}, messages: [], wouldShow: null,
      you: { isOwner: false, kept: true, blocked: false } };
  }
  const c = stored.claims;
  const enforced = c.mode === `enforce`;
  return {
    has: true, enforced, mode: c.mode, plan: c.plan, state: c.state, graceEndsAt: c.graceEndsAt || null,
    seats: c.seats || { used: 0, cap: null, unknowable: false }, limits: c.limits || {}, features: c.features || {},
    you: c.you || { isOwner: false, kept: true, blocked: false },
    decision: stored.decision || `allow`, reason: stored.reason || null,
    messages: enforced ? (stored.messages || []) : [],
    wouldShow: c.state !== `ok` ? c.state : null,
  };
}

/**
 * Usage counters to send for one day: what stats.js has counted since the last send (`sent` = what was sent before).
 * AI uses always; per-field AI accuracy (`ai.fb.*`) only when feedback is on. Pure, exported for tests.
 */
export function dayCounters(day, sent = {}, { feedback = false } = {}) {
  const now = {};
  for (const [k, v] of Object.entries(day?.c || {})) if (Number.isFinite(v)) now[k] = v;
  for (const [kind, a] of Object.entries(day?.ai || {})) {
    const kk = String(kind).replace(/[^A-Za-z0-9_]/g, ``) || `x`;
    now[`ai.${kk}.uses`] = a.uses || 0;
    if (!feedback) continue;
    now[`ai.fb.${kk}.n`] = a.n || 0; now[`ai.fb.${kk}.t`] = a.t || 0;
    for (const [field, [kept, total, score]] of Object.entries(a.fields || {})) {
      const f = String(field).replace(/[^A-Za-z0-9_]/g, ``); if (!f) continue;
      now[`ai.fb.${kk}.${f}.kept`] = kept || 0; now[`ai.fb.${kk}.${f}.total`] = total || 0;
      now[`ai.fb.${kk}.${f}.score1000`] = Math.round((score || 0) * 1000);
    }
  }
  const delta = {};
  for (const [k, v] of Object.entries(now)) { const d = Math.round(v - (sent[k] || 0)); if (d > 0) delta[k] = d; }
  return { delta, now };
}

// ------------------------------------------------------------------ the client
class Licensing extends EventTarget {
  stub = null;
  keys = [];
  version = `dev`;
  ctxFn = () => null;
  gaugeFn = () => null;
  usageFn = () => null;
  busy = null;
  lastTick = 0;
  install = null;
  identityFn = async () => null;
  signingIn = null;
  lastInv = null;

  on() { return Boolean(CONFIG.LICENSE_URL); }
  isStub() { return CONFIG.LICENSE_URL === `stub`; }

  /** Call once at boot. Safe when licensing is off (does nothing). */
  async init() {
    if (!this.on()) return;
    this.install = await this.ensureInstall();
    this.version = await appVersion();
    this.keys = [...(CONFIG.LICENSE_KEYS || []), ...(read(`keys`)?.keys || [])];
    if (this.isStub()) {
      const { createStub } = await import(`./licensing-stub.js`);
      this.stub = await createStub();
      this.keys = [...this.keys, ...(await this.stub.publicKeys())];
    }
    document.addEventListener(`visibilitychange`, () => {
      if (document.hidden) this.flushUsage({ keepalive: true }).catch(() => {});
      else this.tick();
    });
    window.addEventListener(`online`, () => this.tick());
  }

  /** installId kept in IndexedDB and localStorage; restored from whichever survives. */
  async ensureInstall() {
    let rec = read(`install`);
    if (!rec?.id) rec = await blobs.get(`lic.install`).catch(() => null);
    if (!rec?.id) rec = { id: uuid(), firstOpenAt: nowIso() };
    write(`install`, rec);
    blobs.put(`lic.install`, rec).catch(() => {});
    return rec;
  }

  /** fn({ hint }) → an identity-only Google token (openid email), or null. Called only inside a user gesture. */
  setIdentityProvider(fn) { this.identityFn = fn; }
  /**
   * fn() → { email, demo, inventoryId, isOwner, role, collectAccess(), recordCheck(mode), licOk, licMode } or null.
   * collectAccess() → null when the person owns nothing in Paran, else
   *   { files: [{ fileId, kind, general, people: [{ email, role, type }] }], listed: [emails], props: { licOk, licMode } }.
   */
  setContext(fn) { this.ctxFn = fn; this.emit(); }
  /** fn() → { inventories, groups, items, events, aiOn } for the open inventory's owner's licence. */
  setGauges(fn) { this.gaugeFn = fn; }
  /** fn() → stats.js data { days: { date: { c, ai, mode } } } (always kept while licensing is on). */
  setUsageSource(fn) { this.usageFn = fn; }
  ctx() { try { return this.ctxFn() || null; } catch { return null; } }
  emit() { this.dispatchEvent(new Event(`change`)); }

  // ---------------- identity: a licensing session (from POST /auth), bound to this install and this Google account
  sessionToken() {
    const a = read(`auth`); const ctx = this.ctx();
    if (!a?.token || a.iid !== this.install?.id || (ctx?.email && a.email !== ctx.email)) return null;
    return Date.parse(a.expiresAt) - Date.now() > SESSION_RENEW_MS ? a.token : null;
  }
  /** True when licensing needs the person to confirm who they are (on their next tap). */
  needsIdentity() { const ctx = this.ctx(); return Boolean(this.on() && this.install && ctx?.email && !ctx.demo && !this.sessionToken()); }

  /** Must run inside a user gesture (the identity token may open a short popup). */
  signIn() {
    if (this.signingIn) return this.signingIn;
    this.signingIn = (async () => {
      const ctx = this.ctx(); if (!ctx?.email) return false;
      const idToken = this.isStub() ? `stub:${ctx.email}` : await this.identityFn({ hint: ctx.email });
      if (!idToken) return false;
      const r = await this.call(`POST`, `/auth`, { identityToken: idToken }, { auth: false });
      write(`auth`, { token: r.token, expiresAt: r.expiresAt, email: ctx.email, iid: this.install.id });
      this.emit();
      this.tick(true);
      return true;
    })().catch((e) => { console.warn(`licensing sign-in`, e); return false; }).finally(() => { this.signingIn = null; });
    return this.signingIn;
  }

  // ---------------- privacy notice. Licence checks and usage counts are part of using the app (shown once, not
  // optional); AI feedback is optional and off until the person turns it on.
  consent() { return read(`consent`); }
  noticeSeen() { return Boolean(this.consent()?.at); }
  markNoticeSeen() { if (!this.noticeSeen()) { write(`consent`, { at: nowIso(), feedback: false }); this.emit(); this.flushUsage({ force: true }).catch(() => {}); } }
  needsNotice() { return this.on() && !this.noticeSeen(); }
  feedbackAllowed() { return this.consent()?.feedback === true; }
  setFeedback(on) { write(`consent`, { at: this.consent()?.at || nowIso(), feedback: Boolean(on) }); this.emit(); }

  /** Licensing's own counters (lic.wouldShow.*, invite) go into stats.js through this, set by the app. */
  setCounter(fn) { this.countFn = fn; }
  count(name, n = 1) { try { this.countFn?.(name, n); } catch { /* ignore */ } }

  // ---------------- usage: stats.js counts since the last send, attributed to the open inventory's owner's licence
  async flushUsage({ keepalive = false, force = false, licence } = {}) {
    if (!this.on() || !this.install) return;
    if (!this.noticeSeen()) return; // nothing leaves the device before the privacy notice has been shown
    if (!force && !keepalive && Date.now() - read(`lastFlush`, 0) < FLUSH_EVERY_MS) return;
    this.packBatch(licence);
    let batches = read(`batches`, []).filter((b) => Date.now() - Date.parse(b.sentAt) < BATCH_MAX_AGE_MS);
    for (const b of [...batches]) {
      try {
        await this.call(`POST`, `/usage`, b, { auth: `optional`, keepalive });
        batches = batches.filter((x) => x.batchId !== b.batchId);
        write(`batches`, batches);
      } catch (e) { if (e.code !== `network`) { batches = batches.filter((x) => x.batchId !== b.batchId); write(`batches`, batches); } break; }
    }
    write(`lastFlush`, Date.now());
  }

  /** licence: whose counts these are (default: the open inventory's owner's; on a switch, the one just left). */
  packBatch(forLicence) {
    let data = null; try { data = this.usageFn(); } catch { data = null; }
    const ctx = this.ctx();
    const licence = forLicence !== undefined ? forLicence : ctx && !ctx.demo ? this.licenceFor(ctx) : null;
    const sent = read(`sent`, {});
    const days = [];
    for (const [date, day] of Object.entries(data?.days || {})) {
      const { delta, now } = dayCounters(day, sent[date], { feedback: this.feedbackAllowed() });
      if (!Object.keys(delta).length) continue;
      days.push({ date, tenantId: day.mode === `demo` ? null : licence, counters: delta });
      sent[date] = { ...(sent[date] || {}), ...now };
    }
    let gauges = null;
    try { gauges = licence ? this.gaugeFn() : null; } catch { gauges = null; }
    if (!days.length && !gauges) return;
    const cut = new Date(Date.now() - 130 * DAY_MS).toISOString().slice(0, 10);
    for (const d of Object.keys(sent)) if (d < cut) delete sent[d];
    const batch = {
      batchId: uuid(), sentAt: nowIso(),
      install: { firstOpenAt: this.install.firstOpenAt, standalone: isStandalone(), locale: navigator.language || ``, demo: Boolean(ctx?.demo) },
      days, snapshots: gauges && licence ? [{ tenantId: licence, at: nowIso(), gauges }] : [],
    };
    write(`batches`, [...read(`batches`, []), batch].slice(-MAX_BATCHES));
    write(`sent`, sent);
  }

  // ---------------- the main loop: owner's access report → session for the open inventory → usage
  /** Runs at most every 15 s (unless forced); safe to call often. */
  tick(force = false) {
    if (!this.on() || !this.install) return Promise.resolve();
    if (this.busy) return this.busy;
    const ctx = this.ctx();
    const switched = Boolean(ctx?.inventoryId && ctx.inventoryId !== this.lastInv); // another inventory opened: check it now
    if (!force && !switched && Date.now() - this.lastTick < 15_000) return Promise.resolve();
    this.lastTick = Date.now();
    this.busy = this.run(force, switched).catch((e) => { if (![`no_session`, `network`, `auth_unavailable`].includes(e.code)) console.warn(`licensing`, e); })
      .finally(() => { this.busy = null; });
    return this.busy;
  }

  async run(force, switched) {
    if (!navigator.onLine) return;
    await this.refreshKeys();
    const ctx = this.ctx();
    if (switched && this.lastInv) await this.flushUsage({ force: true, licence: this.lastLicence ?? null }).catch(() => {}); // counts so far belong to the last one
    if (ctx?.inventoryId) this.lastInv = ctx.inventoryId;
    if (ctx?.email && !ctx.demo && this.sessionToken()) {
      if (force || read(`accessDirty`) || Date.now() - read(`accessAt`, 0) > ACCESS_EVERY_MS) await this.reportAccess(ctx);
      if (ctx.inventoryId) {
        const st = this.invState(ctx.inventoryId);
        if (force || switched || !st || Date.now() >= Date.parse(st.nextAt || 0)) await this.session(ctx);
      }
    }
    this.lastLicence = ctx && !ctx.demo ? this.licenceFor(ctx) : null;
    await this.flushUsage();
  }

  async refreshKeys() {
    if (this.isStub()) return; // the stub's key is added at init
    const k = read(`keys`);
    if (k && Date.now() - k.at < KEYS_EVERY_MS) return;
    try {
      const r = await this.call(`GET`, `/keys`, null, { auth: false });
      if (Array.isArray(r?.keys)) { write(`keys`, { at: Date.now(), keys: r.keys }); this.keys = [...(CONFIG.LICENSE_KEYS || []), ...r.keys]; }
    } catch { /* bundled keys still work */ }
  }

  /**
   * POST /licence/access: everything this person owns in Paran and who can open each. Someone who owns nothing has no
   * licence and sends nothing. The server keys the licence on the owner's identity, so no id is written to any sheet.
   */
  async reportAccess(ctx) {
    if (!ctx.collectAccess) return;
    const raw = await ctx.collectAccess();
    write(`accessAt`, Date.now()); drop(`accessDirty`);
    if (!raw) { write(`ownsNothing`, true); return; }
    drop(`ownsNothing`);
    if (raw.props) write(`rootProps`, raw.props);
    const files = await Promise.all(raw.files.map(async (f) => ({
      fileId: f.fileId, kind: f.kind, general: f.general,
      people: await Promise.all(f.people.filter((p) => p.email).map(async (p) => ({ emailHash: await emailHash(p.email), role: p.role, type: p.type }))),
    })));
    const listed = [...new Set(await Promise.all((raw.listed || []).filter(Boolean).map(emailHash)))];
    const r = await this.call(`POST`, `/licence/access`, { reportedAt: nowIso(), files, listed });
    write(`seatPeople`, [...new Set(files.flatMap((f) => f.people.map((p) => p.emailHash)))]);
    if (r?.tenantId) write(`mine`, r.tenantId);
    await this.accept(r?.tenantId, r);
  }

  markAccessDirty() { write(`accessDirty`, 1); }

  /** POST /session for the open inventory; remembers which licence it belongs to. */
  async session(ctx) {
    try {
      const r = await this.call(`POST`, `/session`, { inventoryId: ctx.inventoryId, role: ctx.role });
      write(`inv.${ctx.inventoryId}`, { licence: r.tenantId, nextAt: r.nextCheckAt });
      await this.accept(r.tenantId, r, { session: true });
    } catch (e) {
      if (e.code === `tenant_unknown`) { // its owner hasn't reported it yet: allowed, ask again later
        write(`inv.${ctx.inventoryId}`, { licence: null, nextAt: new Date(Date.now() + UNKNOWN_RETRY_MS).toISOString() });
        this.emit(); return;
      }
      throw e;
    }
  }

  invState(inventoryId) { return inventoryId ? read(`inv.${inventoryId}`) : null; }
  mine() { return read(`mine`); }
  /** The licence that applies to the open inventory: the owner's own, or its owner's. */
  licenceFor(ctx) { return ctx?.isOwner ? (this.mine() || this.invState(ctx.inventoryId)?.licence || null) : (this.invState(ctx?.inventoryId)?.licence || null); }

  /** Owner: for the given email hashes, last opened / seat / kept. → { members, others } */
  async members(hashes) {
    if (!this.mine()) return { members: [], others: 0 };
    const r = await this.call(`POST`, `/licence/members`, { emailHashes: [...new Set(hashes)].slice(0, 500) });
    return { members: r?.members || [], others: r?.others || 0 };
  }

  async setKeepers(hashes) {
    const r = await this.call(`PUT`, `/licence/keepers`, { keep: hashes });
    if (r?.tenantId) write(`mine`, r.tenantId);
    await this.accept(r?.tenantId || this.mine(), r);
  }

  async checkout(plan, interval = `month`) { return this.call(`POST`, `/licence/checkout`, { plan, interval }); }

  async deleteMe() { return this.call(`DELETE`, `/me`, null); }

  /** Keep a response only if its signed token verifies; the token's claims are what the app uses. */
  async accept(licence, r, { session = false } = {}) {
    if (!r?.token || !licence) return;
    const claims = await verifyJws(r.token, this.keys);
    if (!claims || claims.aud !== APP || claims.sub !== licence) { console.warn(`licensing: entitlement did not verify`); return; }
    const prev = this.stored(licence) || {};
    const next = {
      claims, messages: r.messages || [],
      decision: session ? (r.decision || `allow`) : (prev.decision || `allow`),
      reason: session ? (r.reason || null) : (prev.reason || null),
      receivedAt: nowIso(),
    };
    write(`ent.${licence}`, next);
    if (claims.you?.isOwner) {
      write(`okAt`, Date.now());
      try { await this.ctx()?.recordCheck?.(claims.mode); } catch { /* best effort */ }
    }
    if (r.minAppVersion && versionNumber(r.minAppVersion) > versionNumber(this.version)) this.dispatchEvent(new Event(`update-required`));
    const v = viewOf(next);
    if (!v.enforced && v.wouldShow) this.count(`lic.wouldShow.${v.wouldShow}`);
    this.emit();
  }

  stored(licence) { return licence ? read(`ent.${licence}`) : null; }

  /** The answer for the open inventory (fail-open defaults when there is none). */
  view() {
    const ctx = this.ctx();
    if (!this.on() || !ctx?.email || ctx.demo) return { ...viewOf(null), unverified: false };
    return { ...viewOf(this.stored(this.licenceFor(ctx))), unverified: this.unverified() };
  }

  /** The owner's own licence, whichever inventory is open (for People pages and invites). */
  ownView() {
    const ctx = this.ctx();
    if (!this.on() || !ctx?.email || ctx.demo) return { ...viewOf(null), unverified: false };
    return { ...viewOf(this.stored(this.mine())), unverified: this.unverified() };
  }

  /**
   * Fail open only for a while. If an owner's plan hasn't been checked for too long (a blocked server, never confirming
   * who they are), their sharing is paused until it is. The last check date also lives on the owner's Paran folder in
   * Drive, so clearing app data doesn't reset it. The limit is 7 days once enforced, else CONFIG.LICENSE_FAIL_OPEN_DAYS
   * (null = no limit, the pilot). Owners only: nobody is locked out of using Paran because a server can't be reached.
   */
  unverified() {
    const ctx = this.ctx();
    if (!this.on() || !ctx?.email || ctx.demo || read(`ownsNothing`)) return false;
    if (!this.mine() && !ctx.ownsSomething) return false;
    const props = read(`rootProps`) || {};
    const enforced = props.licMode === `enforce` || this.stored(this.mine())?.claims?.mode === `enforce`;
    const days = enforced ? 7 : CONFIG.LICENSE_FAIL_OPEN_DAYS;
    if (days == null) return false;
    const last = Math.max(read(`okAt`, 0), props.licOk ? Date.parse(`${props.licOk}T23:59:59Z`) : 0, Date.parse(this.install?.firstOpenAt || 0) || 0);
    return Boolean(last) && Date.now() - last > days * DAY_MS;
  }

  /** Is this person blocked from the open inventory right now? Its owner never is. */
  blocked() {
    const v = this.view();
    if (!v.enforced || v.you.isOwner || this.ctx()?.isOwner) return false;
    return v.decision === `deny` || v.you.blocked;
  }

  /**
   * Can the owner share with this person? People who already have access to something of the owner's take no new
   * seat, so they're always fine. → { ok, why, enforced }, why = unverified | full | restricted | locked.
   * In observe mode ok is always true and `why` says what would have been shown.
   */
  async inviteCheck(email = ``) {
    const v = this.ownView();
    if (!this.on() || !v) return { ok: true, why: null, enforced: false };
    if (v.unverified) return { ok: false, why: `unverified`, enforced: true };
    if (email && (read(`seatPeople`, []) || []).includes(await emailHash(email))) return { ok: true, why: null, enforced: v.enforced };
    const why = v.state === `locked` ? `locked` : v.state === `restricted` ? `restricted`
      : (v.seats.unknowable || (v.seats.cap != null && v.seats.used >= v.seats.cap)) ? `full` : null;
    if (why && !v.enforced) this.count(`lic.wouldShow.${why}`);
    return { ok: !why || !v.enforced, why, enforced: v.enforced };
  }

  // ---------------- transport
  async call(method, path, body, { auth = true, keepalive = false } = {}) {
    const token = auth === false ? null : this.sessionToken();
    if (auth === true && !token) throw new LicError(`no_session`);
    const h = {
      'X-App-Id': APP, 'X-Install-Id': this.install.id, 'X-App-Version': this.version, 'X-Platform': platform(),
      ...(body ? { 'Content-Type': `application/json` } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const fail = (status, data) => {
      if (status === 401 && token) { drop(`auth`); this.emit(); } // session refused: confirm identity again on the next tap
      return new LicError(data?.code || (status >= 500 ? `network` : `http_${status}`), status, data);
    };
    if (this.stub) {
      const res = await this.stub.handle(method, path, h, body ? JSON.parse(JSON.stringify(body)) : null);
      if (res.status >= 400) throw fail(res.status, res.data);
      return res.data;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${CONFIG.LICENSE_URL.replace(/\/$/, ``)}${path}`, {
        method, headers: h, body: body ? JSON.stringify(body) : undefined, keepalive, signal: ctl.signal, credentials: `omit`,
      });
    } catch { throw new LicError(`network`); }
    finally { clearTimeout(timer); }
    let data = null;
    try { data = res.status === 204 || res.status === 202 ? null : await res.json(); } catch { data = null; }
    if (!res.ok) throw fail(res.status, data);
    return data;
  }

  /** Forget this phone's licensing state (Start fresh). The install id is kept: it's the same phone. */
  forget() {
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(LS) && k !== `${LS}install` && k !== `${LS}consent`) localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

function isStandalone() {
  try { return window.matchMedia(`(display-mode: standalone)`).matches || navigator.standalone === true; } catch { return false; }
}

/** The service worker's cache name is the app version (one cache is kept), so no second copy of VERSION is needed. */
async function appVersion() {
  try { const k = (await caches.keys()).find((n) => /^paran-v\d+$/.test(n)); return k || `dev`; } catch { return `dev`; }
}

export const lic = new Licensing();
