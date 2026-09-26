## Symptom

Live operator report immediately after item 13 (view-once media) shipped: "even if I press
that ① on the thumbnail, it doesn't do shit... nothing happens." Separately, and correctly, the
operator objected to the affordance's discoverability ("the world's smallest little eye button
... on the world's smallest thumbnail"), and asked for a WhatsApp-style full-size toggle next to
the composer's text box instead.

## Root cause

`spec/server-chat/06-view-once-media.md` §3.1 (the Architect's binding ruling) specified: "The
attachment chip for a photo or video in the composer gets a 'View once' control. It opens a
small picker." The shipped implementation (`admin-ui/src/server/thread.ts`) followed this
literally: a ~20px "①" badge in the corner of a 56×56px staged-photo thumbnail
(`.wx-chat-attachment-chip`), which opens a picker (`.wx-srv-view-once-picker`) appended as a
CHILD of that same thumbnail's content wrapper.

`.wx-chat-attachment-chip` has `overflow: hidden` (admin-ui/src/chatComposer's shared chip
styling). The picker was `position: absolute; bottom: calc(100% + 8px)` — positioned ABOVE the
56px-tall chip. An element positioned `absolute` is still clipped by an ancestor's
`overflow: hidden`, regardless of how it escapes normal document flow. The picker therefore
rendered with zero visible area on every browser, every device, every time — not merely small,
genuinely invisible. Tapping the badge correctly ran its click handler and correctly created and
appended the picker to the DOM; none of that was visible to a real user.

**This was undetectable by every automated check that ran against the feature**, including the
five-round opus audit (relation e1ddc9bf) that cleared item 13: vitest/jsdom does not implement
CSS layout or clipping at all, so a test asserting "the picker element exists with the right
class" passed regardless of real-world visibility. The one e2e spec covering view-once sending
(`e2e/tests/server-view-once.spec.ts`) seeded every test message via a fixture helper or the raw
`POST /messages/view-once` route directly — no test ever clicked through the real composer UI to
open the picker, so Playwright's real-layout `toBeVisible()` (which WOULD have caught this) was
never exercised against it. The gap survived scout review, DM review, and opus audit rounds 3-5.

## What was decided

Replaced the per-chip badge and its clipped picker entirely with:
1. A full-size, clearly labelled button (`.wx-srv-view-once-toggle-button`, "⏱ View once") in the
   composer's own button row, next to 🎤/📎 — always visible-sized, never inside a clipped
   ancestor.
2. A picker rebuilt as a bottom sheet (`.wx-srv-view-once-sheet`), `position: fixed` to the
   viewport and appended to `document.body` — `position: fixed` is immune to ANY ancestor's
   `overflow: hidden` by construction, closing this entire class of bug rather than just this
   one instance of it.
3. The button always targets the MOST RECENTLY staged eligible (photo/video) file — the
   operator's own common case is exactly one at a time, matching WhatsApp's own pattern.
   Attaching a different file retargets the button and clears the previous file's flag
   automatically, so there is no separate per-chip state for the user to forget to undo (this
   replaces item 2's original "flagging a second chip clears the first" per-chip mutual
   exclusion, which is no longer reachable through the UI since there is now only one control).

## A real regression caught during the redesign itself

The first version of the retargeting logic cleared the outgoing target's `enabled` flag on
EVERY transition away from it, including a transition to "nothing staged." `takeServerDraft()`
(the send path) clears the live composer's staged list as an implementation detail of lifting
the draft for sending, which re-renders chips with none staged — triggering exactly that
transition and erasing the very flag `send()` was about to read moments later. This made every
single-file view-once send silently fall through to an ordinary message send. Caught by the
existing item 2/5/6/9 audit-round regression tests (rewritten for the new UI, not by new tests
written for this redesign) — a real value of not deleting prior coverage during a UI rewrite.
Fixed by only clearing the outgoing target when a DIFFERENT non-null file replaces it, never on
a transition to null.

## Deviation from the Architect's ruling — and why it stands

Spec 06 §3.1's literal text ("a small picker" on the chip) is no longer accurate. The
UNDERLYING behaviour spec 06 actually governs — duration choices (2 s/5 s/30 s/no limit),
Spotlight (photo only), the disclaimer wording, one-attachment-only, no-text-alongside — is
unchanged; only the composer-side AFFORDANCE (which DOM element you tap, and where its picker
lives) changed. This shipped directly on the operator's own explicit, live directive following a
genuine, blocking, confirmed defect — not a unilateral redesign. No schema, route, erasure, or
security-relevant surface was touched. The Architect was notified for the record (peer message)
rather than asked to re-rule before shipping; the operator's own directive is the authority for
a UI-only change of this kind, matching how earlier round-2 UX fixes (composer focus, send
flicker, item-14 test-button delay) shipped directly on operator report without a fresh ruling.

## What to watch for

- Any FUTURE feature that opens a popover/menu from inside a scrollable or `overflow: hidden`
  container should use `position: fixed` (or portal to `document.body`) by default, not
  `position: absolute` relative to a nearby element — this bug class is easy to reintroduce and
  was NOT specific to this one badge.
- An e2e suite that only ever seeds test data through fixture helpers or raw API calls, and never
  clicks through the real sending UI, cannot catch a UI-only defect no matter how many times it
  runs. `e2e/tests/server-view-once.spec.ts` now has one test doing exactly that (attach via the
  real file input, click the real button, assert `toBeVisible()` genuinely holds on a real mobile
  viewport, send through the real Send button) — keep it, and prefer this pattern for the next
  send-side feature.
