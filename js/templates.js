// Starting points for someone new: a ready outline of inventories and places they edit (remove, rename, add)
// before anything is created. Kept to three; "Start empty" is always there.
import { esc, $, promptSheet, icon } from './ui.js';

export const TEMPLATES = [
  {
    id: `home`, icon: `home`, title: `My home`, blurb: `The house, room by room. Add a storage unit or a second home any time.`,
    inventories: [{
      name: `Home`,
      places: [
        { name: `Kitchen`, rooms: [`Pantry`, `Under the sink`, `Drawers`] },
        { name: `Garage`, rooms: [`Shelves`, `Workbench`, `Cabinets`] },
        { name: `Bedrooms`, rooms: [`Main bedroom`, `Kids’ room`, `Guest room`] },
        { name: `Closets`, rooms: [`Hall closet`, `Coat closet`, `Linen closet`] },
        { name: `Living room`, rooms: [] },
        { name: `Laundry`, rooms: [] },
        { name: `Basement or attic`, rooms: [`Storage boxes`] },
      ],
    }],
  },
  {
    id: `office`, icon: `room`, title: `Office or small business`, blurb: `Supplies, equipment and who has what.`,
    inventories: [{
      name: `Office`,
      places: [
        { name: `Supply closet`, rooms: [`Paper and printing`, `Stationery`] },
        { name: `Storage room`, rooms: [`Shelves`, `Archive boxes`] },
        { name: `Desks`, rooms: [] },
        { name: `Kitchenette`, rooms: [] },
        { name: `IT and AV`, rooms: [`Cables and chargers`, `Spare devices`] },
      ],
    }],
  },
  {
    id: `group`, icon: `users`, title: `School, temple or community group`, blurb: `A group with its building and a storage unit; events can use both.`,
    group: ``, groupPlaceholder: `e.g. Tamil School`,
    inventories: [
      {
        name: `Main building`,
        places: [
          { name: `Hall or stage`, rooms: [`Stage closet`, `AV cabinet`] },
          { name: `Office`, rooms: [`Supply cabinet`] },
          { name: `Classrooms`, rooms: [] },
          { name: `Kitchen`, rooms: [`Pantry`] },
        ],
      },
      { name: `Storage unit`, places: [{ name: `Shelves`, rooms: [`Shelf 1`, `Shelf 2`] }, { name: `Bins on the floor`, rooms: [] }] },
    ],
  },
];

const copy = (t) => JSON.parse(JSON.stringify(t));

/**
 * Pick a starting point, then edit it. Resolves { group?, inventories: [{ name, places: [{ name, rooms }] }] },
 * { empty: true, name } for an empty start, or null if they go back.
 */
export function chooseTemplate(root) {
  return new Promise((resolve) => {
    let t = null;
    const pick = () => {
      root.innerHTML = `<main class="welcome tpl">
        <h1>What are you setting up?</h1>
        <p class="lead">Pick the closest. You’ll see the places first and can remove, rename or add before anything is made.</p>
        <div class="choice-grid">${TEMPLATES.map((x) => `<button class="choice" data-tpl="${x.id}">${icon(x.icon)}<b>${esc(x.title)}</b><span>${esc(x.blurb)}</span></button>`).join(``)}</div>
        <div class="row-actions center"><button type="button" class="btn ghost" data-back>Back</button><button type="button" class="link" data-empty>Start empty instead</button></div>
      </main>`;
      root.onclick = async (e) => {
        if (e.target.closest(`[data-back]`)) return resolve(null);
        if (e.target.closest(`[data-empty]`)) {
          const name = await promptSheet(`Name your inventory`, { label: `Name`, value: `My home`, placeholder: `e.g. My home, Lake house, Tamil School`, okLabel: `Create` });
          if (name) resolve({ empty: true, name });
          return;
        }
        const b = e.target.closest(`[data-tpl]`); if (!b) return;
        t = copy(TEMPLATES.find((x) => x.id === b.dataset.tpl)); edit();
      };
    };
    const count = () => t.inventories.reduce((a, inv) => a + inv.places.length + inv.places.reduce((x, p) => x + p.rooms.length, 0), 0);
    const edit = () => {
      root.onclick = null; // the picker's handler; the editor's is below
      const multi = t.group !== undefined;
      root.innerHTML = `<main class="welcome tpl tpl-edit">
        <h1>${esc(t.title)}</h1>
        <p class="lead">Remove what you don’t have, add what’s missing. You can change all of it later too.</p>
        ${multi ? `<label class="field"><span>Group name</span><input data-gname value="${esc(t.group)}" placeholder="${esc(t.groupPlaceholder)}" required></label>` : ``}
        ${t.inventories.map((inv, i) => `<section class="tpl-inv">
          <div class="tpl-invhead">${icon(`box`)}<input data-iname="${i}" value="${esc(inv.name)}" aria-label="Inventory name">
            ${t.inventories.length > 1 ? `<button type="button" class="icon-btn" data-rminv="${i}" aria-label="Remove ${esc(inv.name)}">${icon(`x`)}</button>` : ``}</div>
          ${inv.places.map((p, j) => `<div class="tpl-place">
            <div class="tpl-ptop">${icon(`place`)}<input data-pname="${i}:${j}" value="${esc(p.name)}" aria-label="Place name">
              <button type="button" class="icon-btn" data-rmplace="${i}:${j}" aria-label="Remove ${esc(p.name)}">${icon(`x`)}</button></div>
            <div class="chips">${p.rooms.map((r, k) => `<span class="chip on tpl-room">${esc(r)}<button type="button" data-rmroom="${i}:${j}:${k}" aria-label="Remove ${esc(r)}">${icon(`x`)}</button></span>`).join(``)}
              <button type="button" class="chip add" data-addroom="${i}:${j}">${icon(`plus`)} Inside ${esc(p.name)}</button></div>
          </div>`).join(``)}
          <button type="button" class="link small" data-addplace="${i}">${icon(`plus`)} Add a place</button>
        </section>`).join(``)}
        ${multi ? `<button type="button" class="btn ghost" data-addinv>${icon(`plus`)} Add another inventory</button>
          <p class="fine">Each inventory can be shared on its own; the group shares them all, with its events.</p>` : ``}
        <div class="form-actions"><button type="button" class="btn ghost" data-back>Back</button>
          <button type="button" class="btn primary big" data-create>Create${count() ? ` with ${count()} place${count() === 1 ? `` : `s`}` : ``}</button></div>
      </main>`;
    };
    root.oninput = (e) => {
      const x = e.target;
      if (x.dataset.gname !== undefined) t.group = x.value;
      else if (x.dataset.iname) t.inventories[x.dataset.iname].name = x.value;
      else if (x.dataset.pname) { const [i, j] = x.dataset.pname.split(`:`); t.inventories[i].places[j].name = x.value; }
    };
    root.addEventListener(`click`, async (e) => {
      if (!t || !root.querySelector(`.tpl-edit`)) return;
      const b = e.target.closest(`button`); if (!b) return;
      const d = b.dataset;
      if (d.back !== undefined) { t = null; return pick(); }
      if (d.rminv) { t.inventories.splice(Number(d.rminv), 1); return edit(); }
      if (d.rmplace) { const [i, j] = d.rmplace.split(`:`); t.inventories[i].places.splice(Number(j), 1); return edit(); }
      if (d.rmroom) { const [i, j, k] = d.rmroom.split(`:`); t.inventories[i].places[j].rooms.splice(Number(k), 1); return edit(); }
      if (d.addroom) {
        const [i, j] = d.addroom.split(`:`);
        const name = await promptSheet(`Inside ${t.inventories[i].places[j].name}`, { label: `Name`, placeholder: `e.g. Top shelf, Blue bin`, okLabel: `Add` });
        if (name) t.inventories[i].places[j].rooms.push(name); return edit();
      }
      if (d.addplace) {
        const name = await promptSheet(`Add a place`, { label: `Name`, placeholder: `e.g. Shed, Car, Parents’ house`, okLabel: `Add` });
        if (name) t.inventories[d.addplace].places.push({ name, rooms: [] }); return edit();
      }
      if (d.addinv !== undefined) {
        const name = await promptSheet(`Add an inventory`, { label: `Name`, placeholder: `e.g. Volunteer’s garage, Second building`, okLabel: `Add` });
        if (name) t.inventories.push({ name, places: [] }); return edit();
      }
      if (d.create !== undefined) {
        const clean = (s) => String(s || ``).trim();
        if (t.group !== undefined && !clean(t.group)) { $(`[data-gname]`, root)?.focus(); return; }
        const inventories = t.inventories.map((inv) => ({ name: clean(inv.name) || `Inventory`, places: inv.places.filter((p) => clean(p.name)).map((p) => ({ name: clean(p.name), rooms: p.rooms.map(clean).filter(Boolean) })) }));
        resolve({ group: t.group !== undefined ? clean(t.group) : undefined, inventories });
      }
    });
    pick();
  });
}
