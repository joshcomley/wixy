# 00022 [rf7g3m] wixy: e2e coverage — extensionless + trailing-slash 404 + legacy .html

Full context: sidecar 00017.

## What

Add public-surface coverage in the spec file that already exercises public serving
(`section-panel.spec.ts` or a more fitting one): `/gallery` returns the same content as
`/gallery.html`; `/gallery/` → 404. Keep existing `/gallery.html` requests as legacy-behavior
coverage (don't remove). Also verify the editor-overlay internal-link interception e2e (grep
for one) still passes with extensionless hrefs in the rendered nav.
