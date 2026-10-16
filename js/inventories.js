// Several inventories per person, optionally gathered in a group: an organization, or "my homes".
//
// In Google Drive a group is one folder. Sharing that folder shares every inventory inside it.
//   <Group name>/            folder, appProperties.stash = "group"
//     <Group> – directory    sheet, stash = "directory": Inventories + People tabs (the group's own list)
//     <Inventory name>/      folder, stash = "root" (same as a standalone inventory)
//       <Inventory name>     sheet, stash = "sheet"
//       Photos/
// The app only sees files it created or the user picked (drive.file), so the directory is how
// people who were shared a group learn which inventories it holds.
import { CONFIG } from './config.js';
import { drive, sheets } from './google.js';
import { TABS, MEMBER_COLS, rowsToObjects, objectToRow, lastCol, now } from './store.js';

export const DIR_INV_COLS = [`id`, `name`, `folderId`, `addedBy`, `addedAt`, `removed`];
export const DIR_PEOPLE_COLS = [`email`, `role`, `invitedBy`, `joinedAt`];
const DIR_TABS = [{ name: `Inventories`, cols: DIR_INV_COLS }, { name: `People`, cols: DIR_PEOPLE_COLS }];
const DELETED_COL = `S`; // Items column of `deleted` (ITEM_COLS index 18)

// ---------------------------------------------------------------- what this device knows about
// { inv: { sheetId: { name, groupId, owner } }, groups: { folderId: { name, dirId, owner } } }
const knownKey = (email) => `paran.known.${email}`;
export function loadKnown(email) {
  try { const k = JSON.parse(localStorage.getItem(knownKey(email)) || `null`); if (k?.inv && k?.groups) return k; } catch { /* ignore */ }
  return { inv: {}, groups: {} };
}
export function saveKnown(email, k) { try { localStorage.setItem(knownKey(email), JSON.stringify(k)); } catch { /* ignore */ } }
export function rememberInventory(email, sheetId, info) {
  const k = loadKnown(email); k.inv[sheetId] = { ...(k.inv[sheetId] || {}), ...info }; saveKnown(email, k); return k;
}

/** Items count from this device's copy, if it has one. */
export function cachedCount(sheetId) {
  try {
    const c = JSON.parse(localStorage.getItem(`paran.cache.${sheetId}`) || `null`);
    return c ? (c.items || []).filter((i) => i.deleted !== true && i.deleted !== `TRUE`).length : null;
  } catch { return null; }
}

/** Items count straight from the sheet (two thin columns). */
export async function remoteCount(sheetId) {
  const r = await sheets.batchGet(sheetId, [`Items!A:A`, `Items!${DELETED_COL}:${DELETED_COL}`]);
  const ids = r.valueRanges[0].values || []; const del = r.valueRanges[1].values || [];
  let n = 0;
  for (let i = 1; i < ids.length; i++) if (ids[i]?.[0] && !(del[i]?.[0] === true || del[i]?.[0] === `TRUE`)) n++;
  return n;
}

/** Ask Drive what this person can reach, and read each group's directory. */
export async function discover(user) {
  const k = loadKnown(user.email);
  const [sheetsFound, dirs] = await Promise.all([drive.findTagged(`sheet`), drive.findTagged(`directory`)]);
  for (const f of sheetsFound) {
    k.inv[f.id] = { ...(k.inv[f.id] || {}), name: f.name, owner: f.owners?.[0]?.emailAddress === user.email, reachable: true };
  }
  for (const d of dirs) {
    const groupId = d.parents?.[0]; if (!groupId) continue;
    let name = k.groups[groupId]?.name;
    try { name = (await drive.meta(groupId)).name || name; } catch { /* shared directory without the folder picked */ }
    k.groups[groupId] = { ...(k.groups[groupId] || {}), name: name || d.name.replace(/ – directory$/, ``), dirId: d.id, owner: d.owners?.[0]?.emailAddress === user.email };
    try {
      const dir = await readDirectory(d.id);
      k.groups[groupId].people = dir.people;
      for (const inv of dir.inventories) {
        k.inv[inv.id] = { ...(k.inv[inv.id] || {}), name: k.inv[inv.id]?.name || inv.name, groupId };
        if (!sheetsFound.some((f) => f.id === inv.id)) k.inv[inv.id].reachable = k.inv[inv.id].reachable || false;
      }
    } catch { /* directory unreadable right now */ }
  }
  saveKnown(user.email, k);
  return k;
}

export async function readDirectory(dirId) {
  const r = await sheets.batchGet(dirId, [`Inventories!A1:${lastCol(DIR_INV_COLS)}`, `People!A1:${lastCol(DIR_PEOPLE_COLS)}`]);
  const [inv, people] = r.valueRanges.map((v) => v.values || []);
  return {
    inventories: rowsToObjects(inv, DIR_INV_COLS).filter((i) => !i.removed),
    people: rowsToObjects(people, DIR_PEOPLE_COLS),
  };
}

// ---------------------------------------------------------------- creating
export async function createGroup(user, name) {
  const folder = await drive.createFolder(name, null, `group`);
  const ss = await sheets.create(`${name} – directory`, DIR_TABS);
  const m = await drive.meta(ss.spreadsheetId);
  await drive.tagAndMove(ss.spreadsheetId, folder.id, (m.parents || []).join(`,`), `directory`);
  await sheets.batchUpdateValues(ss.spreadsheetId, DIR_TABS.map((t) => ({ range: `${t.name}!A1`, values: [t.cols] })));
  await sheets.append(ss.spreadsheetId, `People!A1`, [objectToRow({ email: user.email, role: `owner`, invitedBy: ``, joinedAt: now() }, DIR_PEOPLE_COLS)]);
  const k = loadKnown(user.email);
  k.groups[folder.id] = { name, dirId: ss.spreadsheetId, owner: true, people: [{ email: user.email, role: `owner` }] };
  saveKnown(user.email, k);
  return { id: folder.id, name, dirId: ss.spreadsheetId };
}

/** A new inventory: its own folder (inside the group's, if any) with the sheet and, later, Photos. */
export async function createInventory(user, name = CONFIG.SHEET_NAME, groupId = ``) {
  const k = loadKnown(user.email);
  const group = groupId ? k.groups[groupId] : null;
  const folder = await drive.createFolder(name, group ? groupId : null, `root`);
  const ss = await sheets.create(name, TABS);
  const m = await drive.meta(ss.spreadsheetId);
  await drive.tagAndMove(ss.spreadsheetId, folder.id, (m.parents || []).join(`,`), `sheet`);
  await sheets.batchUpdateValues(ss.spreadsheetId, TABS.map((t) => ({ range: `${t.name}!A1`, values: [t.cols] })));
  await sheets.append(ss.spreadsheetId, `Members!A1`, [objectToRow({ email: user.email, role: `owner`, invitedBy: ``, joinedAt: now() }, MEMBER_COLS)]);
  if (group?.dirId) await addDirectoryRow(group.dirId, user, { id: ss.spreadsheetId, name, folderId: folder.id });
  rememberInventory(user.email, ss.spreadsheetId, { name, owner: true, reachable: true, groupId: group ? groupId : `` });
  return { sheetId: ss.spreadsheetId, folderId: folder.id, name };
}

async function addDirectoryRow(dirId, user, inv) {
  await sheets.append(dirId, `Inventories!A1`, [objectToRow({ ...inv, addedBy: user.email, addedAt: now(), removed: `` }, DIR_INV_COLS)]);
}

/** Put an existing inventory (one you own) into a group: its folder moves into the group's folder. */
export async function addToGroup(user, inv, groupId) {
  const k = loadKnown(user.email); const group = k.groups[groupId];
  if (!group) throw new Error(`Group not found`);
  if (inv.folderId) {
    const m = await drive.meta(inv.folderId);
    if (!(m.parents || []).includes(groupId)) await drive.move(inv.folderId, groupId, (m.parents || []).join(`,`));
  }
  if (group.dirId) {
    const dir = await readDirectory(group.dirId);
    if (!dir.inventories.some((i) => i.id === inv.sheetId)) await addDirectoryRow(group.dirId, user, { id: inv.sheetId, name: inv.name, folderId: inv.folderId || `` });
  }
  rememberInventory(user.email, inv.sheetId, { groupId });
}

/** Everyone invited here can open every inventory in the group (Drive passes folder access down). */
export async function inviteToGroup(user, groupId, email, role = `writer`) {
  const k = loadKnown(user.email); const group = k.groups[groupId];
  await drive.share(groupId, email, role === `reader` ? `reader` : `writer`, true);
  const person = { email, role: role === `reader` ? `viewer` : `member`, invitedBy: user.email, joinedAt: now() };
  if (group?.dirId) await sheets.append(group.dirId, `People!A1`, [objectToRow(person, DIR_PEOPLE_COLS)]);
  if (group) { group.people = [...(group.people || []), person]; saveKnown(user.email, k); }
  return person;
}

export async function renameInventory(user, inv, name) {
  await drive.rename(inv.sheetId, name);
  if (inv.folderId) await drive.rename(inv.folderId, name).catch(() => {});
  const k = loadKnown(user.email); const groupId = k.inv[inv.sheetId]?.groupId; const dirId = groupId && k.groups[groupId]?.dirId;
  if (dirId) {
    const r = await sheets.get(dirId, `Inventories!A:A`);
    const row = (r.values || []).findIndex((v, i) => i > 0 && v[0] === inv.sheetId);
    if (row > 0) await sheets.update(dirId, `Inventories!B${row + 1}`, [[name]]).catch(() => {});
  }
  rememberInventory(user.email, inv.sheetId, { name });
}

/** What a picked file is: an inventory sheet, a group directory, or neither. */
export async function identify(fileId) {
  const m = await drive.meta(fileId);
  const role = m.appProperties?.stash;
  return { id: fileId, name: m.name, role: role === `sheet` || role === `directory` ? role : ``, parents: m.parents || [], owner: m.owners?.[0]?.emailAddress };
}
