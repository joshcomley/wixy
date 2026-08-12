# 00002 [kf58x2] Prepare indexing handoff

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
