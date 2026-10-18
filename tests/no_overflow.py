# No screen may be wider than the phone (a wide page scrolls sideways and drags the fixed tab bar with it), and the
# tab bar must stay pinned to the bottom while scrolling. Demo mode, at 320 and 390 px wide.
import asyncio, sys
from playwright.async_api import async_playwright
FAILS = []
def check(c, w):
    print(('  ok   ' if c else '  FAIL ') + w)
    if not c: FAILS.append(w)
WIDTH = "() => ({ W: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth })"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for w in (320, 390):
            pg = await b.new_page(viewport={'width': w, 'height': 700}, is_mobile=True, has_touch=True)
            await pg.goto('http://localhost:8080/'); await pg.evaluate("localStorage.clear(); localStorage.setItem('paran.mode','demo')"); await pg.reload(); await pg.wait_for_timeout(1500)
            c = await pg.evaluate("JSON.parse(localStorage.getItem('paran.cache.demo'))")
            ev, it, loc = c['events'][0]['id'], c['items'][0]['id'], c['locations'][0]['id']
            # a long inventory of activity, so the chart has 120 days
            await pg.evaluate("""() => { const s = JSON.parse(localStorage.getItem('paran.stats') || '{"id":"x","days":{}}'); for (let i = 1; i < 120; i++) { const d = new Date(); d.setDate(d.getDate() - i); s.days[d.toISOString().slice(0,10)] = { c: { open: 1, add: i % 3 }, ai: {}, groups: {} }; } localStorage.setItem('paran.stats', JSON.stringify(s)); }""")
            routes = ['#/', '#/places', f'#/place/{loc}', '#/out', f'#/item/{it}', '#/add', f'#/edit/{it}', '#/more', '#/more/ai', '#/more/stats', '#/more/data',
                      '#/more/people', '#/more/inventory', '#/events', f'#/event/{ev}', '#/setup']
            for r in routes:
                await pg.goto('http://localhost:8080/' + r); await pg.wait_for_timeout(450)
                if r == '#/more/stats': await pg.click('[data-period="0"]'); await pg.wait_for_timeout(300)
                if r == f'#/edit/{it}': await pg.evaluate("document.querySelectorAll('details').forEach(d => d.open = true)"); await pg.wait_for_timeout(100)
                m = await pg.evaluate(WIDTH)
                check(m['sw'] <= m['W'], f'{w}px {r}: page {m["sw"]} ≤ screen {m["W"]}')
            # sheets: Help, and the template editor isn't reachable in demo
            await pg.goto('http://localhost:8080/#/'); await pg.wait_for_timeout(300); await pg.click('#helpbtn'); await pg.wait_for_timeout(300)
            await pg.fill('[data-hq]', 'how do I share an inventory with my whole family and friends'); await pg.wait_for_timeout(200)
            m = await pg.evaluate(WIDTH); check(m['sw'] <= m['W'], f'{w}px Help sheet with a long question')
            await pg.fill('[data-hq]', 'move an item to another place'); await pg.wait_for_timeout(200)
            await pg.click('[data-toggle="move"] >> nth=0'); await pg.wait_for_timeout(800)  # two pictures side by side
            m = await pg.evaluate(WIDTH); check(m['sw'] <= m['W'] and bool(await pg.query_selector('.help-shots.many img')), f'{w}px Help topic with pictures')
            await pg.click('.sheet-wrap.open [data-close]'); await pg.wait_for_timeout(300)
            # the tab bar stays at the bottom while scrolling
            await pg.goto('http://localhost:8080/#/places'); await pg.wait_for_timeout(400)
            for y in (0, 400, 1200):
                await pg.evaluate(f"window.scrollTo(0, {y})"); await pg.wait_for_timeout(150)
                bar = await pg.evaluate("(() => { const r = document.querySelector('.tabbar').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.bottom), innerHeight, Math.round(r.width), document.documentElement.clientWidth]; })()")
                check(abs(bar[1] - bar[2]) <= 1 and bar[0] >= 0 and bar[3] <= bar[4], f'{w}px tab bar pinned at scroll {y} ({bar})')
            await pg.close()
        await b.close()
    print('\nFAILURES:', FAILS or 'none'); sys.exit(1 if FAILS else 0)
asyncio.run(main())
