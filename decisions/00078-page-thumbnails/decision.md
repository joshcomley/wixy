# Pages list shows mobile-view thumbnails, captured client-side and stored server-side

## The ask (operator, 2026-07-21)

"On the pages list, we could do with a tiny thumbnail screenshot preview of
what that page is… The screenshot should always be the mobile view… generate
them all initially, then if you're going into edit and then you press save it
should take a snapshot there and then… and of course if you cancel the pending
change that should revert, it should all be handled gracefully."

## Decisions

**Client-side capture (html2canvas), server as a dumb validated store.** The
admin already renders pages in iframes; the thumbnail is just another render
of the same `/admin/preview/<slug>.html` in a hidden 390px iframe, painted to
a canvas by html2canvas and PUT to the server as JPEG. Rejected: server-side
Playwright — a browser engine is a heavy deployment dependency in exactly the
places wixy must stay lean (the Slots slots and, decisively, the independence
standalone-Docker target), when the client already owns a perfectly good
renderer. html2canvas is admin-ui's FIRST runtime dependency — accepted for
fidelity (hand-rolled SVG-foreignObject serialization breaks on external
stylesheets/fonts, and this site runs on Google Fonts; the dep is bundled, so
the no-CDN rule holds).

**Mobile view always, derived, never content.** Captures are 390px regardless
of the current device simulation; they live in `Storage/projects/<slug>/
thumbnails/<page>.jpg` (outside the site repo — a thumbnail is a derived
artifact, regenerable any time). The server validates like media (size cap,
PIL-readable, re-encode — never the client's bytes verbatim) and serves with
`Cache-Control: no-cache`; the panel pins `?v=<draftRev>` so a fresh capture
is refetched, and a 404 swaps in a dashed placeholder AND queues a capture
(that's the initial backfill — no batch job needed; the placeholders pull
their own thumbnails into existence on first view).

**Triggers, no timers.** Serial debounced queue (`thumbnailService`):
accepted ops refresh the edited page (a `_global` op refreshes all — nav,
hours, brand touch every page); publish completion refreshes all;
history reinstate/restore refreshes all. "Cancel" needs no work — cancelling
never changes server state, so no capture happens; the graceful-revert ask
is covered by the reinstate/restore trigger.

**Overlay chrome is stripped at capture** (`ignoreElements` on the wx
selectors) so a mid-edit capture never bakes eye toggles or the composer
into the thumbnail.

## What to watch for

- html2canvas paints text with the PARENT document's fonts; the admin shell
  doesn't load the site's Google Fonts, so thumbnail body text can fall back
  to a system serif — accepted as "tiny preview" fidelity; if the operator
  calls it out, the fix is one fonts `<link>` in admin_shell.html.
- Captures are ~900ms-settled + encode; the serial queue means a 9-page
  publish refresh takes ~30s in the background. The placeholder stays until
  its capture lands.
- `?v=<draftRev>` pins to the REV, not the capture's recency — a panel
  re-render between accept and capture-landing can briefly show the old
  thumbnail at the new URL (placeholder → new capture → next render shows
  it). Self-heals on the next revalidation (60s).
