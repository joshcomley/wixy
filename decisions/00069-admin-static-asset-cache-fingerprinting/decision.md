## Symptom

A merged + fully deployed admin-ui change (PR #81, the mobile pages-list rework) was
invisible to the operator: `/api/version` on the live site reported the new commit,
the active slot's on-disk bundle contained the new code, yet the phone browser kept
rendering the old admin. "Nothing appears to have changed."

## Root cause

Every admin frontend asset URL was **unfingerprinted and uncache-headered**:

- `admin_shell.html` referenced `/admin/static/admin/admin.css` / `admin.js` (and the
  icons) as bare literals; `preview.py`'s `EDITOR_SCRIPT_PATH`/`EDITOR_STYLESHEET_PATH`
  were likewise bare.
- Starlette's `StaticFiles` emits only `ETag`/`Last-Modified` — no `Cache-Control`.
  Browsers then apply **heuristic caching** (RFC 7234 §4.2.2: fresh for a fraction of
  the file's age). A bundle last modified days ago is served from the phone's cache
  for days, no revalidation, straight over a freshly deployed slot.
- The shell HTML itself (`GET /admin`) was served with no `Cache-Control` either, so
  even a corrected bundle URL might not have been picked up.

Same class of bug would have recurred on every future bundle change (and on the
editor overlay, which is equally unfingerprinted).

## What was decided

Adopt the canonical fingerprinted-asset contract, in `wixy_server/staticcache.py`:

1. **Every `/admin/static/*` URL referenced from served HTML carries
   `?v=<sha256(file)[:10]>`.** Done by construction, not by discipline:
   `app.py:_fingerprint_shell_assets` regex-rewrites every `src`/`href` into
   `/admin/static/` in the shell string at import; `preview.py`'s
   `EDITOR_SCRIPT_PATH`/`EDITOR_STYLESHEET_PATH` constants are fingerprinted at
   import. A rebuilt bundle ⇒ a new URL ⇒ every cache layer (browser, CF edge)
   misses by construction. A missing file falls back to the bare URL (the app
   must still start from a broken checkout).
2. **The `/admin/static` mount (`FingerprintedStaticFiles`) answers any request
   carrying `?v=` with `Cache-Control: public, max-age=31536000, immutable`** —
   safe because the bytes behind a given fingerprint never change. Requests
   without the query keep StaticFiles' default headers (unchanged behaviour;
   e.g. `test_auth_gate_integration.py`'s direct fetches).
3. **`GET /admin` is served `Cache-Control: no-cache`** — the shell is the
   document that carries the new fingerprints, so it must revalidate on every
   navigation for a deploy to become visible.

Tests: `wixy_server/tests/test_staticcache.py` pins the whole contract, including
a guard (`test_every_static_reference_in_shell_is_fingerprinted`) that fails if
any future `src`/`href` into `/admin/static` goes out bare.

## What to watch for

- The **Uxer compliance-bridge bundle** (`/admin/static/uxer/…`, loaded via a
  dynamic `import()` inside a `<script type="module">`, gated behind `?uxer=`) is
  deliberately NOT fingerprinted: it's a gitignored, locally-built, AI-tooling-only
  surface, and the regex only rewrites `src`/`href` attributes. If it ever becomes
  operator-facing, fingerprint it the same way (or the stale-bundle bug returns
  there).
- `/admin/guide/*` and `/admin/draft-media/*` mounts are untouched: the guide is
  rebuilt rarely and its pages are link-navigated (each navigation revalidates
  heuristically at worst); draft media changes per-upload (unique filenames).
  Revisit if either ever gets long-lived references from cached documents.
- Anything adding a NEW document that references `/admin/static/*` (a future
  server-rendered page) must fingerprint the same way — extend
  `_fingerprint_shell_assets` or call `fingerprinted_url` directly.
- The fingerprints are computed at **import time**; a process serves the hashes
  of the files it started with. Correct under blue/green (each deploy restarts
  the service on the new slot), but a bundle replaced under a running process
  (only ever true in dev) needs a process restart to re-fingerprint.
