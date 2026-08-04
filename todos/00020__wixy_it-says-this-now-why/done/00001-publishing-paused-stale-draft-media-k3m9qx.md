# 00001 — Publishing paused on ca.cinnamons.uk (stale draft-media refs)

**id:** k3m9qx · **opened:** 2026-08-04 · **decisions/00115**

## What the owner saw

The admin's Review & publish drawer showing "Publishing is paused — Some recent
changes have a technical problem…", since the evening of 2026-08-03 (~22 hours).
Live site unaffected. Two reports already sent (`Storage/projects/ca/reports/
20260803T2032*.json` — that one was the separate publish false-failure, fixed in
PR #149 — and `…210717Z.json`, this one).

## Cause (short)

Publish v31 consumed two staged uploads (copied into `images/`, deleted from
`draft/media/`). The Before & After section panel was still holding the
pre-publish array in memory; her next edit 2½ minutes later wrote the whole
stale array back, resurrecting two dead `/admin/draft-media/…` srcs. Publish
preview then validated them as `missing-image` and paused publishing. "Fix it
for me" could not clear it — repair only checked items against the JSON schema,
which a well-formed-but-dead src passes.

## Work

- [x] Diagnose from live state (overlay, reports, access log, repo content)
- [x] RED tests (repair + normalize + route + panel + shell) — all confirmed
      failing on pre-fix code
- [x] Fix layer 1 — `sectionPanel.refresh()` + shell wiring (publish + repair)
- [x] Fix layer 2 — `normalize_set_ops` re-points an already-published upload
- [x] Fix layer 3 — repair checks image resolution, and writes back a
      normalize-only correction
- [x] `decisions/00115`, docs/ai (media, contracts, editor-and-admin-ui,
      invariants Inv 27)
- [x] Ship: PR #151 merged (`7fc5fc5`), Slots deployed it to the green slot
- [x] Cleared the stuck draft via the product's own
      `POST /api/admin/draft/repair` (rev 177 → 178, `validate.ok: true`,
      all 6 pairs intact, her new pair untouched). Overlay backed up first.
- [x] Answers-log entry — **Q-78** ("It says this, now - why?")
- [x] Follow-up PR #152 (`b4582e6`): the repair's own owner-facing message read
      "Before &amp; After" — the nav label is stored entity-escaped and was
      interpolated raw. Now decoded, mirroring `decodeCommonEntities`.

## Not done, deliberately

Publishing itself. The draft is Purdi's content and the review drawer exists so
she approves the change before it goes live — unblocking was the defect, not the
publish. The site remains on version 31 with her new pair pending.

## Closed 2026-08-04
