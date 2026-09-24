# `DELETE /uploads/{uploadId}` now validates the id before any filesystem access

## Symptom

Found by the `gpt-6-sol` reviewer dispatched for P6b's candidate review (operator
decision #1164's routing — implementation to `gpt-6-luna[xl]`, review to `gpt-6-sol`),
while reading code adjacent to P6b's own diff rather than P6b's diff itself. Not a
regression from any parcel in this delivery — the vulnerable code shipped with P1/P2b
(already merged to `cmd/workspace-00029` before this was caught).

`wixy_server/livechat/uploads.py`'s `cancel_upload` (the implementation behind
§5.5's `DELETE /api/admin/server/uploads/{uploadId}`) took the client-supplied
`upload_id` and passed it straight into `ProjectPaths.server_upload_dir(upload_id)`
(`storage.py`: `return self.server_uploads / upload_id`, a plain `pathlib` join with
no normalization), then unconditionally called
`shutil.rmtree(paths.server_upload_dir(upload_id), ignore_errors=True)` regardless
of whether the id matched any real record.

A `..` value for `upload_id` is a valid single path segment (no `/`, so it still
matches FastAPI's `{upload_id}` route pattern) and resolves
`server_uploads / ".."` to `server_uploads`'s own PARENT — `server_dir` itself,
which holds `server.db`, `secret.key`, `vapid.json`, and every attachment's media
(`media/`), plus `uploads/` and `failed/`. Any authenticated request (i.e. anyone
who has unlocked the PIN chat once) to
`DELETE /api/admin/server/uploads/..` would silently (`ignore_errors=True`) wipe
the ENTIRE feature's state. This chat has no backup (an already-accepted tradeoff,
decision-adjacent operator answer recorded in the persistent todo: "private,
low-stakes chat, no backup needed") — the deletion would have been unrecoverable.

## Root cause

`upload_id` is always server-generated via `uuid.uuid4().hex` at `init_upload` time
(32 lowercase hex characters, no separators) and is never meant to be freeform —
but `cancel_upload` never verified that invariant before using the value as a
filesystem path component. A sibling route (`GET /media/{attId}/{rendition}`)
already validates its own id (`_ATTACHMENT_ID_RE = re.compile(r"^[0-9a-f]{32}$")`
in `routes_livechat_media.py`) before any file access — `cancel_upload` simply
never got the same treatment.

The route's own docstring states the frozen §5.5 contract: `DELETE` returns `204`
"unconditionally... the frozen contract defines no error case" — this is written
for the "unknown id" case (delete-of-nonexistent-upload is a no-op, not a 404), and
was likely read as license to skip validating the id at all, rather than as license
to skip validating specifically its *existence*.

Confirmed with a failing test before writing any fix: a sentinel file placed at
`paths.server_dir / "secret.key"` was ACTUALLY DELETED by
`cancel_upload(upload_id="..")` on the pre-fix code — not a theoretical read of the
code, a reproduced deletion.

## What was decided

Added `_UPLOAD_ID_RE = re.compile(r"^[0-9a-f]{32}$")` (mirroring the existing
`_ATTACHMENT_ID_RE` pattern) to `uploads.py`, with a `.fullmatch()` guard at the top
of `cancel_upload`: an id that doesn't match the format returns early, before any
`store.get_attachment`/`store.delete_upload`/`shutil.rmtree` call. This preserves
the frozen "`204` unconditionally, no error case" contract exactly — an invalid id
is now handled identically to an unknown one (silent no-op), just without ever
reaching the filesystem or the DB.

`.fullmatch()` rather than `.match()` with an explicit `^...$` pattern: a `gpt-6-sol`
review-of-the-fix caught that Python's `$` anchor also matches immediately before a
single trailing `\n`, so `.match(r"^[0-9a-f]{32}$")` would accept a 32-hex-char id
plus a trailing newline. Not itself a traversal bypass (a trailing newline doesn't
escape the directory), but `.fullmatch()` removes any doubt and costs nothing.

Traced every other call site that derives a filesystem path from an id
(`janitor.py`'s two `shutil.rmtree` calls, `media_queue.py`'s four, the chunk-upload
route's `write_chunk`, `assemble`'s own internal use): all of them operate on ids
that are either (a) read back from the DB (`stale_upload_ids`, `orphan_attachment_ids`,
`att.id` on an `AttachmentRow`) — which can only ever contain genuinely
server-generated `uuid4().hex` values, since nothing else ever writes a row — or
(b) gated by an existing `store.get_upload(upload_id)` / `store.get_attachment(...)`
lookup that 404s first (the chunk-upload and complete routes). None of them accept
raw, unvalidated client input the way `cancel_upload` did. Deliberately did NOT add
redundant validation to those sites — per this project's standing rule against
defensive code for scenarios that structurally cannot occur.

## What to watch for

- Any NEW route or internal function that turns a client-supplied string into a
  filesystem path component must validate its format BEFORE any path join/access,
  not rely on a later existence check to save it — `pathlib`'s `/` operator does no
  normalization or containment checking of its own.
- If `upload_id`'s generation scheme ever changes (e.g. a different length/charset),
  `_UPLOAD_ID_RE` in `uploads.py` and `_ATTACHMENT_ID_RE` in `routes_livechat_media.py`
  must be updated together — they're currently independent copies of the same
  pattern, not shared, because they live in different modules with different import
  boundaries (`uploads.py` has no FastAPI/route-layer dependency by design, per its
  own module docstring).
- This was caught by a dedicated code-review pass reading unfamiliar code with fresh
  eyes, not by the existing automated test suite (which had a happy-path test and an
  "unknown id" no-op test, but nobody had tried a malformed/malicious id). Automated
  coverage existing and passing is not evidence that input validation is present —
  test for hostile input explicitly, especially at any boundary that turns a string
  into a filesystem path.
