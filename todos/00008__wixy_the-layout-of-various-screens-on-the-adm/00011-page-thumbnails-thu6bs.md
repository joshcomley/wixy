# 00011 — Pages list: mobile-view thumbnail screenshots

**Status: design decided, not started. PR-E.**

Operator ask: each page row on the Pages panel gets a small thumbnail of the page,
ALWAYS the mobile view. Generate all initially (backfill); re-snapshot on save;
cancel/revert handled gracefully (thumbnail tracks effective content state).

## Design (decided)

- CLIENT-side capture in admin-ui (NOT server-side Playwright: keeps the prod slot
  and the independence standalone-Docker target free of a browser dependency —
  record in decisions entry). html2canvas (npm, bundled — self-hosted rule OK;
  admin-ui's first runtime dep, note in decision) over a HIDDEN offscreen iframe
  pointed at `/admin/preview/<slug>.html` at 390px, after fonts settle; strip
  overlay chrome in the onclone hook. JPEG q~0.75.
  NOTE: admin-ui/src/screenshot.ts is getDisplayMedia (screen-picker capture) —
  NOT reusable here.
- Server: store/serve only. `GET /api/admin/pages/{slug}/thumbnail` (404 if none,
  short-cache + ?v= buster) + `PUT/POST` same path accepting a JPEG body →
  `Storage/projects/<slug>/thumbnails/<page>.jpg` (derived artifact, NOT site repo).
  Mirror media.py's storage conventions. pytest both routes.
- Triggers (thumbnailService.ts, serial queue): pagesPanel mount regenerates
  missing/stale; OpQueue onAccepted for page X (debounced ~1.5s so coalesced
  typing = one capture); publish completion → refresh affected pages;
  restore/reinstate accepted → refresh. "Cancel" needs no work: cancel never
  changes server state, so no capture happens (graceful by construction).
- Pages panel: row-leading thumb cell (~48-64px wide, aspect of a phone screen),
  <img> with onerror → placeholder div; keep the ≤720px card layout intact
  (thumb left, text right).
- RED vitest: queue coalescing/trigger wiring with fake capture+api. Ad-hoc
  Playwright: real capture against fixture at 390, assert JPEG arrives + renders
  in the row, dark mode ok.

## Files

wixy_server/routes_admin_api.py (+ storage.py/media.py conventions), new
admin-ui/src/thumbnailService.ts, pagesPanel.ts, api.ts, style.css,
admin-ui/tests/thumbnailService.test.ts, wixy_server/tests/test_routes_admin_api.py.
