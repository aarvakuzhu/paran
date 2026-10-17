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
