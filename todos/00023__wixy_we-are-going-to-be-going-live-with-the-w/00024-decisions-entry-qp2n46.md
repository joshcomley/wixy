# 00024 [qp2n46] wixy: decisions/ entry for clean URLs

Full context: sidecar 00017.

## What

New `decisions/NNNNN-slug/` (next id after 00126 — scan for the true max incl. any
`decisions/done/`). Content: operator-directed change, spec/02 §3 superseded; the
zero-redirect strategy and why (Pages can't redirect; server mirrors Pages; canonical
disambiguates — shipped round 1); trailing-slash-is-404 as a deliberate contract;
`/admin/preview/*.html` deliberately unchanged.
