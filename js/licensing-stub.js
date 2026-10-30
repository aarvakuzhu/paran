// In-browser stand-in for the licensing server (CONFIG.LICENSE_URL = `stub`). For building and testing the app
// before (or without) the real server. Implements the same contract using the server's own rules
// (licensing-rules.js, vendored from Urimam), on data kept in this browser only.
// Differences from the real server: people are keyed by the app's email hash (the server re-keys them with a secret),
// the identity token is `stub:<email>` instead of a Google token, and there are no rate limits.
// Test switches (Your activity → Licensing test, only in stub mode) change the mode, the free limit, the grace
// length, force a state, or make the server unreachable.
import { emailHash } from './licensing.js';
import { effectiveSettings, planFor, evaluate, messagesFor, claimsFor, nextCheckAt, applyAccessReport, addFlag, reportIsFresh } from './licensing-rules.js';

const KEY = `paran.lic.stub`;
const KEYPAIR = `paran.lic.stub.key`;
const TRANSFER_AFTER_MS = 30 * 86400_000;

const FEATURES = { invite: true, viewOnlyMembers: true, multipleInventories: true, events: true, eventAssignments: true,
  eventDayOf: true, ownershipTransfer: true, auditExport: true, aiScan: true, hostedAi: false };
const APP = {
  id: `paran`, name: `Paran`, defaults: { mode: `observe`, freeMembers: 5, graceDays: 14, minAppVersion: null },
  plans: { free: { limits: { members: 5 }, features: FEATURES }, pilot: { limits: { members: null }, features: FEATURES } },
};

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
const fresh = () => ({ licences: {}, bindings: {}, memberships: {}, usage: [], debug: { mode: `observe`, cap: 5, graceDays: 14, force: ``, down: `` } });
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``);
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
const fromB64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, `+`).replace(/_/g, `/`)), (c) => c.charCodeAt(0)));
const problem = (status, code, detail = code, extra = {}) => ({ status, data: { type: `about:blank`, title: code, status, code, detail, ...extra } });
async function licenceIdFor(personHash) {
  const buf = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(`licence:paran:${personHash}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, `0`)).join(``).slice(0, 32);
}

export async function createStub() {
  let db = load() || fresh();
  db = { ...fresh(), ...db, debug: { ...fresh().debug, ...(db.debug || {}) } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* ignore */ } };

  // signing key, generated once per browser
  let pair = null; let kid = ``;
  try {
    const saved = JSON.parse(localStorage.getItem(KEYPAIR) || `null`);
    if (saved) {
      pair = { privateKey: await crypto.subtle.importKey(`jwk`, saved.priv, { name: `ECDSA`, namedCurve: `P-256` }, false, [`sign`]), pub: saved.pub };
      kid = saved.pub.kid;
    }
  } catch { pair = null; }
  if (!pair) {
    const kp = await crypto.subtle.generateKey({ name: `ECDSA`, namedCurve: `P-256` }, true, [`sign`, `verify`]);
    const priv = await crypto.subtle.exportKey(`jwk`, kp.privateKey);
    const pubJwk = await crypto.subtle.exportKey(`jwk`, kp.publicKey);
    kid = `stub-${Date.now().toString(36)}`;
    const pub = { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y, kid, alg: `ES256`, use: `sig` };
    try { localStorage.setItem(KEYPAIR, JSON.stringify({ priv, pub })); } catch { /* ignore */ }
    pair = { privateKey: kp.privateKey, pub };
  }
  async function sign(claims) {
    const h = b64urlText(JSON.stringify({ alg: `ES256`, typ: `JWT`, kid }));
    const p = b64urlText(JSON.stringify(claims));
    const sig = await crypto.subtle.sign({ name: `ECDSA`, hash: `SHA-256` }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }

  const settings = () => effectiveSettings(APP, { mode: db.debug.mode, freeMembers: Number(db.debug.cap) || 5,
    graceDays: db.debug.graceDays === `` ? 14 : Number(db.debug.graceDays) });
  const memberships = (lid) => Object.values(db.memberships).filter((m) => m.tenantId === lid);

  function evalFor(t, who) {
    const ev = evaluate({ app: APP, tenant: t, memberships: memberships(t._id), settings: settings(), who, now: Date.now() });
    if (db.debug.force) { // test switch: pretend the licence is in this state
      ev.state = db.debug.force;
      ev.kept = ev.isOwner || ev.state === `ok` || ev.state === `grace` || (t.keepers || []).includes(who);
      ev.blocked = !ev.isOwner && ((ev.state === `restricted` && !ev.kept) || ev.state === `locked`);
    }
    return ev;
  }

  async function entitlementFor(t, who) {
    const before = t.graceStart || null;
    let ev = evalFor(t, who);
    if (before !== ev.graceStart) { t.graceStart = ev.graceStart; ev = evalFor(t, who); }
    const claims = claimsFor({ issuer: `stub`, appId: `paran`, tenant: t, ev });
    save();
    return { ev, body: { entitlement: claims, token: await sign(claims), messages: messagesFor(ev, `Paran`), nextCheckAt: nextCheckAt(ev), minAppVersion: null, tenantId: t._id } };
  }

  /** Session token: s1.stub.<base64url {email, iid}>. */
  async function who(headers) {
    const m = /^Bearer s1\.stub\.([A-Za-z0-9_-]+)$/.exec(headers.Authorization || ``);
    if (!m) return null;
    try {
      const p = JSON.parse(fromB64url(m[1]));
      return p.iid === headers[`X-Install-Id`] ? emailHash(p.email) : null;
    } catch { return null; }
  }

  async function handle(method, path, headers, body) {
    const route = `${method} ${path}`;
    if (db.debug.down) return problem(503, `unavailable`, `Test switch: server unreachable`);
    if (route === `GET /keys`) return { status: 200, data: { keys: [pair.pub] } };
    if (route === `POST /auth`) {
      const m = /^stub:(.+@.+)$/.exec(body?.identityToken || ``);
      if (!m) return problem(401, `auth_invalid`, `The stub expects identity token "stub:<email>"`);
      return { status: 200, data: { token: `s1.stub.${b64urlText(JSON.stringify({ email: m[1], iid: headers[`X-Install-Id`] }))}`, expiresAt: new Date(Date.now() + 14 * 86400_000).toISOString() } };
    }
    if (route === `POST /usage`) {
      db.usage = [...db.usage, { at: new Date().toISOString(), install: headers[`X-Install-Id`], authed: Boolean(headers.Authorization), batch: body }].slice(-50); save();
      return { status: 202, data: null };
    }
    const me = await who(headers);
    if (!me) return problem(401, `auth_invalid`, `Missing or invalid session`);
    const myId = await licenceIdFor(me);
    if (route === `DELETE /me`) {
      for (const [k, m] of Object.entries(db.memberships)) if (m.personHash === me) delete db.memberships[k];
      for (const t of Object.values(db.licences)) t.keepers = (t.keepers || []).filter((h) => h !== me);
      save(); return { status: 202, data: null };
    }
    if (route === `POST /session`) {
      const b = db.bindings[body.inventoryId];
      const t = b && db.licences[b.tenantId];
      if (!t) return problem(404, `tenant_unknown`, `The owner of this inventory hasn’t reported it yet`);
      if (me !== t.ownerHash && reportIsFresh(t, Date.now()) && !(t.access.hashes || []).includes(me)) addFlag(t, `session_not_in_report`);
      const key = `${t._id}|${me}`;
      db.memberships[key] = { ...(db.memberships[key] || { tenantId: t._id, personHash: me }), lastOpenedAt: new Date().toISOString(), role: body.role };
      const { ev, body: out } = await entitlementFor(t, me);
      const deny = ev.mode === `enforce` && ev.blocked;
      return { status: 200, data: { ...out, decision: deny ? `deny` : `allow`, reason: deny ? (ev.state === `locked` ? `locked` : `not_kept`) : null } };
    }
    if (route === `POST /licence/access`) {
      const t = db.licences[myId] ||= { _id: myId, appId: `paran`, ownerHash: me, createdAt: new Date().toISOString(), plan: `free`, keepers: [], flags: [], graceStart: null, tamper: null, access: null };
      for (const f of body.files) {
        const cur = db.bindings[f.fileId];
        if (!cur) { db.bindings[f.fileId] = { tenantId: myId, ownerHash: me }; continue; }
        if (cur.tenantId === myId) continue;
        const other = db.licences[cur.tenantId];
        const stillListed = other?.access?.fileIds?.includes(f.fileId);
        const silent = !other?.access?.at || Date.now() - Date.parse(other.access.at) > TRANSFER_AFTER_MS;
        if (!other || !stillListed || silent) { db.bindings[f.fileId] = { tenantId: myId, ownerHash: me, movedFrom: cur.tenantId }; addFlag(t, `file_transferred_in`); }
        else addFlag(t, `file_claimed_elsewhere`);
      }
      const { removed, present } = applyAccessReport({ app: APP, tenant: t, memberships: memberships(myId), settings: settings(), report: body, now: Date.now() });
      for (const h of removed) { const k = `${myId}|${h}`; if (db.memberships[k]) db.memberships[k].removedAt = new Date().toISOString(); }
      for (const h of present) { const k = `${myId}|${h}`; if (db.memberships[k]) delete db.memberships[k].removedAt; }
      const k = `${myId}|${me}`;
      db.memberships[k] = { ...(db.memberships[k] || { tenantId: myId, personHash: me }), lastOpenedAt: new Date().toISOString(), role: `owner` };
      return { status: 200, data: (await entitlementFor(t, me)).body };
    }
    const t = db.licences[myId];
    if (!t) return problem(404, `tenant_unknown`, `No licence yet`);
    if (route === `POST /licence/members`) {
      const ev = evalFor(t, t.ownerHash);
      const asked = new Set(body.emailHashes);
      return { status: 200, data: {
        members: [...asked].map((h) => ({ emailHash: h, lastOpenedAt: db.memberships[`${t._id}|${h}`]?.lastOpenedAt || null, seat: ev.seatHolders.has(h),
          kept: h === t.ownerHash || ev.state === `ok` || ev.state === `grace` || (t.keepers || []).includes(h) })),
        others: [...ev.seatHolders].filter((h) => !asked.has(h)).length,
      } };
    }
    if (route === `PUT /licence/keepers`) {
      const keep = [...new Set(body.keep || [])].filter((h) => h !== t.ownerHash);
      const cap = planFor(APP, t, settings()).limits.members;
      if (cap != null && keep.length + 1 > cap) return problem(422, `too_many_keepers`, `You can keep up to ${cap - 1} people besides yourself.`);
      t.keepers = keep;
      return { status: 200, data: (await entitlementFor(t, me)).body };
    }
    if (route === `POST /licence/checkout`) return problem(501, `not_implemented`, `Payments aren’t set up yet.`);
    return problem(400, `bad_request`, `No such route in the stub: ${route}`);
  }

  return {
    handle,
    publicKeys: async () => [pair.pub],
    debug: () => ({ ...db.debug }),
    setDebug(patch) { db.debug = { ...db.debug, ...patch }; save(); },
    lastUsage: () => db.usage[db.usage.length - 1] || null,
    usage: () => [...db.usage],
    licence: (id) => db.licences[id] || null,
    licenceOf: async (email) => db.licences[await licenceIdFor(await emailHash(email))] || null,
    binding: (fileId) => db.bindings[fileId] || null,
    reset() { db = fresh(); save(); },
  };
}
