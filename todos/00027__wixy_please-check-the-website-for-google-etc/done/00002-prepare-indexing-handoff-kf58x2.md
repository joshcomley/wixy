# DONE 00002 [kf58x2] Prepare indexing handoff

## What

Turn the completed search-indexing audit into two deliverables: a detailed, implementation-ready brief for a Sonnet 5 agent and a self-contained HTML guide for the account-level actions only a human can complete. Dispatch the agent in a visible cmd workspace and verify that it starts with the correct model and context.

## Why

The public site is crawlable, but meaningful improvements span two authority boundaries. Code, templates, tests, documentation, and site-repository work can be delegated; Google Search Console, Bing Webmaster Tools, and Google Business Profile require the owner's authenticated accounts. Splitting those lanes avoids blocking safe engineering work on account access.

## Context

The prior audit is recorded as completed task `[bfx6zs]`. Its priorities were legacy Wix redirect signals, correct staging index controls, structured identity and favicon support, mobile image performance, and stronger treatment-page coverage. The public sitemap currently contains nine healthy URLs and the Google DNS verification TXT record already exists.

## Relevant files and commits

- Prior audit record: `todos/00027__wixy_please-check-the-website-for-google-etc/done/00001-audit-search-indexing-bfx6zs.md`
- Engine areas: `builder/`, `wixy_server/redirects.py`, `projects/ca.json`, `docs/ai/`, `spec/`
- Site source areas to inspect in its own workspace: templates, content, assets, and `.github/workflows/pages.yml`
- Social-preview improvement already on engine main: `d318cd4`

## How to continue and acceptance criteria

1. Write a brief that separates sequenced agent milestones from explicit human approval gates, names likely files, records risks, and gives measurable acceptance checks.
2. Write a responsive, accessible, self-contained HTML guide with exact Google, Bing, and Business Profile steps, warnings against submitting staging, copyable values, and a return-check schedule.
3. Validate the guide locally as HTML and visually inspect it.
4. Commit the artifacts with the required `Release-note:` trailer, make them available to a fresh workspace, then launch and verify a visible Claude Sonnet 5 chat with the brief as its mission.
5. Record the resulting chat/workspace link or identifier and close this task.

## Links

- Public site: `https://cottageaesthetics.co.uk/`
- Staging site: `https://ca.cinnamons.uk/`
- Google Search Console: `https://search.google.com/search-console/`
- Bing Webmaster Tools: `https://www.bing.com/webmasters/`

## Outcome

- Added `docs/search-indexing-implementation-brief.md`, a complete work-package and PR-train handover with repository ownership, decisions, risk gates, tests, measurable acceptance criteria, rollback expectations, and explicit human-only blockers.
- Added `docs/search-indexing-console-guide.html`, a responsive and printable owner walkthrough with saved progress, copyable exact values, official-source links, warnings against submitting staging, and post-publish monitoring checkpoints.
- Validated the guide with html5lib structural assertions, `node --check`, cmd's artifact endpoint (`200 text/html`), the repository link checker, Playwright at 1440 px and 390 px with no horizontal overflow, and desktop/full-mobile visual review.
- Merged documentation PR `#196` at `4cf4c941f92b1f0acd87b06bf1b386a14dfb4c37` after every required CI job passed.
- Launched visible Wixy workspace `00028` (`01d20177-7924-4d9c-8fcc-2b8038b16f61`) on branch `cmd/workspace-00028`, session `38f24301-b8a9-4ae8-aa52-4f4033e2ffb1`, confirmed as `claude` / `claude-sonnet-5` / `max` and active.
- Armed lane monitor `8d59a952-41d8-4821-a234-7b277927431c` and delivered its reporting instructions to the successor through the peer channel.
- Checked the Answers log before handoff; no open operator questions required forwarding.
