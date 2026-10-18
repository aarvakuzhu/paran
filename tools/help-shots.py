#!/usr/bin/env python3
# Makes the pictures for Help (help/shots/*.webp + help/shots/index.json) from the app itself, so they never go stale.
#
# For each topic in js/help.js it opens the screen, does the taps in the topic's `shots` (or, without them, opens `go`
# and rings `ui`), draws a ring around the button to tap and saves a crop around it. Demo topics use the demo's sample
# data; topics marked `google` run against tests/fake_google.py (a group with two inventories). No real data, ever.
#
# Run from the repo root with the app served on :8080:
#   python3 -m http.server 8080 &   pip install playwright pillow
#   python3 tools/help-shots.py            (all)      python3 tools/help-shots.py move qr   (some)
# GitHub runs it on every push that changes the app (.github/workflows/help-shots.yml) and commits what changed.
#
# Shot spec (in a topic): shots: [{ at, tap, ui, cap, mode }]
#   at:  route, with {item} {lent} {reserved} {place} {spot} {event} filled from the sample data (default: the topic's go)
#   tap: selectors to click first, in order ("fill:<selector>=<text>" types instead; "wait:<ms>" waits)
#   ui:  what to ring (default: the topic's ui; any Playwright selector); none = the top of the screen
#   mode: 'google' to use the fake-Google group (default: the topic's google flag, else demo)
#   cap: caption under the picture
import asyncio, hashlib, io, json, os, re, subprocess, sys
from playwright.async_api import async_playwright
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'help', 'shots')
URL = os.environ.get('PARAN_URL', 'http://localhost:8080/')
W, H, SCALE, OUT_W = 390, 844, 2, 560
FIXED_NOW = '2026-10-20T10:00:00'  # same pictures on every run: dates in the sample data come out the same

HELP = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    f"import('{os.path.join(ROOT, 'js', 'help.js')}').then(m => console.log(JSON.stringify(m.HELP)))"]))

def specs(t):
    """The pictures a topic gets: its own `shots`, else one of `go` with `ui` ringed, else none."""
    if t.get('shots') is not None: return t['shots']
    if t.get('go') and t.get('ui'): return [{'at': t['go'], 'ui': t['ui']}]
    return []

def sig(t):
    """Changes when what the pictures show changes (help-check compares it with index.json)."""
    return hashlib.sha1(json.dumps([t.get('go'), t.get('ui'), specs(t)], sort_keys=True).encode()).hexdigest()[:10]

NO_MOTION = '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}'
RING = """(el) => {
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect(); const pad = 6;
  const ring = document.createElement('div'); ring.id = '__ring';
  Object.assign(ring.style, { position: 'fixed', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    border: '3px solid #e8590c', borderRadius: '14px', boxShadow: '0 0 0 4px rgba(232,89,12,.25)', zIndex: 99999, pointerEvents: 'none' });
  document.body.appendChild(ring);
  const sheet = el.closest('.sheet');
  const s = sheet ? sheet.getBoundingClientRect() : null;
  return { x: r.left, y: r.top, w: r.width, h: r.height, sheetTop: s ? s.top : null };
}"""

async def fill_tokens(pg, at):
    if '{' not in at: return at
    d = await pg.evaluate("""() => {
      const id = localStorage.getItem('paran.mode') === 'demo' ? 'demo' : JSON.parse(localStorage.getItem('paran.session') || '{}').sheetId;
      const c = JSON.parse(localStorage.getItem(`paran.cache.${id}`) || '{}');
      const items = (c.items || []).filter((i) => !i.deleted); const locs = (c.locations || []).filter((l) => !l.deleted);
      const home = items.find((i) => i.status === 'home' && i.locationId) || items[0] || {};
      const top = locs.find((l) => !l.parentId && locs.some((k) => k.parentId === l.id)) || locs[0] || {};
      const spot = locs.find((l) => l.parentId && items.some((i) => i.locationId === l.id)) || top;
      return { item: home.id, lent: (items.find((i) => i.status === 'lent') || home).id, reserved: (items.find((i) => i.status === 'reserved') || home).id,
        place: top.id, spot: spot.id, event: ((c.events || []).find((e) => !e.deleted) || {}).id,
        group: Object.keys(JSON.parse(localStorage.getItem(Object.keys(localStorage).find((x) => x.startsWith('paran.known.')) || 'null') || '{}').groups || {})[0] };
    }""")
    return re.sub(r'\{(\w+)\}', lambda m: str(d.get(m.group(1)) or ''), at)

async def shoot(pg, t, n, s):
    at = await fill_tokens(pg, s.get('at') or t.get('go') or '#/')
    await pg.goto(URL + at); await pg.reload(); await pg.wait_for_timeout(1200)  # a clean screen: no sheet left open
    for step in s.get('tap', []):
        if step.startswith('wait:'): await pg.wait_for_timeout(int(step[5:])); continue
        if step.startswith('fill:'):
            sel, text = step[5:].split('=', 1); await pg.fill(sel, text); await pg.wait_for_timeout(400); continue
        await pg.locator(step).first.click(timeout=5000); await pg.wait_for_timeout(600)
    ui = s['ui'] if 'ui' in s else t.get('ui')
    box = None
    if ui:
        loc = pg.locator(ui).first
        try: await loc.wait_for(state='visible', timeout=4000)
        except Exception: raise RuntimeError(f'#{n}: “{ui}” not found on {at}')
        box = await loc.evaluate(RING)
    await pg.wait_for_timeout(150)
    if box:
        cy = box['y'] + box['h'] / 2; ch = 420
        top = max(0, min(H - ch, cy - ch / 2))
        if box['y'] + box['h'] + 40 < ch: top = 0  # near the top: keep the screen's title in
        if box['sheetTop'] is not None and box['sheetTop'] > top and box['y'] - box['sheetTop'] < ch - 60: top = max(0, box['sheetTop'] - 24)
        clip = {'x': 0, 'y': top, 'width': W, 'height': min(ch, H - top)}
    else:
        clip = {'x': 0, 'y': 0, 'width': W, 'height': 520}
    png = await pg.screenshot(clip=clip)
    await pg.evaluate("document.getElementById('__ring')?.remove()")
    img = Image.open(io.BytesIO(png)).convert('RGB')
    img = img.resize((OUT_W, round(img.height * OUT_W / img.width)), Image.LANCZOS)
    buf = io.BytesIO(); img.save(buf, 'WEBP', quality=72, method=6)
    return buf.getvalue()

async def demo_page(b):
    ctx = await b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=SCALE, service_workers='block')
    pg = await ctx.new_page()
    await pg.clock.set_fixed_time(FIXED_NOW)
    await pg.add_init_script(f"addEventListener('DOMContentLoaded', () => {{ const s = document.createElement('style'); s.textContent = `{NO_MOTION}`; document.head.appendChild(s); }})")
    await pg.goto(URL); await pg.evaluate("localStorage.clear(); localStorage.setItem('paran.mode', 'demo'); localStorage.setItem('paran.stats.off', '1')")
    await pg.reload(); await pg.wait_for_timeout(1500)
    return ctx, pg

async def google_page(b):
    """The owner of a school group (Main building + Storage unit) with a few things, against the fake Google."""
    sys.path.insert(0, os.path.join(ROOT, 'tests'))
    src = open(os.path.join(ROOT, 'tests', 'access_e2e.py')).read().split('\nasync def main():')[0]
    env = {}; exec(src.replace("import os; SP = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, SP)", "import os"), env)
    G = env['G']; G.FILES.clear(); G.SHEETS.clear(); G.PICKED.clear()
    ctx, pg, _ = await env['phone'](b, env['OWNER'])
    await pg.clock.set_fixed_time(FIXED_NOW)
    await pg.add_style_tag(content=NO_MOTION)
    await pg.click('#create'); await pg.wait_for_timeout(300); await pg.click('[data-tpl="group"]'); await pg.wait_for_timeout(300)
    await pg.fill('[data-gname]', 'Tamil School'); await pg.click('[data-create]'); await pg.wait_for_timeout(8000)
    mb = next(f['id'] for f in G.FILES.values() if f['name'] == 'Main building' and f['mime'] == G.SHEET)
    av = next(r['id'] for r in G.rows(mb, 'Locations') if r['name'] == 'AV cabinet')
    cols = G.SHEETS[mb]['Items'][0]
    for i, n in (('g1', 'Projector'), ('g2', 'Banner stand'), ('g3', 'Mic stand')):
        d = {c: '' for c in cols}; d.update(id=i, name=n, qty=1, status='home', locationId=av, addedBy=env['OWNER']); G.SHEETS[mb]['Items'].append([d[c] for c in cols])
    await pg.add_init_script(f"addEventListener('DOMContentLoaded', () => {{ const s = document.createElement('style'); s.textContent = `{NO_MOTION}`; document.head.appendChild(s); }})")
    await pg.goto(URL + '#/more/people'); await pg.reload(); await pg.wait_for_timeout(3000)
    await pg.fill('.invite-form input[type=email]', 'ravi@example.com'); await pg.click('.invite-form button.primary'); await pg.wait_for_timeout(2000)
    return ctx, pg

async def main(only):
    os.makedirs(OUT, exist_ok=True)
    index_path = os.path.join(OUT, 'index.json')
    try: index = json.load(open(index_path))
    except Exception: index = {}
    todo = [t for t in HELP if specs(t) and (not only or t['id'] in only)]
    made, failed = 0, []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pages = {}
        for t in todo:
            files = []
            try:
                for n, s in enumerate(specs(t), 1):
                    mode = s.get('mode') or ('google' if t.get('google') else 'demo')
                    if mode not in pages: pages[mode] = await (google_page(b) if mode == 'google' else demo_page(b))
                    pg = pages[mode][1]
                    data = await shoot(pg, t, n, s)
                    name = f"{t['id']}-{n}.webp"
                    path = os.path.join(OUT, name)
                    old = open(path, 'rb').read() if os.path.exists(path) else None
                    if old != data: open(path, 'wb').write(data); made += 1
                    files.append({'f': name, 'v': hashlib.sha1(data).hexdigest()[:8], 'cap': s.get('cap', '')})
                index[t['id']] = {'sig': sig(t), 'shots': files}
                print(f"  {t['id']}: {len(files)}", flush=True)
            except Exception as e:
                failed.append(f"{t['id']}: {e}"); print(f"  FAIL {t['id']}: {e}")
        await b.close()
    # topics that no longer have pictures
    keep = {t['id'] for t in HELP if specs(t)}
    if not only:
        for k in [k for k in index if k not in keep]: del index[k]
        used = {s['f'] for v in index.values() for s in v['shots']}
        for f in os.listdir(OUT):
            if f.endswith('.webp') and f not in used: os.remove(os.path.join(OUT, f))
    json.dump(dict(sorted(index.items())), open(index_path, 'w'), indent=1)
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f'{len(todo)} topics, {made} pictures changed, {total // 1024} KB in help/shots')
    if failed: print('FAILED:\n  ' + '\n  '.join(failed)); sys.exit(1)

if __name__ == '__main__':
    asyncio.run(main(set(sys.argv[1:])))
