# Decision: go-live guide's GitHub steps rewritten deep-link-first, menu click-paths banned

## Symptom

The operator, verbatim: "None of the instructions for Github in the go live HTML match up
with Guthub's settings layout." `docs/go-live-github-pages.html` (decisions/00126, refined by
decisions/00128 and decisions/00129) wrote every GitHub step as a menu click-path — "Settings
&rarr; Secrets and variables &rarr; Actions &rarr; the Variables tab", "left sidebar, under
&lsquo;Code, planning, and automation&rsquo;", "click your profile picture &rarr; Settings
&rarr; Pages &rarr; Add a domain". GitHub had reorganized its settings navigation since those
steps were written, and none of the click-paths matched what the operator actually saw.

## What was found — GitHub's own two Pages-settings pages have already diverged from each other

Verified against GitHub's current official docs, fetched live in a headed real Chrome browser
(Playwright, `channel="chrome"`, `headless=False` — never from memory, per the fleet's
no-fabrication rule for UI facts) for the five relevant articles: managing a custom domain,
configuring a publishing source, configuration variables for a repository, verifying a custom
domain, and manually running a workflow. The repository-level Pages settings sidebar section is
now titled **"Code and automation"** — GitHub dropped "planning" from that specific label. The
*personal-account* Pages settings sidebar (used for domain verification) still reads
**"Code, planning, and automation"** as of this check. The guide's stale text ("Code, planning,
and automation") happened to still be correct for one of its two "Settings &rarr; Pages"
references and wrong for the other — concrete proof that a single menu-path string can't
describe two different pages reliably, and that GitHub's own navigation is not internally
consistent, let alone stable over time. Every other verified field/button label (Custom domain
box, Save, Enforce HTTPS, Run workflow, the Variables tab flow, Add a domain, "What domain
would you like to add?", Verify) still matched the guide's existing content-level wording —
this was a navigation problem, not a terminology problem.

## What was decided — every GitHub step leads with a stable deep link, described by content

Rewrote Part 1a/b/c, Part 3, and the two troubleshooting-table rows that referenced a click-path,
to open with the exact settings-page URL as a clickable link, then describe the field or button
to find on that page ("the Custom domain box", "a table of repository variables", "the green
Run workflow button") instead of the sidebar/menu route to reach it. The four URLs used
throughout:

- Repo Pages settings: `https://github.com/joshcomley/cottage-aesthetics-preview/settings/pages`
- Repo Actions variables: `https://github.com/joshcomley/cottage-aesthetics-preview/settings/variables/actions`
- Deploy workflow page: `https://github.com/joshcomley/cottage-aesthetics-preview/actions/workflows/pages.yml`
- Personal verified-domains page: `https://github.com/settings/pages`

Added a single "If it looks different" callout at the top of Part 1 (reusing the existing
`.callout.important` style, no new CSS) stating plainly that GitHub moves its menus but the
links always land in the right place — the reader should match field/button names, not
position. Kept one deliberate exception to "no click-paths": the personal Pages settings step
(Part 3's recommended callout) keeps a one-line parenthetical fallback ("also reachable by
hand: your profile picture &hellip; &rarr; Settings &rarr; Pages") alongside its deep link,
since that page has no other anchor in the guide the way repo pages are anchored by "the
repository" — demoted to a parenthetical, never the primary instruction, per the brief's
explicit allowance.

New links use real `<a>` text ("the repository's Pages settings page"), never a raw URL inside
a `<code>` span — deliberately, to stay clear of the `code { white-space: nowrap }` /
`.records-table` overflow bug class decisions/00129 found and fixed in the troubleshooting
table. Confirmed with a headed-browser element-boundary scan (`getBoundingClientRect` vs
viewport) at 1400/900/390px: zero new overflow at any width; the 390px scan still lists exactly
the same 5 pre-existing long-URL `<code>` spans decisions/00129 already documented and
deliberately left out of scope (Part 3's TXT-record command, four of Part 4's checklist URLs).

## What was verified, and how — two independent checks per URL, not one

The brief's original assumption was "a working deep link redirects to login; a 404 means the
URL pattern is wrong." That heuristic turned out to be only half right, and worth recording
precisely:

- The two **personal-account** settings URLs (`github.com/settings/pages`) behave exactly as
  assumed: unauthenticated, they redirect to `github.com/login?return_to=...`. Proven not to be
  a blind redirect-anything-to-login fallback by a discriminator test: a deliberately bogus
  personal-settings slug (`github.com/settings/this-is-definitely-not-a-real-...`) 404s
  *before* any login redirect, while both `/settings/pages` and a known-real control
  (`/settings/profile`) redirect to login — GitHub validates the slug server-side ahead of the
  auth check, so a login redirect on `/settings/pages` is real proof the route exists.
- The two **repository Settings** URLs (`/settings/pages`, `/settings/variables/actions`) 404
  unauthenticated instead — confirmed this is universal GitHub behaviour for *any* repository's
  Settings sub-paths, not evidence of a wrong pattern, via a control probe against
  `github.com/torvalds/linux/settings` and `/settings/pages` (a famous, unambiguously public
  repo) — both 404 the same way. GitHub deliberately can't be distinguished from "page doesn't
  exist" vs "you lack permission" on Settings routes, for any repo, logged out. Cross-confirmed
  the underlying objects these pages would show are real via `gh api`: `repos/.../pages`
  (Pages config present, `https_enforced: true`, `cname: null` — the custom-domain box is
  genuinely not filled in yet, consistent with the operator not having completed this guide's
  Part 1c/Part 2 for real as of this round), `repos/.../actions/variables` (`WIXY_PUBLIC_DOMAIN
  = cottageaesthetics.co.uk`, confirming Part 1a's target page is populated correctly), and
  `repos/.../actions/workflows` (`.github/workflows/pages.yml`, name "Deploy to GitHub Pages" —
  confirming the workflow-page URL's filename segment is exactly right).
- The deploy-workflow-page URL was the one link directly confirmed by a plain unauthenticated
  `200`, since Actions run history on a public repo is visible logged out.

**What this round could not verify, and said so in the guide itself:** the actual rendered,
authenticated settings *pages* — sidebar position, exact pixel layout, whether GitHub has
changed anything else cosmetic. That needs the repository owner's own logged-in browser
session, which this agent doesn't have (API tokens, not a web session). The content-based
descriptions plus the "if it looks different" callout are the deliberate mitigation for that
residual gap, not a claim that the pixel layout was checked.

## What to watch for

- If GitHub ever renames the actual **field or button labels** this guide describes (not just
  where they sit in a menu), that's a different, harder problem than this round solved — the
  deep links will still land on the right page, but the guide's prose would then be wrong about
  what's *on* it. Re-verify against GitHub's docs (same method as this round) if the operator
  reports a mismatch again.
- The repo-Settings-404-vs-personal-Settings-login-redirect split is a general fact about
  GitHub, not specific to this repository — worth remembering before any future agent
  interprets an unauthenticated 404 on a `github.com/<owner>/<repo>/settings/...` URL as proof
  the URL is broken. It isn't, by itself; corroborate with `gh api` or a control repo.
- `cname: null` in the live Pages API confirms the operator has not yet completed this guide
  for real (Part 1c's custom-domain box is still empty) — consistent with decisions/00129's
  finding that the domain's nameservers were still Wix's as of 2026-08-10. Nothing here changes
  that; this round only fixes the guide's own instructions.
- Related: decisions/00126 (original guide + `wixy-live` architecture), decisions/00128 (clean
  URLs), decisions/00129 (Wix DNS delegation fix, and the `.records-table` vs
  `table:not(.records-table) code` overflow-CSS split this round deliberately continued
  following rather than reintroducing).
