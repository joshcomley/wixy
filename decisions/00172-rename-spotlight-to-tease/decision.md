## Symptom

The operator asked to rename the "Spotlight" feature — part of the already-shipped view-once
("disappearing photo") feature, spec/server-chat/06-view-once-media.md section 4 — to "Tease",
everywhere and consistently. Spotlight/Tease is the sender-chosen mode where a view-once photo
starts blacked out with a moving circular cut-out the recipient can drag/resize. This was
scoped explicitly as a **pure rename**: zero behavior change, only the name, top to bottom —
user-visible text, code identifiers, CSS classes, the database column, the wire JSON field,
tests, and the forward-facing spec/docs.

## Root cause

N/A (not a bug fix) — this is a planned rename, not a defect.

## What was decided

Renamed every "spotlight"/"Spotlight"/"SPOTLIGHT" occurrence to "tease"/"Tease"/"TEASE" across
the codebase, with one exception load-bearing enough to call out: **the schema migration
ladder in `wixy_server/livechat/store.py` keeps its historical v11 step referencing
`view_spotlight` exactly as it always did** (that step is what a fresh or partially-migrated
database actually runs, and rewriting history there would misdescribe what v11 does). A new
**schema migration v12** does the rename:

- `_LATEST_SCHEMA_VERSION` bumped from 11 to 12.
- New migration step (`if current < 12`): `ALTER TABLE messages RENAME COLUMN view_spotlight TO
  view_tease`, guarded the same way every other migration step here is guarded (checked against
  `PRAGMA table_info(messages)` rather than blindly trusting `user_version`, so a racing
  duplicate migration attempt or an already-renamed column is a harmless no-op, consistent with
  every other step in this ladder).
- Verified (not assumed) that SQLite 3.25+ rewrites the column's own `CHECK` constraint text on
  `RENAME COLUMN`: `CHECK(view_spotlight IN (0, 1))` becomes `CHECK(view_tease IN (0, 1))`
  automatically, with no separate constraint-migration step needed. Proven by a new test,
  `test_migrates_v11_database_renames_spotlight_column_to_tease`, which builds a database
  frozen at v11 under the old column name, migrates it forward, reads the live `sqlite_master`
  DDL text back to confirm the constraint's own text now says `view_tease`, and inserts an
  out-of-range value to confirm the constraint still fires post-rename.

Every live code path that reads/writes the column now uses the new name (`view_tease`) since
those paths always run against the fully-migrated schema:
- `wixy_server/livechat/store.py`: `_row_to_message`'s row mapping, `create_view_once_message`'s
  `tease: bool` parameter (was `spotlight: bool`), its local `view_tease` variable, and its
  INSERT statement's column list.
- `wixy_server/livechat/models.py`: `MessageRow.view_tease` field (was `view_spotlight`); the
  wire JSON key emitted by `message_json` (`viewOnce: {durationS, tease}`, was `spotlight`).
- `wixy_server/routes_livechat.py`: `SendViewOnceMessageIn.tease` request field (was
  `spotlight`), and the `POST /messages/{seq}/view-once/open` response's `tease` key (was
  `spotlight`).
- `admin-ui/src/server/api/messages.ts`, `thread.ts`, `viewOnceViewer.ts`: every `spotlight`-named
  field, variable, function (`computeSpotlightRadius` → `computeTeaseRadius`,
  `computeSpotlightCoords` → `computeTeaseCoords`, `SpotlightCoordsParams` → `TeaseCoordsParams`,
  `isSpotlight` → `isTease`) and constant (`SPOTLIGHT_CYCLE_MS` → `TEASE_CYCLE_MS`,
  `SPOTLIGHT_DRAG_RESUME_DELAY_MS` → `TEASE_DRAG_RESUME_DELAY_MS`, `SPOTLIGHT_EASE_DURATION_MS` →
  `TEASE_EASE_DURATION_MS`), renamed.
- `admin-ui/src/server/chat.css`: `.wx-srv-view-once-spotlight-label` (and its nested `input`
  selector) → `.wx-srv-view-once-tease-label`; `.wx-srv-view-once-spotlight-badge` →
  `.wx-srv-view-once-tease-badge`.
- User-visible strings: the composer checkbox label "Spotlight" → "Tease"; the recipient-bubble
  badge text "Spotlight" → "Tease"; the slider's `aria-label` "Spotlight size" → "Tease size".
- Every test file's names, comments, fixtures, assertions and selectors
  (`admin-ui/tests/server/viewOnce.test.ts`, `admin-ui/tests/serverThread.test.ts`,
  `admin-ui/tests/server/replyTo.test.ts`, `wixy_server/tests/test_livechat_view_once.py`,
  `e2e/tests/server-view-once.spec.ts`, `e2e/fixture_server.py`).
- Forward-facing spec and docs, plain search-and-replace (this describes current behavior, not a
  ruled amendment): `spec/server-chat/06-view-once-media.md` (including its section 4 heading,
  now "## 4. Tease (photos, and only for view-once)"), the one incidental mention in
  `spec/server-chat/07-live-drawing.md` ("the tease drag" — same pointer-capture pattern),
  `docs/ai/livechat.md` (schema section header now also notes the v12 rename for anyone who
  reads it and wonders why the DB has `view_tease` while the section is titled "migration v11"),
  `docs/ai/contracts.md`'s wire-shape line, `docs/ai/invariants.md`'s test-coverage mention, and
  this repo's own `CLAUDE.md` store-schema table row.
- Rebuilt `admin-ui` bundle (`npm run build`) so the committed
  `wixy_server/static/admin/admin.js`/`admin.css` (+ source maps) match the renamed source —
  CI fails on drift otherwise.

Deliberately **left untouched** (historical record, never rewritten after the fact):
`decisions/00169-view-once-composer-button-redesign/decision.md` and
`todos/TODO-00029.md`. (The brief also named a handover file,
`handover/2609261044-view-once-composer-redesign-ratified-conditions.md`, as do-not-touch; it
does not exist in this worktree — nothing to leave alone there.)

## Why

The operator's instruction was explicit and total: rename it everywhere, consistently, with
zero behavior change. A partial rename (e.g. renaming the UI text but leaving the DB column,
wire field, or code identifiers as `spotlight`) would leave the name inconsistent between what
the site owner sees and what engineers read in code/logs/DB — exactly the kind of drift this
project's naming-consistency doctrine exists to prevent. A real schema migration (rather than
silently changing what a fresh install's v11 step creates) was necessary because `store.py`'s
migration ladder must remain a faithful, replayable history of what happened to every database
that has ever run this code, including ones already deployed and sitting at schema v11 with the
old column name — rewriting the v11 step in place would silently break their upgrade path.

## What to watch for

- **Any future code must never reintroduce "spotlight" naming for this feature.** If a future
  contributor (human or agent) adds a new reference to "Spotlight" anywhere in this codebase —
  a new test, a new doc mention, a copy-pasted snippet from an old branch, a stale AI-agent
  memory of the old name — that is a regression of this rename and should be corrected back to
  "Tease" on sight, not treated as a legitimate alternate name.
- The v11 migration step's own SQL (`_SCHEMA_V11_VIEW_ONCE_MESSAGES` in `store.py`) still says
  `view_spotlight` on purpose — this is correct and must stay that way; it documents what v11
  actually did historically. Only the *runtime* code (post-migration reads/writes) and the v12
  step's own SQL should say `view_tease`. Do not "clean up" the v11 constant to say
  `view_tease` — that would make the migration ladder lie about its own history and desync a
  database that is still mid-upgrade from an old version.
- If a future rename ever needs to touch this column again, follow the same pattern: add a new
  migration version, `ALTER TABLE ... RENAME COLUMN`, keep every prior version's SQL text
  unchanged, and add a test that builds a database frozen at the prior version and migrates it
  forward.

## Deploy skew: the transitional `spotlight` wire alias (added by the reviewer, not the renamer)

The pure rename as first built had a privacy-affecting gap. A browser tab loaded before the
deploy keeps running the OLD bundle (stale bundles survive deploys for days, decisions/00069;
there is no client-version guard). Against the renamed server that old bundle would:
- SEND `spotlight: true`, which `SendViewOnceMessageIn` (no `extra="forbid"`) silently dropped,
  so the photo went out with Tease OFF and the recipient saw the FULL picture the sender meant
  to tease (proved red: `test_stale_tab_sending_the_old_spotlight_key_still_gets_a_tease` fails
  without the alias); and
- READ `viewOnce.spotlight` / the open response's `spotlight`, find nothing, and show the full
  photo for a Tease message.

So the server ACCEPTS the old request key (either key switches Tease on) and EMITS the old key
beside the new one in `message_json`'s `viewOnce` and in the `.../view-once/open` response, all
via the single constant `LEGACY_TEASE_WIRE_KEY`. Current code never reads it. It is time-boxed:
**remove after 2026-10-27** (sidecar `todos/00031__.../00002-remove-legacy-spotlight-wire-alias-tq7nz4.md`).
The v12 rename was verified against a snapshot of the real production chat database (1,004 messages:
v11 -> v12 applied, column renamed, CHECK text rewritten, integrity ok, counts identical, reopen a no-op).

## Rollback caveat

`RENAME COLUMN` is not rollback-safe. Once any process has migrated a database to v12, an OLDER
build (which expects `view_spotlight` and treats `user_version >= 11` as up to date) will fail
every chat query. If Wixy ever has to roll back past this release, first run
`ALTER TABLE messages RENAME COLUMN view_tease TO view_spotlight; PRAGMA user_version = 11;` on
`Storage/projects/<site>/server/server.db` (with the service stopped), then swap slots. Migration is
lazy (first `_connect()`), and the deploy's validate step uses a throwaway Storage dir, so the
production database is not touched until the new process serves its first chat request.
