# Event from words + receipts, with a stand-in Gemini that answers in the real API's shape.
import asyncio, sys, json, re
import os; SP = os.path.dirname(os.path.abspath(__file__))
from playwright.async_api import async_playwright
T = lambda s: re.sub(r'\s+', ' ', s).strip()
FAILS = []; PROMPTS = []; DROP = []
def check(c, w):
    print(('  ok   ' if c else '  FAIL ') + w)
    if not c: FAILS.append(w)

def section(prompt, head):
    m = re.search(head + r':\n(.*?)(\n\n|$)', prompt, re.S)
    return [l[2:].strip() for l in (m.group(1).splitlines() if m else []) if l.startswith('- ')]

def gemini(body):
    req = json.loads(body); prompt = req['contents'][0]['parts'][0]['text']; PROMPTS.append(prompt)
    if 'Identify the distinct physical items in this photo' in prompt:
        out = {'items': [{'name': 'Stud finder', 'purpose': 'Finding studs behind walls', 'category': 'Tools', 'tags': ['stud', 'wall'], 'qty': 1}]}
    elif "ORGANIZER'S TEXT" in prompt:
        inv = [re.sub(r' \(×\d+\)$', '', x) for x in section(prompt, 'INVENTORY \\(what the group already has\\)')]
        pick = lambda word: [n for n in inv if word.lower() in n.lower()][:2]
        out = {'name': 'Graduation 2027', 'date': '2027-05-17', 'notes': 'Gym, 200 people', 'lines': [
            {'section': 'Stage', 'name': 'Podium', 'qty': 1, 'matches': []},
            {'section': 'Stage', 'name': 'Microphones', 'qty': 2, 'matches': []},
            {'section': 'Seating', 'name': 'Folding tables', 'qty': 20, 'guessed': True, 'matches': pick('Folding')},
            {'section': 'Decor', 'name': 'Table covers', 'qty': 40, 'matches': pick('Tablecloth')},
            {'section': 'Ceremony', 'name': 'Certificates', 'qty': 35, 'note': 'gold paper', 'matches': ['Made-up name not in list']},
        ]}
    else:
        need = section(prompt, 'NEEDED \\(id: name, event\\)')
        lid = next((x.split(':')[0] for x in need if 'Certificates' in x), '')
        inv = section(prompt, 'INVENTORY')
        tc = next((n for n in inv if 'Tablecloth' in n), '')
        out = {'store': 'Party City', 'date': '2026-10-12', 'currency': 'USD', 'total': 156.70, 'subtotal': 146.45, 'tax': 10.25, 'items': [
            {'name': 'Certificate paper, gold', 'qty': 1, 'price': 12.99, 'category': 'Stationery', 'purpose': 'Printing certificates', 'tags': ['certificate', 'paper'], 'line': lid},
            {'name': 'Folding table, 6 ft', 'brand': 'Lifetime', 'qty': 2, 'price': 99.98, 'warrantyMonths': 12, 'category': 'Furniture'},
            {'name': 'White tablecloths', 'qty': 10, 'price': 24.99, 'match': tc},
            {'name': 'Paper plates', 'qty': 100, 'price': 8.49, 'consumable': True},
        ]}
        out['items'] = [i for i in out['items'] if i['name'] not in DROP]
    return {'candidates': [{'content': {'parts': [{'text': json.dumps(out)}]}, 'finishReason': 'STOP'}]}

def make_receipt():
    path = f'{SP}/receipt.jpg'
    if os.path.exists(path): return
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (600, 1100), 'white'); d = ImageDraw.Draw(im); y = 30
    for t in ['PARTY CITY #142', '10/12/2026', '', 'CERT PAPER GOLD 50CT   12.99', 'FOLD TBL 6FT 2 @ 49.99   99.98', 'TBLCLTH WHT 10PK  24.99', 'PAPER PLATES 100CT  8.49', '', 'TOTAL 156.70', 'VISA ****4421']:
        d.text((30, y), t, fill='black'); y += 40
    im.save(path)

async def main():
    make_receipt()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, service_workers='block')
        pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def g(route):
            if route.request.method == 'POST': await route.fulfill(status=200, content_type='application/json', body=json.dumps(gemini(route.request.post_data)))
            else: await route.fulfill(status=200, content_type='application/json', body='{"name":"m"}')
        await ctx.route('https://generativelanguage.googleapis.com/**', g)
        await pg.goto('http://localhost:8080/')
        await pg.evaluate("""() => { localStorage.clear(); localStorage.setItem('paran.mode', 'demo');
          localStorage.setItem('paran.ai', JSON.stringify({ enabled: true, key: 'AIzaSyD' + 'x'.repeat(32), model: 'gemini-3.5-flash-lite' })); }""")
        await pg.reload(); await pg.wait_for_timeout(1500)
        cache = lambda: pg.evaluate("JSON.parse(localStorage.getItem('paran.cache.demo'))")

        print('1. New event from words (no name typed)')
        await pg.goto('http://localhost:8080/#/events'); await pg.wait_for_timeout(500)
        await pg.click('[data-ev="new"]'); await pg.wait_for_timeout(400)
        await pg.screenshot(path=f'{SP}/w1-form.png')
        await pg.fill('.sheet textarea[name=words]', 'Graduation for 200 in the gym. Stage: podium and 2 mics. Tables, table covers, certificates for 35 students on gold paper.')
        await pg.click('.sheet button.primary'); await pg.wait_for_timeout(5500)
        rv = T(await pg.inner_text('.sheet-wrap.open .sheet')) if await pg.query_selector('.plan-review') else ''
        print('  review:', rv[:260])
        await pg.screenshot(path=f'{SP}/w2-review.png', full_page=True)
        check('5 things' in rv, 'five lines drafted')
        picks = await pg.eval_on_selector_all('.pr-pick', 'ss => ss.map(s => s.value)')
        check(picks == ['', '', '', 'Tablecloths (white)', ''], f'only “Table covers” matched (to Tablecloths); nothing invented ({picks})')
        check('estimated' in rv, 'estimated count flagged')
        inv_prompt = PROMPTS[-1]
        check('INVENTORY' in inv_prompt and 'Tablecloths' in inv_prompt, 'inventory names sent with the text (no photos)')
        # untick Microphones, add the rest
        await pg.click('.pr-row:has(input[value="Microphones"]) input[type=checkbox]'); await pg.wait_for_timeout(200)
        await pg.click('[data-addall]'); await pg.wait_for_timeout(800)
        c = await cache()
        ev = next(e for e in c['events'] if e['name'] == 'Graduation 2027')
        lines = [l for l in c['eventLines'] if l['eventId'] == ev['id'] and not l.get('deleted')]
        names = sorted(l['name'] for l in lines)
        check(names == ['Certificates', 'Folding tables', 'Podium', 'Table covers'], f'lines added ({names})')
        check(ev['date'] == '2027-05-17' and ev['notes'] == 'Gym, 200 people', 'name, date and notes filled from the text')
        tc = next(l for l in lines if l['name'] == 'Table covers')
        check(bool(tc['itemId']), 'Table covers line points at the Tablecloths item')
        cert = next(l for l in lines if l['name'] == 'Certificates')
        check(not cert['itemId'] and cert['note'] == 'gold paper', 'invented match ignored; note kept')
        await pg.wait_for_timeout(500)
        page = T(await pg.inner_text('#view, main, body'))
        await pg.screenshot(path=f'{SP}/w3-event.png', full_page=True)

        print('2. Receipt from the event page')
        btn = await pg.query_selector('[data-ev="receipt"]')
        check(bool(btn), 'event page offers “Bought some? Scan the receipt”')
        await btn.click(); await pg.wait_for_timeout(400)
        await pg.screenshot(path=f'{SP}/r1-pick.png')
        await pg.set_input_files('.rc-pick input[type=file] >> nth=1', f'{SP}/receipt.jpg'); await pg.wait_for_timeout(5500)
        rv = T(await pg.inner_text('.sheet-wrap.open .sheet')) if await pg.query_selector('.rc-review') else ''
        print('  review:', rv[:300])
        await pg.screenshot(path=f'{SP}/r2-review.png', full_page=True)
        check('Party City' in rv and '$156.70' in rv, 'store and total shown')
        check('Adds up to the receipt’s subtotal ($146.45)' in rv, 'total check passes when every line was read')
        lsel = await pg.eval_on_selector_all('.rc-review select[data-line]', 'ss => ss.map(s => s.options[s.selectedIndex].text)')
        check(lsel and 'Certificates' in lsel[0], f'certificate paper matched to the Certificates line ({lsel[:1]})')
        ons = await pg.eval_on_selector_all('.rc-review [data-on]', 'cs => cs.map(c => c.checked)')
        check(ons == [True, True, True, False], f'plates (used up, not for an event) start unticked ({ons})')
        modes = await pg.eval_on_selector_all('.rc-review select[data-mode]', 'ss => ss.map(s => s.value)')
        opts = await pg.eval_on_selector_all('.rc-review select[data-mode] option', 'os => os.map(o => o.text)')
        print('  options:', opts)
        check(len(modes) == 1 and modes[0].startswith('more:') and sum('Add 10' in o for o in opts) == 2, f'both tablecloth items offered, named by place')
        before_tc = next(i for i in c['items'] if i['id'] == modes[0].split(':')[1])
        await pg.fill('.rc-review input[data-name="1"]', 'Folding table, 6 ft, Lifetime'); await pg.press('.rc-review input[data-name="1"]', 'Tab')
        await pg.click('[data-save]'); await pg.wait_for_timeout(1500)
        c = await cache()
        new = [i for i in c['items'] if i.get('store') == 'Party City']
        print('  saved:', [(i['name'], i['qty'], i.get('price'), i.get('boughtAt'), i.get('warranty'), (i.get('receipt') or '')[:6]) for i in new])
        check(len(new) == 3, 'three items carry the purchase')
        tbl = next(i for i in new if 'Folding table, 6 ft, Lifetime' == i['name'])
        check(tbl['price'] == '99.98 USD' and tbl['boughtAt'] == '2026-10-12' and tbl['warranty'] == '2027-10-12' and 'Lifetime' in tbl['notes'], 'price, date, warranty and brand captured')
        tcn = next(i for i in new if i['id'] == before_tc['id'])
        check(int(tcn['qty']) == int(before_tc['qty']) + 10, f"existing tablecloths +10 ({before_tc['qty']} → {tcn['qty']})")
        check(all(i.get('receipt') for i in new) and len({i['receipt'] for i in new}) == 1, 'all share one receipt photo')
        cert = next(l for l in c['eventLines'] if l['id'] == cert['id'])
        check(bool(cert['itemId']), 'Certificates line now uses the new item')
        check(not any('4421' in json.dumps(i) for i in c['items']), 'no card digits stored')

        print('3. Item page shows the purchase and the receipt')
        await pg.goto(f"http://localhost:8080/#/item/{tbl['id']}"); await pg.wait_for_timeout(800)
        facts = T(await pg.inner_text('.facts'))
        check('Party City' in facts and '$99.98' in facts, f'Bought line on the item ({facts[:120]})')
        await pg.click('[data-a="receipt"]'); await pg.wait_for_timeout(800)
        check(bool(await pg.query_selector('.receipt-img[src^="blob:"]')), 'receipt photo opens')
        await pg.screenshot(path=f'{SP}/r3-item.png', full_page=True)
        await pg.click('.sheet-wrap.open [data-close]'); await pg.wait_for_timeout(400)

        print('4. From Add')
        await pg.goto('http://localhost:8080/#/add'); await pg.wait_for_timeout(600)
        check(bool(await pg.query_selector('[data-receipt]')), 'Add screen offers the receipt')
        await pg.screenshot(path=f'{SP}/r4-add.png')
        DROP.append('White tablecloths')  # the model missed a line
        await pg.click('[data-receipt]'); await pg.wait_for_timeout(400)
        await pg.set_input_files('.rc-pick input[type=file] >> nth=1', f'{SP}/receipt.jpg'); await pg.wait_for_timeout(5500)
        warn = T(await pg.inner_text('.rc-check.warn')) if await pg.query_selector('.rc-check.warn') else ''
        print('  warning:', warn)
        check('add up to $121.46' in warn and '$24.99 short' in warn, 'missing line flagged with the gap')
        await pg.screenshot(path=f'{SP}/r5-warn.png')
        await pg.click('.sheet-wrap.open [data-close]'); await pg.wait_for_timeout(400)

        print('5. A photo on Add; the name is changed before saving')
        await pg.goto('http://localhost:8080/#/add'); await pg.wait_for_timeout(600)
        await pg.set_input_files('#photo', f'{SP}/receipt.jpg'); await pg.wait_for_timeout(6000)
        check(await pg.input_value('#f [name=name]') == 'Stud finder', 'AI filled the name')
        await pg.fill('#f [name=name]', 'Stud sensor'); await pg.wait_for_timeout(100)
        await pg.click('#f .form-actions .btn.primary'); await pg.wait_for_timeout(1500)
        if await pg.query_selector('.sheet-wrap.open [data-new]'): await pg.click('.sheet-wrap.open [data-new]'); await pg.wait_for_timeout(1000)

        print('6. Accuracy card')
        await pg.goto('http://localhost:8080/#/more/ai'); await pg.wait_for_timeout(800)
        card = T(await pg.inner_text('.acc-card')) if await pg.query_selector('.acc-card') else ''
        print('  card:', card)
        await pg.screenshot(path=f'{SP}/a1-card.png', full_page=True)
        check('Event lists used 1 time · 4 of 5 suggestions added' in card, 'event list: offered vs added')
        check('Matched to your items 100% right 4 of 4 saved as suggested' in card, 'event list matches counted')
        check('Receipts used 1 time · 3 of 4 suggestions added' in card and 'Names 92% right 2 of 3 saved as suggested' in card, 'receipt: a word added to one name gets part marks (1 + 1 + 0.77 of 3)')
        check('Receipts that added up 1 of 1' in card, 'receipt total check counted')
        st = await pg.evaluate("JSON.parse(localStorage.getItem('paran.stats'))")
        d = list(st['days'].values())[0]
        print('  stats today:', json.dumps(d['c']), json.dumps(d['ai'])[:200])
        check(d['ai'].get('receipt', {}).get('uses') == 1 and d['ai'].get('plan', {}).get('uses') == 1 and d['c'].get('add', 0) >= 3, 'usage counts picked up AI uses and adds')
        check('Photos used 1 time · 1 of 1' in card and 'Names 57% right 0 of 1 saved as suggested' in card and 'What it’s for 100% right 1 of 1' in card, 'photo: Stud finder → Stud sensor is half right; purpose kept')
        c = await cache()
        rows = [l for l in c['log'] if l['action'] == 'ai']
        check(len(rows) == 3 and all(r['itemId'] == '' for r in rows), 'one History row per use of AI')
        print('errors', errs)
        await b.close()
    print('\nFAILURES:', FAILS or 'none')
    sys.exit(1 if FAILS else 0)
asyncio.run(main())
