# Decision: prominent visibility switch + Turn all on/off; a real Save-accepted signal

## Symptom

Two of Purdi's four original complaints (decisions/00118 covered the other two — no visible
"unsaved" state, no Save button) were about the `visible` toggle specifically: "unclear why
entries are greyed out" and "the 'Show on site' control isn't prominent." The toggle lived as
one ordinary field row among several (title, category, …), with only a small "Hidden" pill on
the card as a secondary cue — nothing told her, in her own words, *why* a card looked greyed
out, or that flipping one control was the fix.

Separately, PR1's own FINAL HANDOFF review (planner, cmd session `75f673ab-…`) surfaced a real
MEDIUM-severity gap in `saveNow()`'s success detection: it inferred "the Save landed" from
`opQueue.rev` advancing across a `flushNow()` call, because `OpQueueLike` exposed no richer
signal. `opQueue.ts`'s `flush()` has one sequence where that inference is a **false positive**:
a 409 conflict re-fetches the current rev (`fetchCurrentRev()`, which itself ADVANCES the
queue's `currentRev`) and re-queues the same batch for an immediate retry — if THAT retry then
hits a network error, the batch is only re-queued again (not landed), but `rev` already moved
from the conflict-refetch. `saveNow()` would read `rev !== revBefore` as success and tell her
"Saved. Ready to publish." for an edit that was, in fact, still only queued. The planner judged
this non-blocking for PR1 alone (Purdi is a single user on a single active route — no
concurrent rev-advancing writer in practice, so no real 409 — and the false-positive variant
self-heals since the queue keeps retrying regardless of what the save bar displays), but
flagged it as a real, tracked follow-up for whenever the panel was touched again — which PR2
is, so it's fixed here rather than deferred further.

## What was decided — the header switch

The `visible` field (`"kind": "toggle"`) now renders as a **full-width card-header bar**
(`renderVisibilityBar`, `sectionPanel.ts`), prepended as the card's FIRST child ahead of the
drag handle — pulled entirely out of the ordinary fields loop, not merely restyled in place. A
real `<input type="checkbox">` sits behind a styled `.wx-switch` track+thumb (native checkbox
semantics = keyboard + screen-reader support for free; a 44px tappable area — the checkbox
itself, not just the visible 26px-tall track — per the Uxer touch-target convention), paired
with a plain-English line that carries the actual answer to "why is this greyed out": **"Shown
on your site"** when checked, **"Hidden — not on your site yet. Turn on to add it."** when not.
The whole bar is a `<label>`, so tapping the text also flips the switch. This wording replaces
the old `.wx-section-hidden-chip` pill ENTIRELY (deleted, along with its now-dead CSS) — the
chip only ever said "Hidden," never why the card looked dimmed or what to do about it, which
was the literal complaint.

Storage semantics are **completely unchanged** from decisions/00117 (Inv 28): unchecking still
stages `updateItemField(items, index, "visible", false)`, re-checking still stages
`removeItemField(items, index, "visible")` (the key exists only when `false`, never `true` —
matching `builder.bindings._expand_list`'s own convention). Only WHERE and how prominently the
control renders moved; it still stages via `stageLocal` like every other edit (decisions/
00118), never auto-saving. The card's existing `wx-section-card-hidden` dimming (~0.55 opacity)
stays as a secondary whole-card cue, unchanged, driven by the same `item["visible"] === false`
check `renderCard` already computed.

A new `--wx-success` CSS token (a FILL color, distinct from the existing `--wx-success-text`,
which is tuned for text-on-surface and isn't a safe fill in dark mode — only 3.63:1 there)
drives the switch's ON-state track: light `#1a7f37` (5.08:1 against white), dark `#238636`
(4.63:1 against white, 3.63:1 against dark `--wx-surface`). OFF uses the existing `--wx-muted`.

## What was decided — Turn all on / Turn all off

Each collection header (`renderCollectionSection`, next to "Add a `<noun>`") gets two buttons,
rendered only when the collection actually declares a toggle-kind field (registry-driven, Inv
1 — never assumes `visible` by name): **Turn all on** drops the toggle field's key from every
item in one pass; **Turn all off** sets it `false` on every item. Both are new pure helpers in
`sectionPanelModel.ts` — `showAllItems`/`hideAllItems` — generic over `SectionItem[]` plus a
field key (not hardcoded to `"visible"`), following the exact "never mutate, always return a
new array" convention every existing helper there already documents. Both confirm via
`win.confirm` (matching Remove/Discard's existing pattern) and are a silent no-op on an empty
collection — nothing to confirm, and the collection header renders once at `load()` time, so an
enabled/disabled state that tracked "is this collection currently empty" would go stale the
moment she adds or removes an item without a full header re-render the current architecture
doesn't otherwise need. Either button stages the WHOLE collection through the SAME `stageLocal`
chokepoint an individual card's own switch uses — one bulk action is one Undo step, and lands
in whatever she Saves next alongside any other edit already in progress.

## What was decided — a real Save-accepted signal (`opQueue.enqueueTracked`)

`OpQueue` (`opQueue.ts`) gains `enqueueTracked(op): Promise<EnqueueOutcome>` ALONGSIDE its
existing `enqueue(op): void` — additive, not a replacement, so `editView.ts`'s own narrower
`OpQueueLike` (`{rev, enqueue, flushNow}`) is completely untouched. Internally, `pending`
changed from `DraftOp[]` to an array of `{op, onSettle}` entries; `enqueue` pushes one with
`onSettle: null` (today's fire-and-forget behavior, unchanged), `enqueueTracked` pushes one
carrying a `Promise` resolver. `flush()`'s three outcomes now settle any tracked entries in the
batch they belong to: **ok** → `{accepted: true, rev}`; **rejected (422)** → `{accepted:
false}` (matches the existing "dropped, not re-queued" behavior, decisions/00095); **network/5xx
(catch)** → `{accepted: false}` immediately, AND the resolver is detached before the batch is
re-queued for a later automatic retry, so a caller awaiting `enqueueTracked` never hangs waiting
on that eventual retry — it gets an answer bounded to the SAME flush attempt `flushNow()`
triggers, exactly the timing a caller already gets from today's single-attempt `rev` comparison,
just correct instead of sometimes lying. A **conflict (409)** re-queues the batch WITHOUT
settling — the retry happens synchronously within the same `flush()` call's `while` loop, so the
tracked promise still resolves within this one `flushNow()` unless THAT retry itself errors.

`sectionPanel.ts` defines its own narrow `SectionOpQueueLike = {rev, enqueueTracked, flushNow}`
(mirroring `editView.ts`'s existing "narrow slice this module needs" pattern, rather than
widening the shared `OpQueueLike` to include something `editView.ts` itself never needed) and
`saveNow()` now does:
```
const outcomes = collections.filter(dirty).map(c => opQueue.enqueueTracked({...}));
await opQueue.flushNow();
const settled = await Promise.all(outcomes);
const succeeded = settled.every(o => o.accepted);
```
replacing the old `const revBefore = opQueue.rev; …; const succeeded = opQueue.rev !== revBefore;`.
The concrete `OpQueue` class satisfies `SectionOpQueueLike` with no wiring change in `shell.ts`
— it already holds one `OpQueue` instance (typed as the concrete class, not the narrow
interface) and passes it to every panel, so adding a method to the class makes it available
everywhere for free.

## What was decided — inline before/after preview (PR3)

The brief's original ask (the operator, before this was scoped into three PRs) wanted the
Before & After gallery to be a genuinely enjoyable, "wow"-impact experience — full-size photos
and an interactive drag-to-compare slider, not small static thumbnails. The PUBLIC site
(`cottage-aesthetics-preview`) already got that treatment (`pages/gallery.html`'s `.bas-frame`
slider: two stacked `object-fit: cover` images, the before one clipped via `clip-path`, a
transparent full-frame `<input type="range">` as the drag surface). This PR ports that SAME
recipe into the ADMIN, as a lightweight inline preview under each 2-photo card
(`beforeAfterSlider.ts`'s `renderBeforeAfter`, ~50 lines, zero deps) — restyled with the
admin's own `--wx-` tokens rather than the site's earthy palette (two separate design systems
that must never bleed into each other), and with the label pills/auto-nudge-on-scroll flourishes
the public hero page has stripped out — this is a working preview for HER, not public marketing
copy. A small expand button opens the identical component larger in a modal for a closer look;
neither version has any editing control — dragging only ever previews, it never writes anything.

Determining which two fields feed the slider is entirely registry-driven
(`collection.fields.filter(f => f.kind === "image")`, Inv 1) rather than hardcoding `before`/
`after` key names, so this works for `gallery.sliders` (2 image fields) and silently does
nothing for `gallery.tiles` (1 image field) or any future collection shape without a special
case. The fallback rule is deliberately simple: no slider unless BOTH of the first two image
fields are actually filled — a tile, or a pair still missing one photo, just shows its existing
thumbnail(s), exactly as before this PR. Never a fabricated slider from a single image.

The tap-to-enlarge modal mirrors `sectionPanel.ts`'s OWN existing `openAddFlow` backdrop
idiom (backdrop + Escape-key listener wrapping `backdrop.remove` + click-outside-to-close, its
own distinct `.wx-before-after-modal-backdrop`/`.wx-before-after-modal` classes — never reusing
`.wx-media-dialog-backdrop`/`.wx-section-add-backdrop`, the same "two dialogs must never share a
selector" lesson `openAddFlow`'s own doc-comment already recorded from a real E2E strict-mode
violation) rather than `mediaDialog.ts`'s differently-shaped one, since it's more directly
consistent within this file.

## What to watch for

- `enqueueTracked`'s promise is bounded to ONE flush attempt by design — it does NOT wait for
  an indefinite string of automatic background retries (that would leave the Save button
  stuck on "Saving…" forever during a real outage, a worse regression than the bug being
  fixed). A caller that genuinely needs "tell me the moment it eventually lands, however long
  that takes" would need a different primitive than this one.
- If a flush is already in-flight when `saveNow()` calls `flushNow()`, that specific call
  no-ops (`flush()`'s own `flushing` guard) — but `enqueueTracked`'s promise still resolves
  correctly, because settlement is driven by whichever `flush()` loop iteration actually
  processes the entry, not by which specific `flushNow()` call the caller happened to invoke.
  This is a pre-existing `flushNow()` shape (not introduced here); do not assume a `flushNow()`
  call's own return guarantees its just-enqueued ops were processed BY that call.
- `showAllItems`/`hideAllItems` are generic over any toggle-kind field's key — reuse them
  (never hand-roll a bulk-set-key-on-every-item loop) if a future collection needs the same
  bulk pattern for a DIFFERENT boolean field.
- The guided add-flow's own toggle row (`renderToggleInputRow`, the wizard's form step) is a
  COMPLETELY SEPARATE code path from `renderVisibilityBar` and was not touched — it still uses
  the older `.wx-section-toggle-input`/`.wx-section-field-toggle` classes on purpose.
- **A real bug caught only by e2e, never by the unit suite**: `.wx-switch`'s DOM order
  (`input` then `track`, required for the `:checked + .wx-switch-track` selector) means
  `track`/`thumb` paint ON TOP of the real checkbox unless they carry `pointer-events: none`
  — jsdom doesn't enforce real paint/stacking order, so `npm test` stayed fully green while the
  switch was genuinely unclickable in a real browser (Playwright's `.check()` failed with
  "element intercepts pointer events" — the exact same failure a real tap would hit). Any
  FUTURE custom control built the same way (styled visual layer stacked as a LATER sibling of
  its real, functional input) needs the same `pointer-events: none` treatment on the visual
  layer, and should get at least one e2e assertion that actually clicks it — a jsdom unit test
  alone cannot catch this class of bug.
- `beforeAfterSlider.ts`'s `renderBeforeAfter` is a pure, context-free component reused
  IDENTICALLY for both the inline preview and the enlarged modal (just a wider container) —
  resist the temptation to add a "large" size variant; the component already fills whatever
  width it's given via `width: 100%` + `aspect-ratio`.
