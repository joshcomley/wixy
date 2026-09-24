# Decision

**Status:** accepted (R14a)

**Scope:** Server-chat commit trailers and the one delivery merge from `cmd/workspace-00029` to `main`.

## Symptom / context

The update popup reads `Release-note:` trailers. Earlier commits in this delivery contain
descriptive notes that reveal the disguised chat, its media, or its PIN/lock behavior.

## What was decided

- The single feature delivery merge to `main` must be a squash with a hand-written commit
  body. Its only `Release-note:` line is exactly:
  `Release-note: Added a Server page showing your website's server status.`
- Never accept GitHub's generated squash body, which copies the hidden descriptive trailers
  into the squash commit. The delivery manager verifies the notes before and after the merge.
- After delivery, every commit touching Server chat uses exactly
  `Release-note: General bug fixes and improvements.`. A trailer must not name the chat,
  messages, photos, video, voice, PIN, or locking.

## Why

`routes_version.resolve_release_notes` runs plain `git log --format=%B` over the release range,
not first-parent history. Every commit trailer can therefore reach the owner's update popup,
including trailers inside a default squash body.

## What to watch for

This squash rule applies only to the one feature-to-`main` delivery merge. Parcel merges into
`cmd/workspace-00029` remain ordinary merges. Keep commit subjects generic and use the exact
trailers above; see [`docs/ai/livechat.md`](../../docs/ai/livechat.md),
[`CLAUDE.md`](../../CLAUDE.md), and spec R14a.
