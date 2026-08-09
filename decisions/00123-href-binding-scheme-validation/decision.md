# Decision: `data-wx-href` bindings now validate URL scheme (nh3-backed), closing an XSS gap

## Symptom

While reviewing PR #27 (source-post-links) for clearance, the planner asked a sharper
question than "does the schema allow `sourceUrl`": does anything stop a `javascript:` value
from becoming a live, clickable href on the public site? Tracing it: no. This wasn't
specific to `sourceUrl` — it's a gap in the generic `data-wx-href` binding mechanism every
page uses (contact page phone/email, footer/header nav links, social links, and now the
gallery's source-post links).

## Root cause

`builder/bindings.py`'s `_apply_href` set `el["href"] = value` verbatim — a type check
(must be a string) and nothing else. The admin-ui's `renderUrlField` guard
(`/^https?:\/\//i`, decisions/00120) looked like it covered this but doesn't: it only
controls whether the ADMIN's own "Open ↗" convenience link is shown — it never touched the
STORED value, which the plain text input beside it saves unconditionally. So even after
decisions/00122's fix (kind `text` → `url`), a `javascript:...` value typed into `sourceUrl`
would still save fine, and the BUILDER would render it as a real `href` on the public
gallery page with no check at all — a stored-XSS vector reachable by anything with admin
write access to that field (a compromised session, a mistake, or a deliberately malicious
edit).

Current data is 100% real `https://instagram.com/...` / `https://facebook.com/...` URLs
(safe today) — this was a latent capability gap, not an active incident. But it's exactly
the kind of gap that turns a future ordinary content edit into a real vulnerability, and the
codebase already knows the risk exists (`admin-ui/src/markdown.ts`'s own comment: "Only
http(s) targets become real links — never javascript:/data:/etc"; `sectionPanel.ts`'s "a
javascript: URL must never become clickable" comment) — that awareness just never reached
the builder's render path for `data-wx-href` specifically.

## What was decided

Reuse the sanitizer this project ALREADY has for exactly this class of problem —
`builder/sanitize.py`'s `sanitize_rich_lite` (nh3/ammonia-backed) already restricts rich-text
`href` values to its `_URL_SCHEMES = {"http", "https", "mailto", "tel"}` allowlist. Added
`is_safe_href(value)` to that same module, and wired it into `_apply_href` via the EXISTING
`_fail()` mechanism (the same hard-`BuildError`-in-strict-mode / collected-error-in-validate-
mode split decisions/00120 already traced for `data-wx-if`'s missing-key case) — a dangerous
scheme now fails the build loudly, it doesn't silently drop the href or silently render it.

**Why nh3, not a hand-rolled regex/`urlsplit` check**: verified directly (not assumed) that
a naive scheme check misses real bypass classes browsers still honor — leading whitespace
(`"  javascript:..."`) and embedded control characters (`"java\tscript:..."`) both parse as
schemeless under Python's `urlsplit`, which would have let them through, but browsers strip
those before parsing the scheme and still execute them. `nh3` implements WHATWG-correct URL
parsing (it's a real HTML sanitizer, not a toy), so it catches all of these — confirmed with
a direct probe against `javascript:`, `JaVaScRiPt:`, leading-whitespace, tab-embedded, and
`data:`/`vbscript:` variants, all correctly stripped, while `http(s)`, `mailto:`, `tel:`,
relative paths, `#fragment`, and empty string all correctly pass through unchanged.
`is_safe_href` builds a minimal probe anchor (`value` HTML-escaped first, so it can never
break out of the probe's own attribute and be misread as markup), runs it through the same
`nh3.clean` call `sanitize_rich_lite` uses, and checks whether `href=` survived — if nh3
would strip it from real rendered HTML, it's unsafe.

Verified against every REAL current use of `data-wx-href` in the site repo (contact page's
`tel:`/`mailto:`, footer/header nav `.href`, social links, gallery's `sourceUrl`) — a full
`validate` + `build` run against the actual site content succeeds unchanged; none of them
use anything outside the allowlist.

## What to watch for

- This is a GENERIC binding-engine fix, not a `sourceUrl`-specific patch — it protects every
  current and future `data-wx-href` binding (nav items, any future admin field bound to a
  public href) the same way, consistent with this project's "fix at the mechanism, not a
  per-field special case" pattern (Inv 1; decisions/00120 made the same call for the field
  KIND, this makes the same call for the render-time SAFETY check).
- If a legitimate future use case needs a scheme outside `{http, https, mailto, tel}` (e.g.
  `sms:`), extend `builder/sanitize.py`'s single `_URL_SCHEMES` constant — both
  `sanitize_rich_lite` and `is_safe_href` read the same set, so there is exactly one place
  to change.
- The admin-ui's `renderUrlField` guard (decisions/00120) is now genuinely redundant with
  this — intentionally left in place as the earlier, cheaper UX signal (don't show a
  misleading "Open" link for a value that wasn't going to work anyway), but this builder-
  side check is the actual security boundary. Don't remove this one to "simplify."
