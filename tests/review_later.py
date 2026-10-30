# Photos now, details later (demo mode, a fake camera and a stand-in Gemini).
# Quick capture with no signal; the photos stay on this phone (not in the inventory) until checked; AI fills them in
# automatically once online; Save … as AI named them; Check one by one (one thing, several things, nothing found);
# Fill in later on Add, and the offer when AI can't be reached; Select → Fill in with AI with automatic off.
import asyncio, sys, json, re, os
from playwright.async_api import async_playwright
SP = os.path.dirname(os.path.abspath(__file__))
T = lambda s: re.sub(r'\s+', ' ', s).strip()
URL = 'http://localhost:8080/'
FAILS = []; ANSWERS = []; CALLS = []
def check(c, w):
    print(('  ok   ' if c else '  FAIL ') + w)
    if not c: FAILS.append(w)

def gemini(body):
    prompt = json.loads(body)['contents'][0]['parts'][0]['text']; CALLS.append(prompt[:60])
    items = ANSWERS.pop(0) if ANSWERS else []
    return {'candidates': [{'content': {'parts': [{'text': json.dumps({'items': items})}]}, 'finishReason': 'STOP'}]}
DRILL = [{'name': 'Cordless drill', 'purpose': 'Drilling holes', 'category': 'Tools', 'tags': ['drill'], 'qty': 1}]
TWO = [{'name': 'Paint roller', 'purpose': 'Painting walls', 'category': 'Paint', 'tags': ['roller'], 'qty': 1, 'box_2d': [100, 100, 500, 500]},
       {'name': 'Drop cloth', 'purpose': 'Covering floors', 'category': 'Paint', 'tags': ['cloth'], 'qty': 2, 'box_2d': [500, 500, 900, 900]}]

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, service_workers='block', permissions=['camera'])
        pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def g(route):
            if route.request.method == 'POST': await route.fulfill(status=200, content_type='application/json', body=json.dumps(gemini(route.request.post_data)))
            else: await route.fulfill(status=200, content_type='application/json', body='{"name":"m"}')
        await ctx.route('https://generativelanguage.googleapis.com/**', g)
        await pg.goto(URL)
        await pg.evaluate("""() => { localStorage.clear(); localStorage.setItem('paran.mode', 'demo');
          localStorage.setItem('paran.ai', JSON.stringify({ enabled: true, key: 'AQ.' + 'x'.repeat(30), model: 'gemini-3.5-flash-lite', auto: true })); }""")
        await pg.reload(); await pg.wait_for_timeout(1500)
        cache = lambda: pg.evaluate("JSON.parse(localStorage.getItem('paran.cache.demo'))")
        drafts = lambda: pg.evaluate("JSON.parse(localStorage.getItem('paran.drafts.demo') || '[]')")
        items0 = len([i for i in (await cache())['items'] if not i.get('deleted')])
        c = await cache(); garage = next(l['id'] for l in c['locations'] if l['name'] == 'Garage'); shelf = next(l['id'] for l in c['locations'] if l['name'] == 'Metal shelf')

        print('1. Quick capture with no signal')
        await ctx.set_offline(True)
        await pg.goto(URL + f'#/place/{garage}'); await pg.wait_for_timeout(600)
        await pg.click('[data-a="quick"]'); await pg.wait_for_timeout(1500)
        check('Garage' in T(await pg.inner_text('.quick [data-place]')), 'the camera opens, putting photos in Garage')
        for _ in range(2): await pg.click('.quick [data-shoot]'); await pg.wait_for_timeout(500)
        await pg.click('.quick [data-place]'); await pg.wait_for_timeout(500)   # next photos go on the metal shelf
        await pg.fill('.sheet [data-q]', 'metal'); await pg.wait_for_timeout(300); await pg.click('.sheet [data-pick] >> nth=0'); await pg.wait_for_timeout(500)
        check('Metal shelf' in T(await pg.inner_text('.quick [data-place]')), 'the place can change between photos')
        await pg.click('.quick [data-shoot]'); await pg.wait_for_timeout(500)
        check('3 photos kept' in T(await pg.inner_text('.quick .scan-count')), 'counts what’s kept')
        await pg.click('.quick [data-done]'); await pg.wait_for_timeout(1200)
        d = await drafts()
        check(len(d) == 3 and [x['locationId'] for x in d] == [garage, garage, shelf] and all(x['state'] == 'waiting' for x in d), f'3 photos kept with their places, waiting ({[x["state"] for x in d]})')
        check(pg.url.endswith('#/review') and 'waiting for a connection' in T(await pg.inner_text('#view')), 'Photos to review says they wait for a connection')
        check(len([i for i in (await cache())['items'] if not i.get('deleted')]) == items0, 'nothing added to the inventory yet (private to this phone)')
        await pg.goto(URL + '#/'); await pg.wait_for_timeout(500)
        check('3 photos to review' in T(await pg.inner_text('#view')), 'Find shows 3 photos to review')

        print('2. Back online: AI fills them in by itself')
        ANSWERS[:] = [DRILL, TWO, []]
        await ctx.set_offline(False); await pg.evaluate("dispatchEvent(new Event('online'))")
        for _ in range(40):
            await pg.wait_for_timeout(500)
            if all(x['state'] in ('ready', 'none') for x in await drafts()): break
        d = await drafts()
        check([x['state'] for x in d] == ['ready', 'ready', 'none'] and d[0]['items'][0]['name'] == 'Cordless drill' and len(d[1]['items']) == 2, f'filled in: one thing, two things, nothing ({[x["state"] for x in d]})')
        check('ready to check' in T(await pg.inner_text('#view')), 'Find says they’re ready to check')

        print('3. Save the clear ones as AI named them')
        await pg.goto(URL + '#/review'); await pg.wait_for_timeout(800)
        await pg.screenshot(path=f'{SP}/rv1-list.png', full_page=True)
        btn = await pg.query_selector('[data-a="keepall"]')
        check(btn and 'Save 1 as AI named them' in T(await btn.inner_text()), 'offers to save the one clear photo (not the photo with two things)')
        await btn.click(); await pg.wait_for_timeout(400); await pg.click('.sheet [data-yes]'); await pg.wait_for_timeout(1200)
        c = await cache(); drill = [i for i in c['items'] if i['name'] == 'Cordless drill' and not i.get('deleted')]
        thumbs = await pg.evaluate("(async () => { const { blobs } = await import('./js/idb.js'); const t = await blobs.get('thumbs:demo'); return t ? Object.keys(t) : []; })()")
        check(drill and drill[0]['locationId'] == garage and drill[0]['id'] in thumbs, 'Cordless drill saved in Garage, with its photo')
        check(len(await drafts()) == 2, 'and it’s gone from the list')
        check(any(e['action'] == 'ai' and e['detail'] == 'photo' for e in c['log']), 'AI accuracy recorded')

        print('4. Check one by one')
        await pg.click('[data-a="reviewnext"]'); await pg.wait_for_timeout(1500)
        t = ' '.join(await pg.evaluate("[...document.querySelectorAll('.sheet-wrap.open input')].map(i => i.value)")) if await pg.query_selector('.sheet-wrap.open') else ''
        check('Paint roller' in t and 'Drop cloth' in t, f'the photo with two things opens the usual review ({t[:80]})')
        await pg.click('.sheet-wrap.open button.primary >> nth=-1'); await pg.wait_for_timeout(1500)
        c = await cache()
        check(all(any(i['name'] == n and not i.get('deleted') for i in c['items']) for n in ('Paint roller', 'Drop cloth')), 'both saved')
        await pg.wait_for_timeout(800)
        check('draft=' in pg.url and await pg.input_value('input[name=name]') == '' and 'Check and save' in T(await pg.inner_text('#view')), 'then the next photo opens: AI found nothing, so the name is empty')
        await pg.fill('input[name=name]', 'Paint can'); await pg.click('#f button[type=submit].primary'); await pg.wait_for_timeout(1500)
        c = await cache()
        check(any(i['name'] == 'Paint can' and i['locationId'] == shelf for i in c['items']), 'saved on the metal shelf, where it was photographed')
        check(pg.url.endswith('#/review') and len(await drafts()) == 0 and 'Nothing to review' in T(await pg.inner_text('#view')), 'and the list is empty')

        print('5. Fill in later on Add, and the offer when AI can’t be reached')
        from PIL import Image
        Image.new('RGB', (640, 480), (90, 120, 160)).save(f'{SP}/rv-photo.jpg')
        await ctx.set_offline(True)
        await pg.goto(URL + f'#/add?loc={garage}'); await pg.wait_for_timeout(700)
        await pg.set_input_files('#photo', f'{SP}/rv-photo.jpg'); await pg.wait_for_timeout(1800)
        toast = T(await pg.inner_text('#toasts'))
        check('Fill in later' in toast, f'offline, AI can’t answer: the message offers Fill in later ({toast})')
        check(await pg.is_visible('[data-a="later"]'), 'and the form has Fill in later')
        await pg.click('[data-a="later"]'); await pg.wait_for_timeout(1000)
        d = await drafts()
        check(len(d) == 1 and d[0]['locationId'] == garage and '#/add' in pg.url and not await pg.query_selector('#pp img'), 'kept; the form is ready for the next thing')

        print('6. Automatic off: Select → Fill in with AI')
        await pg.goto(URL + '#/review'); await pg.wait_for_timeout(600)
        await pg.click('.review-ai .switch'); await pg.wait_for_timeout(300)
        await ctx.set_offline(False); await pg.evaluate("dispatchEvent(new Event('online'))"); await pg.wait_for_timeout(2500)
        check((await drafts())[0]['state'] == 'waiting', 'with automatic off, nothing is sent')
        ANSWERS[:] = [DRILL]
        await pg.click('[data-rsel]'); await pg.wait_for_timeout(300); await pg.click('.draft-card >> nth=0'); await pg.wait_for_timeout(300)
        await pg.click('[data-a="draftai"]'); await pg.wait_for_timeout(3000)
        check((await drafts())[0]['state'] == 'ready', 'the selected photo is filled in')
        await pg.click('[data-rsel]'); await pg.wait_for_timeout(300); await pg.click('.draft-card >> nth=0'); await pg.wait_for_timeout(300)
        await pg.click('[data-a="draftdel"]'); await pg.wait_for_timeout(300); await pg.click('.sheet [data-yes]'); await pg.wait_for_timeout(600)
        check(len(await drafts()) == 0, 'Delete removes it (it was never in the inventory)')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()
    print('\nFAILURES:', FAILS or 'none'); sys.exit(1 if FAILS else 0)
asyncio.run(main())
