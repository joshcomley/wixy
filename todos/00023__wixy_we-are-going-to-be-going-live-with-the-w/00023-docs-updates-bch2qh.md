# 00023 [bch2qh] wixy: docs/ai updates for clean URLs

Full context: sidecar 00017.

## What

Run `op call aim-doc.doc_rules` first. Then update:
- `docs/ai/builder.md` — page_url shape
- `docs/ai/serving-and-overlay.md` — resolution rule + Pages-parity rationale +
  trailing-slash-404 contract
- `docs/ai/contracts.md` — if it states public page URL shapes
- `docs/ai/invariants.md` — if any invariant text cites `/<slug>.html`
- `docs/ai/editor-and-admin-ui.md` — navigation.ts's accepted shapes
