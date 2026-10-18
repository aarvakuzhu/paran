# Moving items between the inventories of a group (strict fake Google): the school's Main building → its Storage unit.
# One item from its page, two with Select; the copy there keeps details and history; it's removed here with a History
# line; a group event's line follows it; and a move into an inventory you can only view is refused with nothing changed.
import asyncio, sys, json, re, os
SP = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, SP)
src = open(os.path.join(SP, 'access_e2e.py')).read()
exec(src.split('\nasync def main():')[0].replace("import os; SP = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, SP)", ""))
G.FILES.clear(); G.SHEETS.clear(); G.PICKED.clear()

def add_row(sid, tab, **vals):
    cols = G.SHEETS[sid][tab][0]; d = {c: '' for c in cols}; d.update(vals); G.SHEETS[sid][tab].append([d[c] for c in cols])

async def move_dialog(pg, inv_id, place):
    await pg.click(f'.sheet [data-oinv="{inv_id}"] >> nth=0'); await pg.wait_for_timeout(1500)
    await pg.click(f'.sheet [data-opick]:has-text("{place}")'); await pg.wait_for_timeout(400)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        a, A, errs = await phone(b, OWNER)
        await A.click('#create'); await A.wait_for_timeout(300); await A.click('[data-tpl="group"]'); await A.wait_for_timeout(300)
        await A.fill('[data-gname]', 'Tamil School'); await A.click('[data-create]'); await A.wait_for_timeout(9000)
        sheet = lambda n: next(f['id'] for f in G.FILES.values() if f['name'] == n and f['mime'] == G.SHEET)
        mb, su = sheet('Main building'), sheet('Storage unit')
        d = next(f['id'] for f in G.FILES.values() if f['app'].get('stash') == 'directory')
        loc = lambda sid, n: next(r['id'] for r in G.rows(sid, 'Locations') if r['name'] == n)
        av = loc(mb, 'AV cabinet')
        for i, n in (('i1', 'Projector'), ('i2', 'Banner stand'), ('i3', 'Mic stand'), ('i4', 'Extension cord')):
            add_row(mb, 'Items', id=i, name=n, qty=1, status='home', locationId=av, addedBy=OWNER, addedAt='2026-09-01T10:00:00Z', price='300' if i == 'i1' else '', thumb='')
            add_row(mb, 'Log', ts='2026-09-01T10:00:00Z', itemId=i, action='added', detail='Hall or stage › AV cabinet', by=OWNER)
        add_row(mb, 'Items', id='i5', name='Speaker', qty=1, status='lent', lentTo='Ravi', locationId=av, addedBy=OWNER)
        add_row(d, 'Events', id='e1', name='Graduation', date='2027-05-17', updatedAt='2026-10-01T00:00:00Z')
        add_row(d, 'EventLines', id='l1', eventId='e1', section='AV', itemId='i1', invId=mb, name='Projector', qty=1, sort=1)
        # open Main building and let it read everything; Storage unit's copy arrives when picked
        here = json.loads(await A.evaluate("localStorage.getItem('paran.session')"))['sheetId']
        if here != mb:
            await A.evaluate(f"(() => {{ const s = JSON.parse(localStorage.getItem('paran.session')); s.sheetId = '{mb}'; s.sheetName = 'Main building'; localStorage.setItem('paran.session', JSON.stringify(s)); localStorage.setItem('paran.sheet.{OWNER}', '{mb}'); }})()")
        await A.goto('http://localhost:8080/#/item/i1'); await A.reload(); await A.wait_for_timeout(3500)
        check('Projector' in T(await A.inner_text('body')), 'item page open in Main building')

        print('1. Move one item from its page')
        await A.click('[data-a="move"]'); await A.wait_for_timeout(500)
        t = await sheet_text(A)
        check('other inventories in tamil school' in t.lower() and 'Storage unit' in t, 'Move offers the group’s other inventories')
        await A.screenshot(path=f'{SP}/mv1-picker.png')
        await move_dialog(A, su, 'Shelf 1')
        t = await sheet_text(A); check('Move Projector to Storage unit?' in t and 'history' in t, f'asks first, says what comes along ({t[:120]})')
        await A.click('.sheet [data-yes]'); await A.wait_for_timeout(3000)
        there = [r for r in G.rows(su, 'Items') if r['id'] == 'i1']
        check(there and there[0]['locationId'] == loc(su, 'Shelf 1') and not there[0]['deleted'] and there[0]['price'] == '300', 'it’s in Storage unit › Shelf 1 with its details')
        here_row = next(r for r in G.rows(mb, 'Items') if r['id'] == 'i1')
        check(bool(here_row['deleted']), 'and removed from Main building')
        su_log = [r for r in G.rows(su, 'Log') if r['itemId'] == 'i1']
        check([r['action'] for r in su_log] == ['added', 'moved'] and 'from Main building › Hall or stage › AV cabinet' in su_log[-1]['info'], f'history came along, plus the move ({[(r["action"], r["info"]) for r in su_log]})')
        mb_log = [r for r in G.rows(mb, 'Log') if r['itemId'] == 'i1' and r['action'] == 'moved']
        check(mb_log and mb_log[-1]['detail'] == 'Storage unit › Shelves › Shelf 1', f'Main building’s History says where it went ({mb_log[-1]["detail"] if mb_log else None})')
        line = next(r for r in G.rows(d, 'EventLines') if r['id'] == 'l1')
        check(line['invId'] == su, 'the Graduation line now looks in Storage unit')
        check('#/item/i1' not in A.url, 'left the item page (it isn’t here any more)')

        print('2. Move two with Select, one of them lent')
        await A.goto(f'http://localhost:8080/#/place/{av}'); await A.wait_for_timeout(1500)
        await A.click('[data-select-toggle] >> nth=0'); await A.wait_for_timeout(300)
        for n in ('Banner stand', 'Speaker'): await A.click(f'.card:has-text("{n}")'); await A.wait_for_timeout(150)
        await A.click('[data-s="move"]'); await A.wait_for_timeout(500)
        await move_dialog(A, su, 'Bins on the floor')
        await A.click('.sheet [data-yes]'); await A.wait_for_timeout(3500)
        rows = {r['id']: r for r in G.rows(su, 'Items')}
        check('i2' in rows and 'i5' in rows and rows['i5']['status'] == 'lent' and rows['i5']['lentTo'] == 'Ravi', 'both moved; the lent one is still with Ravi')
        check(all(next(r for r in G.rows(mb, 'Items') if r['id'] == i)['deleted'] for i in ('i2', 'i5')), 'both removed from Main building')
        toast = T(await A.inner_text('#toasts'))
        check('Open Storage unit' in toast, f'toast offers to open Storage unit ({toast})')

        print('3. Open Storage unit: the items are there with their history')
        await A.click('#toasts button'); await A.wait_for_timeout(4000)
        body = T(await A.inner_text('body'))
        check('Banner stand' in body or 'Speaker' in body or 'Projector' in body, 'Storage unit shows the moved items')
        await A.goto('http://localhost:8080/#/item/i1'); await A.wait_for_timeout(1500)
        body = T(await A.inner_text('body'))
        check('Projector' in body and 'Moved to Storage unit' in body, 'Projector’s page there shows the move in History')
        await A.screenshot(path=f'{SP}/mv2-there.png', full_page=True)

        print('4. Into an inventory you can only view: refused, nothing changes')
        # Storage unit now belongs to someone else, who lets the owner only view it
        G.FILES[su]['owner'] = 'kp@example.com'; G.FILES[su]['parents'] = ['root:kp@example.com']; G.FILES[su]['perms'][OWNER] = 'reader'
        await A.evaluate(f"(() => {{ const s = JSON.parse(localStorage.getItem('paran.session')); s.sheetId = '{mb}'; s.sheetName = 'Main building'; localStorage.setItem('paran.session', JSON.stringify(s)); localStorage.setItem('paran.sheet.{OWNER}', '{mb}'); }})()")
        await A.goto('http://localhost:8080/#/item/i3'); await A.reload(); await A.wait_for_timeout(3000)
        await A.click('[data-a="move"]'); await A.wait_for_timeout(500)
        await move_dialog(A, su, 'Shelf 1')
        await A.click('.sheet [data-yes]'); await A.wait_for_timeout(2000)
        toast = T(await A.inner_text('#toasts'))
        check('view Storage unit, but not change it' in toast, f'says why ({toast})')
        check(not next(r for r in G.rows(mb, 'Items') if r['id'] == 'i3')['deleted'] and not any(r['id'] == 'i3' for r in G.rows(su, 'Items')), 'Mic stand stays in Main building')

        print('errors', errs, [x for x in G.LOG if x[3] >= 400][:5])
        check(not errs, 'no page errors')
        await b.close()
    print('\nFAILURES:', FAILS or 'none'); sys.exit(1 if FAILS else 0)
asyncio.run(main())
