// Paran's Drive token and the licensing identity token must never get mixed up.
// Google's sign-in popups share one window ("g_auth_token_window"), so a reply can reach the wrong token client.
// This runs js/google.js in Node with a stand-in for Google Identity Services that delivers every reply to the FIRST
// client created (the misrouting that left a phone with "Request had insufficient authentication scopes").
//
//   node tests/google_tokens.mjs        (exits non-zero if any check fails)
const DRIVE = `https://www.googleapis.com/auth/drive.file`;
let fails = 0;
const check = (cond, what) => { console.log(`${cond ? `  ok  ` : `  FAIL`} ${what}`); if (!cond) fails += 1; };

// ---- browser globals the module touches
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = { querySelector: () => ({}) }; // the GIS script counts as loaded
globalThis.window = globalThis;

// ---- GIS stand-in: replies go to the first client ever created, whoever asked
const clients = [];
let nextReply = null; // what Google answers to the next request
globalThis.google = { accounts: { oauth2: {
  initTokenClient: (o) => { const c = { o, requestAccessToken: () => { const r = nextReply; setTimeout(() => clients[0].o.callback(r), 5); } }; clients.push(c); return c; },
  revoke: () => {},
} } };

const g = await import(`../js/google.js`);
const driveReply = { access_token: `drive-token`, scope: `${DRIVE} openid email`, expires_in: 3599 };
const idReply = { access_token: `identity-token`, scope: `openid https://www.googleapis.com/auth/userinfo.email`, expires_in: 3599 };
const stored = () => JSON.parse(localStorage.getItem(`paran.token`) || `null`)?.access_token || null;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

console.log(`1. Sign in, then licensing asks who you are (its reply lands on Paran's own client)`);
nextReply = driveReply;
await g.signIn({ silent: true });
check(stored() === `drive-token`, `Paran keeps the Drive token`);
nextReply = idReply;
const idP = g.getIdentityToken({ hint: `a@gmail.com` });
await tick();
check(stored() === `drive-token`, `an identity-only reply never replaces the Drive token`);

console.log(`2. One popup at a time`);
let threw = null; try { await g.signIn({ silent: true }); } catch (e) { threw = e.message; }
check(Boolean(threw), `Paran's sign-in won't open a second popup while the identity one is open (${threw})`);
check(stored() === `drive-token`, `and the Drive token is untouched`);

console.log(`3. A token without Drive access is dropped on Google's "insufficient scopes" answer`);
globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 403, message: `Request had insufficient authentication scopes.`, status: `PERMISSION_DENIED`,
  errors: [{ reason: `insufficientPermissions` }] } }), { status: 403, headers: { 'Content-Type': `application/json` } });
let err = null; try { await g.userinfo(); } catch (e) { err = e; }
check(err instanceof g.AuthError, `it becomes "Session expired" (so the next tap signs in again), not a sync error`);
check(stored() === null && !g.hasValidToken(), `and the bad token is gone`);

console.log(`4. Other 403s are still errors, and keep the token`);
nextReply = null; // let the identity request time out quietly; not needed below
localStorage.setItem(`paran.token`, JSON.stringify({ access_token: `drive-token`, expires_at: Date.now() + 3600_000 }));
globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 403, message: `The caller does not have permission`, status: `PERMISSION_DENIED`, errors: [{ reason: `forbidden` }] } }), { status: 403 });
err = null; try { await g.userinfo(); } catch (e) { err = e; }
check(err && !(err instanceof g.AuthError), `a sharing 403 stays an ordinary error`);
check(stored() === `drive-token`, `and keeps the token`);

void idP;
console.log(fails ? `${fails} check(s) failed` : `all checks passed`);
process.exit(fails ? 1 : 0);
