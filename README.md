# Stash – Home Inventory (PWA)

Know what you have, where it is, and what it's for. A static web app (no server, no database) that keeps everything in **the user's own Google Drive**:

```
My Drive/
└── Stash – Home Inventory/
    ├── Stash Inventory        ← Google Sheet: Items, Locations, Members, Log tabs
    └── Photos/                ← full-size photos (≤1600px JPEG)
```

The app only asks for the `drive.file` scope, so it can see **only the files it created** (or the one sheet a family member picks to join). It cannot read anything else in the user's Drive.

## What's in v1

- **Quick capture:** photo (resized on the phone), name, what it's for, location, optional category/tags/qty/warranty/expiry/notes. "Save & add another" keeps the same location for bulk logging.
- **Location hierarchy:** Place → Room → Container, with any depth. Recently used spots appear first.
- **Search by purpose:** matches name, "what it's for", tags, category, location and notes, with prefix and typo tolerance and a few synonyms ("fix a leak" finds plumber's tape). Every word must match.
- **Moving things around (every move has Undo):**
  - *One item:* **Move** on the item screen.
  - *Several items:* tap **Select** above any list (or long-press a card), tick items, then **Move**.
  - *From the destination:* open a place and tap **Bring items here** to search and tick items from anywhere.
  - *A whole bin or shelf:* open it and tap **Move this spot**; everything inside goes with it.
  - The place picker has a search box ("box 3", "garage shelf") and can create a new spot on the spot.
- **Save for later:** **Lend / Save** on an item has two modes. *Lend now* is one tap on a name. *Save for later* reserves it for someone with an optional pick-up-by date (Today, Tomorrow, In 3 days, Next week, or any date). Saved items show "Saved for Ravi · pick up by Thu" (red once late), stay saved if moved, and appear under the **Saved for someone** filter and in the person's view. **Picked up** turns it into a lend; **Cancel** (with Undo) releases it. Lending something saved for someone else asks first. The date is stored in a new `dueAt` column, added automatically to older sheets after `thumb`.
- **Photos open inside the app:** tap an item's photo for full screen. Full-size photos are cached on the phone (most recent 150), so they open instantly and offline. Photos another family member added show the preview, with a link to their Drive for the original.
- **Item history:** each item's page ends with a **History** list, newest first (last 5, then *Show all*): added, moved (from → to), edited (what changed, e.g. "Name: Stud finder → Zircon stud finder · Qty: 1 → 2"), saved for (with pick-up-by date), picked up, lent, returned, missing/found, with date, time and who did it when it wasn't you.
- **People you lend to:** "Lend" takes a free-text name and drops down matching people you've lent to before (typing "RAVI" reuses "Ravi", so one person stays one person). Tap a borrower's name (on an item, in the **Lent out** filter's "Who has your things" strip, or in **More → People you lend to**) to see what they have now with *Got it back* / *Got everything back*, and their full history of items borrowed and returned with dates. People are derived from the **Log** tab, so there's no separate list to maintain.
- **Duplicate check (on the phone, no AI):** saving a new item whose name matches an existing one (plurals, punctuation, small typos and word order ignored) asks first: *Open it*, *Same one, it's here now* (moves it), *I have another (+qty)*, or *Save as a new item*. Matches in the same place are flagged more readily. In the AI multi-item review, items already in the chosen place are labelled "Already here" and start unticked. Save locks after the first tap.
- **Status:** Move, Lend (who has it), Got it back, Can't find / Found it. Every change is appended to the **Log** tab.
- **QR labels:** print a label for any bin or shelf. Scanning it with the phone camera opens that place in the app.
- **Family sharing:** the owner invites by email (edit access to the sheet, view access to photos). The family member signs in and picks "Join a shared inventory".
- **Offline:** the app shell is cached and data is cached on the device. Changes made offline queue up and sync when the connection returns.
- **Export:** CSV (opens in Excel), or just open the Google Sheet.
- **AI suggestions (optional, off by default):** each user turns it on in **More → AI suggestions**, agrees to a plain-language notice, and pastes their own Gemini API key from aistudio.google.com/apikey. The key is stored only on that device, never in the Sheet. A per-photo switch on the Add screen ("Identify with AI when I take a photo") controls whether a photo is analyzed.
  - One item in the photo: empty fields are filled and marked "AI suggested" until edited. Anything the user typed is never overwritten.
  - Several items (an open bin or shelf): a review sheet lists each with a cropped photo. Untick, rename, choose the location, then **Add selected**.
  - Model `gemini-3.5-flash-lite` (falls back to `gemini-3.1-flash-lite`). Calls are paced under 15 per minute; hitting the daily limit shows a clear message and the user carries on manually.
  - Free-tier note shown at opt-in: Google may use free-tier content to improve its products, so don't analyze IDs or private documents.
- **Demo mode:** try everything without Google; data stays in that browser.

## Run it locally

```bash
cd stash
python3 -m http.server 8080
# open http://localhost:8080  → "Try it without an account"
```

It has to be served over http(s), not opened as a file, because it uses ES modules and a service worker.

## Google Cloud setup (one time, about 10 minutes)

1. Go to <https://console.cloud.google.com/>, create a project (e.g. `stash-inventory`).
2. **APIs & Services → Library:** enable **Google Drive API**, **Google Sheets API**, and **Google Picker API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - User type **External**, app name "Stash", your email as support contact.
   - Data access → add scope `.../auth/drive.file` (plus `openid`, `email`, `profile`).
   - Audience → while in **Testing**, add each family member's Gmail under **Test users** (up to 100). Users not on the list can't sign in until you publish the app.
4. **Credentials → Create credentials → OAuth client ID** → type **Web application**.
   - Authorized JavaScript origins: `http://localhost:8080` and your hosting origin, e.g. `https://aarvakuzhu.github.io`. Origins only, with no path and no trailing slash.
   - No redirect URIs are needed (the app uses the popup token flow).
   - Copy the **Client ID** into `CLIENT_ID` in `js/config.js`.
5. **Credentials → Create credentials → API key** → restrict it to **Google Picker API** and to your website origins (HTTP referrers). Put it in `API_KEY`.
6. **Project number** (Dashboard → Project info, digits only) → `APP_ID`. The Picker needs it so a joined sheet is granted to the app.

The Client ID and API key are not secrets in a browser app; they are protected by the origin restrictions above.

## Host on GitHub Pages

1. Create a repo (e.g. `aarvakuzhu/stash`) and push the contents of this folder to `main`.
2. Repo **Settings → Pages → Deploy from branch → main / (root)**.
3. The app is at `https://aarvakuzhu.github.io/stash/`. Make sure `https://aarvakuzhu.github.io` is in the OAuth client's JavaScript origins.
4. On the phone, open the URL, then **Share → Add to Home Screen** (iOS) or **Install app** (Android Chrome).

After changing files, bump `VERSION` in `sw.js` so installed copies pick up the update.

## How sharing works (and its limits)

- The owner taps **More → Invite**. That shares the sheet (edit) and the root folder (view) with the email and adds a row to **Members**.
- The family member opens Stash, signs in, and chooses **Join a shared inventory**. The Google Picker grants the app access to that one sheet.
- Each item stores a small thumbnail (≈20 KB) inside the sheet, so **everyone always sees every photo thumbnail**. The full-size photo opens in Drive.
- Photos a family member adds go to a "Stash photos (shared inventory)" folder in *their* Drive. It is shared with everyone on the Members list at the time they join; people invited later see the thumbnail, and need the photo shared to open the full size.

## Data model (Google Sheet)

| Tab | Columns |
|---|---|
| Items | id, name, purpose, category, tags, locationId, qty, status (home/lent/reserved/missing), lentTo (person), photoId, photoUrl, warranty, expiry, notes, addedBy, addedAt, updatedAt, updatedBy, deleted, thumb, dueAt (pick-up-by date) |
| Locations | id, name, parentId, kind (place/room/container), notes, createdBy, createdAt, deleted |
| Members | email, role, photoFolderId, invitedBy, joinedAt |
| Log | ts, itemId, action, detail, by, info (what changed / moved from / pick-up date) |

Rules for editing the sheet by hand: it's fine to edit cell values and to sort or filter **in a filter view**. Don't delete rows or rename the header row, because the app matches rows by `id` and columns by header name. Removing an item in the app sets `deleted`; it never deletes rows.

## Known limits in v1

- **Sign-in:** a browser-only app can't hold a long-lived Google session (that needs a server). Stash keeps Google's one-hour pass across app restarts, always opens straight into your inventory from the phone's copy, and renews the pass on your first tap after it runs out, using your saved account, so you normally see at most a brief Google popup and no account picker. Edits made meanwhile wait in the queue; the pill shows **Tap to sync**.
- If two people edit the *same* item at the same moment, the last save wins.
- AI suggestions use each user's own Gemini quota; the "photos analyzed today" count is per device, while Google's limit is per key's project.
- Google accounts only.

## Files

```
index.html              app shell
manifest.webmanifest    install metadata
sw.js                   offline cache for the app files (never caches Google data calls)
css/app.css             styles, light + dark
js/config.js            ← your Client ID, API key, project number
js/google.js            sign-in, Drive, Sheets, Picker wrappers
js/store.js             data layer: cache, offline outbox, Google + demo backends
js/search.js            purpose-aware search
js/ai.js                optional Gemini suggestions (consent, key check, pacing, quota errors)
js/image.js             on-device photo resize + thumbnail
js/ui.js                sheets, toasts, icons
js/app.js               screens and routing
icons/                  app icons
```
