# A stricter stand-in for Google Drive + Sheets: several accounts, sharing with folder inheritance,
# drive.file visibility (the app sees only files this person created with it or picked), and permission errors.
import json, re, urllib.parse, itertools

FILES = {}     # id -> {id,name,mime,parents,owner,creator,app,perms{email:role},wcs}
SHEETS = {}    # id -> {tab: rows}
PICKED = set() # (email, id)
LOG = []       # (email, method, short path, status)
_n = itertools.count(1)
RANK = {'reader': 1, 'writer': 2, 'owner': 3}
FOLDER = 'application/vnd.google-apps.folder'; SHEET = 'application/vnd.google-apps.spreadsheet'

def myroot(email): return 'root:' + email

def new_id(prefix): return f'{prefix}{next(_n)}'

def role(email, fid, seen=None):
    f = FILES.get(fid)
    if not f: return None
    if f['owner'] == email: return 'owner'
    best = f['perms'].get(email)
    for p in f['parents']:
        if p.startswith('root:'): continue
        r = role(email, p)
        if r and (not best or RANK[r] > RANK[best]): best = 'writer' if r == 'owner' else r
    return best

def visible(email, fid):
    f = FILES.get(fid)
    return bool(f) and role(email, fid) is not None and (f['creator'] == email or (email, fid) in PICKED)

class Err(Exception):
    def __init__(self, code, msg): self.code, self.msg = code, msg

def need(email, fid, min_role='reader'):
    if not visible(email, fid): raise Err(404, f'File not found: {fid}.')
    if RANK[role(email, fid)] < RANK[min_role]: raise Err(403, 'The caller does not have permission')

def meta(email, f):
    r = role(email, f['id'])
    return {'id': f['id'], 'name': f['name'], 'mimeType': f['mime'], 'parents': [p for p in f['parents']],
            'owners': [{'emailAddress': f['owner']}], 'appProperties': dict(f['app']),
            'capabilities': {'canEdit': RANK.get(r, 0) >= 2}, 'webViewLink': 'x'}

def create(email, name, mime, parents, app=None):
    parents = parents or [myroot(email)]
    for p in parents:
        if not p.startswith('root:'): need(email, p, 'writer')
    fid = new_id('S' if mime == SHEET else 'F')
    FILES[fid] = {'id': fid, 'name': name, 'mime': mime, 'parents': list(parents), 'owner': email, 'creator': email,
                  'app': dict(app or {}), 'perms': {}, 'wcs': True}
    return fid

# ---------- sheets helpers
def colnum(s):
    n = 0
    for ch in s: n = n * 26 + ord(ch) - 64
    return n - 1
def parse(rng):
    tab, _, a = rng.partition('!'); tab = tab.strip("'")
    m = re.fullmatch(r'([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?', a)
    c1, r1, c2, r2 = m.groups()
    return tab, (colnum(c1) if c1 else 0), (int(r1) - 1 if r1 else 0), (colnum(c2) if c2 else (colnum(c1) if c1 and m.group(3) is None else 10**6)), (int(r2) if r2 else 10**9)
def read(sid, rng):
    tab, c1, r1, c2, r2 = parse(rng)
    if tab not in SHEETS[sid]: raise Err(400, 'Unable to parse range: ' + rng)
    rows = SHEETS[sid][tab]
    out = [list(r[c1:c2 + 1]) for r in rows[r1:r2]]
    while out and not any(x != '' for x in out[-1]): out.pop()
    return out
def write_cells(sid, rng, vals):
    tab, c1, r1, *_ = parse(rng)
    if tab not in SHEETS[sid]: raise Err(400, 'Unable to parse range: ' + rng)
    rows = SHEETS[sid][tab]
    for k, v in enumerate(vals):
        while len(rows) <= r1 + k: rows.append([])
        row = list(rows[r1 + k])
        while len(row) < c1 + len(v): row.append('')
        row[c1:c1 + len(v)] = v; rows[r1 + k] = row

# ---------- request handler
def handle(email, method, url, body):
    u = urllib.parse.urlparse(url); q = urllib.parse.parse_qs(u.query); path = urllib.parse.unquote(u.path)
    try:
        r = _handle(email, method, path, q, body)
        LOG.append((email, method, path[-50:], 200)); return r
    except Err as e:
        LOG.append((email, method, path[-50:], e.code)); return ('ERR', e.code, e.msg)

def _handle(email, method, path, q, body):
    J = json.loads(body) if body and body[:1] in '{[' else {}
    if path.endswith('/oauth2/v3/userinfo'): return {'email': email, 'name': email.split('@')[0].title()}
    if path == '/__pick':
        for fid in json.loads(body): PICKED.add((email, fid))
        return {}
    # ----- Drive
    if path.endswith('/drive/v3/files') and method == 'POST':
        fid = create(email, J['name'], J.get('mimeType', FOLDER), J.get('parents'), J.get('appProperties'))
        return {'id': fid, 'webViewLink': 'x'}
    if path.endswith('/drive/v3/files') and method == 'GET':
        role_ = re.search(r"value='([^']+)'", q['q'][0]).group(1)
        return {'files': [meta(email, f) for f in FILES.values() if f['app'].get('stash') == role_ and visible(email, f['id'])]}
    m = re.search(r'/drive/v3/files/([^/]+)/permissions(?:/([^/]+))?$', path)
    if m:
        fid, pid = m.groups(); f = FILES.get(fid)
        if method == 'GET':
            need(email, fid)
            return {'permissions': [{'id': f['owner'], 'type': 'user', 'emailAddress': f['owner'], 'role': 'owner'}] +
                    [{'id': e, 'type': 'user', 'emailAddress': e, 'role': r} for e, r in f['perms'].items()]}
        need(email, fid, 'writer')
        if role(email, fid) != 'owner' and not f['wcs']: raise Err(403, 'The caller does not have permission to share')
        if method == 'POST': f['perms'][J['emailAddress']] = J['role']; return {'id': J['emailAddress']}
        if method == 'PATCH': f['perms'][pid] = J.get('role', f['perms'].get(pid)); return {'id': pid, 'role': f['perms'][pid]}
        if method == 'DELETE': f['perms'].pop(pid, None); return {}
    m = re.search(r'/drive/v3/files/([^/]+)$', path)
    if m:
        fid = m.group(1)
        if method == 'GET': need(email, fid); return meta(email, FILES[fid])
        if method == 'PATCH':
            need(email, fid, 'writer'); f = FILES[fid]
            if 'appProperties' in J:
                for k, v in J['appProperties'].items():
                    if v is None: f['app'].pop(k, None)
                    else: f['app'][k] = v
            if 'name' in J: f['name'] = J['name']
            if 'writersCanShare' in J:
                if role(email, fid) != 'owner': raise Err(403, 'Only the owner can change sharing settings')
                f['wcs'] = J['writersCanShare']
            if q.get('addParents'):
                to = q['addParents'][0]
                if not to.startswith('root:'): need(email, to, 'writer')
                rm = set(q.get('removeParents', [''])[0].split(','))
                f['parents'] = [p for p in f['parents'] if p not in rm] + [to]
            return meta(email, f)
    # ----- Sheets
    if path.endswith('/v4/spreadsheets') and method == 'POST':
        sid = create(email, J['properties']['title'], SHEET, None)
        SHEETS[sid] = {s['properties']['title']: [] for s in J['sheets']}
        return {'spreadsheetId': sid}
    m = re.search(r'/v4/spreadsheets/([^/:]+)(.*)$', path)
    if m:
        sid, rest = m.groups()
        if rest == ':batchUpdate':
            need(email, sid, 'writer')
            for r in J['requests']: SHEETS[sid][r['addSheet']['properties']['title']] = []
            return {}
        if rest == '' and method == 'GET': need(email, sid); return {'sheets': [{'properties': {'title': t}} for t in SHEETS[sid]]}
        if rest == '/values:batchGet':
            need(email, sid); return {'valueRanges': [{'range': r, 'values': read(sid, r)} for r in q['ranges']]}
        if rest == '/values:batchUpdate':
            need(email, sid, 'writer')
            for d in J['data']: write_cells(sid, d['range'], d['values'])
            return {}
        m2 = re.fullmatch(r'/values/(.+?)(:append)?', rest); rng = m2.group(1)
        if m2.group(2):
            need(email, sid, 'writer'); tab = rng.split('!')[0]
            if tab not in SHEETS[sid]: raise Err(400, 'Unable to parse range: ' + rng)
            SHEETS[sid][tab].extend(J['values']); n = len(SHEETS[sid][tab])
            return {'updates': {'updatedRange': f'{tab}!A{n}:Z{n}'}}
        if method == 'PUT': need(email, sid, 'writer'); write_cells(sid, rng, J['values']); return {}
        need(email, sid); return {'values': read(sid, rng)}
    raise Err(400, 'fake: unhandled ' + method + ' ' + path)

# ---------- inspection helpers for tests
def tree(email):
    def walk(parent, depth):
        out = []
        for f in sorted(FILES.values(), key=lambda f: f['name']):
            if parent in f['parents'] and f['owner'] == email:
                share = ', '.join(f'{e.split("@")[0]}:{r}' for e, r in f['perms'].items())
                out.append('  ' * depth + f"{f['name']}{'/' if f['mime'] == FOLDER else ''}" + (f'   [shared: {share}]' if share else '') + (f"   {{{', '.join(f'{k}={v}' for k, v in f['app'].items() if k != 'stash')}}}" if len(f['app']) > 1 else ''))
                if f['mime'] == FOLDER: out += walk(f['id'], depth + 1)
        return out
    return '\n'.join(['My Drive/'] + walk(myroot(email), 1))
def find(name): return next(f['id'] for f in FILES.values() if f['name'] == name)
def rows(sid, tab):
    r = SHEETS[sid].get(tab, [])
    return [dict(zip(r[0], x)) for x in r[1:]] if r else []
