# WP3-site: structured data + favicon (site-repo half)

Dispatched to cottage-aesthetics-preview workspace #18 (session e46c4302), reused
from the earlier WP2-site (00004) dispatch.

Delivered: `content/_global.json` gained the ruled `business` block (types,
address); `favicon.ico`/`favicon.svg`/`apple-touch-icon.png` at repo root
(3-petal botanical mark, theme.json colours); `<link rel="icon">`/
`<link rel="apple-touch-icon">` on all 9 page templates. Verified locally
against wixy engine PR #204 branch `feat/structured-data-favicon` @ `8783844`
(homepage-only JSON-LD, zero validation warnings, favicon files land in build
output). `decisions/00020-structured-data-favicon/` (site repo) records the
rationale.

Merged as cottage-aesthetics-preview PR #44, commit `5b7e20d`. CI green even
against wixy's pre-PR#204 main (confirmed inert-safe: no schema restricts the
new `business` key, nothing yet reads it).

**Still outstanding, not this task's job:**
- Favicon needs Purdi's own visual sign-off before Publish — artifact:
  https://claude.ai/code/artifact/ba89d011-5461-49f3-b6e8-846bc9b19e07
- No live effect until wixy engine PR #204 also merges (the JSON-LD emission +
  favicon passthrough live only on that branch right now).
