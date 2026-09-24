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
- The fixes for F14 to F17 follow in a separate pull request onto `main`. The final docs pass
  and the intermittent-test fix (decision 00157) also land as their own pull request after
  delivery; neither is part of `6ca0d506`.

## Why

The operator directed it. This entry records the fact of that direction and what was open at
the time; it does not record his reasoning.

## What to watch for

- Until the F14 fix merges, `main` carries the open F14 behaviour described above. The `unlock`
  route reads the request body with `request.json()` and does not check the `Content-Type`
  header (`wixy_server/routes_livechat.py`, `unlock`); this is an observation from the code,
  not a root-cause analysis, which the fix pull request should record.
- When the F14 to F17 fixes land, update [`docs/ai/invariants.md`](../../docs/ai/invariants.md)
  (Inv 41), [`docs/ai/contracts.md`](../../docs/ai/contracts.md) and this entry's status if the
  behaviour they describe changes.
