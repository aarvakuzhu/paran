# Ask (AI answers in Help), with a stand-in Gemini in the real API's shape. Demo mode.
import asyncio, sys, json, re, os
SP = os.path.dirname(os.path.abspath(__file__))
from playwright.async_api import async_playwright
T = lambda s: re.sub(r'\s+', ' ', s).strip()
FAILS = []; SENT = []; MODE = {'v': 'ok'}
def check(c, w):
    print(('  ok   ' if c else '  FAIL ') + w)
    if not c: FAILS.append(w)
def gemini(body):
    prompt = json.loads(body)['contents'][0]['parts'][0]['text']; SENT.append(prompt)
    ids = re.findall(r'^\[([a-z-]+)\]', prompt, re.M)
    if MODE['v'] == 'none': out = {'found': False, 'answer': 'I don’t know that one.', 'topics': []}
    elif 'EARLIER QUESTION' in prompt: out = {'found': True, 'answer': 'Yes: when inviting, choose Can view.', 'topics': ['roles', 'made-up-id']}
    else: out = {'found': True, 'answer': '1. Go to More → People & access.\n2. Type their Google email and tap Invite.', 'topics': ['share-inv', 'roles']}
    return {'candidates': [{'content': {'parts': [{'text': json.dumps(out)}]}, 'finishReason': 'STOP'}]}
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, service_workers='block')
        pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def g(route):
            if MODE['v'] == 'down': await route.fulfill(status=503, content_type='application/json', body='{"error":{"message":"overloaded"}}'); return
            if route.request.method == 'POST': await route.fulfill(status=200, content_type='application/json', body=json.dumps(gemini(route.request.post_data)))
            else: await route.fulfill(status=200, content_type='application/json', body='{}')
        await ctx.route('https://generativelanguage.googleapis.com/**', g)
        await pg.goto('http://localhost:8080/'); await pg.evaluate("localStorage.clear(); localStorage.setItem('paran.mode','demo')"); await pg.reload(); await pg.wait_for_timeout(1500)
        print('1. Without AI: no Ask, a hint to set it up')
        await pg.click('#helpbtn'); await pg.wait_for_timeout(300); await pg.fill('[data-hq]', 'share with my wife'); await pg.wait_for_timeout(200)
        check(not await pg.query_selector('[data-ask]') and bool(await pg.query_selector('[data-aion]')), 'no Ask AI button; “Set it up” hint shown')
        await pg.click('.sheet-wrap.open [data-close]'); await pg.wait_for_timeout(300)
        await pg.evaluate("localStorage.setItem('paran.ai', JSON.stringify({ enabled: true, key: 'AQ.' + 'x'.repeat(40), model: 'gemini-3.5-flash-lite' }))")
        print('2. Ask')
        await pg.goto('http://localhost:8080/#/places'); await pg.wait_for_timeout(400)
        await pg.click('#helpbtn'); await pg.wait_for_timeout(300); await pg.fill('[data-hq]', 'how can my wife see our stuff'); await pg.wait_for_timeout(200)
        check(bool(await pg.query_selector('[data-ask]')), 'Ask AI button shown with AI on')
        await pg.press('[data-hq]', 'Enter'); await pg.wait_for_timeout(5000)
        ans = T(await pg.inner_text('.help-answer')) if await pg.query_selector('.help-answer') else ''
        print('  answer:', ans[:220])
        check('People & access' in ans and 'How do I share an inventory with someone?' in ans, 'answer with its source topic')
        check(bool(await pg.query_selector('.help-answer [data-go="share-inv"]')), 'Take me there for the main topic')
        pr = SENT[-1]
        topics_sent = re.findall(r'^\[([a-z-]+)\]', pr, re.M)
        check(len(topics_sent) == 8 and 'share-inv' in topics_sent, f'8 topics sent, the right one among them ({topics_sent})')
        check('looking at the places screen' in pr and 'demo' in pr, 'who/where context sent')
        check(not any(x in pr for x in ['Tablecloths', 'Diwali', 'Garage', 'Diyas']), 'no inventory contents sent')
        check(len(pr) < 9000, f'prompt is small ({len(pr)} characters)')
        print('3. Follow-up')
        await pg.fill('.help-follow input', 'can she only look, not change?'); await pg.click('.help-follow button'); await pg.wait_for_timeout(5000)
        ans2 = T(await pg.inner_text('.help-answer'))
        check('choose Can view' in ans2 and 'Can someone only view' in ans2 and not await pg.query_selector('.help-follow'), 'follow-up answered; made-up topic id dropped; no second follow-up')
        check('EARLIER QUESTION: how can my wife see our stuff' in SENT[-1], 'follow-up carries the first question and answer')
        await pg.click('[data-askno]'); await pg.wait_for_timeout(300); await pg.fill('.sheet-wrap.open:last-of-type input', 'wanted to share only the garage'); await pg.click('.sheet-wrap.open:last-of-type button.primary'); await pg.wait_for_timeout(300)
        fb = await pg.evaluate("JSON.parse(localStorage.getItem('paran.feedback')||'[]')")
        check(any(f.get('ai') and f.get('helpful') is False for f in fb) and any(f.get('text') == 'wanted to share only the garage' for f in fb), 'No + note kept as feedback')
        print('4. Not covered, and Gemini down')
        MODE['v'] = 'none'
        await pg.fill('[data-hq]', 'can paran order pizza'); await pg.press('[data-hq]', 'Enter'); await pg.wait_for_timeout(5000)
        ans3 = T(await pg.inner_text('.help-answer'))
        check('Not in Paran’s help yet' in ans3, f'says it isn’t covered ({ans3[:80]})')
        MODE['v'] = 'down'
        await pg.fill('[data-hq]', 'how do I lend things'); await pg.press('[data-hq]', 'Enter'); await pg.wait_for_timeout(9000)
        ans4 = T(await pg.inner_text('.help-answer'))
        check('Try again' in ans4 and bool(await pg.query_selector('.help-list .help-topic')), f'error shown with Try again, matches still listed ({ans4[:80]})')
        print('5. A question about your things is not sent')
        n = len(SENT); MODE['v'] = 'ok'
        await pg.fill('[data-hq]', 'where is my drill'); await pg.press('[data-hq]', 'Enter'); await pg.wait_for_timeout(1500)
        check(len(SENT) == n and not await pg.query_selector('[data-ask]'), 'no Ask, nothing sent; item search offered instead')
        st = await pg.evaluate("Object.values(JSON.parse(localStorage.getItem('paran.stats')).days)[0].c")
        check(st.get('helpAsk', 0) >= 3 and st.get('helpAskNone') == 1 and st.get('helpAskNo') == 1, f'counted ({st})')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()
    print('\nFAILURES:', FAILS or 'none'); sys.exit(1 if FAILS else 0)
asyncio.run(main())
