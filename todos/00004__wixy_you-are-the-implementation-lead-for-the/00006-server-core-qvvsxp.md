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
