# 00017 — Proper path links instead of # hash links in admin

**Requested:** 2026-07-21 (operator): "please can we move to non # links, aka proper links".

**What (decisions/00087):**
- Server: `get_admin_shell_deep_link` (`/admin/{rest:path}`) serves the fingerprinted shell
  for every panel path — registered AFTER all real `/admin/*` mounts (they keep their
  prefixes), BEFORE the public site catch-all. pytest `TestAdminDeepLinks` (11 tests:
  9 path shapes 200+shell, fingerprints intact, mounts still win).
- Client: `router.ts` — one `routeFromSegments` table behind `parsePath` + legacy
  `parseHash`; `routeToPath`; `navigateTo` = pushState + synthetic popstate;
  `onRouteChange` = popstate + hashchange; `canonicalizeUrl` rewrites legacy `#/x` →
  `/admin/x` and bare `/admin` → `/admin/pages` (restore-last-view gets first refusal).
  `sessionState` writes paths, reads both spellings (old stored hashes parse).
- Link generators swept: shell nav, chatPanel preview chip href, Uxer bridge module URLs
  in admin_shell.html, spec/05 + contracts.md route table, app.py docstring.
- Tests: router.test.ts +13 (parse/route round-trips, currentRoute hash-wins, navigateTo
  pushState+notify, canonicalize ×3); shell.test.ts fakeWindow gains pathname+history,
  `goTo` helper mirrors navigateTo, ~20 idioms ported; chatPanel.test.ts fake + 2 asserts;
  e2e admin-routing.spec.ts NEW (deep link no-hash, back/forward real history, legacy
  canonicalize, bare /admin) + all specs/helpers moved to paths.

**Gates:** admin-ui vitest 476, tsc strict, mypy strict, ruff check+format, pytest 866,
e2e 32/32, ad-hoc 14/14 at 390+320 dark. CI green on the PR.

**PR:** #120 (merged 2026-07-21; live on prod `a98e6e7`, slot green — deep links 200 +
shell verified on prod, catch-all in the deployed slot) · **Decision:** decisions/00087
