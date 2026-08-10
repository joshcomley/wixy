# 00027 [xlwxy0] site-repo: validate+build check; schema href-shape check

Full context: sidecar 00017.

## What

BEFORE the wixy PR merges: check `builder/schemas/*.schema.json` (footer-link, nav-extra) for
whether any constrains href shape (pattern requiring `.html` etc.) — if so, that's an
engine-side fix belonging in the WIXY PR, catch it early.

After migrating site content: from the wixy checkout (post-merge main), run
`python -m builder validate --root <site> --project <wixy>/projects/ca.json` and a full
`build`; confirm zero errors and that built pages carry the migrated hrefs.
