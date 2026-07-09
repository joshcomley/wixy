# Milestone 7 slice 1: protocol types + op queue

## Context

First slice of the M7 PR train (decisions/00015 explains the slicing). Builds the
overlay↔shell `postMessage` protocol (spec/05 §2) as typed, runtime-validated message
parsers in both `admin-ui/` and `editor/` (duplicated per decisions/00015 decision 2),
and the shell-owned draft op queue (PATCH coalescing @300ms, rev/409 refetch+replay).
Pure logic, no DOM/iframe wiring yet — that's slices 2-3.

## Decisions

**1. Each message parser (`parseShellToOverlayMessage`/`parseOverlayToShellMessage`)
does real runtime field validation per message `type`, not just a type-cast.**
`postMessage` payloads cross a structured-clone/serialization boundary — TypeScript's
compile-time types vanish at runtime, so a message claiming `type: "init"` with a
missing `draftRev` must be *rejected* (returns `null`), not silently accepted with
`undefined` in that slot. `isWxEnvelope`'s return type intersects `Record<string,
unknown>` with the fixed `{wx, type}` shape specifically so the per-type field checks
that follow can index arbitrary message-specific keys (`file`, `rect`, `bindings`, …)
without TypeScript rejecting the access — found by running `tsc --noEmit` for real
(TS7053) rather than assumed.

**2. The op queue's `flush()` is a `while` loop over `this.pending`, not recursion,
and re-entrancy is guarded by a single `flushing` boolean plus a `maybeScheduleFlush`
helper called from both `enqueue()` and `flush()`'s `finally` block.** Two race
conditions were designed out explicitly, not discovered by luck:
   - Recursing into `flush()` after a 409 (re-fetch rev, retry) while ALSO letting the
     surrounding `finally` schedule a follow-up risked a double-flush of the same
     pending batch. The loop reads `this.pending` fresh each iteration instead, so an
     op enqueued *during* an in-flight `sendPatch` await is picked up by the next
     iteration automatically — no recursion, no double-schedule.
   - A naive "schedule a timer only if none is already pending" check misses the
     window where a flush is *currently running* (timer already fired, `flushing`
     true, no timer object exists) — an `enqueue()` in that window would silently
     never get a scheduled flush. `maybeScheduleFlush` checks `flushing` too, and is
     called again from `flush()`'s `finally` so anything that arrived in the last
     instant before `flushing` flips back to `false` still gets picked up.
   Tested explicitly (`opQueue.test.ts`): coalescing multiple enqueues into one PATCH,
   409-triggers-immediate-replay-not-another-300ms-wait, an enqueue landing mid-flight
   getting swept into the same flush loop, and a rejected `sendPatch` leaving the batch
   queued for the next trigger.

**3. Found and fixed a real cross-platform CI trap while building this slice, not
deferred: a `.gitattributes` (`* text=auto eol=lf`) was added, because none existed.**
Rebuilding the (untouched) `admin-ui`/`editor` bundles on this Windows session
initially produced a `*.js.map` diff against the committed one — not because the
actual JS output changed, but because `admin-ui/src/index.ts`/`editor/src/index.ts`
were checked out with CRLF line endings (Windows git default), and esbuild's
sourcemap embeds each source file's exact text verbatim into `sourcesContent`. CI
builds on Ubuntu, where the same checkout stays LF — meaning ANY Windows contributor
rebuilding these packages, even with zero real changes, would produce a `*.js.map`
that fails `git diff --exit-code -- wixy_server/static` (the bundle-drift check) the
moment they touch `admin-ui/`/`editor/` at all, purely from their platform's line
endings, not their edit. Root-caused (not routed around): added `.gitattributes`
normalizing every text file to LF on checkin, `git add --renormalize`'d the tree, then
directly rewrote the two `index.ts` files' working-tree bytes to LF (renormalize alone
only fixes the INDEX, not files already checked out with CRLF) and rebuilt twice to
confirm a THIRD rebuild produces zero further diff — i.e. the fix is stable, not just
a one-time coincidence.

## Verification

`admin-ui`: `tsc --noEmit` clean, `vitest run` — 28 tests (1 scaffold + 19 protocol +
8 op-queue). `editor`: `tsc --noEmit` clean, `vitest run` — 21 tests (1 scaffold + 20
protocol, its own copy). `git diff --exit-code -- wixy_server/static` clean (CI's
exact bundle-drift check, run locally). Python suite untouched this slice (no `.py`
files changed) — not re-run, per "test what changed."

## What to watch for

- The `.gitattributes` fix should make this a one-time fix, not a recurring
  Windows-session tax — if a future rebuild on this OR any other platform still shows
  spurious `.map`-only diffs, re-check `git add --renormalize .` was actually applied
  (it only affects the INDEX; already-checked-out working-tree files need an explicit
  rewrite or a fresh `git checkout` of the affected paths, as this session found out).
- Slice 2 (editor overlay) is the first real CONSUMER of `editor/src/protocol.ts`;
  slice 3 (admin shell) is the first real consumer of both `admin-ui/src/protocol.ts`
  and `opQueue.ts`. Until then these modules are correctly unreferenced by `index.ts`
  — not dead code to clean up, just not wired in yet.
