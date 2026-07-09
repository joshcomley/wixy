# 00006 [qvvsxp] M6 WX — Server core

## What
Project registry, Storage layout + site checkout manager (clone/fetch/ff-only), draft
overlay store (rev/409/atomic), merged-content service, preview renderer (draft render +
editor asset injection), public serving of a built tree behind the atomic pointer,
`/api/admin/state|content|draft|media(list)`, CF Access JWT middleware (dev bypass
flag), instant-render shell.

## Why
The FastAPI backbone everything else (editor, media, publish, chat) mounts onto.

## Context / current state
Depends on 00002 (builder v1). This is the first wixy_server milestone.

Given the real size of this milestone, it's being built as a PR train (matching
how M4's CA migration was itself per-page PRs, not one) rather than a single PR —
see decisions/00010 for the full reasoning. Slices, updated as they ship:
- Slice 1 [DONE]: settings/`.env` loading, Storage directory layout,
  project registry wrapper, site checkout manager (clone/fetch/ff-only). No
  FastAPI app yet. decisions/00010. PR #23 merged.
- Slice 2 [DONE]: draft overlay store (rev/409/atomic) + merged-content
  service (spec/02 §8's merge rule) + a small `builder/theme.py` refactor
  (`theme_from_dict`/`theme_to_dict`) the merge service needed. decisions/00011.
- Slice 3 [DONE]: bindings-map v1 format (decisions/00012, provisional) +
  preview renderer (`wixy_server/preview.py`: merged `SiteSource` + `render_page`
  preview mode + editor asset injection) + first FastAPI app
  (`wixy_server/app.py`, `GET /admin/preview/{page}.html`) + upstream watcher
  (`wixy_server/watcher.py`, spec/04 §7, background fetch loop). decisions/00013.
  PR #25 merged.
- Slice 4 [DONE]: public serving (atomic live pointer, cache headers, 404 —
  incl. a `builder/build.py` fix so a 404.html actually gets emitted), CF
  Access JWT middleware (`wixy_server/auth.py`, dev bypass, real offline-tested
  verification), `/api/admin/state|content|draft|media(list)`
  (`wixy_server/routes_admin_api.py`), `/internal/ready|warmup`, `/healthz`
  (`wixy_server/routes_internal.py`), `/api/version`
  (`wixy_server/routes_version.py`), instant-render admin shell. decisions/00014.
  PR #(fill in when opened) merged.

**Milestone 6 COMPLETE — all 4 slices shipped and merged.**

## Relevant files
- spec/04-server.md (full — storage layout §2, public serving §3, preview §4, admin API
  index §8, security invariants §9)
- spec/08-testing-acceptance.md §1 server test list

## How to continue + acceptance
127.0.0.1-only bind asserted; CF Access JWT verify (signature/aud/iss/expiry) with
WIXY_DEV_NO_AUTH=1 dev bypass refusing to start under WIXY_ENV=prod; overlay atomic
tmp+rename writes; rev-conflict 409 tested; instant-render budget (no blocking fetches
in shell).

## Links
PR: (fill in when opened)
