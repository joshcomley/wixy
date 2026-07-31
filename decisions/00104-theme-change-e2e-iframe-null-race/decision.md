# theme-change.spec.ts's live-preview `waitForFunction` predicates could throw on a transient null `documentElement`, aborting the wait instead of retrying

## What happened

Running the full e2e suite as PR7's own pre-ship gate (unrelated feature — chat image
attachments), test 38/40, `theme-change.spec.ts › changing a color and the headings font
live-applies to the embedded preview`, failed:

```
Error: page.waitForFunction: TypeError: Cannot read properties of null (reading 'style')
```

Not a flake to shrug off unverified: re-ran `theme-change.spec.ts` in isolation 3× — all 3
green (2 tests each, ~10s) — then root-caused the exact mechanism rather than stopping at
"passes on retry."

## Root cause

All three of this file's `page.waitForFunction` predicates read the live-preview iframe's
CSS custom properties the same way:

```js
const iframe = document.querySelector("iframe.wx-preview-iframe") as HTMLIFrameElement | null;
const doc = iframe?.contentDocument;
return doc?.documentElement.style.getPropertyValue("--cream").trim() === "#00AA33";
```

`doc?.documentElement` only guards `doc` itself being nullish — `documentElement` is
plain-accessed afterward via `.style`. During a real theme-apply, the iframe's
`contentDocument` can (rarely, timing-dependent) be observed in a transitional state where
`documentElement` is momentarily `null` — a real, if narrow, window in the DOM's own
navigation/reset lifecycle, not something either the test or the application can avoid by
waiting differently outside the polled predicate itself. `page.waitForFunction`'s contract
is: a **thrown** predicate rejects the whole wait immediately; only a **falsy return**
causes it to keep polling. So the one time this transitional state landed inside a poll
tick, the test failed hard instead of just polling again next tick — a pure test-harness
race, unrelated to any application code (confirmed: `admin-ui/src/themePanel.ts` and the
live-preview iframe wiring were untouched by whatever else was in flight when this was
found).

## Fix

One more `?.` at each of the three call sites (`theme-change.spec.ts:58,74,154`):
`doc?.documentElement?.style...`. Per the optional-chaining spec, once ANY `?.` in a chain
short-circuits, the entire REST of the chain — including later plain `.` accesses like
`.getPropertyValue(...).trim()` — is skipped too, evaluating to `undefined` rather than
throwing. `undefined === "#00AA33"` (or `undefined?.includes(...) ?? false`) is a clean
`false`, exactly the "not yet, keep polling" signal `waitForFunction` expects — the fix
makes the transient-null case behave like "not yet true" instead of "predicate broke."

Confirmed via the full e2e suite re-run after the fix (see this session's own PR7 shipping
notes) — same 40 specs, this one included, all green.

## What to watch for

- This exact `doc?.documentElement.style` pattern (guarding the document but not the root
  element) was copy-pasted three times in one file — grepped the rest of `e2e/tests/` for
  the same shape; no other spec file uses it, so this was contained to `theme-change.spec.ts`.
  If a future test polls an iframe's `document.documentElement` (or any other DOM property
  one level past a cross-frame boundary) via `waitForFunction`, chain `?.` all the way
  through every level that could plausibly be transiently null/undefined during navigation,
  not just the outermost one.
- General lesson for this codebase's E2E suite: a `waitForFunction` predicate that reads
  into a live iframe crosses a real navigation boundary — treat every property access past
  `contentDocument` as potentially transiently absent, not just `contentDocument` itself.
