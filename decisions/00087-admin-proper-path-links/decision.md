# 00087 — Admin routes on proper paths instead of hash fragments; legacy hashes canonicalize

## Symptom / request

Operator, 2026-07-21: "please can we move to non # links, aka proper links". The admin was
hash-routed since milestone 7 (`/admin#/pages`, `/admin#/edit/<page>`, …): the URL's path
never changed, so panel URLs weren't first-class links (can't see where you are from the
address bar, server access logs show only `/admin`, hash links are second-class to share).

## What was decided

The admin now routes on PROPER PATHS — `/admin/pages`, `/admin/edit/<page>`, `/admin/theme`,
`/admin/media`, `/admin/chat[/<conv>]`, `/admin/history`, `/admin/settings[/<sub>]`:

- **Server:** `get_admin_shell_deep_link` (`/admin/{rest:path}`) serves the same
  fingerprinted shell for every panel path, registered AFTER every real `/admin/*` mount
  (static/guide/draft-media/preview all keep winning their prefixes — Starlette matches in
  registration order) and BEFORE `routes_public`'s `/{path:path}` site catch-all.
- **Client (`admin-ui/src/router.ts`):** one segment→Route mapping now backs both parsers
  (`routeFromSegments`) so the path and legacy-hash spellings can never drift.
  `navigateTo` is `history.pushState` + an explicit `popstate` dispatch (pushState fires no
  event of its own); `onRouteChange` listens to `popstate` (back/forward AND navigateTo's
  notification) plus `hashchange` (a hand-typed legacy hash after load still routes).
- **Legacy hashes never break:** `parseHash`/`routeToHash` stay; a non-empty hash WINS over
  the path (`currentRoute`), and `canonicalizeUrl` rewrites `#/edit/x` → `/admin/edit/x`
  via `replaceState` on load (no navigation, the hash leaves the address bar). A bare
  `/admin` canonicalizes to `/admin/pages` — after the last-active-view restore gets first
  refusal (order matters: restore navigates, canonicalize only fires when nothing was
  restored). `sessionState` writes path spellings and reads BOTH (old stored `#/…` values
  parse fine).
- Everything that generates links updated: shell nav, chatPanel's preview chip href (real
  `/admin/pages` — middle-click opens a working tab), the Uxer compliance-bridge module
  URLs in `admin_shell.html`, spec/05's routing lines, contracts.md's route table.

## Why

Proper paths are the normal web: the address bar tells the truth, deep links are real,
back/forward walk real history entries (pushState), and the server sees panel traffic
shapes. The hash era's one advantage — "one served document, no server routing" — is
preserved by the catch-all, so nothing was traded away.

## What to watch for

- **Registration order is load-bearing** on the server: the deep-link catch-all must stay
  AFTER the `/admin/*` mounts and BEFORE the public site catch-all — the pytest class
  `TestAdminDeepLinks` (incl. `test_mounts_still_win_over_the_deep_link_catch_all`) pins it.
- `navigateTo`'s synthetic `popstate` is how listeners learn about pushState navigations —
  don't "optimize" it away; back/forward and SPA nav share the one listener path by design.
- Test fakes that drive routes must mirror the real mechanism (pushState + popstate) —
  `shell.test.ts`'s `goTo` helper exists for exactly this; setting `location.pathname`
  directly notifies nobody.
- The router has TWO spellings for one route table on purpose (paths forward, hashes for
  legacy reads); any new route kind goes in `routeFromSegments`/`segmentsFor` ONCE and both
  spellings follow.
