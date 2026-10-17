# End to end with four accounts and access enforced by the stricter fake (fake2):
# owner (Ashok), a helper with School only, a group editor (Ravi), a group viewer (Priya).
import asyncio, sys, json, re
import os; SP = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, SP)
import fake_google as G
from playwright.async_api import async_playwright
T = lambda s: re.sub(r'\s+', ' ', s).strip()
OWNER, HELPER, RAVI, PRIYA = 'ashok@example.com', 'helper@example.com', 'ravi@example.com', 'priya@example.com'
FAILS = []
def check(cond, what):
    print(('  ok   ' if cond else '  FAIL ') + what)
    if not cond: FAILS.append(what)

PICKER_STUB = """
window.gapi = { load: (n, cb) => cb() };
window.google = window.google || {};
google.picker = { ViewId: { SPREADSHEETS: 1 }, DocsViewMode: { LIST: 1 }, Action: { PICKED: 'picked', CANCEL: 'cancel' }, Feature: { MULTISELECT_ENABLED: 1 },
  DocsView: class { setMode() { return this } setParent() { return this } setOwnedByMe() { return this } },
  PickerBuilder: class { addView() { return this } enableFeature() { return this } setOAuthToken() { return this } setDeveloperKey() { return this }
    setAppId() { return this } setTitle() { return this } setCallback(cb) { this.cb = cb; return this }
    build() { const cb = this.cb; return { setVisible() { const ids = window.__pick || [];
      fetch('https://www.googleapis.com/__pick', { method: 'POST', headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('paran.token')).access_token }, body: JSON.stringify(ids) })
        .then(() => cb({ action: 'picked', docs: ids.map((id) => ({ id })) })); } }; } } };
"""

async def phone(b, email):
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, service_workers='block')
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    async def gapi(route):
        req = route.request
        who = (req.headers.get('authorization') or '').replace('Bearer tok:', '')
        try: r = G.handle(who, req.method, req.url, req.post_data)
        except Exception as ex: r = ('ERR', 500, repr(ex))
        if isinstance(r, tuple): await route.fulfill(status=r[1], content_type='application/json', body=json.dumps({'error': {'code': r[1], 'message': r[2]}}))
        else: await route.fulfill(status=200, content_type='application/json', body=json.dumps(r))
    await ctx.route('https://*.googleapis.com/**', gapi)
    await ctx.route('https://apis.google.com/js/api.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=PICKER_STUB))
    await ctx.route('https://accounts.google.com/**', lambda r: r.fulfill(status=200, content_type='text/javascript', body=''))
    await pg.goto('http://localhost:8080/')
    await pg.evaluate("""e => { localStorage.clear(); localStorage.setItem('paran.mode', 'google'); localStorage.setItem('paran.migrated', '1');
      localStorage.setItem('paran.token', JSON.stringify({ access_token: 'tok:' + e, expires_at: 9999999999999 })); }""", email)
    await pg.reload(); await pg.wait_for_timeout(2000)
    return ctx, pg, errs

async def sheet_text(pg): return T(await pg.inner_text('.sheet-wrap.open .sheet')) if await pg.query_selector('.sheet-wrap.open') else ''

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # ================= 1. Owner starts fresh
        print('1. Owner creates an inventory')
        a, A, aerr = await phone(b, OWNER)
        check('Start a new inventory' in T(await A.inner_text('body')), 'first run offers Start a new inventory')
        await A.click('#create'); await A.wait_for_timeout(300); await A.click('[data-empty]'); await A.wait_for_timeout(300)
        await A.fill('.sheet input', 'School'); await A.click('.sheet button.primary'); await A.wait_for_timeout(3000)
        S = G.find('School') if any(f['name'] == 'School' and f['mime'] == G.SHEET for f in G.FILES.values()) else None
        S = next(f['id'] for f in G.FILES.values() if f['name'] == 'School' and f['mime'] == G.SHEET)
        print(G.tree(OWNER))
        paran = next(f for f in G.FILES.values() if f['app'].get('stash') == 'paran')
        sfolder = G.FILES[S]['parents'][0]
        check(paran['parents'] == [G.myroot(OWNER)] and paran['name'] == 'Paran', 'Paran folder at the top of My Drive')
        check(G.FILES[sfolder]['parents'] == [paran['id']], 'School folder inside Paran')
        # some items (as if added in the app)
        I = G.SHEETS[S]['Items']; cols = I[0]
        def item(i, n, qty=1):
            d = {c: '' for c in cols}; d.update(id=i, name=n, qty=qty, status='home', locationId='L1', addedBy=OWNER); return [d[c] for c in cols]
        I += [item('i1', 'Podium'), item('i2', 'Tablecloth', 15)]
        G.SHEETS[S]['Locations'] += [['L1', 'Stage closet', '', 'room', '', OWNER, '', '']]
        await A.goto('http://localhost:8080/#/more/data'); await A.reload(); await A.wait_for_timeout(2000)
        check(len(await A.query_selector_all('.more a[target]')) == 2, 'owner of a loose inventory sees its sheet + Paran folder in Your data')

        # ================= 2. Owner shares School only with Helper
        print('2. Owner invites Helper to School only')
        await A.goto('http://localhost:8080/#/more/people'); await A.wait_for_timeout(800)
        await A.fill('#invite input[type=email]', HELPER); await A.click('#invite button'); await A.wait_for_timeout(1500)
        check(G.FILES[S]['perms'].get(HELPER) == 'writer', 'Helper can edit the School sheet')
        check(any(r['email'] == HELPER for r in G.rows(S, 'Members')), 'Helper listed in Members')

        # ================= 3. Owner starts an event -> group first
        print('3. New event on a loose inventory')
        await A.goto('http://localhost:8080/#/events'); await A.wait_for_timeout(800)
        await A.click('[data-ev="new"]'); await A.wait_for_timeout(400)
        check('Events need a group' in await sheet_text(A), 'explains a group will be created')
        await A.fill('.sheet input[name=name]', 'Tamil School'); await A.click('.sheet button.primary'); await A.wait_for_timeout(3500)
        t = await sheet_text(A)
        check('Give them all of Tamil School' in t and HELPER in t, 'offers to give School’s people the whole group')
        await A.click('.sheet-wrap.open [data-no]'); await A.wait_for_timeout(800)  # keep Helper at School only
        await A.fill('.sheet input[name=name]', 'Graduation'); await A.click('.sheet button.primary'); await A.wait_for_timeout(2500)
        gfolder = next(f for f in G.FILES.values() if f['app'].get('stash') == 'group')
        D = next(f['id'] for f in G.FILES.values() if f['app'].get('stash') == 'directory')
        print(G.tree(OWNER))
        check(gfolder['parents'] == [paran['id']], 'group folder inside Paran')
        check(G.FILES[sfolder]['parents'] == [gfolder['id']], 'School folder moved into the group')
        check(G.FILES[S]['app'].get('groupName') == 'Tamil School', 'School sheet labelled with the group')
        check([r['name'] for r in G.rows(D, 'Events')] == ['Graduation'], 'event saved in the group directory')
        check(not G.rows(S, 'Events'), 'nothing written to School’s own Events tab')
        check(HELPER not in gfolder['perms'], 'Helper NOT given the group')
        ev = G.rows(D, 'Events')[0]['id']

        # ================= 4. Owner invites Ravi (edit) and Priya (view) to the whole group
        print('4. Group invites')
        await A.goto(f"http://localhost:8080/#/group/{gfolder['id']}"); await A.wait_for_timeout(1500)
        await A.fill('#ginvite input[type=email]', RAVI); await A.click('#ginvite button'); await A.wait_for_timeout(1500)
        await A.fill('#ginvite input[type=email]', PRIYA); await A.select_option('#ginvite select', 'reader'); await A.click('#ginvite button'); await A.wait_for_timeout(1500)
        check(gfolder['perms'].get(RAVI) == 'writer' and gfolder['perms'].get(PRIYA) == 'reader', 'group folder shared: Ravi edit, Priya view')
        check(G.FILES[S]['perms'].get(RAVI) is None, 'Ravi reaches School through the group, not a direct share')

        # ================= 5. Owner plans the event and assigns people
        print('5. Lines and assignments')
        await A.goto(f'http://localhost:8080/#/event/{ev}'); await A.wait_for_timeout(1200)
        await A.click('[data-ev="add"]'); await A.wait_for_timeout(600)
        await A.fill('.sheet [data-q]', 'podium'); await A.wait_for_timeout(300)
        await A.click('.sheet .bring-row input[type=checkbox]')
        await A.fill('.sheet [data-q]', 'Certificates'); await A.press('.sheet [data-q]', 'Enter'); await A.wait_for_timeout(300)
        await A.click('.sheet [data-done]'); await A.wait_for_timeout(2500)
        lines = G.rows(D, 'EventLines')
        check(sorted(l['name'] for l in lines) == ['Certificates', 'Podium'], 'two lines in the directory')
        await A.click('[data-mode="plan"]') if await A.query_selector('[data-mode="plan"]') else None
        await A.click('.eline:has-text("Certificates")'); await A.wait_for_timeout(500)
        quick = T(await A.inner_text('.sheet .who-quick'))
        check(HELPER.split('@')[0].title() in quick or HELPER in quick, f'Helper offered as a person with access ({quick[:80]})')
        await A.fill('.sheet [data-need]', '40'); await A.press('.sheet [data-need]', 'Tab'); await A.wait_for_timeout(400)
        await A.fill('.sheet .who-form [name=wq]', '5'); await A.click(f'.sheet [data-email="{HELPER}"]'); await A.wait_for_timeout(300)
        await A.click(f'.sheet [data-email="{RAVI}"]') if await A.query_selector(f'.sheet [data-email="{RAVI}"]') else print('  (Ravi not in quick-picks yet)')
        await A.wait_for_timeout(300)
        await A.click('.sheet-wrap.open [data-close]'); await A.wait_for_timeout(3000)
        tasks = [r for r in G.rows(S, 'Tasks') if r.get('deleted') in ('', None, False)]
        check(len(tasks) == 1 and tasks[0]['email'] == HELPER and str(tasks[0]['qty']) == '5', f'one task in School for Helper ×5 ({[(t["email"], t["qty"]) for t in tasks]})')
        check(not any(r['email'] == RAVI for r in G.rows(S, 'Tasks')), 'no task row for Ravi (he has the group)')
        await a.close()

        # ================= 6. Helper joins School only
        print('6. Helper (School only)')
        h, H, herr = await phone(b, HELPER)
        await H.evaluate(f"window.__pick = ['{S}']")
        await H.click('#join'); await H.wait_for_timeout(3500)
        home = T(await H.inner_text('body'))
        check('School' in home, 'Helper opened School')
        check('Certificates' in home and 'Mark done' in home, 'Helper sees the task on home with Mark done')
        await H.goto('http://localhost:8080/#/events'); await H.wait_for_timeout(1500)
        evp = T(await H.inner_text('.events'))
        check('run by the group' in evp and 'Tamil School' in evp, 'Events page says the group runs them')
        check(not await H.query_selector('[data-ev="new"]'), 'no New event for Helper')
        await H.goto(f'http://localhost:8080/#/event/{ev}'); await H.wait_for_timeout(1000)
        check('not found' in T(await H.inner_text('body')).lower(), 'Helper cannot open the event')
        check(not any(e == HELPER and D in p for e, m_, p, s in G.LOG if s == 200), 'Helper’s app never read the directory')
        await H.goto('http://localhost:8080/#/more/data'); await H.wait_for_timeout(800)
        check(not await H.query_selector('.more a[target]'), 'Helper gets no sheet links in Your data')
        await H.goto('http://localhost:8080/#/'); await H.wait_for_timeout(1200)
        await H.click('[data-taskdone]'); await H.wait_for_timeout(2500)
        check(any(str(r.get('done') or '') not in ('', 'False', 'FALSE') for r in G.rows(S, 'Tasks')), 'Mark done written to the Tasks tab')
        await h.close()

        # ================= 7. Ravi joins the group
        print('7. Ravi (group, can edit)')
        r_, R, rerr = await phone(b, RAVI)
        await R.evaluate(f"window.__pick = ['{D}']")
        await R.click('#join'); await R.wait_for_timeout(2500)
        # the app then asks to tick the group's inventories inside its folder
        await R.evaluate(f"window.__pick = ['{S}']")
        if await R.query_selector('.sheet-wrap.open button.primary'):
            print('  prompt:', (await sheet_text(R))[:140]); await R.click('.sheet-wrap.open button.primary'); await R.wait_for_timeout(3000)
        await R.goto('http://localhost:8080/#/events'); await R.wait_for_timeout(1500)
        evp = T(await R.inner_text('.events'))
        check('Graduation' in evp, 'Ravi sees the group’s event')
        check(bool(await R.query_selector('[data-ev="new"]')), 'Ravi can start events')
        await R.goto(f'http://localhost:8080/#/event/{ev}'); await R.wait_for_timeout(1500)
        await R.click('[data-mode="plan"]') if await R.query_selector('[data-mode="plan"]') else None
        page = T(await R.inner_text('body'))
        check('Podium' in page and 'Certificates' in page, 'Ravi sees all lines')
        await R.click('.eline:has-text("Certificates")'); await R.wait_for_timeout(600)
        check('✓ done' in await sheet_text(R), 'Ravi sees Helper’s ✓ done in the line')
        await R.click('.sheet-wrap.open [data-close]'); await R.wait_for_timeout(300)
        await R.goto('http://localhost:8080/#/more/data'); await R.wait_for_timeout(800)
        check(not await R.query_selector('.more a[target]'), 'Ravi (not an owner) gets no sheet links')
        await r_.close()

        # ================= 8. Priya joins the group as viewer
        print('8. Priya (group, view only)')
        q_, Q, qerr = await phone(b, PRIYA)
        await Q.evaluate(f"window.__pick = ['{D}']")
        await Q.click('#join'); await Q.wait_for_timeout(2500)
        await Q.evaluate(f"window.__pick = ['{S}']")
        if await Q.query_selector('.sheet-wrap.open button.primary'):
            await Q.click('.sheet-wrap.open button.primary'); await Q.wait_for_timeout(3000)
        await Q.goto('http://localhost:8080/#/events'); await Q.wait_for_timeout(1500)
        check('Graduation' in T(await Q.inner_text('.events')), 'Priya sees the event')
        check(not await Q.query_selector('[data-ev="new"]'), 'Priya has no New event')
        await Q.goto(f'http://localhost:8080/#/event/{ev}'); await Q.wait_for_timeout(1200)
        check(not await Q.query_selector('[data-ev="add"]'), 'Priya cannot add lines')
        denied = [x for x in G.LOG if x[0] == PRIYA and x[3] == 403]
        check(not denied, f'Priya’s app attempted no writes ({denied[:2]})')
        await q_.close()

        # ================= 9. Owner again: Your data, Drive tree
        print('9. Owner after everything')
        a, A, aerr2 = await phone(b, OWNER)
        await A.goto('http://localhost:8080/#/events'); await A.wait_for_timeout(1500)
        evp = T(await A.inner_text('.events'))
        check('Graduation' in evp and 'run by the group' not in evp, f'owner on a new phone sees the group’s events ({evp[:90]})')
        await A.goto('http://localhost:8080/#/more/data'); await A.wait_for_timeout(1500)
        check(len(await A.query_selector_all('.more a[target]')) == 3, 'owner sees School sheet, directory, Paran folder')
        print(G.tree(OWNER))
        others = {e: G.tree(e) for e in (HELPER, RAVI, PRIYA)}
        for e, t in others.items(): print(e, '->', t.replace('\n', ' | '))
        check(not any(f['owner'] == PRIYA for f in G.FILES.values()), 'nothing created in the viewer’s Drive')
        all_errs = aerr + herr + rerr + qerr + aerr2
        check(not all_errs, f'no page errors ({all_errs[:3]})')
        bad = [x for x in G.LOG if x[3] >= 400]
        print('Google errors seen:', bad)
        for f in G.FILES.values(): print('   FILE', f['id'], f['name'], f['parents'], f['owner'].split('@')[0], f['app'])
        print('   TASKS', G.rows(S, 'Tasks'))
        print('   HELPER LOG', [x for x in G.LOG if x[0]==HELPER and x[1]!='GET'])
        await a.close(); await b.close()
    print('\nFAILURES:', FAILS if FAILS else 'none')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
