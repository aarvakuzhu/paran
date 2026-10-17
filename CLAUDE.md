# Working on Paran

- **Help stays in step with features.** Any change that adds, removes, renames or changes what a button or screen does
  must update `js/help.js` in the same commit: the topic's steps (in the words on the buttons), `covers`, `ui`,
  `screens` and `go`. Add a topic for anything new a person might ask "how do I…?" about. Then run
  `node tools/help-check.mjs`; it fails when an action in the code has no topic, a topic points at something gone,
  or a screen has no topic. GitHub runs the same check on every push (`.github/workflows/checks.yml`).
- Bump `VERSION` in `sw.js` for every change that ships, and add new modules to its file list and to the
  modulepreload links in `index.html`.
- Keep `README.md` describing what's built; tests live in `tests/` (see `tests/README.md`).
- **Layout:** nothing may make a screen wider than the phone (it drags the fixed tab bar sideways). Grid/flex children
  that hold text, inputs or many small items need `min-width: 0` / `minmax(0, 1fr)`. Run `python3 tests/no_overflow.py`
  after any layout change.
