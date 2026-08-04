# Stale draft-media refs after a publish

## Symptom

2026-08-04, ca.cinnamons.uk/admin: the review drawer showed the calm blocked
panel — "Publishing is paused… You can fix this automatically, or send a report
to your developer" (decisions/00095) — and had done since the evening of
2026-08-03, roughly 22 hours. The live site was unaffected throughout, exactly
as the panel says.

The publish preview's two validate errors (`Storage/projects/ca/reports/
20260803T210717Z.json`, and repeated in the server log):

```
missing-image  content/gallery.json  gallery.sliders[4].after
  image file '/admin/draft-media/cc9f64c7-img-1721-aligned.jpg' does not exist
missing-image  content/gallery.json  gallery.sliders[4].before
  image file '/admin/draft-media/6bcc5b2c-img-1723-aligned.jpg' does not exist
```

Both photos were in fact perfectly fine and already **live** — the published
`content/gallery.json` in the checkout references them as
`images/cc9f64c7-img-1721-aligned.jpg` / `images/6bcc5b2c-img-1723-aligned.jpg`,
and both files are in the repo's `images/`. The access log shows the same two
names served `200 OK` from `/admin/draft-media/…` earlier in the evening and
`404` later — they moved, they were never lost.

## Root cause

A three-step sequence, each step correct on its own:

1. **The publish consumes staged uploads.** `publisher._materialize_locked`
   copies every referenced `draft/media/<name>` into the repo as
   `images/<name>`, rewrites the content's srcs to that published form
   (`_rewrite_draft_media_refs`), and then — past the abort point — DELETES the
   staged copies. After a publish, `/admin/draft-media/<name>` is a dead URL by
   design.

2. **The section panel keeps the array in memory.** `admin-ui/src/
   sectionPanel.ts` is "the array's source of truth while mounted" (spec 3c,
   decisions/00098), and every mutation writes the WHOLE array as one op.
   Nothing re-read it after a publish: `shell.ts`'s `onPublished` called
   `refreshStateInBackground()`, which deliberately never touches the mounted
   panel.

3. So the panel went on holding the PRE-publish array. Publish v31 landed at
   21:04:32Z; at 21:06:56Z the owner added her next before/after pair, and the
   whole stale array went back to the server as one op — resurrecting two
   `/admin/draft-media/` srcs whose files the publish had consumed 2½ minutes
   earlier. From then on every publish preview validated those two dead refs and
   paused publishing.

**And nothing could clear it.** "Fix it for me" (`draft_repair.py`) checked each
collection item against the item's JSON schema only; a dead-but-well-formed src
passes every schema check ever written, so repair changed nothing, re-ran the
same validate, got the same two errors, and routed her to the Report path. Two
reports were sent. Confirmed as a RED test before the fix
(`test_draft_repair.py::TestStaleDraftMediaAfterPublish`).

## Decision

Fix all three layers — the origin, the gate, and the recovery:

1. **Origin — the panel re-reads (`sectionPanel.ts`, `shell.ts`).**
   `SectionPanel` gains `refresh()`; the shell holds the mounted panel and calls
   it from `announcePublishSucceeded` (the single version-guarded terminal path
   both the drawer callback and the shell's own watch funnel through) and from a
   new `onDraftRepaired` callback on the publish drawer. A re-read that could
   destroy work is deferred, never dropped: it awaits `opQueue.flushNow()` first
   (text fields commit on BLUR and the queue coalesces at 300 ms, so re-reading
   early would read back the pre-edit value), and while a field inside the panel
   has focus it waits for `focusout` instead of re-rendering under her cursor.
   `OpQueueLike` gains `flushNow()` for that.

2. **Gate — the write gate normalizes (`draft_validate.py`).**
   `normalize_set_ops` now re-points an ALREADY-PUBLISHED staged upload:
   `/admin/draft-media/<name>` → `images/<name>`, but ONLY when the staged copy
   is gone AND `images/<name>` genuinely exists. Both halves matter — the first
   keeps a legitimately-still-staged upload untouched, the second keeps the
   "never invent a reference" rule `rewrite_leading_slash_src` already follows.
   A name that resolves nowhere stays put and surfaces as the real
   `missing-image` it is. This makes the corruption impossible to PERSIST
   regardless of which client produces it — the same durable-backstop shape
   decisions/00095 established.

3. **Recovery — repair can actually repair it (`draft_repair.py`).**
   A collection item is now "good" only if it is BOTH schema-valid AND free of
   image refs that don't resolve; a bad one falls back to the base checkout's
   same-index item as before. And an op that step 1's normalize alone corrected
   is written back — the pre-00115 `if not any_changed: continue` dropped the
   normalized value on the floor, which is how a repair could run, report
   success, and change nothing.

`normalize_set_ops` takes `ProjectPaths` instead of a bare repo root (it needs
`draft_media` as well as `repo`).

## Why not something simpler

- *Just have repair drop the offending items.* It would have unblocked her, but
  it deletes a published before/after pair from the gallery to fix a bookkeeping
  problem — and leaves the origin intact, so the very next publish-then-edit
  re-creates the block.
- *Only fix the client.* Any other writer (another tab, an older cached bundle,
  a hand-authored PATCH, a future AI edit path) reproduces it. The write gate
  exists precisely so a client bug can't persist bad content.
- *Only fix the server.* The gate makes the draft publishable, but the panel
  would still be silently re-sending an out-of-date array over her newer edits.

## What to watch for

- The rewrite is deliberately conditional on the staged file being ABSENT. If a
  future change keeps staged copies after publish (a media-history feature, say),
  this rewrite silently stops firing — the gate would go quiet rather than wrong,
  but the repair path is the only thing left catching it.
- `refresh()` replaces the panel's working copy wholesale. Any future in-panel
  state that ISN'T committed to the op queue on every mutation (a multi-step
  wizard, a drag in progress) would be lost by it — the focus guard only covers
  text/select fields.
- The blocked panel is deliberately calm and content-free (decisions/00095), so
  the ONLY place the actual cause appears is the server log line
  `publish preview blocked: …` and the report bundle's `validate.errors`. When
  someone says publishing is paused, read those two first.
