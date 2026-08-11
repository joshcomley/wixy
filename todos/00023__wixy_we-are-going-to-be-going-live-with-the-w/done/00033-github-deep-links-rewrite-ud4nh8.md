# 00033 [ud4nh8] Round 4: rewrite guide's GitHub steps deep-link-first

## What

Operator report (verbatim): "None of the instructions for Github in the go live HTML match up
with Guthub's settings layout." Rewrite every GitHub click-path in
`docs/go-live-github-pages.html` to lead with a stable deep-link URL and describe the
destination page by its field/button content rather than by surrounding navigation
("Settings → Secrets and variables → Actions → Variables tab", "left sidebar under 'Code,
planning, and automation'", "click your profile picture → Settings → Pages → Add a domain").

## Why

GitHub redesigns its settings navigation periodically; menu click-paths rot. URLs to specific
settings pages are long-stable even when the surrounding chrome changes. The operator's
complaint says "none of them" match — treat every GitHub-referring instruction in the file as
suspect, not just one.

## The four deep links (from the brief)

- Repo Pages settings: `https://github.com/joshcomley/cottage-aesthetics-preview/settings/pages`
- Repo Actions variables: `https://github.com/joshcomley/cottage-aesthetics-preview/settings/variables/actions`
- Deploy workflow page: `https://github.com/joshcomley/cottage-aesthetics-preview/actions/workflows/pages.yml`
- Personal verified-domains page: `https://github.com/settings/pages`

## Context / current state

Round 3 (sidecar 00032, decisions/00129-wix-dns-delegation) fixed the Wix DNS delegation gap
and left a known pre-existing mobile overflow issue on long `<code>` URLs untouched (that's
in scope THIS round per the brief's overflow-scan requirement). The guide file is
`docs/go-live-github-pages.html`, self-contained (inline CSS), 4 GitHub touchpoints across
Part 1 (a/b/c), Part 3, and the troubleshooting table.

## How to continue + acceptance

1. Verify field/button names against GitHub's current official docs (headed Chrome,
   `channel="chrome"`, `headless=False` — fleet rule) for: custom domain for Pages,
   configuring the publishing source, configuration variables for a repo, verifying a custom
   domain, manually running a workflow.
2. Rewrite Part 1a/b/c, Part 3, and the troubleshooting table's GitHub-referring rows.
3. Add one short "if it looks different" callout near the first GitHub step.
4. Sanity-check the 4 deep URLs resolve to login redirects (not 404s) unauthenticated.
5. Render in headed browser at 1400/900/390px; re-run element-boundary overflow scan on
   changed sections (mind `code { white-space: nowrap }` in `.records-table` vs the
   `table:not(.records-table) code` wrap rule from round 3).
6. ToC anchors resolve; HTML tag balance clean; ruff/mypy/pytest untouched but green; CI green.
7. decisions/ entry (next free NNNNN, scanning ALL incl. both 00129 dirs); Answers log NEW
   question (don't overwrite Q-005); close this todo.

## Links

- Brief in this session's system context (not a file).
- decisions/00126-github-pages-go-live, decisions/00129-wix-dns-delegation (context).
- decisions/00133-go-live-guide-github-deep-links (this round's record, written).
- Planner session: 74703766-f2a8-4255-aafd-430ff10ba9a4.

## Answers log — drafted, fire POST after merge (per operating contract §5 + rounds 2/3 precedent)

API confirmed live on this box (hub, 127.0.0.1:9320/api/answers). Project "wixy". Next qnum
will be 8 (Q-007 is the current highest). `source_message_uuid` intentionally omitted — the
operator's report reached this session only via the planner's relayed brief, not as a directly
attributable chat bubble in a session this agent can query (same accepted pattern as Q-006:
`source_verified: false`).

POST body (fill in PR URL + merge SHA once known):

```json
{
  "session_id": "879d4cef-82d1-43c2-9e9c-c0c4ac0cf46f",
  "project": "wixy",
  "title": "Why don't the GitHub steps in the go-live guide match what I see on GitHub?",
  "question": "None of the instructions for Github in the go live HTML match up with Guthub's settings layout",
  "status": "answered",
  "answer": "Fixed. GitHub had moved things around in its settings menus since I first wrote your guide, so the old step-by-step directions (\"click here, then here\") no longer matched what you'd see. I've rewritten every GitHub step to link straight to the exact page instead of describing a path through menus — so even if GitHub moves things again, the links still take you to the right place; you just look for the box or button named in the guide, not its position on screen.",
  "detail": "Checked GitHub's own current help pages (in a real, up-to-date browser, not from memory) for all five things the guide asks you to do on GitHub, and confirmed the box/button names in the guide (Custom domain, Enforce HTTPS, Run workflow, Add a domain, etc.) are still correct today — only the menu paths to reach them had gone stale. Found one extra wrinkle along the way: GitHub's own two \"Pages\" settings screens (one for this website's repository, one for your personal GitHub account) now use two DIFFERENT sidebar labels from each other — exactly the kind of thing that makes a fixed menu-path description unreliable even when it was correct the day it was written.\n\nFour direct links now used throughout the guide:\n- Repository Pages settings: https://github.com/joshcomley/cottage-aesthetics-preview/settings/pages\n- Repository Actions variables: https://github.com/joshcomley/cottage-aesthetics-preview/settings/variables/actions\n- The deploy workflow's own page: https://github.com/joshcomley/cottage-aesthetics-preview/actions/workflows/pages.yml\n- Your personal verified-domains page: https://github.com/settings/pages\n\nAdded a short note near the top of the GitHub section explaining GitHub can still redesign its pages further and that's fine — the links keep working regardless. Shipped in wixy PR <FILL_IN> (merged <FILL_IN_SHA>); full technical record in decisions/00133.",
  "limits": "I can't see your actual logged-in GitHub screen myself (I only have API access, not your browser session), so I verified this against GitHub's own current published instructions and by checking the links resolve to the right place, rather than by looking at the exact page you'd see. If GitHub changes the actual NAMES of the boxes/buttons (not just where they sit), the guide would need another look — let me know if it still doesn't match and I'll re-check."
}
```

Submit via: `curl -s -X POST http://127.0.0.1:9320/api/answers -H "Content-Type: application/json" -d @payload.json` (this box is the hub itself, no CF-Access needed). Cross-reference Q-005 (id 247) in the detail/decisions entry — do not overwrite it.
