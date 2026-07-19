# M2 — pre-publication audit results

## Context

spec/independence/02: before the engine repo goes public + MIT, it must pass a
pre-publication audit (secrets scan over full history, owner-material relocation,
dependency license check). This entry is the durable record of what was checked and
found, per §2's own instruction to have "evidence in the PR." SECURITY-GATED
milestone — this PR waits for explicit Fable approval before merge (09-work-plan.md).

## 1. Secrets scan (full history)

Installed `gitleaks` 8.30.1 (winget, `Gitleaks.Gitleaks`) — not previously on this box.
Ran `gitleaks git --report-format json .` against the full repo history:

```
123 commits scanned. scanned ~8.24 MB in 948ms. no leaks found.
```

Manually eyeballed the two "known non-secret" call-outs spec/independence/02 §2.1
names, to confirm the classification (not just trust the spec's memory of them):

- **`tooling/set_hours.py`**: contains Wix `EXT`/`SCHED`/`MASTERS` calendar-event
  UUIDs (structural identifiers) and a `SITE` id — the actual secret
  (`WIX_API_KEY`) is read from an environment variable, never hardcoded. Confirmed
  non-secret.
- **The truncated AUD in `decisions/00041-m11-cloudflare-provisioned/decision.md`**:
  `3ccac41a...75d5` — genuinely truncated (8 + "..." + 4 hex chars, not the full
  value). Confirmed non-secret, no scrub needed.

No other Access AUD values found anywhere un-truncated (`grep -i aud` across
`decisions/`) — the one real instance is the already-truncated one above.

## 2. Owner-material move

Spec's exact list (§2.3): `photos/`, `brief.md`, `docs/DESIGN-AND-CONTENT.md`,
`docs/google-reviews.json`, `docs/booking-platform-comparison.md`,
`reviews-demo.html`, `advertising/`. All seven confirmed present (2.3MB + 9.3MB in
the two directories) and removed via `git rm -r` from this PR's branch tip — history
retains them (acceptable per spec: "never secret, but going-forward they live
privately"). Pre-removal reference commit: **`7c4fa3c02957599bfed994ddb37a93ed293e685f`**
(this branch's base, i.e. `main` immediately before this PR) — recorded here and in
every doc pointer this milestone touched, so retrieval before `ca-business` exists is
a one-line `git show 7c4fa3c:<path>` or `git checkout 7c4fa3c -- <path>` away.

**One addition beyond the spec's literal list, with reasoning**: `tooling/
downscale_photos.py` was also removed. It is a small (34-line), single-purpose
helper hardcoded to operate on `photos/*` (`SRC = os.path.join(HERE, "photos")`) —
tightly coupled to the directory the spec already requires moving, not imported by
any other code (`grep` confirmed), and business-specific in its own docstring
("Downscale photos/* ... Keeps large source images out of AI context"). Once
`photos/` moves, this script becomes permanently non-functional dead code with zero
purpose in the public MIT engine repo. Leaving a broken, orphaned utility script in
a now-public repo seemed worse than the small scope addition of moving it alongside
its target directory — this is offered as a documented reality-conflict resolution
(binding rule: "reality contradicts a cited fact -> prefer reality, record a
decision, keep moving"), not a redesign of the spec's list. `tooling/set_hours.py`
and `tooling/provision_bookings.py` were checked and are NOT coupled to any moved
path — left in place, unchanged, exactly as the spec's list implies.

Updated every dangling doc reference the move created (`spec/README.md`,
`spec/00-mission.md`, `spec/03-site-migration.md`, `spec/KICKOFF-PROMPT.md`,
`tooling/README.md`) to note the move + the retrieval commit, rather than leave
stale pointers to now-missing files. Left `handover/before-after-gallery-
enhancement.md`'s reference untouched — it's a historical record of its own moment
in time, same treatment as git history itself.

## 3. Dependency license check

**Python** (`pip-licenses` against the installed environment): every production dep
(`beautifulsoup4`, `html5lib`, `nh3`, `playwright`, `pillow`, `fastapi`, `uvicorn`,
`httpx`, `PyJWT`, `cryptography`, `anyio`, `python-multipart`, `websockets`) is
MIT / BSD / Apache-2.0 / MIT-CMU (Pillow's own permissive variant) / dual
Apache-2.0-OR-BSD-3-Clause (cryptography). Dev-only deps (`pytest`, `pytest-xdist`,
`pytest-asyncio`, `mypy`, `ruff`, the `types-*` stub packages) are the same set of
permissive licenses — checked for completeness even though dev tooling isn't
distributed with the software.

**TypeScript** (`license-checker` against each workspace's FULL resolved tree,
prod+dev, via `npx license-checker --production=false`): `admin-ui`/`editor` have
**zero runtime dependencies** (only `devDependencies`: esbuild, jsdom, typescript,
vitest — matches the repo's own "no framework, self-hosted assets only" design,
decisions/00001); `e2e` has only `@playwright/test`. Full transitive trees: mostly
MIT (68 in admin-ui's tree), plus Apache-2.0/ISC/MIT-0/BSD-2/3-Clause/BlueOak-1.0.0/
CC0-1.0 — all permissive, all fine. Two things surfaced worth explicitly recording:

- **`lightningcss`/`lightningcss-win32-x64-msvc` (MPL-2.0)**: a transitive
  devDependency (via vitest's own CSS-processing chain). MPL-2.0 is weak-copyleft
  scoped to the MPL-licensed files themselves, not code that merely imports/links
  them — and this is a **build-time-only tool**, never bundled into or distributed
  with Wixy's own shipped code. Not a licensing concern for an MIT project.
- **`wixy-admin-ui`/`wixy-editor`/`wixy-e2e` themselves flagged `UNLICENSED`** — a
  false alarm: this was our OWN `package.json` files missing a `license` field, not
  a third-party dependency issue. Fixed by adding `"license": "MIT"` to all three
  `package.json` files, and `license = { text = "MIT" }` + `authors = [{ name =
  "Josh Comley" }]` to `pyproject.toml`'s `[project]` table (also missing before
  this audit — same category of gap, just the Python-side equivalent).

No GPL/AGPL/SSPL or other copyleft-incompatible license found anywhere in either
ecosystem's full resolved tree.

## 4. LICENSE + README

`LICENSE` — MIT, `Copyright (c) 2026 Josh Comley` (spec's exact text). `README.md`
rewritten: what Wixy is, the Cottage Aesthetics origin story (one paragraph),
quickstart pointer to `deploy/standalone/` (its real content lands milestone 3;
today it's still a placeholder — the pointer stays valid across that later merge
with no further edit needed here), MIT badge. The prior README's fleet-specific
deployment detail (Devfleet/Slots/ports) was kept, not deleted — spec/independence/
02 §2.2 explicitly accepts internal-infrastructure exposure in docs — just
repositioned under an explicit "This deployment: Cottage Aesthetics" heading so an
OSS reader understands it's one specific operator's instance detail, not something
their own deployment needs.

## Verification

`ruff check` / `ruff format --check` / `mypy --strict` clean. Full pytest suite: 543
passed (no test files touched by this milestone — only non-code paths removed/
license metadata added). Frontend: `admin-ui` (372 tests) + `editor` (109 tests) all
green after the `package.json` edits; both rebuild with zero bundle drift
(`git status` clean on `wixy_server/static/` post-build).

## What to watch for

- The visibility flip itself (spec/independence/02 §3: audit -> public -> she
  forks) is explicitly **Josh's own manual click** (Track J), never this agent's —
  this PR only gets the repo READY to flip; it does not flip it.
- If `ca-business` is ever created and someone goes to populate it from this repo's
  history, the retrieval commit is `7c4fa3c02957599bfed994ddb37a93ed293e685f` for
  every one of the seven-plus-one moved paths — that SHA is now recorded in five
  separate places (this entry + the four doc pointers) specifically so it survives
  independent of any one of them.
- `docs/projects/01-cottage-aesthetics.md` and `docs/wix-cli/*` were deliberately
  LEFT IN the public repo — engineering/historical context per spec/README.md's own
  categorization, not owner-private material.
