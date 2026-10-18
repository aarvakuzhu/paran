# "Why?" beside messages, and shared help steps (demo mode; Gemini answered by a stand-in).
# A message never opens help by itself: it gets a small ?; tapping it shows the message and the topic that explains it.
# Help remembers the last such message for a few minutes. Share these steps sends the steps with a link that opens
# them in Paran, before sign-in (once) and again once the app is open.
import asyncio, sys, json, re
from playwright.async_api import async_playwright
T = lambda s: re.sub(r'\s+', ' ', s).strip()
URL = 'http://localhost:8080/'
FAILS = []
def check(c, w):
    print(('  ok   ' if c else '  FAIL ') + w)
    if not c: FAILS.append(w)

async def page(b, mode='demo'):
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
    await ctx.add_init_script("navigator.share = async (d) => { window.__shared = d; }; navigator.canShare = () => true;")
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(URL); await pg.evaluate(f"localStorage.clear(); {'localStorage.setItem(`paran.mode`, `demo`)' if mode == 'demo' else ''}")
    await pg.reload(); await pg.wait_for_timeout(1500)
    return ctx, pg, errs

async def sheet_text(pg): return T(await pg.inner_text('.sheet-wrap.open:last-of-type .sheet'))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx, pg, errs = await page(b)

        print('1. A real error: an AI key Google refuses')
        async def gem(route):
            await route.fulfill(status=400, content_type='application/json', body=json.dumps({'error': {'code': 400, 'message': 'API key not valid. Please pass a valid API key.', 'details': [{'reason': 'API_KEY_INVALID'}]}}))
        await ctx.route('https://generativelanguage.googleapis.com/**', gem)
        await pg.goto(URL + '#/more/ai'); await pg.wait_for_timeout(500)
        await pg.click('[data-m="aion"]'); await pg.wait_for_timeout(400)
        await pg.fill('.sheet [name=key]', 'AQ.not-a-real-key-but-long-enough-123'); await pg.wait_for_timeout(100)
        await pg.click('.sheet .kf-on'); await pg.wait_for_timeout(1500)
        box = await pg.query_selector('.sheet .error-box:not([hidden])')
        check(box and 'isn’t valid' in T(await box.inner_text()) and bool(await box.query_selector('[data-why="ai-trouble"]')), 'the error has a ? beside it, and nothing opened by itself')
        await pg.click('.sheet .error-box [data-why]'); await pg.wait_for_timeout(500)
        t = await sheet_text(pg)
        check('about this message' in t.lower() and 'isn’t valid' in t and 'AI didn’t work. What now?' in t and 'Change key' in t, f'? shows the message and the topic, open ({t[:140]})')

        print('2. A toast with ?, and Help remembering it')
        await pg.goto(URL + '#/'); await pg.reload(); await pg.wait_for_timeout(1200)
        await pg.evaluate("import('./js/ui.js').then((u) => u.toast('You can view Home, not change it', { help: 'no-edit' }))"); await pg.wait_for_timeout(300)
        why = await pg.query_selector('#toasts .toast-why')
        check(bool(why) and not await pg.query_selector('.sheet-wrap.open'), 'the message shows a ? and doesn’t open help')
        await why.click(); await pg.wait_for_timeout(500)
        t = await sheet_text(pg)
        check('You can view Home, not change it' in t and 'Why can’t I change something?' in t and 'ask its owner for Can edit' in t, 'tapping ? explains it')
        await pg.click('.sheet-wrap.open [data-close]'); await pg.wait_for_timeout(400)
        await pg.evaluate("import('./js/ui.js').then((u) => u.toast('Couldn’t reach Google: offline', { help: 'offline' }))"); await pg.wait_for_timeout(7500)  # gone
        check(not await pg.query_selector('#toasts .toast'), 'the message went away on its own')
        await pg.click('#helpbtn'); await pg.wait_for_timeout(400)
        t = await sheet_text(pg)
        check('the message you just saw' in t.lower() and 'Couldn’t reach Google' in t and 'Does it work without internet?' in t, 'the ? at the top still explains the last message')
        await pg.click('.sheet-wrap.open [data-close]'); await pg.wait_for_timeout(400)

        print('3. Share these steps')
        await pg.click('#helpbtn'); await pg.wait_for_timeout(300); await pg.fill('[data-hq]', 'lend my ladder'); await pg.wait_for_timeout(200)
        await pg.click('[data-toggle="lend"] >> nth=0'); await pg.wait_for_timeout(300)
        await pg.click('[data-hshare="lend"]'); await pg.wait_for_timeout(400)
        d = await pg.evaluate('window.__shared')
        check(d and '1. Open the item and tap Lend or reserve.' in d['text'] and d['text'].rstrip().endswith('#/help/lend'), f'shares the steps with a link ({(d or {}).get("text", "")[-60:]})')
        link = d['text'].rstrip().split(' ')[-1]
        await ctx.close()

        print('4. Opening the link in Paran')
        ctx, pg, e2 = await page(b)
        await pg.goto('about:blank'); await pg.goto(link); await pg.wait_for_timeout(1800)
        t = await sheet_text(pg)
        check('steps shared with you' in t.lower() and 'How do I lend something' in t and 'Got it back' in t and await pg.query_selector('.sheet [data-go="lend"]'), 'opens those exact steps, with Take me there')
        check(pg.url.endswith('#/'), f'the link is tidied away ({pg.url})')
        await pg.reload(); await pg.wait_for_timeout(1500)
        check(not await pg.query_selector('.sheet-wrap.open'), 'and not shown again on the next open')
        await ctx.close()

        print('5. Before signing in')
        ctx, pg, e3 = await page(b, mode='none')
        await pg.goto('about:blank'); await pg.goto(link); await pg.wait_for_timeout(1800)
        t = await sheet_text(pg)
        check('steps shared with you' in t.lower() and 'Sign in (or try the demo)' in t and not await pg.query_selector('.sheet [data-go]'), 'shown on the welcome screen, with a note, no Take me there')
        await pg.click('.sheet-wrap.open [data-close]'); await pg.wait_for_timeout(400)
        await pg.click('#demo'); await pg.wait_for_timeout(2500)
        t = await sheet_text(pg) if await pg.query_selector('.sheet-wrap.open') else ''
        check('steps shared with you' in t.lower() and await pg.query_selector('.sheet [data-go="lend"]'), 'opens again once Paran is open, to follow them')
        await ctx.close()

        check(not (errs + e2 + e3), f'no page errors {(errs + e2 + e3)[:2]}')
        await b.close()
    print('\nFAILURES:', FAILS or 'none'); sys.exit(1 if FAILS else 0)
asyncio.run(main())
