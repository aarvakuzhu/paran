// The help catalog: "How do I…?" topics, shipped with the app (works offline, no AI).
//
// Each topic:
//   id       unique, stable (feedback refers to it)
//   q        the question, as a person would ask it
//   also     other ways people ask it (search matches these too)
//   steps    what to do, in order, using the words on the buttons
//   go       where "Take me there" opens (a #/ route), optional
//   ui       the button it points at on that screen (a CSS selector), optional; it's highlighted
//   screens  route names where it's offered first under "On this screen" (find, item, add, edit, places, place,
//            out, more, more/people, more/ai, more/data, more/stats, more/inventory, setup, group, events, event)
//   covers   the app's actions this topic explains, as kind:value (a: data-a, ev: data-ev, m: data-m, act: data-act).
//            tools/help-check.mjs fails if any action in the code isn't covered here or listed in HELP_IGNORE,
//            or if a topic's ui/covers no longer exist in the code. That's what keeps this file up to date.
//   who      who it's for, when it isn't everyone (shown under the answer)
//
// When a feature changes: update the topic in the same change, then run `node tools/help-check.mjs`.

export const HELP = [
  // ---------------------------------------------------------------- getting started
  { id: `start`, q: `How do I get started?`, also: [`first time`, `begin`, `new here`, `what do I do first`, `setup`, `getting started`],
    steps: [`Tell Paran where you keep things: Places tab → Quick-add rooms and places.`, `Add the things you always hunt for with the + button.`, `Next time, type a word in the search box on Find.`],
    go: `#/setup`, screens: [`find`, `places`, `setup`], covers: [`a:create`], related: [`places-setup`, `add-item`, `find`] },
  { id: `places-setup`, q: `How do I add rooms and places?`, also: [`room`, `closet`, `garage`, `shelf`, `location`, `storage`, `new place`, `where things are kept`],
    steps: [`Open the Places tab.`, `Tap Add a place, or Quick-add rooms and places to pick from common ones.`, `To add a place inside another (a shelf in the garage), open it and tap Add a place inside.`],
    go: `#/places`, ui: `[data-a="new"]`, screens: [`places`, `place`, `setup`], covers: [`a:new`, `m:new`], related: [`place-edit`, `qr`] },
  { id: `place-edit`, q: `How do I rename, move or remove a place?`, also: [`rename room`, `delete place`, `move shelf`, `reorganize`, `change place name`],
    steps: [`Open the place from the Places tab.`, `Tap ⋯ at the top.`, `Choose Rename, Move to another place, or Remove place. Things inside a removed place stay in the inventory without a place.`],
    go: `#/places`, screens: [`place`], covers: [`m:rename`, `m:delete`, `m:open`], related: [`places-setup`] },
  { id: `templates`, q: `Can I start from a ready-made setup?`, also: [`template`, `home template`, `school template`, `office`, `preset`, `starting point`],
    steps: [`When you start a new inventory for the first time, Paran offers My home, Office or small business, and School, temple or community group.`, `Remove what you don’t have and add what’s missing before tapping Create.`, `Later, add more places any time from the Places tab.`],
    screens: [`setup`], related: [`places-setup`] },

  // ---------------------------------------------------------------- items
  { id: `add-item`, q: `How do I add an item?`, also: [`add thing`, `new item`, `log something`, `record`, `put in`, `enter item`, `plus`],
    steps: [`Tap the + button at the bottom.`, `Take a photo (optional), give it a name, say how many and what it’s for.`, `Choose where it is, then Save. Save & add another keeps going.`],
    go: `#/add`, screens: [`find`, `add`, `place`], covers: [`m:add`], related: [`photo-ai`, `scan-many`, `receipt`, `qty`] },
  { id: `qty`, q: `How do I record how many I have?`, also: [`quantity`, `count`, `how many`, `number of`, `more than one`],
    steps: [`On the Add or Edit screen, use − and + under How many.`, `When you add something you already have in the same place, choose I have another and Paran adds to the count.`],
    go: `#/add`, screens: [`add`, `edit`], related: [`add-item`, `duplicates`] },
  { id: `duplicates`, q: `What happens if I add something I already have?`, also: [`duplicate`, `already have`, `same item twice`, `again`],
    steps: [`Paran notices and asks: Open it, It moved here, or I have another (adds to the count).`, `Or choose Save as a new item if it really is a separate thing.`],
    screens: [`add`], covers: [`act:open`, `act:move`, `act:more`], related: [`qty`] },
  { id: `photo-ai`, q: `How do I let AI fill in details from a photo?`, also: [`ai`, `gemini`, `key`, `api key`, `key not working`, `invalid key`, `automatic`, `suggest`, `recognize`, `identify`, `smart`],
    steps: [`Go to More → AI suggestions and tap Set it up.`, `Tap Open Google AI Studio, tap Create API key, then Copy.`, `Come back, tap Paste, then Turn on. From then on, a photo on Add fills in the name, what it’s for and more; you check before saving.`],
    go: `#/more/ai`, ui: `[data-m="aion"]`, screens: [`more/ai`, `add`], covers: [`m:aion`, `m:aikey`, `m:aioff`], related: [`scan-many`, `receipt`, `ai-accuracy`] },
  { id: `scan-many`, q: `How do I add a whole shelf or box at once?`, also: [`bulk`, `many items`, `scan`, `pan camera`, `lots of things`, `quickly add`],
    steps: [`Open the place (a shelf, a bin) from the Places tab.`, `Tap Scan many and move the camera slowly across it.`, `AI lists what it saw; untick anything wrong, fix names, then Add selected.`],
    go: `#/places`, screens: [`place`], covers: [`a:scan`, `m:scan`], who: `Needs AI suggestions turned on.`, related: [`photo-ai`] },
  { id: `receipt`, q: `How do I add things from a receipt?`, also: [`bill`, `purchase`, `bought`, `shopping`, `invoice`, `order`, `price`, `warranty`],
    steps: [`On Add, tap Bought a few things? (or on an event, Bought some? Scan the receipt).`, `Take a photo of the receipt, or choose a screenshot of an online order.`, `Check the list: Paran matches things you already have and what events still need, and checks the prices add up. Then Add.`, `The receipt stays with the items: open an item and tap Receipt.`],
    go: `#/add`, ui: `[data-receipt]`, screens: [`add`, `item`, `event`], covers: [`a:receipt`, `ev:receipt`], who: `Needs AI suggestions turned on.`, related: [`photo-ai`, `event-readiness`] },
  { id: `edit-item`, q: `How do I change an item’s details?`, also: [`edit`, `rename item`, `fix name`, `change`, `update`, `correct`],
    steps: [`Open the item.`, `Tap the pencil (or ⋯ → Edit details).`, `Change what you need and Save.`],
    screens: [`item`, `edit`], covers: [`m:edit`], related: [`history`, `photos`] },
  { id: `photos`, q: `How do I add or change an item’s photos?`, also: [`picture`, `image`, `camera`, `close-up`, `more photos`],
    steps: [`Open the item.`, `Tap Add a photo, or More photos next to its photo for a close-up or a size reference.`, `Tap a photo to see it full size.`],
    screens: [`item`], related: [`edit-item`] },
  { id: `history`, q: `Can I see what changed, or undo a change?`, also: [`history`, `undo`, `log`, `who changed`, `previous`, `restore`, `old value`],
    steps: [`Open the item and scroll to History.`, `Each change shows who made it and what it was before.`, `Tap Restore on an older value to put it back.`],
    screens: [`item`], related: [`edit-item`] },
  { id: `remove-item`, q: `How do I remove an item?`, also: [`delete`, `throw away`, `get rid of`, `gave away`, `sold`],
    steps: [`Open the item.`, `Tap ⋯ → Remove from inventory.`, `It goes from the list; its history stays in the sheet.`],
    screens: [`item`], related: [`missing`] },
  { id: `move`, q: `How do I move an item to another place?`, also: [`moved`, `relocate`, `put away`, `different place`, `change location`],
    steps: [`Open the item and tap Move, then choose the new place.`, `For several at once: open a place, ⋯ → Bring items here, and tick them.`, `On Find or a place, tap Select (or long-press a card) to pick several, then Move.`],
    screens: [`item`, `place`], covers: [`a:move`, `m:move`, `m:bring`], related: [`places-setup`] },
  { id: `qr`, q: `How do I print QR labels for boxes and shelves?`, also: [`label`, `qr code`, `sticker`, `print label`, `scan label`, `barcode`],
    steps: [`Open a place (or an item) and tap QR label (or ⋯ → Print QR label).`, `Print and stick it on the box.`, `Later, tap Scan label on Places and point the camera at it to open that place.`],
    go: `#/places`, ui: `[data-a="scanlabel"]`, screens: [`place`, `places`, `item`], covers: [`a:qr`, `m:qr`, `a:scanlabel`], related: [`places-setup`] },
  { id: `share-item`, q: `How do I share an item or a list with someone?`, also: [`send`, `whatsapp`, `message`, `text`, `share list`],
    steps: [`Open the item or place and tap the share button at the top (or ⋯ → Share what’s here).`, `Pick WhatsApp, Messages or anything on your phone.`],
    screens: [`item`, `place`], covers: [`a:share`, `m:share`], related: [`share-inv`] },

  // ---------------------------------------------------------------- finding
  { id: `find`, q: `How do I find something?`, also: [`where is`, `search`, `locate`, `lost`, `looking for`, `can’t find`, `where did I put`],
    steps: [`On Find, type a word in the search box: a name, what it’s for, a colour.`, `Each result shows the place it’s in. Tap it for the full path.`, `Use the chips under the search box to narrow down.`],
    go: `#/`, ui: `#q`, screens: [`find`], related: [`search-all`, `missing`] },
  { id: `search-all`, q: `Does search look in all my inventories?`, also: [`other inventory`, `everywhere`, `all places`, `storage unit search`],
    steps: [`Yes. Results from the inventory you’re in come first, then “In your other inventories”.`, `An inventory not opened on this phone yet shows Include; tap it once.`, `Tap a result to jump to it.`],
    go: `#/`, screens: [`find`], related: [`inventories`] },

  // ---------------------------------------------------------------- lending
  { id: `lend`, q: `How do I lend something, or note who has it?`, also: [`borrow`, `loan`, `gave`, `friend has`, `who has`, `lent`],
    steps: [`Open the item and tap Lend or reserve.`, `Type who has it and tap Lend.`, `When it comes back, tap Got it back.`],
    go: `#/out`, screens: [`item`, `out`], covers: [`a:lend`, `m:lend`, `a:return`], related: [`reserve`, `out`] },
  { id: `reserve`, q: `How do I set something aside for someone to pick up?`, also: [`reserve`, `hold`, `pick up`, `set aside`, `keep for`],
    steps: [`Open the item, tap Lend or reserve, then choose Reserve and a pick-up date.`, `When they collect it, tap Picked up. To cancel, tap Cancel reservation.`],
    screens: [`item`, `out`], covers: [`a:pickup`, `a:unsave`, `m:reserve`], related: [`lend`, `event-reserve`] },
  { id: `out`, q: `Who has my things right now?`, also: [`out`, `lent out`, `overdue`, `late`, `borrowed`, `who has what`],
    steps: [`Open the Out tab: everything lent or reserved, by person.`, `Late pick-ups are at the top and counted on the tab.`, `Tap a person to see everything they have.`],
    go: `#/out`, screens: [`out`], related: [`lend`] },
  { id: `missing`, q: `How do I mark something as missing, or found?`, also: [`missing`, `lost`, `can’t find it`, `found it`],
    steps: [`Open the item and tap ⋯ → Mark as missing.`, `It shows under Needs attention on Find.`, `When it turns up, tap Found it.`],
    screens: [`item`, `find`], covers: [`m:missing`, `m:found`, `a:found`], related: [`find`] },

  // ---------------------------------------------------------------- inventories, groups, people
  { id: `inventories`, q: `What is an inventory, and how do I add another?`, also: [`second home`, `lake house`, `storage unit`, `another place`, `new inventory`, `separate list`],
    steps: [`An inventory is one place’s list with its own places, people and history (your home, a storage unit, an office).`, `Tap the inventory name at the top → New inventory.`, `Search covers all of them.`],
    screens: [`more/inventory`, `group`], covers: [`a:newinv`, `m:newinv`], related: [`switch`, `group`] },
  { id: `switch`, q: `How do I switch between inventories?`, also: [`change inventory`, `other inventory`, `open another`, `go to`],
    steps: [`Tap the inventory name at the top of the screen.`, `Pick the one you want from Your inventories.`],
    screens: [`more/inventory`, `group`], covers: [`m:switch`, `a:list`], related: [`inventories`] },
  { id: `rename-inv`, q: `How do I rename an inventory?`, also: [`rename`, `change name`],
    steps: [`Go to More → the inventory’s name → Rename this inventory.`, `The sheet and folder in Google Drive are renamed too.`],
    go: `#/more/inventory`, screens: [`more/inventory`], related: [`inventories`] },
  { id: `group`, q: `What is a group, and how do I make one?`, also: [`organization`, `school`, `temple`, `community`, `family`, `our homes`, `team`],
    steps: [`A group holds several inventories (the school building, the storage unit) so people and events can use them all.`, `Tap the inventory name at the top → New group.`, `On the group page, New inventory in the group adds one, and Add “this inventory” to this group moves the one you have open into it.`],
    screens: [`group`, `more/inventory`], covers: [`m:newgroup`, `a:addcur`], related: [`share-group`, `events-what`] },
  { id: `share-inv`, q: `How do I share an inventory with someone?`, also: [`invite`, `share`, `add person`, `family member`, `wife`, `husband`, `volunteer`, `give access`, `let someone see`, `see my inventory`, `use it together`, `access`],
    steps: [`Go to More → People & access.`, `Type their Google email, choose Can edit or Can view, and tap Invite.`, `They open Paran, sign in, choose Open one shared with you and pick the inventory.`],
    go: `#/more/people`, screens: [`more/people`], related: [`roles`, `share-group`, `join`] },
  { id: `share-group`, q: `How do I give someone the whole group?`, also: [`whole group`, `all inventories`, `group access`, `invite to group`],
    steps: [`Open the group page (tap the inventory name at the top → the group).`, `Invite them there with their Google email; they can open every inventory in it and its events.`, `On People & access, Give whole group upgrades someone who has one inventory.`],
    screens: [`group`, `more/people`], related: [`share-inv`, `roles`] },
  { id: `roles`, q: `Can someone only view, not change things?`, also: [`view only`, `read only`, `permission`, `access level`, `can edit`, `can view`, `viewer`, `only look`, `only see`, `not change`],
    steps: [`When inviting, choose Can view: they can search and browse but not change anything.`, `To change it later, the owner taps the person on People & access.`],
    go: `#/more/people`, screens: [`more/people`, `group`], related: [`share-inv`, `people-change`] },
  { id: `people-change`, q: `How do I remove someone or change their access?`, also: [`remove person`, `stop sharing`, `revoke`, `change role`, `make owner`, `transfer`],
    steps: [`Go to More → People & access (or the group page).`, `Tap the person, then choose Can edit, Can view, Remove, or Make them the owner.`],
    go: `#/more/people`, screens: [`more/people`, `group`], who: `Only the owner can change people.`, related: [`roles`] },
  { id: `join`, q: `Someone shared Paran with me. How do I open it?`, also: [`shared with me`, `join`, `invited`, `open shared`, `sign in`],
    steps: [`Open Paran and sign in with the Google account they invited.`, `Choose Open one shared with you.`, `Pick the inventory, or “<group> – directory” for a whole group, and tick its inventories when asked.`],
    screens: [`more/inventory`], covers: [`m:join`, `m:google`], related: [`share-inv`] },

  // ---------------------------------------------------------------- events
  { id: `events-what`, q: `What are events for, and how do I make one?`, also: [`event`, `party`, `graduation`, `annual day`, `pongal`, `diwali`, `camping`, `function`, `program`, `plan`],
    steps: [`An event is what you gather for something: a graduation, a party, a trip.`, `Go to More → Events → New event.`, `Events belong to a group; if your inventory isn’t in one, Paran sets one up first.`],
    go: `#/events`, ui: `[data-ev="new"]`, screens: [`events`], covers: [`ev:new`], who: `Events are for people with access to the whole group.`, related: [`event-words`, `event-add`] },
  { id: `event-words`, q: `Can I make the event’s list from a description or a list I already have?`, also: [`paste list`, `whatsapp list`, `describe`, `ai list`, `checklist`, `from text`],
    steps: [`On a new event, write what it needs in What does it need?, or on an event tap From a list.`, `Describe it (“graduation for 200 in the gym…”) or paste your list.`, `Check the list: each line shows what it found in your inventories. Untick, rename or change counts, then Add.`],
    screens: [`event`, `events`], covers: [`ev:words`], who: `Needs AI suggestions turned on.`, related: [`event-add`, `photo-ai`] },
  { id: `event-add`, q: `How do I add things to an event?`, also: [`add to event`, `event items`, `needed`, `checklist`, `sections`],
    steps: [`Open the event and tap Add items.`, `Tick things from your inventories, or type something nobody has logged and tap Add.`, `Group them in sections like Stage or Food; tap Done.`],
    screens: [`event`], covers: [`ev:add`], related: [`event-words`, `event-readiness`, `event-sections`] },
  { id: `event-readiness`, q: `How do I see what’s ready and what’s still needed for an event?`, also: [`ready`, `missing`, `still needed`, `shopping list`, `to buy`, `short`, `print list`],
    steps: [`Open the event: the bar shows how many things are ready.`, `Tap a filter (Short, With someone, Not in inventory) to see those.`, `Still needed lists what to buy, borrow, get back or find, with Share and Print.`],
    screens: [`event`], covers: [`ev:needshare`, `ev:needprint`], related: [`event-assign`, `receipt`] },
  { id: `event-assign`, q: `How do I assign who brings what?`, also: [`assign`, `volunteer`, `who brings`, `bring`, `responsible`, `remind`, `task`],
    steps: [`Open the event, tap a line, and add people under Who’s bringing it (with how many each).`, `People with access get it on their home screen under You’re bringing.`, `Remind sends each person their list.`],
    screens: [`event`], covers: [`ev:remind`], related: [`youre-bringing`] },
  { id: `youre-bringing`, q: `Where do I see what I’m bringing?`, also: [`my tasks`, `assigned to me`, `what do I bring`, `my list`, `mark done`],
    steps: [`It’s on Find (the home screen) under You’re bringing.`, `Tap Mark done when you’ve got it; the organizer sees ✓ done.`],
    go: `#/`, screens: [`find`], related: [`event-assign`] },
  { id: `event-dayof`, q: `How do I check things off on the day?`, also: [`day of`, `arrived`, `tick off`, `check in`, `brought`],
    steps: [`Open the event and tap Day of.`, `Tick each thing as it arrives (or count, for several), and who brought it.`, `Share what’s not here yet sends the gaps to the group.`],
    screens: [`event`], covers: [`ev:missingshare`], related: [`event-after`] },
  { id: `event-after`, q: `What do I do after the event?`, also: [`after`, `put back`, `return`, `clean up`, `damaged`, `used up`],
    steps: [`Open the event and tap After.`, `For each thing: Back in place, Somewhere else, Missing, Damaged, Keep it or Used up.`, `Share where things went sends the summary.`],
    screens: [`event`], covers: [`ev:aftershare`], related: [`event-copy`] },
  { id: `event-copy`, q: `How do I reuse last year’s event?`, also: [`copy event`, `next year`, `repeat`, `reuse`, `duplicate event`],
    steps: [`Open last year’s event.`, `Tap Copy for next time (or ⋯ → Copy for next time) and give it a date.`],
    screens: [`event`], covers: [`ev:copy`, `m:copy`], related: [`events-what`] },
  { id: `event-reserve`, q: `How do I hold the event’s items so nobody else takes them?`, also: [`reserve for event`, `hold items`, `book`],
    steps: [`Open the event, tap ⋯ → Reserve its items.`, `They show as reserved until you mark them Back in place after the event.`],
    screens: [`event`], related: [`reserve`, `event-after`] },
  { id: `event-sections`, q: `How do I rename a section of an event?`, also: [`section`, `rename section`, `group lines`],
    steps: [`Open the event, tap ⋯ → Rename a section.`],
    screens: [`event`], covers: [`m:sections`], related: [`event-add`] },
  { id: `event-share`, q: `How do I share or print an event’s list?`, also: [`print event`, `share event`, `send list`],
    steps: [`Open the event and tap the share button at the top.`, `Share sends it as text; Print makes a page (or a page per person).`],
    screens: [`event`], covers: [`ev:share`], related: [`event-readiness`] },

  // ---------------------------------------------------------------- data, account, app
  { id: `data`, q: `Where is my data, and can I get a copy?`, also: [`google drive`, `sheet`, `backup`, `export`, `csv`, `download`, `privacy`, `spreadsheet`],
    steps: [`Everything is in your own Google Drive, in a Paran folder; Paran has no server.`, `More → Your data has the sheets (for owners) and Download this inventory (CSV).`],
    go: `#/more/data`, screens: [`more/data`], covers: [`m:csv`], related: [`offline`] },
  { id: `offline`, q: `Does it work without internet?`, also: [`offline`, `no signal`, `no wifi`, `sync`, `not saved`, `refresh`],
    steps: [`Yes. Changes are kept on the phone and saved to Google when you’re back online; the pill at the top says Saved when done.`, `More → Your data → Refresh now checks for others’ changes.`],
    screens: [`more/data`], covers: [`m:sync`], related: [`data`] },
  { id: `activity`, q: `What does Your activity show?`, also: [`stats`, `usage`, `how much`, `counts`, `tracking`],
    steps: [`More → Your activity shows what you’ve done in Paran: days used, items added, searches, events and AI.`, `It stays on this phone and isn’t sent anywhere; the switch there turns it off and deletes it.`],
    go: `#/more/stats`, screens: [`more/stats`], related: [`ai-accuracy`] },
  { id: `ai-accuracy`, q: `How accurate is AI?`, also: [`accuracy`, `wrong`, `mistake`, `ai wrong`, `how good`],
    steps: [`More → AI suggestions shows how often its suggestions were kept, as % right, for photos, receipts and event lists.`, `You always check before anything is saved.`],
    go: `#/more/ai`, screens: [`more/ai`], related: [`photo-ai`] },
  { id: `update`, q: `How do I get the latest version?`, also: [`update`, `new version`, `upgrade`, `not loading`, `stuck`, `reload`],
    steps: [`Paran updates itself; when a new version is ready it offers Reload.`, `If it won’t open, the start screen says why and offers Get the latest version. Your inventory stays as it is.`],
    screens: [`more`], covers: [`m:about`], related: [`offline`] },
  { id: `signout`, q: `How do I sign out, or use another Google account?`, also: [`log out`, `sign out`, `switch account`, `other account`],
    steps: [`Go to More → Sign out.`, `Sign in again with the other account.`],
    screens: [`more`], covers: [`m:signout`], related: [`join`] },
  { id: `demo`, q: `What is demo mode?`, also: [`demo`, `try`, `sample`, `without account`, `clear demo`],
    steps: [`Demo mode lets you try Paran with sample data, kept only in this browser.`, `More → Clear demo data starts it fresh; Sign in with Google uses your own Drive.`],
    screens: [`more`], covers: [`m:reset`], related: [`start`] },
  { id: `help`, q: `How do I use this help?`, also: [`help`, `question mark`, `support`, `how to`, `ask`, `ask ai`, `chat`, `assistant`],
    steps: [`Tap ? at the top of any screen; it starts with what’s on that screen.`, `Type your question in your own words.`, `With AI suggestions on, tap Ask AI (or press Enter) for a direct answer from Paran’s help, with the topics it came from; you can ask one follow-up.`, `Take me there opens the right screen; tell us if something’s missing.`],
    screens: [], related: [`start`] },
];

/** Actions in the code that don't need their own topic (navigation, closing, generic menus). */
export const HELP_IGNORE = [`a:back`, `a:cancel`, `a:menu`, `ev:menu`];

// ---------------------------------------------------------------- search (offline)
const STOP = new Set(`a an the i me my we our you your to do does did can could how what where when which who is are was it its of in on at for with and or from this that there here be get got want need please should would will any some`.split(` `));
// words people use that mean the same thing as words in the catalog
const SAME = { delete: `remove`, erase: `remove`, trash: `remove`, rename: `rename`, borrow: `lend`, loan: `lend`, gave: `lend`, lent: `lend`, invite: `share`, add: `add`, picture: `photo`, pic: `photo`, image: `photo`, location: `place`, room: `place`, spot: `place`, thing: `item`, stuff: `item`, things: `item`, items: `item`, quantity: `qty`, number: `qty`, count: `qty`, lost: `missing`, misplaced: `missing`, find: `find`, search: `find`, locate: `find`, look: `find`, list: `list`, people: `person`, family: `person`, friend: `person`, wife: `person`, husband: `person`, kid: `person`, kids: `person`, bill: `receipt`, receipts: `receipt`, party: `event`, function: `event`, program: `event`, events: `event`, ai: `ai`, gemini: `ai` };
const stem = (w) => SAME[w] || SAME[w.replace(/(ies)$/, `y`)] || w.replace(/(ing|ed|es|s)$/, ``) || w;
const words = (t) => String(t || ``).toLowerCase().replace(/[’']/g, ``).split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w)).map(stem);

let index = null; let idf = null;
function buildIndex() {
  index = HELP.map((t) => ({ t, q: new Set(words(t.q)), also: new Set(t.also.flatMap(words)), body: new Set(t.steps.flatMap(words)) }));
  // rare words tell topics apart ("wife", "label"); words in many topics ("item", "tap") count for little
  const df = new Map();
  for (const e of index) for (const w of new Set([...e.q, ...e.also, ...e.body])) df.set(w, (df.get(w) || 0) + 1);
  idf = (w) => Math.log(1 + index.length / (df.get(w) || 1));
}

/**
 * Best topics for a question. screen (route name, or more/<page>) lifts topics for that screen a little.
 * Returns [{ topic, score }] best first, only those that match at all.
 */
export function searchHelp(query, screen = ``) {
  if (!index) buildIndex();
  const qw = [...new Set(words(query))];
  if (!qw.length) return [];
  const near = (w, set) => set.has(w) || (w.length >= 4 && [...set].some((x) => x.length >= 4 && (x.startsWith(w) || w.startsWith(x))));
  const out = [];
  for (const e of index) {
    let s = 0;
    for (const w of qw) s += (near(w, e.q) ? 3 : near(w, e.also) ? 2.5 : near(w, e.body) ? 1 : 0) * idf(w) / 2;
    if (!s) continue;
    s = s / Math.sqrt(qw.length);
    if (screen && e.t.screens.includes(screen)) s += 0.75;
    out.push({ topic: e.t, score: Math.round(s * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Topics offered first on a screen. */
export function topicsFor(screen) { return HELP.filter((t) => t.screens.includes(screen)); }
export const topicById = (id) => HELP.find((t) => t.id === id);
