# 08 — Testing & acceptance

Quality bars are binding. New engine code is TypeScript-strict (UI) + typed Python
(server/builder: full type hints, `ruff` + `ruff format` clean; add `mypy --strict` for
`builder/` and `wixy_server/` and keep it green). Tests parallelize via pytest-xdist with
a **FIXED cap** in `addopts` (`-n 4`; NEVER `-n auto` — fleet ban after the 2026-07-07
hub incident: this suite runs on the hub VM beside production cmd/Cmd-Chats; GitHub
Actions may use a fixed higher N on its dedicated runner, still never `auto`), isolate
per-worker state (tmp dirs / per-test git repos), never hit the real network (except the
explicitly-marked live smokes) and never hit real cmd/Cloudflare in CI.

## 1. Unit / integration (pytest, wixy repo)

**Builder** (`builder/tests/`):
- binding resolution: every `data-wx-*` kind, `@global`, `.relative`, nested lists,
  `data-wx-if`, missing-key → build failure with precise `file:key` error.
- injection correctness on a fixture mini-site (goldens committed): partials, nav
  active-state, head/meta/OG injection, fonts link, `theme.css` emission, sitemap/robots,
  canonical JSON rewrite (sorted keys, stable output → idempotent rebuild = byte-identical).
- sanitizer: allowlist enforcement, href scheme filtering, idempotence.
- validate mode: each 02 §10 rule has a failing fixture + a `--json` shape test.
- determinism: two builds of the same input → identical bytes (hash the output tree).

**Server** (`wixy_server/tests/`, httpx ASGI client):
- draft overlay: PATCH ops (scalar/array/theme), rev conflict → 409 + replay, atomic
  write (kill-during-write simulation leaves valid JSON), per-key + full discard.
- merge semantics: repo content ⊕ overlay (upstream changes flow through untouched keys;
  touched keys keep draft values) — table-driven.
- preview render: draft render equals builder PUBLISH output for the same merged content
  **after stripping `data-wx-hidden` elements** (preview mode retains falsy `data-wx-if`
  elements, 02 §2 — publish mode is the byte-authoritative path); editor assets injected
  only on preview routes, never in builds.
- media: upload → EXIF strip + orient + resize ≤2000px + re-encode (Pillow-verified),
  MIME/size rejects, SVG reject, reference scan, publish-time move+commit.
- publish pipeline on **temp git repos** (origin simulated with a bare repo): happy path
  (pull → materialize → commit → push → build → verify → atomic swap → ledger append),
  every failure leg (pull conflict, validate fail, build fail, push rejected → retry after
  fetch, crash between build and swap) leaves live serving + draft intact, lock serializes
  concurrent publishes, restore semantics (04 §6), prune policy.
- chat integration against the **fake cmd server** (06 §4): create/pending/ready
  (incl. the 404-until-JSONL readiness window), send idempotency + buffered-while-pending,
  poll→SSE fan-out, handover detection + chain-follow (06 §1), all failure rows in the
  06 §3 table.
- security middleware: `/admin` + `/api/admin` require a valid CF Access JWT (signature,
  `aud`, `iss`, expiry — test with a locally-minted JWKS), public routes don't; loopback
  bind asserted in config tests.
- instant-render budget: admin shell + public pages contain no blocking data fetches;
  responses for static/public paths stream from disk (no build-on-request path exists).

**TypeScript**: `tsc --noEmit` (strict flags per fleet rules) + esbuild bundle as a CI
step; unit-test pure logic (op queue/coalescing, postMessage protocol codecs, markdown
renderer options) with vitest (default parallel).

## 2. End-to-end (Playwright, headless, against a local full stack)

Fixture: temp clone of the site repo (post-migration shape) + wixy server on an ephemeral
port + fake cmd. Flows (each independent):

1. **Text edit**: open `/admin` → Edit home → click hero title → type → live DOM updates →
   draft chip shows 1 change → Publish → live page (public route) shows the new text →
   History gained a version.
2. **Image replace**: upload fixture JPEG (oversized, EXIF-rotated) → element updates →
   publish → file committed to repo `images/`, served, resized, EXIF-free.
3. **Theme**: change `clay` + headings font → iframe vars update live → publish →
   `theme.css` + fonts link reflect it.
4. **Collection**: add + reorder a treatment card; delete an FAQ item → publish → output
   HTML reflects order/count.
5. **Restore**: two publishes → restore #1 → live serves #1 content, history has a
   restore entry, draft equals #1.
6. **AI lane (faked)**: fake cmd "ships" a commit to the temp origin's main (fixture
   script) → draft preview banner appears → publish drawer lists the upstream commit →
   publish includes it live.
7. **Chat UX**: new conversation → scripted fake replies incl. tool-activity rows +
   status dot transitions; send-retry on injected 502; offline banner on fake-cmd stop.
8. **Concurrent editing sanity**: two admin tabs, edits in both, no lost ops (rev/replay).

Console errors anywhere in E2E = failure. Runtime target: full suite < 5 min via xdist +
Playwright sharding.

## 3. Parity harness

Spec'd in 03 §5 — the migration's safety net; stays in CI (site repo) forever as the
"AI can't silently wreck the site" gate.

## 4. Live verification (on hub, not CI — part of 07's deploy checklist)

- `@live_cmd` chat smoke (06 §4).
- `verify` skill run: drive the deployed `ca.cinnamons.uk` — public pages 200 + parity
  spot-check; `/admin` bounces unauthenticated (302 to CF Access) and loads with the
  service token; a real text edit → publish → live change → restore; a real AI
  conversation asking for a trivial copy tweak end-to-end (agent ships → preview chip →
  publish). When checking "publish → live change" through Cloudflare, bypass caches
  (hard-reload / cache-buster query): HTML carries up to 300 s of edge/browser TTL
  (04 §3). Evidence (URLs, SHAs, version numbers) recorded in the PR description.
- Lighthouse (or equivalent) on the public home page: performance ≥ 90, a11y ≥ 90 —
  the static site already achieves this; the CMS must not regress it.

## 5. Acceptance criteria (the build is DONE when…)

1. `ca.cinnamons.uk` serves the migrated site with rendered parity vs today's GH-Pages
   site (03 §5 evidence attached).
2. All six owner-experience bullets in 00 §"experience being bought" demonstrably work on
   the deployed instance (04–07), each exercised in the live verification.
3. Publishes/restores are atomic + serialized; a mid-publish crash cannot take the site
   down or corrupt the ledger (tested, and the deploy checklist includes a kill-during-
   publish drill on the deployed instance).
4. The AI lane is gated: site-repo CI (validate+build+parity) is a required check;
   the embedded chat cannot publish.
5. Admin is unreachable without CF Access; public site is reachable without it; both
   verified from an external network path (not just localhost).
6. Both repos' CI green; wixy pytest suite green under the project's capped `-n <N>`
   addopts (never `auto`); zero `@ts-ignore` without justification comments;
   `mypy --strict` green on `builder/` + `wixy_server/`.
7. Slots consumer + Devfleet child registered; `POST 127.0.0.1:9999/restart/Wixy`
   bounces it cleanly; a wixy-repo merge to main auto-deploys via the slot flow and the
   published site survives the swap (pinned build dirs live in Storage, not slots).
8. Docs: engine `README.md` (run/dev/deploy), site repo `CLAUDE.md`, `decisions/` entries
   for the architecture choices called out in 01 §3, todos updated per fleet conventions.
