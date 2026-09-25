# Decision

**Status:** accepted

**Scope:** Delivery of the Server chat (cmd workspace #29) to `main`, 2026-09-24.

## Symptom / context

The pre-delivery security audit ran several rounds. Round 4 was still reporting four open
items, F14 to F17, when the operator directed that the feature be delivered anyway:

- **F14 (medium):** `POST /api/admin/server/unlock` accepted a cross-site simple POST, so a
  hostile page could make the owner's browser burn PIN attempts and lock the owner out.
- **F15, F16, F17 (low):** user-experience findings.

## What was decided

- On 2026-09-24 the operator directed delivery with F14 to F17 open.
- The feature shipped as one squash commit, `6ca0d506` on `origin/main` (title "feat: Server
  page with private admin live chat (cmd workspace 29 delivery)"). Its tree is identical to the
  feature branch head `2d9d2cc`, so nothing beyond that head was delivered.
- The fixes for F14 to F17 follow in a separate pull request onto `main`. The intermittent-test
  fix (decision 00157, merged as `f307195`) and the final docs pass each landed as their own pull
  request after delivery; neither is part of `6ca0d506`.

## Why

The operator directed it. This entry records the fact of that direction and what was open at
the time; it does not record his reasoning.

## Follow-up (F14–F17 now closed)

Delivery `6ca0d506` was merged at 23:55 on 2026-09-24 (UK time). Two commits on `main`, made
on 2026-09-25, closed all four items — `71cb2946` at 01:14 and `0a2f836` at 04:28:

- `71cb2946` ("Server chat unlock CSRF guard, lockout countdown, wipe status, voice discard,
  audit round 4"): F14 — `unlock` now refuses a request before the body is read or cmd is
  contacted unless it is `Content-Type: application/json`, carries the custom header
  `X-Wixy-Server-Unlock: 1`, and (when present) a `Sec-Fetch-Site` of `same-origin`; a cross-site
  simple request cannot satisfy the custom-header requirement without a CORS preflight, which
  wixy does not grant. Also fixed as part of the same commit: the lockout screen's countdown, an
  unconfirmed wipe leaving the delete control stuck, and a failed voice note with no discard
  path.
- `0a2f836` ("follow-up fixes from the round-4 audit review"): closed the independent reviewer's
  further findings on that same commit — a voice recording no longer discarded on a network
  block that is not a definite rejection, a wipe that committed but timed out no longer shown as
  failed, the lockout screen no longer clearing silently on a malformed response, and a stale
  unlock token locking immediately instead of sticking on retry.

`docs/ai/invariants.md` (Inv 41) and `docs/ai/contracts.md` now describe the guard as built; see
[`docs/ai/livechat.md`](../../docs/ai/livechat.md) §4.

## What to watch for

None of F14–F17 remain open. If a future change to `POST /unlock`'s guard, the lockout display,
wipe-outcome handling, or voice-note failure handling contradicts `docs/ai/invariants.md` or
`docs/ai/contracts.md`, update those files and record the change here or in a new entry.
