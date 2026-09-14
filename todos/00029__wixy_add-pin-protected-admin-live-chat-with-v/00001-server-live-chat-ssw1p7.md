# 00001 [ssw1p7] Deliver PIN-protected admin live chat ("Server" panel)

## What

A new admin panel, linked from admin nav as **"Server"** (never "Chat"), that is a
human<->human live chat between admin users (e.g. Josh and Purdy — NOT the embedded
AI assistant, NOT visitor-facing). Requirements as given by the operator (verbatim,
three messages):

1. "I need a page in the admin that is a chat page, a live chat page. It will use a
   username that you set, and it just stores it in the browser cache, in local
   storage or something. It's that simple. So if two different people are logged on
   to the same admin portal, they can go to that chat pane. I can say I'm Josh, she
   can say she's Purdy, and we can have a chat.
   But it needs to be hidden, mostly, and there needs to be a feature where you need
   to put a pin number in to open the chat.
   The link to this page in the admin won't be called 'chat,' it'll be called
   'server.' The pin number will be [REDACTED — see standing rule below], and
   that will open the chat. Whilst
   scrolling up and down the chat, the text will be visible but, and whilst typing
   the text will be visible. There'll be a panic button to close the chat.
   I should be able to record voice notes; they'll be stored on Hub. If no activity
   happens on the screen for 10 seconds - like no mouse, finger taps, or scrolls or
   typing or anything like that - then the text fades out and it basically obscures
   the fact that it's a chat. You have to tap again thinking you're tapping on
   'server'; it'll say 'unlock server,' and you'll have to put the pin number in
   again.
   I will need push notifications optionally, registrable to the phone, but only if
   it's Android."
2. "It should also support uploading videos and photos."
3. "Also, rapidly tapping more than once anywhere on the screen puts it in lock
   mode, where it says open server settings. When you tap that, it asks for the
   pin. And when you're in the chat view, double-tapping or more locks it."

## Why

Operator-requested feature (private, family/business internal messaging tool
piggybacked on the wixy admin, obscured from casual view on a shared device).

## Context + current state (2026-09-14)

- Team: Orchestrator (session `0e9a2c7d-4eef-41ec-8d8b-6405f7696a94`), Architect
  (session `96bd8091-5905-4fd6-8ffc-c32771a42ecb`, role `architect`) — both live.
  No Delivery Manager yet (lazy-spawn at first hand-off, per workspace protocol).
- Workspace delivery_state: `discussing`. No delivery record created yet
  (`GET /api/workspaces/.../deliveries` was empty as of this writing).
- Orchestrator has sent the Architect the full mission text above plus synthesised
  answers to the Architect's 3 clarifying questions (what "live chat" means, who
  holds the PIN, voice-note expectations) and architectural pointers pulled from
  `docs/ai/architecture.md` + `docs/ai/invariants.md`. Full text stored at
  `http://127.0.0.1:9321/intercomm/a7c20681164c4764af6edbcb318074bb` (cmd
  intercomm — may expire; if gone, the same content is reconstructable from this
  sidecar + the chat transcript).

Key answers/assumptions relayed to the Architect (re-confirm before code ships if
in doubt):
1. "Live chat" = human<->human internal messaging, not AI, not visitor-facing.
   Lives inside the already-CF-Access-gated `/admin`.
2. PIN (a fixed 4-digit shared secret — value in the operator's chat message
   and in the Orchestrator's own conversation transcript, deliberately NOT
   reproduced in this git-tracked file, see standing rule below) is known to
   every legitimate chat user — a second, lightweight gate INSIDE the
   already-authenticated admin, not a replacement for CF Access (Inv 12 still
   governs `/admin*`/`/api/admin*`).
3. Username is an arbitrary client-set display name in localStorage, per
   browser/device — not tied to CF Access identity. [assumption, not literally
   operator-confirmed but the only reading that fits]
4. Voice notes / photos / videos upload from the browser and persist
   server-side ("stored on Hub" = wherever wixy's own process + Storage tree
   already live — no new remote target). This is PRIVATE data: must never enter
   the public build/publish pipeline or become reachable at any public URL —
   needs its own CF-Access-gated storage/serving path, separate from
   `draft/media/` (`docs/ai/media.md`) and separate from the AI `chats.json`
   registry (`docs/ai/ai-chat.md`).
5. Lock/reveal state machine has (at least) these transitions — confirm the
   Architect's design covers all of them:
   - Outer "Server" nav link, locked by default → a rapid multi-tap (2+ in quick
     succession) anywhere reveals an "Open server settings" affordance → tapping
     that prompts for the PIN → correct PIN unlocks into the chat view.
   - Inside the unlocked chat view: 10s of zero activity (no mouse/touch/scroll/
     typing) fades the chat text out, obscuring that it's a chat (still says
     "Server", presumably) — tapping it again does NOT re-reveal directly, it
     re-prompts "unlock server" / PIN.
   - Inside the unlocked chat view: an explicit panic button instantly re-locks.
   - Inside the unlocked chat view: a double-tap-or-more (rapid multi-tap) ALSO
     instantly re-locks, as a fast manual gesture alternative to the panic
     button.

## 🔴 Standing rule — the PIN literal must never enter this (PUBLIC) repo

`joshcomley/wixy` is a **public** GitHub repo. The chat's unlock PIN is a
shared secret and must never appear in a committed file, commit message, PR
title/description, or code comment — code reads it from `Storage/.env` (the
existing `.env`-backed `Settings` pattern in `wixy_server/settings.py`, e.g.
a new `WIXY_LIVECHAT_PIN`), never a hardcoded literal. If you need the value
to build/test against, get it from the operator's own message in this
workspace's chat history or ask the Orchestrator — do not copy it into any
file this repo's git tracks. (Incident: an earlier revision of this exact
sidecar briefly committed the literal value to `origin/cmd/workspace-00029`
before the branch was rewritten to scrub it — flagged by the Architect,
fixed same-session.)

## Relevant files / prior art in this repo

- `docs/ai/architecture.md` — module map, storage layout, invariants links.
- `docs/ai/invariants.md` — Inv 12 (CF Access is the only /admin auth), Inv 19
  (never author in `D:\Servers\Wixy`), Inv 24 + its decisions/00110 corollary
  (the EXISTING embedded-AI-chat panel already has a proven single-scroll
  flex-column chat shell — thread scrolls, composer pinned by layout — reuse
  this CSS/layout pattern for the new live-chat panel rather than reinventing
  it; e2e precedent `chat-ux.spec.ts`), Inv 2 (admin-ui bundle committed, CI
  fails on drift), Inv 16 (media.py's EXIF-strip/SVG-reject/dedupe pipeline —
  good template for chat photo uploads, but needs a fresh, non-publish-lifecycle,
  PRIVATE variant; video has zero precedent in this repo).
- `docs/ai/media.md` — existing image upload pipeline detail.
- No WebSocket precedent anywhere in this codebase as of this writing (grepped
  clean); the existing AI chat is SSE-based, one-way. Real-time transport choice
  for this two-party bidirectional chat is an open Architect call.

## How to continue + acceptance

1. Await the Architect's modularized technical brief (builders/parcels, HTTP
   contracts, new invariants, storage layout, e2e coverage) and relay it
   **verbatim** to the Delivery Manager once spawned (Orchestrator conveys,
   does not re-author).
2. Flag to the operator (via this Orchestrator, not silently decided): (a) chat
   media storage/retention policy has no operator-given cap — default is
   "keep indefinitely" unless the Architect surfaces a concrete disk-risk;
   (b) CF Access policy needs Purdy's identity added on the Cloudflare side —
   operator-only action, out of scope for this PR's code.
3. Before merge: route this PR through the `audit` skill (opus-tier: new auth
   surface + new real-time/background transport + new HTTP contract) — it is
   not one of wixy CLAUDE.md's named security-gated independence milestones,
   but the Orchestrator has decided it warrants the same rigor given what it
   touches.
4. Acceptance = operator can, from two different browsers/devices signed into
   admin, set distinct usernames, unlock "Server" with the PIN via the
   multi-tap gesture, exchange text/voice-note/photo/video messages in real
   time, watch the panel auto-fade after 10s idle and re-lock, panic-button
   and double-tap both instantly re-lock, and (on an Android device only)
   opt in to push notifications for new messages.

## Links

- Full mission dossier (operator verbatim + Orchestrator synthesis):
  `http://127.0.0.1:9321/intercomm/a7c20681164c4764af6edbcb318074bb`
- PIN-architecture correction dossier (operator override + new design):
  `http://127.0.0.1:9321/intercomm/2108c7574edc4136ba47a3a7a9cc1843`
- Workspace: `0ae788cb-70c8-4710-a411-88aa5445df15` (cmd workspace #29, project
  wixy), feature branch `cmd/workspace-00029`.
- Cross-repo dependency: cmd workspace #875 ("dragonfly-5", session
  `b1810bdc-4788-45a9-a790-758e4c56d7bd`, folded under this workspace as
  parent) — building the generic app-key-scoped PIN register/verify/lockout
  service. wixy's PIN gate depends on this shipping first (or in parallel,
  stubbed) with a real HTTP contract.

## Update 2026-09-14 (same session) — PIN architecture changed + a leak incident

- **Incident, resolved:** the first version of this sidecar + `TODO-00029.md`
  briefly committed the operator's literal PIN value to `origin/cmd/workspace-
  00029` on the PUBLIC `joshcomley/wixy` repo (commit `4024c25`). The Architect
  caught it within ~2 min. Orchestrator response: amended the tip commit
  (verified it was the sole author, nothing built on top), redacted both
  files, force-pushed (`db8657d`, override `CLAUDE_GIT_DESTRUCTIVE_OK=1` past
  the repo's force-push guard hook). **Caveat told to the operator:** the old
  commit is gone from branch history/search, but GitHub's raw API can still
  serve the exact old SHA by direct lookup (verified live) — force-push
  unlinks, it doesn't delete server-side; true purge needs GitHub Support or
  their own GC. Operator's call on rotate-vs-keep (decision #973): **keep the
  original PIN value** — he accepted the risk knowing this. (Now moot for git
  hygiene purposes anyway: per the architecture change below, this sidecar
  will never carry the PIN literal again regardless.)
- **PIN architecture, operator-directed change (overrides the earlier "PIN in
  `Storage/.env`" plan entirely):** wixy must hold **zero PIN state**, ever —
  not in `.env`, not in code, not in its own DB. Operator's own words: "So
  don't store the PIN number in the website code. Have the website code get
  the PIN number or verify the PIN number with a server method that sits on
  hub, maybe make a CMD pin verify endpoint with a key for which application
  it is, and we can register pins, that sort of thing... that pin verify
  endpoint would only be available if you'd already passed Cloudflare. And
  still wouldn't reveal the PIN. And then we can do other things like
  control blocking for certain amounts of time if they get the PIN wrong so
  many times in a row." Full text + Orchestrator's technical framing at the
  intercomm link above.
- New cmd workspace #875 spawned (see Links) to build a generic, reusable,
  app-key-scoped PIN register/verify/lockout service in the **cmd** repo
  (loopback-only, same trust model as wixy's existing cmd AI-chat calls,
  Inv 13). wixy's side will call it (e.g. `POST 127.0.0.1:9320/api/pin/verify
  {"app_key": "wixy-livechat", "pin": "..."}`) instead of holding any PIN
  state locally. The Architect has been briefed on this correction and told
  to proceed with everything else (transport/media/lock-state-machine/push)
  unblocked while the cmd-side contract is finalized.

## Update 2026-09-14 (later same session) — brief frozen, delivery underway

- **Architect's brief is FROZEN v1.1**: `spec/server-chat/00-brief.md` @ commit
  `be57497` on `cmd/workspace-00029`. 6 Builder parcels across 3 waves (sec.10):
  Wave 1 concurrent (P1 backend core [lands first, others integrate on it],
  P2a media processing, P3a push core, P4 frontend lock/disguise/PIN pad, P5a
  shared-chat-extraction refactor, P6a uploader/recorder frontend); Wave 2
  (P2b uploads/queue/janitor, P3b push routes/dispatch, P5b server chat view);
  Wave 3 (P6b media wiring); close-out P7 (docs/invariants 40-45, decisions
  00144-00147, DM integration). Frozen interfaces: store API (sec.4), HTTP
  contracts (sec.5), TS LockHooks/ServerChatView/serverFetch (sec.6).
- **Delivery Manager spawned**: session `7061c848-e57d-4aee-8fd9-a9bcc459d1b4`.
  Briefed with the frozen brief + wave plan; owns partitioning parcels across
  Builders. Delivery MERGE is explicitly blocked on the cmd PIN service being
  live + the PIN registered for app_key `wixy-livechat` (brief sec.12 step 1)
  — Orchestrator (me) owns that dependency, not the DM.
- **cmd workspace #875** (session `b1810bdc-4788-45a9-a790-758e4c56d7bd`,
  codename "dragonfly-5") accepted the Architect's 4 contract asks (per-subject
  lockout via optional `subject`, `attempts_left` on wrong-PIN, 404
  unknown_app vs 401 wrong_pin vs 429 locked+Retry-After, documented
  retry-safety). It will self-register `wixy-livechat`'s PIN using cmd
  decision #973 (operator's "keep the original PIN" answer) as authorization
  — nobody needs to relay the literal value again. ETA a few hours for a real
  PR with the finished contract.
- **7 operator flags raised** (op-ask-question, delayed/non-blocking, split
  across two multi-question decisions since each call caps at 4): idle-fade
  multi-tap gesture confirmation, chat-media storage limits (20GB quota/10GB
  floor/1080p cap/no originals kept), no-backup-anywhere confirmation, generic
  push-notification text confirmation, public-repo-is-fine-for-code
  confirmation, whether message delete/wipe is wanted, and the standalone
  (non-cmd) edition's PIN gap being acceptable for now. None of these block
  Builder work starting.
- **Next**: wait for Builders to spin up under the DM; watch for the cmd PIN
  service PR; watch for the operator's answers to the 7 flags above (act on
  any that change scope); once cmd's contract is real, relay it to whichever
  Builder owns wixy's P1 backend core (`livechat/pinclient.py`) so they build
  against the real shape instead of the Architect's placeholder.

## Update 2026-09-14 (later same session, by the DM) — delivery record + wave 1 dispatched

- **Delivery record**: cmd delivery `b5377785-73eb-4968-b269-18d958b70d83` (seq 2;
  seq 1 is a stray empty-mission row from a first POST that mis-named the
  `mission_md` field — harmless, `get_active_delivery` picks highest-seq
  `open` row so seq 2 is authoritative). 12 tasks: P1, P2a, P2b, P3a, P3b, P4,
  P5a, P5b, P6a, P6b, P7, plus a DM-owned "Integration, audit, deploy
  verification, delivery merge" task. Workspace `delivery_state`:
  `discussing` → `building`.
- **Wave 1 dispatched** (6 concurrent Builders, brief sec.10 waves), each its
  own build space (worktree `..._bs{1..6}`, branch `cmd/workspace-00029-bs{1..6}`,
  base `cmd/workspace-00029`), each sent a full self-contained module brief
  (stored via intercomm, envelope pointing at it) plus told the FINAL
  HANDOFF / BLOCKER protocol:
  - P1 backend core — session `14dae1f4-d2d4-4d07-aa8f-555dbda1336b`,
    build space `cc5fa7e8`, claude-sonnet-5 xhigh. Lands first; everything
    else integrates on it.
  - P2a media processing (pure, ffmpeg-hardened) — session `08857e56-db5b-
    4447-a7d2-7bb3c99cc7f2`, build space `a80233ca`, claude-sonnet-5 xhigh.
  - P3a push core + service worker — session `6794dc17-4d4d-46b2-b7b0-
    899c0706329e`, build space `ad3fb73b`, codex gpt-5.6-luna high.
  - P4 frontend lock state machine/disguise/PIN pad — session `067bdbd9-
    19b1-428c-b81b-c2316f481e17`, build space `44767545`, claude-sonnet-5
    xhigh (security-critical parcel, kept on the higher tier).
  - P5a shared chat extraction (pure refactor of the LIVE AI chat panel) —
    session `cc37ed23-19f7-4201-bccf-d7eb0535294f`, build space `789e14c5`,
    claude-sonnet-5 xhigh (highest regression-risk parcel — existing
    chat-ux.spec.ts/composer-*.spec.ts must stay green, unmodified except
    import paths).
  - P6a frontend media modules (uploader/recorder/mediaRender) — session
    `61c0f8b6-da4e-4853-9841-ff99c4e53b42`, build space `db744467`, codex
    gpt-5.6-luna high.
  - Model choice rationale: security/auth-adjacent and regression-risk
    parcels (P1, P2a, P4, P5a) kept on claude-sonnet-5/xhigh (the team's
    Claude ceiling); more contained/self-mocked parcels (P3a, P6a) given to
    codex gpt-5.6-luna/high to diversify and parallelize without exceeding
    the ceiling.
  - Lane monitors (`lane-monitor` skill) armed on all 6, `expect_secs=3600`:
    lane ids `c7892056`, `0a2e7a16`, `1fe24d9c`, `d3904fc1`, `e453b0c2`,
    `bbdcc534`. A stalled Builder pages the DM automatically.
- **Sequencing for later waves** (not yet dispatched): wave 2 (P2b, P3b, P5b)
  starts once P1 has landed on `cmd/workspace-00029`; wave 3 (P6b) starts once
  P2b + P5b + P6a have all landed; P7 (docs/invariants 40-45/decisions
  00144-00147) is close-out once every other parcel is in.
- **Merge gate reminder**: the DM reviews every Builder's FINAL HANDOFF
  independently before that Builder may open/merge its module PR against
  `cmd/workspace-00029` (never `main`). The DM never merges a Builder's
  module itself.
- **Delivery-merge blocker unchanged**: still gated on the Orchestrator's
  dependency #9 (cmd PIN service live + the operator's PIN registered under
  app key `wixy-livechat`, brief sec.12 step 1) — the Orchestrator owns
  clearing this and will notify the DM.
- **DM session**: `7061c848-e57d-4aee-8fd9-a9bcc459d1b4` (workspace #29
  Delivery Manager).

## Update 2026-09-14 (later same session, by the Orchestrator) — decisions answered

- **Decision #973** (keep-vs-change the original PIN): answered, kept.
- **Decision #975** answered: public repo is fine (no change) · standalone
  edition's PIN gap OK for now (no change) · **"yes, add delete or wipe"**
  for messages/chat history — this is NEW SCOPE not in the frozen brief.
  Orchestrator's read: implement BOTH per-message delete and a full
  wipe-everything (operator didn't pick one over the other; both is the
  most complete option and isn't worth blocking on a re-ask). Sent to the
  Architect to spec as a v1.2 addendum, with an explicit question on
  whether it can be added without touching the already-frozen store
  API/HTTP contracts/TS interfaces wave-1 Builders are actively coding
  against, or whether it needs to land as a late parcel (P7 close-out or a
  fresh P8) to avoid destabilizing in-flight work. Awaiting the Architect's
  ruling before this reaches any Builder.
- **Decision #974 answered**: storage limits fine, no-backup fine, generic
  push-text fine — no changes. **Gesture correction (important, urgent):**
  the frozen brief's **R2 is wrong**. Operator: "No, it is different + Single
  tap. Double tap is anywhere on the chat view to lock it again." Correct
  reading: the locked "Server" screen reveals "Open server settings" on a
  **single tap** (not the brief's "rapid multi-tap ≥2 taps"); **R3** (a
  double-tap-or-more anywhere in the unlocked chat view re-locks it) was
  already correct, unchanged. Sent urgently to the Architect (errata/v1.3)
  and to the DM as a heads-up, since P4 (Builder D) was actively coding the
  wrong R2 reading. **DM caught it fast**: put an immediate hold on Builder
  D's decoy-tap-reveal detector specifically (rest of P4 unaffected,
  continuing), waiting on the Architect's official errata text before
  redirecting further.
- **Unrelated e2e flake spun off, now FIXED + MERGED**: the DM found + independently
  confirmed a pre-existing, unrelated flake in `e2e/tests/collection-edit.spec.ts`
  while clearing P5a. Per the no-stopgap/root-cause doctrine this wasn't left as a
  dismissed "flake" — spun off into wixy workspace #30 ("anemone-7", session
  `ed5c0281-a830-4ab8-bdbd-d0b73a2482c7`), fully decoupled from this workspace's
  branch/scope. **Outcome**: the originally-reported "reorder-timing" symptom
  never reproduced (55+ clean runs); the REAL, reproduced bug was a server-side
  concurrency race in `wixy_server`'s draft `overlay.json` (unlocked read/write,
  Windows `PermissionError`) — fixed by extending the existing `tree_lock()` to
  every overlay.json access site. Full pytest (1,395) + 50x e2e repro both green
  post-fix. **Merged**: PR #223, SHA `593837a4f7cdd06614533635d2f1ae2110b38b4f`,
  branch deleted, decisions/00144-draft-overlay-json-unlocked-rw-race. Fully
  closed — lane resolved, nothing further to track on this thread.
- **Both open Architect rulings resolved**: R2 errata v1.3 pushed (`ada8550`)
  and sent direct to P4 (Builder D) by the Architect — no further action
  needed. Delete+wipe spec'd as v1.2 addendum sec.17 (`5f29b1f`) — both
  per-message delete and full wipe, purely additive (no frozen sec.4/5/6
  changes). Only in-flight impact: amendment A1 to P1 (not yet merged —
  events CHECK +2 types, nullable `message_seq`, `secure_delete`, stream
  skip/emit); the rest ships as a new late parcel P8 once P1+P2b+P5b land.
  Relayed to the DM to route A1 to P1 now and schedule P8. **DM confirmed**:
  A1 routed to P1 (Builder A) with the exact sec.17.2 text; P8 added as
  delivery task ord13 (full sec.17 spec), gated on P1+P2b+P5b landing.

## Update 2026-09-14 (later same session) — wave 1 complete, real PIN contract landed

- **Wave 1 all 6 Builders reported finished** (P1/P2a/P3a/P4/P5a/P6a) — P6a
  already merged (PR #220); DM is processing the rest's FINAL HANDOFFs.
- **cmd's real PIN-verify contract landed**: PR #3068 open on cmd (full-suite
  CI running, NOT yet merged/deployed). It genuinely differs from the frozen
  brief's sec.5.1 placeholder — route is `POST
  http://127.0.0.1:9320/api/pins/wixy-livechat/verify` (app key in the
  **path**, plural `pins`, not `/api/pin/verify`), with richer error shapes
  (401 wrong_pin+attempts_left, 404 unknown_app, 409 pin_changed, 429
  locked+Retry-After, 503 unavailable) and a strict retry-safety rule
  (retry ONLY on connection-refused/connect-timeout, since an attempt is
  charged before evaluation). Lockout: 5 wrong/subject → 60s doubling to
  24h cap; 20 wrong/app in 15min trips an app-wide lock too. Full text at
  `http://127.0.0.1:9321/intercomm/5e5cb2dff20f4df781f38af32de38933`.
  P1's build space was still unmerged, so relayed the real contract straight
  to P1 (Builder A, session `14dae1f4`) AND to the Architect (for a formal
  errata correcting sec.5.1) — both urgent, both acked.
- **Blocker #9 (delivery-merge gate) still OPEN**: cmd's PR is open/CI-running
  only — not merged, not deployed, PIN not yet registered under
  `wixy-livechat`. Told the DM explicitly not to treat it as cleared.
  cmd-side team will self-register using operator decision #973 as
  authorization once their PR lands; will ping this workspace when live.
- **New fleet-wide stall on blocker #9**: GitHub billing is refusing to start
  the "Frontend (pnpm)" required CI check on GitHub-rented runners
  ("recent account payments have failed or your spending limit needs to be
  increased") across multiple unrelated cmd workspaces (00869/00824/00854/
  00875 — not just ours), since ~11:19 today. cmd's repo ruleset requires
  this check with no bypass, so PR #3068 (the PIN service, otherwise fully
  green — Python suite passed CI, 3,126-test frontend suite passed locally)
  cannot merge until this clears. Raised as operator decision #977 (real
  money / shared-infra tradeoff — pay the GitHub bill vs. move the check to
  self-hosted Fir vs. both) — correctly left unanswered by every agent
  including me, since it's a genuine operator-only call. Purely a wait on
  him now; not something to solve by guessing.
- **Architect formalized the real PIN contract as brief v1.4** (`7df841b`):
  full cmd↔wixy mapping table, added 409 `pin_changed` to `/unlock`, pinned
  the retry-safety rule, `lock_scope` deliberately not surfaced to the
  browser, sub-4-digit PINs rejected client-side so a stray tap can't burn
  a real attempt. Deploy step + blocker #9 wording updated in the brief.
  Sent direct to P1. No further action needed — the brief is now the
  authoritative source, not my earlier paraphrase.
