# Tests

`access_e2e.py` runs Paran in a headless browser as four Google accounts against `fake_google.py`, an in-memory
stand-in for Drive and Sheets that enforces sharing (with folder inheritance), `drive.file` visibility (the app only
sees files a person created with it or picked) and refuses writes from viewers.

It covers: first inventory under a "Paran" folder; sharing one inventory; New event putting the inventory in a group
first; whole-group invites (edit and view); assigning a line to an inventory-only person (task in that inventory);
that person seeing it on home, marking it done, and not being able to open the event; a group editor and a group viewer;
the owner on a new phone; Your data links; and that nothing is created in a viewer's Drive.

    python3 -m http.server 8080        # from the repo root, in another terminal
    pip install playwright && python3 tests/access_e2e.py

Exits non-zero if any check fails.

`ai_flows.py` (demo mode, Gemini answered by a stand-in in the real API's shape) covers an event made from a
description and a receipt read into items: matching to existing items (including the same thing kept in two places),
event lines turning ready, price/store/date/warranty captured, one shared receipt photo, and no card digits stored.

    pip install pillow && python3 tests/ai_flows.py

`templates_first_run.py` (strict fake Google) starts three new people: a group template edited before creating
(places removed and added, an inventory renamed and one added; the group, its inventories and their places all made
in Drive), the home template as is, and an empty start.

    python3 tests/templates_first_run.py

`help_flows.py` (demo mode): ? on every screen with that screen's topics first, search on real phrasings, a question
about your things handed to item search, **Take me there for every topic** (its screen opens and the button it
points at exists), and feedback kept and listed in Your activity. `node tools/help-check.mjs` checks the catalog
against the code without a browser.

`help_ask.py` (demo, stand-in Gemini): Ask AI only with AI on; the answer with its source topics and Take me there;
8 topics, the right one among them, a who/where line and no inventory contents sent; one follow-up carrying the first
question and answer; made-up topic ids dropped; "not in help yet" and Gemini errors (Try again, matches still
listed); questions about your things never sent; feedback and counts kept.
