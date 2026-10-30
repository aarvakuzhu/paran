# Help in demo mode: ? on every screen, on-this-screen topics, search, Take me there for every topic, feedback.
import asyncio, sys, json, re, os, subprocess
SP = os.path.dirname(os.path.abspath(__file__))
from playwright.async_api import async_playwright
T = lambda s: re.sub(r'\s+', ' ', s).strip()
FAILS = []
def check(c, w):
    print(('  ok   ' if c else '  FAIL ') + w)
    if not c: FAILS.append(w)
HELP = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
  "import('" + os.path.join(SP, '..', 'js', 'help.js') + "').then(m => console.log(JSON.stringify(m.HELP)))"]))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, service_workers='block')
        pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8080/'); await pg.evaluate("localStorage.clear(); localStorage.setItem('paran.mode','demo')"); await pg.reload(); await pg.wait_for_timeout(1500)
        async def open_help():
            await pg.click('#helpbtn'); await pg.wait_for_timeout(300)
        async def close_help():
            await pg.click('.sheet-wrap.open [data-close]'); await pg.wait_for_timeout(300)
        print('1. ? on every screen, with that screen’s topics first')
        ev = await pg.evaluate("JSON.parse(localStorage.getItem('paran.cache.demo')).events[0].id")
        item = await pg.evaluate("JSON.parse(localStorage.getItem('paran.cache.demo')).items[0].id")
        for route, expect in [('#/', 'How do I find something?'), ('#/places', 'How do I add rooms and places?'), ('#/out', 'Who has my things right now?'),
                              (f'#/item/{item}', 'How do I lend something'), ('#/add', 'How do I add an item?'), ('#/events', 'What are events for'),
                              (f'#/event/{ev}', 'How do I add things to an event?'), ('#/more/ai', 'How do I let AI fill in details'), ('#/more/stats', 'What does Your activity show?')]:
            await pg.goto('http://localhost:8080/' + route); await pg.wait_for_timeout(500)
            has = bool(await pg.query_selector('#helpbtn'))
            await open_help(); txt = T(await pg.inner_text('.sheet-wrap.open .help'))
            check(has and 'ON THIS SCREEN' in txt.upper() and expect in txt.split('Also asked')[0], f'{route}: ? shows “{expect}” under On this screen')
            await close_help()
        print('2. Search in your own words')
        await pg.goto('http://localhost:8080/#/'); await pg.wait_for_timeout(400); await open_help()
        for q, want in [('how do i share with my wife', 'How do I share an inventory'), ('lend my ladder to a friend', 'How do I lend'), ('print a label for a box', 'QR labels'),
                        ('my key doesnt work', 'AI didn’t work'), ('graduation list from whatsapp', 'from a description'), ('undo a change', 'undo a change'), ('can my kids only view', 'only view')]:
            await pg.fill('[data-hq]', q); await pg.wait_for_timeout(150)
            first = T(await pg.inner_text('.help-list .help-topic >> nth=0')) if await pg.query_selector('.help-list .help-topic') else ''
            check(want.lower() in first.lower(), f'“{q}” → {first[:60]}')
        await pg.fill('[data-hq]', 'where is my drill'); await pg.wait_for_timeout(200)
        btn = await pg.query_selector('[data-items]')
        check(btn and 'drill' in T(await btn.inner_text()), 'a question about your things offers to search them')
        await btn.click(); await pg.wait_for_timeout(600)
        check(await pg.input_value('#q') == 'drill', 'item search runs for “drill”')
        await open_help(); await pg.fill('[data-hq]', 'teleport my sofa to mars'); await pg.wait_for_timeout(1800)
        check('No help topic matches that yet' in T(await pg.inner_text('.help-list')), 'no match says so')
        await close_help()
        print('3. Take me there, for every topic that has one')
        for t in [t for t in HELP if t.get('go') and not t.get('lic')]:  # plan topics are only offered with licensing on
            await pg.goto('http://localhost:8080/#/'); await pg.wait_for_timeout(250)
            await open_help(); await pg.fill('[data-hq]', t['q']); await pg.wait_for_timeout(150)
            await pg.click(f'[data-toggle="{t["id"]}"] >> nth=0'); await pg.wait_for_timeout(150)
            await pg.click(f'[data-go="{t["id"]}"]'); await pg.wait_for_timeout(900)
            url_ok = pg.url.endswith(t['go']) or (t['go'] == '#/' and pg.url.rstrip('/').endswith(':8080') or pg.url.endswith('#/'))
            ui_ok = True if not t.get('ui') or t.get('google') else bool(await pg.query_selector(t['ui']))  # demo has no Google-only buttons
            check(url_ok and ui_ok, f"{t['id']}: opens {t['go']}{' and finds ' + t['ui'] if t.get('ui') else ''}")
        print('4. Feedback')
        await pg.goto('http://localhost:8080/#/'); await pg.wait_for_timeout(300); await open_help()
        await pg.click('[data-toggle="find"] >> nth=0'); await pg.wait_for_timeout(150); await pg.click('[data-yes="find"]'); await pg.wait_for_timeout(150)
        await pg.click('[data-tell]'); await pg.wait_for_timeout(300); await pg.fill('.sheet-wrap.open:last-of-type input', 'Share the storage unit with my brother'); await pg.click('.sheet-wrap.open:last-of-type button.primary'); await pg.wait_for_timeout(400)
        fb = await pg.evaluate("JSON.parse(localStorage.getItem('paran.feedback') || '[]')")
        print('  feedback:', fb)
        check(any(f['topic'] == 'find' and f['helpful'] for f in fb) and any(f['text'] == 'Share the storage unit with my brother' for f in fb) and any(f['q'] == 'teleport my sofa to mars' and not f['topic'] for f in fb), 'helped / told us / unanswered question all kept')
        await pg.goto('http://localhost:8080/#/more/stats'); await pg.wait_for_timeout(500)
        txt = T(await pg.inner_text('.more'))
        check('your help feedback' in txt.lower() and 'Share the storage unit with my brother' in txt and bool(await pg.query_selector('[data-fbshare]')), 'Your activity lists it with Share with the Paran team')
        
        print('5. Pictures')
        idx = json.load(open(os.path.join(SP, '..', 'help', 'shots', 'index.json')))
        await pg.goto('http://localhost:8080/#/'); await pg.reload(); await pg.wait_for_timeout(800); await open_help()
        await pg.fill('[data-hq]', 'lend my ladder'); await pg.wait_for_timeout(200)
        await pg.click('[data-toggle="lend"] >> nth=0'); await pg.wait_for_timeout(1200)
        imgs = await pg.evaluate("[...document.querySelectorAll('.sheet-wrap.open .help-shot img')].map(i => [i.naturalWidth, i.alt])")
        check(len(imgs) == len(idx['lend']['shots']) and all(w > 0 for w, _ in imgs), f'lend shows its {len(idx["lend"]["shots"])} pictures, loaded ({imgs})')
        caps = T(await pg.inner_text('.sheet-wrap.open .help-shots'))
        check('Got it back' in caps, 'with captions')
        await pg.click('.help-shot-img >> nth=0'); await pg.wait_for_timeout(500)
        check(bool(await pg.query_selector('.sheet-wrap.open .help-zoom')), 'tap a picture to enlarge it')
        await pg.goto('http://localhost:8080/#/'); await pg.reload(); await pg.wait_for_timeout(800)
        await pg.route('**/help/shots/*.webp*', lambda r: r.abort())
        await open_help(); await pg.fill('[data-hq]', 'lend my ladder'); await pg.wait_for_timeout(200)
        await pg.click('[data-toggle="lend"] >> nth=0'); await pg.wait_for_timeout(1000)
        t = T(await pg.inner_text('.sheet-wrap.open .help-a'))
        check('The picture shows when you’re online' in t and 'Got it back' in t, 'offline: says the picture shows when online; steps still there')
        await pg.unroute('**/help/shots/*.webp*')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()
    print('\nFAILURES:', FAILS or 'none'); sys.exit(1 if FAILS else 0)
asyncio.run(main())
