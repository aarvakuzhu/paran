# Licensing end to end: Paran against a local Urimam server (insecure-test identity tokens) and the strict fake
# Google, as several accounts. The licence is the owner's and counts people: everyone who can open anything they
# share, once. Groups and inventories are only read.
#
#   (in license-server)  AUTH_MODE=insecure-test ADMIN_TOKEN=e2e-admin-token-0123456789-abcdefghij PORT=8787 \
#        RATE_LIMITS='{"ipAuth":[1000,600000],"admin":[1000,600000]}' node src/server.js
#   python3 -m http.server 8080        # from the repo root
#   python3 tests/licensing_e2e.py
#
# Also checks that with licensing off (the shipped config) nothing changes: no banner, no requests, the old switch.
import asyncio, sys, json, re, os, urllib.request
SP = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, SP)
import fake_google as G
from playwright.async_api import async_playwright

URL = 'http://localhost:8080/'
LIC = os.environ.get('LIC_URL', 'http://127.0.0.1:8787')
ADMIN = os.environ.get('LIC_ADMIN', 'e2e-admin-token-0123456789-abcdefghij')
T = lambda s: re.sub(r'\s+', ' ', s).strip()
OWNER, RAVI, HELPER, KP, NEW = 'ashok@example.com', 'ravi@example.com', 'helper@example.com', 'kp@example.com', 'new@example.com'
FAILS = []
def check(cond, what):
    print(('  ok   ' if cond else '  FAIL ') + what)
    if not cond: FAILS.append(what)

def admin(method, path, body=None):
    req = urllib.request.Request(LIC + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': 'Bearer ' + ADMIN, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as r: return json.loads(r.read() or b'null')

# Google Identity Services, as far as Paran uses it: the Drive token (already in storage) and the identity-only token.
GIS_STUB = """
window.google = window.google || {}; google.accounts = { oauth2: {
  initTokenClient: (o) => ({ requestAccessToken: () => {
    window.__idAsked = (window.__idAsked || 0) + 1; window.__idScope = o.scope; window.__idIncl = o.include_granted_scopes;
    const email = JSON.parse(localStorage.getItem('paran.session') || '{}').user?.email || '';
    setTimeout(() => o.callback({ access_token: 'test:' + email, scope: 'openid https://www.googleapis.com/auth/userinfo.email', expires_in: 3599 }), 10);
  } }), revoke: () => {} } };
"""

OLD_CHECK = """() => { localStorage.setItem('paran.lic.okAt', String(Date.now() - 9 * 86400000));
  localStorage.setItem('paran.lic.rootProps', JSON.stringify({ licOk: new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10), licMode: 'enforce' }));
  const i = JSON.parse(localStorage.getItem('paran.lic.install')); i.firstOpenAt = new Date(Date.now() - 30 * 86400000).toISOString(); localStorage.setItem('paran.lic.install', JSON.stringify(i));
  }"""

async def phone(b, email, lic=True, url=None):
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1, service_workers='block')
    pg = await ctx.new_page(); errs = []; sent = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    async def gapi(route):
        req = route.request
        who = (req.headers.get('authorization') or '').replace('Bearer tok:', '')
        try: r = G.handle(who, req.method, req.url, req.post_data)
        except Exception as ex: r = ('ERR', 500, repr(ex))
        if isinstance(r, tuple): await route.fulfill(status=r[1], content_type='application/json', body=json.dumps({'error': {'code': r[1], 'message': r[2]}}))
        else: await route.fulfill(status=200, content_type='application/json', body=json.dumps(r))
    await ctx.route('https://*.googleapis.com/**', gapi)
    await ctx.route('https://accounts.google.com/**', lambda r: r.fulfill(status=200, content_type='text/javascript', body=GIS_STUB))
    async def cfg(route):
        r = await route.fetch(); body = await r.text()
        if lic: body = body.replace('LICENSE_URL: ``', f'LICENSE_URL: `{url or LIC + "/v1"}`')
        await route.fulfill(status=200, content_type='text/javascript', body=body)
    await ctx.route('**/js/config.js*', cfg)
    pg.on('request', lambda r: sent.append((r.method, r.url, r.headers.get('authorization') or '', r.post_data or '')) if r.url.startswith(LIC) else None)
    await pg.goto(URL)
    await pg.evaluate("""e => { localStorage.clear(); localStorage.setItem('paran.mode', 'google'); localStorage.setItem('paran.migrated', '1');
      localStorage.setItem('paran.token', JSON.stringify({ access_token: 'tok:' + e, expires_at: 9999999999999 })); }""", email)
    await pg.reload(); await pg.wait_for_timeout(2000)
    return ctx, pg, errs, sent

async def tap(pg):  # a tap anywhere harmless: lets licensing confirm who this is (identity needs a user gesture)
    await pg.click('.topbar', position={'x': 200, 'y': 10}); await pg.wait_for_timeout(1500)

async def close_sheets(pg):
    for _ in range(4):
        x = await pg.query_selector_all('.sheet-wrap.open [data-close]')
        if not x: break
        await x[-1].click(); await pg.wait_for_timeout(300)

async def open_inv(pg, sheet_id):  # switch inventory the way a person does: the name at the top → pick it
    await pg.goto(URL + '#/'); await pg.wait_for_timeout(500); await close_sheets(pg)
    await pg.click('#invsw'); await pg.wait_for_timeout(600)
    await pg.click(f'.sheet-wrap.open [data-inv="{sheet_id}"]'); await pg.wait_for_timeout(3000)

async def lic_state(pg, key):
    return await pg.evaluate(f"JSON.parse(localStorage.getItem('paran.lic.{key}') || 'null')")

async def own_view(pg):
    return await pg.evaluate("import('./js/licensing.js').then(m => m.lic.ownView())")

async def here_view(pg):
    return await pg.evaluate("import('./js/licensing.js').then(m => m.lic.view())")

async def main():
    admin('PATCH', '/admin/apps/paran', {'mode': 'observe', 'freeMembers': 5, 'graceDays': 14})
    async with async_playwright() as p:
        b = await p.chromium.launch()

        # ================= 0. Off by default: nothing changes
        print('0. Licensing off (the shipped config)')
        o, O, oerr, osent = await phone(b, 'off@example.com', lic=False)
        await O.click('#create'); await O.wait_for_timeout(300); await O.click('[data-empty]'); await O.wait_for_timeout(300)
        await O.fill('.sheet input', 'Garage'); await O.click('.sheet button.primary'); await O.wait_for_timeout(3000)
        await O.goto(URL + '#/more/stats'); await O.wait_for_timeout(800)
        txt = T(await O.inner_text('.more'))
        check('Keep these counts on this phone' in txt and not await O.query_selector('[data-fbsw]'), 'Your activity keeps its on-phone switch')
        await O.goto(URL + '#/more'); await O.wait_for_timeout(400); await O.click('[data-m="about"]'); await O.wait_for_timeout(400)
        about = T(await O.inner_text('.sheet-wrap.open'))
        check('has no server' in about and 'usage counts' not in about, 'About unchanged')
        check(await O.is_hidden('#licbar'), 'no licensing banner')
        await O.goto(URL + '#/more/people'); await O.wait_for_timeout(600)
        check(not await O.query_selector('[data-everyone]'), 'People & access unchanged')
        check(not osent and not await O.evaluate("Object.keys(localStorage).some((k) => k.startsWith('paran.lic.'))"), 'nothing sent to or stored for licensing')
        check(not oerr, f'no page errors {oerr}')
        await o.close()

        # ================= 1. Owner: a group (two inventories) and a home of their own
        print('1. Owner sets up, sees the notice once, confirms who they are on a tap')
        a, A, aerr, asent = await phone(b, OWNER)
        await A.click('#create'); await A.wait_for_timeout(300); await A.click('[data-tpl="group"]'); await A.wait_for_timeout(300)
        await A.fill('[data-gname]', 'Tamil School'); await A.click('[data-create]'); await A.wait_for_timeout(8000)
        notice = T(await A.inner_text('.sheet-wrap.open')) if await A.query_selector('.sheet-wrap.open') else ''
        check('What Paran sends' in notice and 'one-way code' in notice and 'Share AI feedback' in notice, 'privacy notice shown once, with the optional AI feedback switch')
        check(not [s for s in asent if '/usage' in s[1]], 'nothing sent before the notice was seen')
        if await A.query_selector('.sheet-wrap.open [data-yes]'): await A.click('.sheet-wrap.open [data-yes]'); await A.wait_for_timeout(500)
        await tap(A)
        check(await A.evaluate('window.__idAsked || 0') >= 1 and await A.evaluate('window.__idScope') == 'openid email' and await A.evaluate('window.__idIncl') is False,
              'identity confirmed on a tap with an identity-only Google token (openid email, no Drive)')
        check(all('tok:' not in s[2] and 'tok:' not in s[3] for s in asent), 'the Drive token is never sent to the licensing server')
        await A.wait_for_timeout(1500)
        mb = next(f['id'] for f in G.FILES.values() if f['name'] == 'Main building' and f['mime'] == G.SHEET)
        su = next(f['id'] for f in G.FILES.values() if f['name'] == 'Storage unit' and f['mime'] == G.SHEET)
        group = next(f['id'] for f in G.FILES.values() if f['app'].get('stash') == 'group')
        mine = await lic_state(A, 'mine')
        check(bool(mine) and re.fullmatch(r'[0-9a-f]{32}', mine or ''), 'the owner has a licence (id from the server, nothing written to sheets)')
        check(all('lic' not in k.lower() or k in ('licOk', 'licMode') for f in G.FILES.values() for k in f['app']), 'no licence ids in any file (only the check date on the Paran folder)')
        report = next((json.loads(s[3]) for s in reversed(asent) if s[1].endswith('/licence/access')), None)
        kinds = sorted(f['kind'] for f in (report or {}).get('files', []))
        check(kinds.count('inventory') == 2 and 'group' in kinds and 'directory' in kinds, f'report lists the group, its directory and both inventories ({kinds})')
        check(report and all('@' not in json.dumps(f) and 'name' not in f for f in report['files']), 'report carries hashes only: no emails, no file names')

        # ================= 2. Sharing: the group, one inventory, and a home of their own
        print('2. People across everything count once')
        await A.goto(URL + f'#/group/{group}'); await A.wait_for_timeout(1500)
        await A.fill('#ginvite input[type=email]', RAVI); await A.click('#ginvite button.primary'); await A.wait_for_timeout(2500)
        await A.evaluate(f"import('./js/app.js')")  # no-op; keeps the page busy-free
        # helper: Main building only
        await open_inv(A, mb); await A.goto(URL + '#/more/people'); await A.wait_for_timeout(1500)
        await A.fill('#pinvite input[type=email]', HELPER); await A.select_option('#pinvite select[name=scope]', 'inv'); await A.click('#pinvite button.primary'); await A.wait_for_timeout(2500)
        v = await own_view(A)
        check(v['seats']['used'] == 3, f"owner + Ravi (group) + Helper (one inventory) = 3 ({v['seats']['used']})")
        # Ravi also given Storage unit directly: still one person
        await open_inv(A, su); await A.goto(URL + '#/more/people'); await A.wait_for_timeout(1500)
        await A.fill('#pinvite input[type=email]', RAVI); await A.select_option('#pinvite select[name=scope]', 'inv'); await A.click('#pinvite button.primary'); await A.wait_for_timeout(2500)
        v = await own_view(A)
        check(G.FILES[su]['perms'].get(RAVI) == 'writer' and v['seats']['used'] == 3, f'Ravi on the group and on Storage unit still counts once ({v["seats"]["used"]})')
        # someone added straight in Google Drive
        G.FILES[group]['perms'][KP] = 'reader'
        await A.click('[data-everyone]'); await A.wait_for_timeout(3000)
        ev = T(await A.inner_text('.sheet-wrap.open'))
        check(KP in ev and 'Added in Google Drive' in ev and RAVI in ev and HELPER in ev, 'Everyone you share with lists all three, KP tagged Added in Google Drive')
        check('4 people, counting you' in ev, 'and counts 4 with the owner')
        await close_sheets(A)

        # ================= 3. A member opens an inventory: matched to the owner's licence
        print('3. Members are matched to the owner\'s licence through the inventory')
        G.PICKED.add((RAVI, mb))
        r, R, rerr, rsent = await phone(b, RAVI)
        await R.evaluate(f"localStorage.setItem('paran.sheet.{RAVI}', '{mb}')"); await R.reload(); await R.wait_for_timeout(3000)
        if await R.query_selector('.sheet-wrap.open [data-yes]'): await R.click('.sheet-wrap.open [data-yes]'); await R.wait_for_timeout(300)
        await tap(R); await R.wait_for_timeout(1500)
        inv = await lic_state(R, f'inv.{mb}')
        check(inv and inv.get('licence') == mine, 'Ravi opening Main building gets the owner\'s licence')
        check(not await lic_state(R, 'mine') and await lic_state(R, 'ownsNothing'), 'Ravi owns nothing: no licence of his own, nothing reported')
        hv = await here_view(R)
        check(hv['has'] and not hv['you']['isOwner'] and hv['decision'] == 'allow', 'Ravi is allowed (observe mode)')

        # ================= 4. Usage counts: Paran's own counts, AI feedback only when on
        print('4. Usage')
        await A.evaluate("""() => { const s = JSON.parse(localStorage.getItem('paran.stats')); const d = Object.keys(s.days).sort().pop();
          s.days[d].c.add = (s.days[d].c.add || 0) + 3; s.days[d].ai = { photo: { uses: 2, n: 5, t: 4, fields: { name: [1, 2, 1.5] } } };
          localStorage.setItem('paran.stats', JSON.stringify(s)); }""")
        await A.evaluate("import('./js/licensing.js').then(m => m.lic.flushUsage({ force: true }))"); await A.wait_for_timeout(800)
        u = [json.loads(s[3]) for s in asent if s[1].endswith('/usage')]
        last = u[-1] if u else {'days': []}
        cs = {k: v for d in last['days'] for k, v in d['counters'].items()}
        check(cs.get('add', 0) >= 3 and cs.get('ai.photo.uses') == 2, 'counts from Your activity are sent (adds, AI uses)')
        check(not any(k.startswith('ai.fb.') for k in cs), 'no AI feedback while it is off')
        check(all(d['tenantId'] == mine for d in last['days']), 'attributed to the owner\'s licence')
        await A.evaluate("import('./js/licensing.js').then(m => m.lic.setFeedback(true))")
        await A.evaluate("""() => { const s = JSON.parse(localStorage.getItem('paran.stats')); const d = Object.keys(s.days).sort().pop();
          s.days[d].ai.photo.fields.name = [2, 3, 2.5]; s.days[d].ai.photo.uses = 3; localStorage.setItem('paran.stats', JSON.stringify(s)); }""")
        await A.evaluate("import('./js/licensing.js').then(m => m.lic.flushUsage({ force: true }))"); await A.wait_for_timeout(800)
        u = [json.loads(s[3]) for s in asent if s[1].endswith('/usage')]
        cs2 = {k: v for d in u[-1]['days'] for k, v in d['counters'].items()}
        check(cs2.get('ai.photo.uses') == 1 and cs2.get('add') is None, 'only what is new since the last send')
        check(cs2.get('ai.fb.photo.name.kept') == 2 and cs2.get('ai.fb.photo.name.total') == 3, 'AI feedback sent once turned on')
        st = admin('GET', '/admin/apps/paran/stats?days=30')
        check(st['totals'].get('add', 0) >= 3 and 'ai.photo.uses' in st['totals'], 'server has the counts')
        await A.goto(URL + '#/more/stats'); await A.wait_for_timeout(600)
        check(await A.query_selector('[data-fbsw]') and 'Keep these counts on this phone' not in T(await A.inner_text('.more')), 'Your activity: Share AI feedback instead of the off switch')
        await A.goto(URL + '#/more'); await A.wait_for_timeout(300); await A.click('[data-m="about"]'); await A.wait_for_timeout(300)
        about = T(await A.inner_text('.sheet-wrap.open'))
        check(about.endswith('AI feedback is optional: change it here.') and 'collects usage counts linked to your account' in about, 'About ends with the line on usage counts')
        await close_sheets(A)

        # ================= 5. Enforced, over the limit
        print('5. Enforce with a free limit of 3')
        admin('PATCH', '/admin/apps/paran', {'mode': 'enforce', 'freeMembers': 3, 'graceDays': 14})
        await A.goto(URL + '#/more/people'); await A.wait_for_timeout(500)
        await A.evaluate("import('./js/licensing.js').then(m => m.lic.tick(true))"); await A.wait_for_timeout(2500)
        v = await own_view(A)
        check(v['enforced'] and v['state'] == 'grace' and v['seats']['used'] == 4, f"4 people, limit 3 → grace ({v['state']}, {v['seats']['used']})")
        bar = T(await A.inner_text('#licbar')) if await A.is_visible('#licbar') else ''
        check('You share with 4 people' in bar and 'Manage people' in bar, 'owner sees the grace banner with Manage people')
        await A.fill('#pinvite input[type=email]', NEW); await A.select_option('#pinvite select[name=scope]', 'inv'); await A.click('#pinvite button.primary'); await A.wait_for_timeout(1200)
        blocked = T(await A.inner_text('.sheet-wrap.open')) if await A.query_selector('.sheet-wrap.open') else ''
        check('reached your plan' in blocked, 'inviting a new person is stopped at the limit')
        check(NEW not in json.dumps(G.FILES[su]['perms']), 'and nothing was shared')
        await close_sheets(A)
        await A.fill('#pinvite input[type=email]', HELPER); await A.select_option('#pinvite select[name=scope]', 'inv'); await A.click('#pinvite button.primary'); await A.wait_for_timeout(2500)
        check(G.FILES[su]['perms'].get(HELPER) == 'writer', 'someone already shared with (Helper) can be added to another inventory')
        # Remove from everything frees a seat
        await A.click('[data-everyone]'); await A.wait_for_timeout(3000)
        await A.click(f'.sheet-wrap.open [data-rmall="{KP}"]'); await A.wait_for_timeout(400)
        await A.click('.sheet-wrap.open:last-of-type button.danger, .sheet-wrap.open:last-of-type .btn.primary'); await A.wait_for_timeout(4000)
        check(KP not in G.FILES[group]['perms'], 'Remove takes KP off the group in Drive')
        v = await own_view(A)
        check(v['seats']['used'] == 3 and v['state'] == 'ok', f"back to 3 → ok ({v['seats']['used']}, {v['state']})")
        await close_sheets(A)

        # ================= 6. Restricted: the owner chooses who keeps access; others are blocked
        print('6. Restricted and keepers')
        G.FILES[group]['perms'][KP] = 'reader'  # shared again straight in Drive
        admin('PATCH', '/admin/apps/paran', {'graceDays': 0})
        await A.evaluate("import('./js/licensing.js').then(m => m.lic.tick(true))"); await A.wait_for_timeout(2500)
        v = await own_view(A)
        check(v['state'] == 'restricted', f'over the limit with no grace → restricted ({v["state"]})')
        await A.click('[data-everyone]'); await A.wait_for_timeout(3000)
        await A.click('.sheet-wrap.open [data-keepers]'); await A.wait_for_timeout(500)
        await A.locator('.sheet-wrap.open:last-of-type label.check', has_text=HELPER).locator('input').check(); await A.wait_for_timeout(300)
        await A.click('.sheet-wrap.open:last-of-type [data-save]'); await A.wait_for_timeout(1500)
        await R.evaluate("import('./js/licensing.js').then(m => m.lic.tick(true))"); await R.wait_for_timeout(2000); await R.goto(URL + '#/'); await R.wait_for_timeout(800)
        rb = T(await R.inner_text('#view'))
        check('over its free limit' in rb and 'Check again' in rb, 'Ravi (not kept) sees the blocked screen')
        check(bool(await R.query_selector('#licswitch')), 'with Switch inventory')
        h, H, herr, hsent = await phone(b, HELPER)
        G.PICKED.add((HELPER, mb))
        await H.evaluate(f"localStorage.setItem('paran.sheet.{HELPER}', '{mb}')"); await H.reload(); await H.wait_for_timeout(3000)
        if await H.query_selector('.sheet-wrap.open [data-yes]'): await H.click('.sheet-wrap.open [data-yes]'); await H.wait_for_timeout(300)
        await tap(H); await H.wait_for_timeout(2000)
        check(not await H.evaluate("import('./js/licensing.js').then(m => m.lic.blocked())"), 'Helper (kept) still opens Main building')
        await A.goto(URL + '#/'); await A.wait_for_timeout(500)
        check('over its free limit' not in T(await A.inner_text('#view')), 'the owner is never blocked')

        # ================= 7. Someone else claiming the owner's inventory changes nothing
        print('7. A stranger with a session changes nothing')
        G.PICKED.add((KP, mb))
        k, K, kerr, ksent = await phone(b, KP)
        await K.evaluate(f"localStorage.setItem('paran.sheet.{KP}', '{mb}')"); await K.reload(); await K.wait_for_timeout(2500)
        tok = await K.evaluate("fetch('%s/v1/auth', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Id': 'paran', 'X-Install-Id': crypto.randomUUID(), 'X-App-Version': 'x', 'X-Platform': 'other' }, body: JSON.stringify({ identityToken: 'test:%s' }) }).then((r) => r.json())" % (LIC, KP))
        check(bool(tok.get('token')), 'a stranger can get a session')
        admin('PATCH', '/admin/apps/paran', {'mode': 'observe', 'freeMembers': 5, 'graceDays': 14})
        await R.evaluate("import('./js/licensing.js').then(m => m.lic.tick(true))"); await R.wait_for_timeout(1500)
        check((await lic_state(R, f'inv.{mb}') or {}).get('licence') == mine, 'Main building still belongs to the owner\'s licence')

        # ================= 8. The in-browser stand-in (LICENSE_URL = stub), and pausing sharing when unchecked too long
        print('8. Stub mode; sharing pauses when the plan can\'t be checked')
        G.FILES.clear(); G.SHEETS.clear(); G.PICKED.clear()
        st_, S, serr, ssent = await phone(b, 'solo@example.com', url='stub')
        await S.click('#create'); await S.wait_for_timeout(300); await S.click('[data-empty]'); await S.wait_for_timeout(300)
        await S.fill('.sheet input', 'Home'); await S.click('.sheet button.primary'); await S.wait_for_timeout(3000)
        if await S.query_selector('.sheet-wrap.open [data-yes]'): await S.click('.sheet-wrap.open [data-yes]'); await S.wait_for_timeout(300)
        await close_sheets(S); await tap(S); await S.wait_for_timeout(1500)
        await S.goto(URL + '#/more/people'); await S.wait_for_timeout(800)
        await S.fill('#invite input[type=email]', 'friend@example.com'); await S.click('#invite button.primary'); await S.wait_for_timeout(2500)
        v = await own_view(S)
        check(v['has'] and v['seats']['used'] == 2 and not ssent, f'stub answers in the browser: 2 people, no network calls ({v["seats"]["used"]})')
        await S.goto(URL + '#/more/stats'); await S.wait_for_timeout(600)
        check(bool(await S.query_selector('.dbg [data-dbg="mode"]')), 'Your activity has the licensing test switches in stub mode')
        await S.select_option('[data-dbg="mode"]', 'enforce'); await S.wait_for_timeout(1500)
        paran_id = next(f['id'] for f in G.FILES.values() if f['app'].get('stash') == 'paran')
        check(G.FILES[paran_id]['app'].get('licMode') == 'enforce' and bool(G.FILES[paran_id]['app'].get('licOk')), 'the check date and mode are kept on the Paran folder in Drive')
        # nine days without a check (the server blocked): the phone's and Drive's dates both old
        await S.select_option('[data-dbg="down"]', 'down'); await S.wait_for_timeout(800)
        await S.evaluate(OLD_CHECK)
        import datetime; G.FILES[paran_id]['app']['licOk'] = (datetime.date.today() - datetime.timedelta(days=9)).isoformat()
        await S.goto(URL + '#/more/people'); await S.reload(); await S.wait_for_timeout(1500)
        bar = T(await S.inner_text('#licbar')) if await S.is_visible('#licbar') else ''
        check('hasn’t been able to check your plan' in bar and 'Check now' in bar, 'owner unchecked for 9 days (enforced): sharing paused, with Check now')
        await close_sheets(S)  # the notice, if it hadn't come up yet
        await S.fill('#invite input[type=email]', 'other@example.com'); await S.click('#invite button.primary'); await S.wait_for_timeout(800)
        check('Sharing is paused' in (T(await S.inner_text('.sheet-wrap.open')) if await S.query_selector('.sheet-wrap.open') else ''), 'and inviting says why')
        await close_sheets(S)
        await S.goto(URL + '#/more/stats'); await S.wait_for_timeout(600); await S.select_option('[data-dbg="down"]', ''); await S.wait_for_timeout(800)
        await S.goto(URL + '#/more/people'); await S.wait_for_timeout(600)
        if await S.is_visible('#licbar [data-lic-check]'): await S.click('#licbar [data-lic-check]'); await S.wait_for_timeout(2500)
        check(await S.is_hidden('#licbar') or 'hasn’t been able' not in T(await S.inner_text('#licbar')), 'Check now confirms who they are and turns sharing back on')

        # narrow phone: the banner, People and Everyone you share with stay within the screen
        await S.set_viewport_size({'width': 320, 'height': 700})
        await S.goto(URL + '#/more/stats'); await S.wait_for_timeout(500); await S.select_option('[data-dbg="force"]', 'grace'); await S.wait_for_timeout(1200)
        wide = []
        for at in ['#/', '#/more/people', '#/more/stats']:
            await S.goto(URL + at); await S.wait_for_timeout(700)
            if await S.evaluate('document.documentElement.scrollWidth > innerWidth + 1'): wide.append(at)
        await S.goto(URL + '#/more/people'); await S.wait_for_timeout(500); await S.click('[data-everyone]'); await S.wait_for_timeout(2500)
        if await S.evaluate("[...document.querySelectorAll('.sheet-wrap.open .sheet')].some((e) => e.scrollWidth > e.clientWidth + 1)"): wide.append('Everyone sheet')
        check(not wide and await S.is_visible('#licbar'), f'nothing wider than a 320px phone with the banner showing ({wide})')
        await close_sheets(S)

        for name, e in (('owner', aerr), ('ravi', rerr), ('helper', herr), ('kp', kerr), ('stub', serr)):
            check(not e, f'no page errors on {name}: {e[:2]}')
        await b.close()
    print('\n' + ('ALL PASSED' if not FAILS else f'{len(FAILS)} FAILED:\n  ' + '\n  '.join(FAILS)))
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
