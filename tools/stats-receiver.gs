/**
 * Paran usage stats receiver (Google Apps Script). Not in use yet: the app keeps stats on each phone until
 * CONFIG.STATS_URL in js/config.js is set to this script's web-app URL.
 *
 * To switch on (when ready):
 *  1. Create a Google Sheet you own, then Extensions → Apps Script, paste this file, save.
 *  2. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone. Copy the /exec URL.
 *  3. Put that URL in CONFIG.STATS_URL, change the app's privacy wording (More → Usage counts, About, Your data)
 *     to say counts are sent, bump the version, push.
 *
 * Each phone sends { id, days: { 'YYYY-MM-DD': Day } } for finished days it hasn't sent (see js/stats.js).
 * Rows go to three tabs: Days (one per phone per day), AI (per phone, day and kind), Groups (per group per day).
 */
function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tab = (name, head) => { let s = ss.getSheetByName(name); if (!s) { s = ss.insertSheet(name); s.appendRow(head); s.setFrozenRows(1); } return s; };
  const days = tab('Days', ['received', 'install', 'date', 'version', 'mode', 'standalone', 'inventories', 'inGroup', 'aiOn',
    'open', 'add', 'addMore', 'move', 'lend', 'return', 'edit', 'remove', 'search', 'event', 'dayof', 'after']);
  const ai = tab('AI', ['received', 'install', 'date', 'kind', 'uses', 'offered', 'taken', 'field', 'unchanged', 'total', 'score']);
  const groups = tab('Groups', ['received', 'install', 'date', 'group', 'members', 'editors', 'viewers', 'inventories', 'items', 'events']);
  const now = new Date(); const id = String(body.id || '').slice(0, 40);
  Object.keys(body.days || {}).forEach((date) => {
    const d = body.days[date]; const c = d.c || {};
    days.appendRow([now, id, date, d.v || '', d.mode || '', !!d.standalone, d.inventories || 0, !!d.inGroup, !!d.aiOn,
      c.open || 0, c.add || 0, c.addMore || 0, c.move || 0, c.lend || 0, c.return || 0, c.edit || 0, c.remove || 0, c.search || 0, c.event || 0, c.dayof || 0, c.after || 0]);
    Object.keys(d.ai || {}).forEach((kind) => {
      const a = d.ai[kind]; const f = a.fields || {};
      const keys = Object.keys(f).length ? Object.keys(f) : [''];
      keys.forEach((k) => ai.appendRow([now, id, date, kind, a.uses || 0, a.n || 0, a.t || 0, k, f[k] ? f[k][0] : '', f[k] ? f[k][1] : '', f[k] ? f[k][2] : '']));
    });
    Object.keys(d.groups || {}).forEach((g) => {
      const x = d.groups[g];
      groups.appendRow([now, id, date, g, x.members || 0, x.editors || 0, x.viewers || 0, x.inventories || 0, x.items || 0, x.events || 0]);
    });
  });
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}
