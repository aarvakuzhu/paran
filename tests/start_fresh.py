# Clean up: delete the Paran folder in Drive, Start fresh on the phone, start again (strict fake Google).
import asyncio, sys, os
SP = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, SP)
exec(open(os.path.join(SP, 'access_e2e.py')).read().split('\nasync def main():')[0].replace("import os; SP = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, SP)", ""))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        a, A, errs = await phone(b, OWNER)
        await A.click('#create'); await A.wait_for_timeout(300); await A.click('[data-tpl="home"]'); await A.wait_for_timeout(200); await A.click('[data-create]'); await A.wait_for_timeout(5000)
        await A.evaluate("localStorage.setItem('paran.ai', JSON.stringify({ enabled: true, key: 'AQ.' + 'x'.repeat(40), model: 'm' }))")
        old_root = next(f for f in G.FILES.values() if f['app'].get('stash') == 'paran')
        check(bool(old_root), 'Paran folder made')
        old_root['trashed'] = True   # deleted in Drive
        await A.goto('http://localhost:8080/#/more/data'); await A.wait_for_timeout(800)
        check(bool(await A.query_selector('[data-m="fresh"]')), 'Your data has Start fresh on this phone')
        await A.click('[data-m="fresh"]'); await A.wait_for_timeout(300)
        txt = T(await A.inner_text('.sheet-wrap.open .sheet'))
        check('Nothing in Google Drive is changed' in txt and 'AI key' in txt, 'explains what it does and keeps')
        await A.click('.sheet-wrap.open [data-yes]'); await A.wait_for_timeout(2500)
        left = await A.evaluate("Object.keys(localStorage).filter(k => k.startsWith('paran.'))")
        print('  kept:', left)
        check(set(left) <= {'paran.ai', 'paran.ai.usage', 'paran.stats', 'paran.stats.off', 'paran.feedback', 'paran.migrated'} and 'paran.ai' in left, 'only the AI key, activity, feedback (and the pilot-copy flag) kept')
        check('Continue with Google' in T(await A.inner_text('body')) or 'Try it without' in T(await A.inner_text('body')), 'back at the welcome screen')
        # sign in again
        await A.evaluate(f"localStorage.setItem('paran.mode','google'); localStorage.setItem('paran.token', JSON.stringify({{ access_token: 'tok:{OWNER}', expires_at: 9999999999999 }}))")
        await A.reload(); await A.wait_for_timeout(2500)
        check('What are you setting up?' in T(await A.inner_text('body')) or 'Start a new inventory' in T(await A.inner_text('body')), 'old inventory not found: offered a fresh start')
        await A.click('#create'); await A.wait_for_timeout(300); await A.click('[data-tpl="home"]'); await A.wait_for_timeout(200); await A.click('[data-create]'); await A.wait_for_timeout(5000)
        roots = [f for f in G.FILES.values() if f['app'].get('stash') == 'paran']
        new_root = next(f for f in roots if not f.get('trashed'))
        home = [f for f in G.FILES.values() if f['name'] == 'Home' and f['mime'] == G.SHEET and not G.in_trash(f)]
        check(len(roots) == 2 and home and G.FILES[home[0]['parents'][0]]['parents'] == [new_root['id']], 'new Paran folder made; the new inventory is in it, not the deleted one')
        check(await A.evaluate("JSON.parse(localStorage.getItem('paran.ai')).key.startsWith('AQ.')"), 'AI key still there')
        check(not errs, f'no page errors {errs[:2]}')
        await b.close()
    print('\nFAILURES:', FAILS or 'none'); sys.exit(1 if FAILS else 0)
asyncio.run(main())
