# Owner-facing version badge: quiet `v N`, green glow on deploy, confirm-then-reload

## Symptom

When Purdy uses the admin ("Wixie"), nothing tells her the version she's looking at is
out of date after a deploy. The shell DID detect it (the 60s revalidation loop compared
`/api/version`'s sha), but its responses were wrong for an owner: an instant
auto-reload outside the edit view (yanks the page mid-work) or a transient 4s toast
inside it (gone before she looks up, then never repeated). Operator, 2026-08-02: "we
need a very simple version of OPVir… a very small, subtle v XXX in the top left… when
there is a newer version it should become the nice glowing green thing… and she taps it
and it says 'Would you like to load the latest version' with a themed pop-up… we don't
want to show the Git history because this is for a client."

## Decision

A client-facing, deliberately-minimal variant of the fleet's `ver` pattern
(Aim.Mcp.Common `code/ver-mcp`), as `admin-ui/src/versionBadge.ts`:

- **Placement**: far LEFT of the always-visible `.wx-statusbar` (00083) — visible on
  every route, edit view included, so the signal can't hide.
- **Quiet state**: tiny muted `v N`. N = the engine's first-parent commit count of HEAD
  (`git rev-list --first-parent --count HEAD` — the fleet `ver` pattern's number, one
  increment per merge to main), newly exposed as `commit.count` on `/api/version`.
  The badge is PINNED to the loaded page's version on its first successful check (the
  fleet pattern's rule: the badge describes THIS page, never the server's latest).
- **Update state**: when a revalidation check finds the server's `sha_full` differs
  from the pinned one, the badge swaps to `v old → v new` with the fleet's canonical
  green glow (`.wx-version-update-available`, `version-glow` keyframes; text uses new
  AA-checked `--wx-success-text`/`--wx-success-tint` tokens per theme — the canonical
  `#3fb950` fails AA on the light status bar). A rollback deploy quiets it again.
- **Tap → themed confirmation, never a changelog**: "A new version of Wixy is ready —
  Would you like to load the latest version now?" + "Anything you've already changed is
  saved and will still be there." Confirm reloads; "Not now"/Escape/backdrop closes and
  the glow stays. (The quiet state opens a small "Wixy is up to date (v N)" note.)
- **The reload gates on unsaved work**: confirm first awaits `beforeReload` = the
  shell's `opQueue.flushNow()`; if the flush re-queued ops (network/5xx — observed via
  a new `opSaveFailed` flag the queue's `onError` sets and `onAccepted` clears), the
  reload is BLOCKED with a calm "Couldn't save your latest change…" note instead of
  silently losing the coalesced batch.
- **No auto-reload, no toast**: the old `knownServerCommit` logic in `shell.ts` is
  deleted. The glow is the notification; the confirm is the only reload path.

Server side: `routes_version.py` gains `resolve_engine_version_count()` — baked
`WIXY_ENGINE_VERSION` env preferred (same provenance story as `WIXY_ENGINE_SHA`; the
Dockerfile + `publish-image.yml` now bake it, `fetch-depth: 0` so the count is real),
git fallback, `null` (never a 500) on a gitless image, where the badge simply hides.

## Why

- The confirmation (not auto-reload) is the point of the ask: she may have edited text
  on screen and not be finished. Draft ops persist server-side and composer text
  persists in localStorage (00088), so a CONFIRMED reload loses nothing — the dialog
  can honestly say so.
- First-parent count, not total: on a merge-commit main it reads as "release N" (one
  bump per shipped change) rather than a per-commit number that jumps by dozens.
- No git history in the popup: this surface is the client's, unlike the fleet pattern's
  developer-facing commit popup + paginated changelog.
- `sha_full` remains the out-of-date DETECTOR (exact); `count` is only the human
  DISPLAY (increments aren't compared — a rollback also reads as "changed").

## What to watch for

- `commit.count` on a shallow clone would read ~1 — the fleet Slots checkouts are full
  clones (verified 2026-08-02); the image workflow passes a computed value instead.
- The badge's `check()` is driven by the shell's existing 60s + visibility-change
  revalidation (plus one immediate pin at mount) — no second poller.
- Tests: `admin-ui/tests/versionBadge.test.ts` (pin/glow/dialog/save-block),
  `shell.test.ts` (status-bar order, deploy→glow→confirm→reload),
  `wixy_server/tests/test_routes_version.py` (count/baked/gitless),
  `e2e/tests/version-badge.spec.ts` (full flow against the real stack).
