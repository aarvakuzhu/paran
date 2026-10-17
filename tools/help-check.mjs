#!/usr/bin/env node
// Keeps the help catalog (js/help.js) in step with the app. Fails (exit 1) when:
//   - a button/action in the code (data-a, data-ev, data-m, data-act) isn't explained by any topic's `covers`
//     (or listed in HELP_IGNORE): a new feature without help
//   - a topic covers an action, or points at a button (`ui`), that no longer exists: help for something removed
//   - a topic opens (`go`) or is offered on (`screens`) a screen that doesn't exist
//   - a screen has no topic at all
//   - ids are repeated, related topics don't exist, or a topic has no steps
// Run: node tools/help-check.mjs   (also runs on every push, see .github/workflows/checks.yml)
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), `..`);
const { HELP, HELP_IGNORE } = await import(join(root, `js/help.js`));
const files = readdirSync(join(root, `js`)).filter((f) => f.endsWith(`.js`) && f !== `help.js`);
const src = Object.fromEntries(files.map((f) => [f, readFileSync(join(root, `js`, f), `utf8`)]));
const all = Object.values(src).join(`\n`);
const problems = [];

// 1. the app's actions
const KIND = { a: `data-a`, ev: `data-ev`, m: `data-m`, act: `data-act` };
const actions = new Map(); // "kind:value" -> "file:line"
for (const [f, text] of Object.entries(src)) {
  text.split(`\n`).forEach((line, i) => {
    for (const [k, attr] of Object.entries(KIND)) {
      for (const m of line.matchAll(new RegExp(`${attr}="([a-z][a-zA-Z0-9-]*)"`, `g`))) {
        const key = `${k}:${m[1]}`; if (!actions.has(key)) actions.set(key, `js/${f}:${i + 1}`);
      }
    }
  });
}
const covered = new Map();
for (const t of HELP) for (const c of t.covers || []) covered.set(c, t.id);
for (const c of HELP_IGNORE) covered.set(c, `(ignored)`);
for (const [key, where] of actions) if (!covered.has(key)) problems.push(`No help topic explains ${key} (${where}). Add it to a topic's covers in js/help.js, or to HELP_IGNORE if it needs none.`);
for (const [key, id] of covered) if (!actions.has(key)) problems.push(`Topic "${id}" covers ${key}, which is no longer in the code.`);

// 2. screens and routes
const screenMap = /const screens = \{([^}]+)\}/.exec(src[`app.js`] || ``);
const routes = new Set(screenMap ? [...screenMap[1].matchAll(/(\w+):/g)].map((m) => m[1]) : []);
const morePages = new Set([...(src[`app.js`] || ``).matchAll(/page === `([a-z]+)`/g)].map((m) => m[1]));
const screens = new Set([...routes, ...[...morePages].map((p) => `more/${p}`)]);
if (!routes.size) problems.push(`Couldn't read the screens list in js/app.js (const screens = { … }).`);
const routeOf = (go) => { const p = go.replace(/^#\/?/, ``).split(/[?/]/).filter(Boolean); return !p.length ? `find` : p[0] === `more` && p[1] ? `more/${p[1]}` : p[0]; };

// 3. topics
const ids = new Set();
for (const t of HELP) {
  if (ids.has(t.id)) problems.push(`Topic id "${t.id}" is used twice.`); ids.add(t.id);
  if (!t.q || !t.steps?.length) problems.push(`Topic "${t.id}" needs a question and steps.`);
  if (t.go && !screens.has(routeOf(t.go)) && routeOf(t.go) !== `more`) problems.push(`Topic "${t.id}" opens ${t.go}, which isn't a screen.`);
  for (const s of t.screens || []) if (!screens.has(s) && s !== `more`) problems.push(`Topic "${t.id}" is offered on "${s}", which isn't a screen.`);
  if (t.ui) {
    const attr = /^\[([a-z-]+)(?:="([^"]+)")?\]$/.exec(t.ui); const id = /^#([\w-]+)$/.exec(t.ui);
    const ok = attr ? all.includes(attr[2] ? `${attr[1]}="${attr[2]}"` : attr[1]) : id ? all.includes(`id="${id[1]}"`) : false;
    if (!ok) problems.push(`Topic "${t.id}" points at ${t.ui}, which isn't in the code any more (or isn't a simple [attr], [attr="value"] or #id selector).`);
  }
}
for (const t of HELP) for (const r of t.related || []) if (!ids.has(r)) problems.push(`Topic "${t.id}" lists related "${r}", which doesn't exist.`);
const offered = new Set(HELP.flatMap((t) => t.screens || []));
for (const s of screens) if (!offered.has(s)) problems.push(`Screen "${s}" has no help topic (add it to a topic's screens).`);

if (problems.length) {
  console.error(`Help catalog is out of step with the app (${problems.length}):\n- ${problems.join(`\n- `)}`);
  process.exit(1);
}
console.log(`Help catalog OK: ${HELP.length} topics, ${actions.size} actions covered, ${screens.size} screens.`);
