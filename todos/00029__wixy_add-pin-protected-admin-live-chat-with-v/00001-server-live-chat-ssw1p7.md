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
  Delivery Manager) — **handed over to `a13d06a4-6290-41ac-9032-b3b9b229edfe`**
  at some point during wave 2/3 (peer_check auto-follows the chain; sends to
  the old id still land correctly). As of 16:05, actively deep in real
  integration debugging: wiring P4's lock/disguise UI to the real P5b chat
  view surfaced (1) 4 of P4's own `server-lock.spec.ts` tests failing
  because they assert the STUB's DOM shape (`.wx-srv-panic`,
  `.wx-srv-draft-stub`), which stops mounting once the real view replaces
  it — needs selector updates, not a real regression; (2) a genuine "A → B
  live delivery" e2e failure, root-caused to B's own message SEND failing
  (not A's receive) — actively instrumenting. This is normal, expected
  integration-stage work, not a stall — a lane-monitor "P4 idle" alert on
  team-status during this period is a false positive (the work is happening
  in the DM's own session, not delegated back to the P4 builder).

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
- **BLOCKER #9 CLEARED** (2026-09-14): cmd PR #3068 merged (`a3baf62d`),
  cmd-prod deployed, app_key `wixy-livechat` registered (authorized by
  decision #973, PIN value never passed through this workspace or git).
  Live-smoke-tested against production: correct PIN → 200 ok; wrong → 401
  wrong_pin+attempts_left; unknown app → 404; bad format → 400. Contract is
  UNCHANGED from what was already relayed to P1/Architect (a pre-merge
  security review found+fixed a lockout-refund race internally, no response
  shape moved) — no rework needed on wixy's side. Reference:
  `docs/ai/pin-service.md` in the cmd repo, new fleet skill `pin-service`.
  Operator can rotate the PIN himself at `cmd.cinnamons.uk/pins`. Told the
  DM immediately — **delivery merge is no longer blocked once the remaining
  parcels land.**
- **GitHub billing recurred** (decision #980, ~1hr after #977 resolved): the
  account-wide GitHub Actions spending limit ran dry again within ~15 min of
  being topped up (cmd main-branch CI failed again at 14:29 and 14:38, same
  "recent account payments have failed" message). Cmd team's options: move
  the GitHub-hosted `frontend (pnpm)` check onto self-hosted Fir (no more
  GitHub spend, but makes CI depend on Fir's uptime) vs. raise the spending
  limit again (keeps the fleet-independent design, costs recur) vs. leave
  blocked. Same as #977 — a shared-infra/spend tradeoff, genuinely the
  operator's call, left unanswered by design. **Risk noted for THIS
  workspace**: the spending limit appears account-wide, not cmd-repo-scoped,
  so wixy's own remaining CI runs (P2b/P3b/P5b/P6b/P7/P8, and the eventual
  delivery-merge PR itself) could hit the same wall — nothing has failed on
  wixy's side yet (PR #223's CI, incl. its own `frontend` check, was fully
  green), just flagging the exposure for awareness.
- **Architect formalized the real PIN contract as brief v1.4** (`7df841b`):
  full cmd↔wixy mapping table, added 409 `pin_changed` to `/unlock`, pinned
  the retry-safety rule, `lock_scope` deliberately not surfaced to the
  browser, sub-4-digit PINs rejected client-side so a stray tap can't burn
  a real attempt. Deploy step + blocker #9 wording updated in the brief.
  Sent direct to P1. No further action needed — the brief is now the
  authoritative source, not my earlier paraphrase.

## Update — pause + resume (2026-09-14 17:16 through 2026-09-23 20:33)

- **Operator paused the workspace** ("Pause this work", 2026-09-14 17:16). The
  Delivery Manager was mid-integration-debug (the "A → B live delivery" bug,
  root-caused to a P5b test-file gap; fix drafted only in a private scratch
  worktree, never applied to any real branch). Orchestrator steered the DM
  to stop, confirmed a clean checkpoint (nothing merged/pushed since, no
  uncommitted loss), and set delivery_state to `on_hold`.
- **~9.3 days on hold.** Orchestrator held every recurring lane-monitor alert
  (wait-expired cycles, allowance walls) throughout with no forward progress
  — all correctly non-actionable given the explicit pause. One synthetic
  `[cmd auto-nudge]` message tried to trigger a resume partway through;
  correctly declined since it wasn't the operator's own words and was
  factually confused about the actual blocker (pre-pause, already-resolved
  items).
- **Operator resumed directly** (2026-09-23 20:33, verbatim: *"Please
  continue, but handover to Luna 6 XL for all implementation work, and Sol 6
  non XL to review it"*). Workspace set back to `building`. **NEW MODEL
  ROUTING for all work from here on**: implementation/Builder dispatches →
  **Luna 6 XL** (codex provider, model id `gpt-6-luna[xl]`); review passes
  (FINAL HANDOFF review, code review, audit-style checks) → **Sol 6**
  (codex provider, model id `gpt-6-sol`, non-XL). Relayed to the DM; applies
  to new dispatches going forward, not a retroactive redo of in-flight work.
  Progress unchanged at resume: 7/13 delivery tasks done, nothing lost
  across the pause.

## Update 2026-09-23 (Orchestrator handover, new seat `b11567bc`) — resume gate + correction

- **Orchestrator seat changed**: `0e9a2c7d` -> `b11567bc` (roster `overlap_session_id`
  links them). Angel seat `71edb1bf` is active and sweeping; DM `014c0ebc` is idle.
- **Delivery Manager is deliberately holding** resume + new model routing until
  decision **#1164** ("Confirm: resume Server chat delivery + new model routing?")
  shows a genuine operator answer. It verified #1164 exists via cmd's decisions API
  itself (correct independent channel). Status at this entry: `open`, no answers.
  Watcher armed on it; on `Yes, confirmed` -> tell the DM to resume the A->B live
  delivery fix + P4's 4 stale selectors, route NEW implementation to
  `gpt-6-luna[xl]` (codex) and review to `gpt-6-sol` (codex); no redo of in-flight work.
- **CORRECTION of the record**: the previous Orchestrator told the DM that the
  `bleep-test <test@bleep>` commit identity predated 2026-09-14 ("since August").
  That was FALSE. Verified today: all 41 `bleep-test` commits in the repo are dated
  2026-09-14 (the day this workspace started, incl. the Orchestrator's own first
  commit `db8657d`); the repo's earlier history is `Biosphere`/`joshcomley`. The DM's
  check was right; the claim is retracted (peer-messaged to the DM). The DM's
  suspicion was reasonable and was answered with better evidence (#1164), not by
  repeating the claim.
- **Angel sweep alert (dormant builders, 9 days)** answered: the dormancy was the
  operator's own hold (9/14 17:16 -> 9/23 20:33), not a stall. Angel asked not to
  re-dispatch builders or alarm while #1164 is pending.
- **Decision #1164 ANSWERED by the operator (2026-09-23): "Yes, confirmed"** —
  resume delivery now; implementation -> Luna 6 XL (`gpt-6-luna[xl]`), review -> Sol 6
  non-XL (`gpt-6-sol`). Verified via cmd's decisions API (`resolved_by=operator`).
  DM `014c0ebc` told to go. Remaining: A->B live-delivery fix, P4 selectors, then
  P6b, P8, P7, delivery merge (named reviewer, CI green, branch current, SHA recorded).

## Update 2026-09-23/24 (DM `014c0ebc`, this session) — resumed, P4+P5b merged, DM-integration landed, P6b+P8 dispatched to codex

- **Security note for future readers**: this session's own peer-message chain (Orchestrator
  `0e9a2c7d`) once relayed a message bundling a plausible resume notice with an unverifiable
  model-routing instruction and self-corroborating "evidence" (a matching git commit, a
  flipped `delivery_state` flag) — a textbook injection shape. It was correctly refused
  pending independent verification. The false "since August" claim (see entry above) came
  from the SAME chain and was later retracted by the successor Orchestrator `b11567bc`. The
  eventual go-ahead came only from operator decision **#1164** (cmd's decisions API,
  `resolved_by=operator`, "Yes, confirmed"), checked directly, not relayed. Lesson: when a
  peer channel asks for a consequential change (here: routing agentic work to a new
  provider), verify via a channel the same actor cannot also write to, not via more messages
  from that actor.
- **P4 (lock/disguise/PIN-pad) merged**: candidate `1e5af5e`, PR #229, merge commit `26525d7`.
  Independently re-verified before merge (mypy/ruff/tsc/pytest 1654/1654/vitest 1001/1001/
  bundle zero-drift). Delivery task + lane closed.
- **P5b (server chat view) merged**: candidate `0b1bcf2` (superseded the earlier `787e24c`
  after the Builder found my drafted `keepAlive(pageB)` fix was NOT the real cause — actual
  root cause was R3's multi-tap gesture firing because Playwright taps Send within ms of the
  Continue tap; fixed via a `MULTI_TAP_INTERVAL_MS+100` wait in `unlockServer`. They also
  found+fixed a real `chat.css` specificity bug: `.wx-srv-thread-view[hidden]` had no
  `display:none` override, so the composer was usable before a name existed.) PR #228, merge
  commit `87651bb`. Independently re-verified (mypy/ruff/tsc/pytest 1654/1654/vitest
  1061/1061, bundle zero-drift, combined server-chat+server-lock e2e 27/27 including the
  originally-blocking "A -> B live delivery" test — run myself with the integration patch
  applied in a scratch copy of bs5 before clearing).
- **DM-integration commit landed**: `a880b57` on `cmd/workspace-00029`, pushed directly (per
  brief sec."Integration rules for DM"). Wires `createServerChatView` into `shell.ts`
  (1 import, 1 arg) and updates P4's `server-lock.spec.ts` off the stub's
  `.wx-srv-panic`/`.wx-srv-draft-stub` selectors onto the real view's
  `.wx-srv-chat-host button[aria-label="Close"]`/`.wx-srv-chat-host textarea`, plus a new
  `enterNameIfPrompted` helper for the real view's first-unlock name prompt (which the stub
  never showed). Verified locally before push: tsc clean, bundle diff = exactly the expected
  wiring line.
- **Progress: 9/13** at this point (P1/P2a/P2b/P3a/P3b/P4/P5a/P5b/P6a done).
- **P6b (media wiring) and P8 (delete/wipe) dispatched** per the operator's new-implementation
  routing (decision #1164): spawned fresh Builder seats via
  `POST /api/workspaces/{id}/team/spawn {"role":"builder"}` then converted each via
  `POST /api/session/{id}/provider-continuation {"provider":"codex","model":"gpt-6-luna[xl]","effort":"high"}`
  (one needed `force:true` - it wedged as `wedge_no_response` on a truly empty fresh spawn;
  forcing past it worked fine). P6b -> session `dea14cd7` in build space bs6 (reused P6a's
  worktree, wave-continuation pattern). P8 -> session `38e9c31a` in a NEW build space bs7
  (`POST /api/workspaces/{id}/build-spaces {"label":"..."}"`, ordinal 7). Both briefed in full
  (spec sec.10 P6b / sec.17 P8) via peer message, lane monitors armed (P6b lane `7a68ed27`,
  P8 lane `c7583fed`, both `expect_secs=3600`). **Decision-number collision flagged to P8's
  Builder**: brief pre-allocates 00148 for delete/wipe semantics, but P5b already took 00148
  for its e2e timing fix decision — told P8 to use **00149** instead.
- **Review routing note**: operator confirmed review work should go to `gpt-6-sol` (codex,
  non-XL) — not yet exercised this session (no FINAL HANDOFF from a codex Builder landed yet
  to review). When one does, either dispatch a `gpt-6-sol` reviewer via the same
  spawn+provider-continuation pattern, or the DM's own independent re-verification (mypy/
  ruff/tsc/pytest/vitest/e2e, as done for P4/P5b above) may itself satisfy this depending on
  how the operator meant "review" to be scoped — worth a quick clarifying ask if it's not
  obvious when the moment comes, rather than guessing.
- **Remaining after P6b + P8 land**: P7 (docs/invariants close-out, decisions 00145-00147 +
  00149 used by P8 — re-check for further collisions at that point since 00148 is now spent
  too), the sec.13 audit (fable tier per the audit skill's trigger rules; needs explicit
  operator authorization per the 2026-09-23 Fable-is-special-counsel ruling — ask via
  op-ask-question if authorization status is unclear), live verification via the `verify`
  skill on `ca.cinnamons.uk` (brief sec.12), then the one delivery merge.

## Update 2026-09-24 (Orchestrator `b11567bc`) — delivery resumed; routing ruling

- **Resume confirmed and running.** Since #1164 was answered: P4 merged (PR #229,
  `26525d7`), P5b merged (PR #228, `87651bb`) -> progress 9/13. P6b (media wiring,
  `dea14cd7`) and P8 (delete + wipe, `38e9c31a`, build space bs7) dispatched by the
  DM on `gpt-6-luna[xl]` (codex). The DM first spawned them on defaults, caught it
  itself, and converted them via `provider-continuation` before briefing.
- **Real product finding (Architect ruling, spec v1.5.1):** the 400 ms multi-tap
  re-lock gesture can fire on a person's normal pick->confirm taps in the delete menu
  (and desktop right-click was miscounted). Genuine user-facing timing bug, not a
  test artifact: tests must run at full speed with no added waits. I flagged that
  P6b's pauses between Send and the photo/voice controls may be the same class; the
  DM asked the Architect and told P6b to hold before finalizing.
- **Review-routing ruling (DM asked, I answered):** operator's "Sol 6 non-XL to
  review it" is read as ALL Luna implementation candidates. The DM keeps its own
  mechanical verification as the gate AND dispatches a dedicated `gpt-6-sol`
  reviewer per candidate before CLEARED. The DM had cleared P6b on its own
  verification alone, so P6b gets the Sol review before merge, or on the merged
  diff with a fix-forward if it already merged. The sec.13 audit is separate and
  still applies at the delivery merge. Fuller reading chosen; the operator can
  narrow it.
- **Noise worth knowing:** roster "active" flickers on finished builders (P4, P5b,
  P6a) are trailing close-out or Q&A, not new dispatches. The old P6a session was
  auto-continued onto another Codex account after its source account hit a usage
  limit (cmd's quota-successor mechanism); no action needed.

## Update 2026-09-24 (DM `014c0ebc`) — P8 course-correction, P6b Sol review findings, process notes

- **P8 nearly shipped a wrong fix once**: after the Architect's v1.5.1 ruling (menu
  taps need a real gesture-boundary product fix, not test waits), the Builder
  independently reconverged on the SAME rejected waits-only approach mid-flight
  (parallel reasoning that hadn't incorporated my relay yet), self-reported it
  "resolved" via decision 00148 with "product lock behavior unchanged." I held this
  firmly (did not accept the clearance), re-escalated, and the Builder correctly
  course-corrected once it saw the ruling — now implementing gesture boundaries +
  `button!==0` filter in `gestures.ts` per spec v1.5.2 (`11bedfd`). **Lesson**: a
  Builder's own "resolved" self-report needs the same skepticism as a FINAL
  HANDOFF — this one crossed in transit with a still-open correction.
- **Architect classify rule (v1.5.2), useful going forward**: did tap 1 make
  control 2 APPEAR UNDER THE FINGER? Yes -> needs a gesture boundary. No -> ordinary
  cadence, waits in the test are fine. P6b's Send->attach case got the "No" answer
  (both controls already on screen) plus one new requirement: voice notes need a
  1s minimum duration (shorter = discard + "Too short" hint).
- **P6b (candidate `9ebcc492`) — my own verification was clean, but the dedicated
  `gpt-6-sol` review (per the routing ruling above) caught 3 real HIGH findings my
  automated checks missed entirely:**
  1. Gesture boundaries are INERT — `thread.ts:109`/`mediaRender.ts:91` mark
     settings/photo openers with `data-srv-gesture-boundary`, but `gestures.ts:85-96`
     never reads that marker. The v1.5.2 fix looks present (markers exist) but does
     nothing functionally.
  2. Old media URLs expire after re-unlock — `thread.ts:523` doesn't refresh loaded
     history's signed URLs on attach/re-render; they carry the original 12h TTL
     (`tokens.py:183-229`), so old thumbnails/video/voice 403 after that window
     despite a fresh unlock.
  3. `thread.ts:380` clears every media DOM node on each send/SSE redraw without
     pausing/disposing active playback (`detach():558` only pauses nodes still in
     `messageList`) — a detached-but-playing node can keep playing after panic,
     undermining the panic button's instant-hide/privacy guarantee, and can leave
     `mediaPlaying` suspended incorrectly.
  All 3 relayed to the Builder for fix-forward; PR #230 (candidate `9ebcc492`) is
  NOT merged and won't be until a new candidate clears both my verification and a
  fresh Sol pass. **This is strong evidence the Sol-review-in-addition-to-DM-
  verification ruling was the right call** — none of these 3 would have been caught
  by mypy/ruff/pytest/vitest/e2e alone.
- **Reviewer worktree pattern established**: dispatch a `gpt-6-sol` reviewer via
  `team/spawn {role:builder}` + `provider-continuation {force:true if wedged}`,
  then point it at an ISOLATED, detached, read-only `git worktree add` checkout of
  the exact candidate SHA (e.g. `...__review-p6b\wixy`) — NOT the shared build-space
  worktree (a live Builder may still be working there) and NOT the DM's own primary
  checkout (one reviewer spawn defaulted into it before being briefed; caught and
  redirected before any edit happened, no harm done, but redirect explicitly next
  time in the FIRST message).
- **Peer-messaging volume cap discovered**: sending several sends to the same
  recipient in quick succession gets `"reason":"volume_cap"` degraded delivery
  (truncated to ~197 chars, independent of the normal ~600-char `over_short_max`
  envelope limit). Workaround used successfully: `POST http://127.0.0.1:9321/intercomm
  {"text":...}` to store the full content, then send a SHORT pointer message (the URL
  survives truncation since it's early in a short message) - same mechanism other
  senders already used when relaying long content to me.
- **Fresh Builder-seat spawns are unreliable** (`team/spawn {role:builder}` ->
  `provider-continuation`): observed `context_unreadable` (spawn genuinely never
  started - check `retired_reason` on the team roster; `"no_live_session"` means
  abandon and respawn, don't keep retrying the same session id) vs `wedge_no_response`
  (spawn is alive but needs `force:true` to convert) vs success. No reliable fixed
  wait time - poll the roster/messages endpoint for a real transcript before
  concluding a spawn failed vs is just slow.
- **Progress unchanged at 9/13** (P6b and P8 still both "doing" pending fixes).
  P4/P5b delivery tasks + lanes already closed (see above). P6b/P8 delivery tasks
  marked "doing" with their builder_session_id/build_space_id set for tracking.

## Update 2026-09-24 (DM `014c0ebc`) — CRITICAL security fix, DM-owned, pushed

- **The `gpt-6-sol` reviewer (`e89fc62b`), while reviewing P6b, found a critical
  base-branch (P1/P2b, already-merged) vulnerability unrelated to P6b's own diff**:
  `DELETE /api/admin/server/uploads/{uploadId}` -> `cancel_upload()` in
  `wixy_server/livechat/uploads.py` passed the client-supplied `upload_id` straight
  into `paths.server_upload_dir(upload_id)` (a plain path join, no normalization),
  then unconditionally `shutil.rmtree(..., ignore_errors=True)`'d the result. An
  authenticated request (any unlocked chat participant) with `upload_id=".."`
  resolved to the PARENT `server/` directory - DB, `secret.key`, `vapid.json`, every
  attachment's media - and silently wiped it. No backup exists for this feature's
  data (per the operator's own accepted decision #974), so this would have been
  unrecoverable.
- **Fixed it myself, directly, as the DM** (not routed to a Builder - small, surgical,
  urgent, and touches P1/P2b's already-closed area, not P6b's or P8's own work):
  red/green discipline - wrote `test_cancel_rejects_a_traversal_id_instead_of_deleting_server_dir`
  in `test_livechat_uploads.py` (a sentinel file in `server_dir`, asserts it survives),
  confirmed it FAILED on unfixed code (the sentinel was actually deleted - proved the
  vuln, not just theorized it), then added `_UPLOAD_ID_RE = re.compile(r"^[0-9a-f]{32}$")`
  (mirrors the existing `_ATTACHMENT_ID_RE` pattern already used for attachment ids)
  and a `.fullmatch()` guard at the top of `cancel_upload` before any DB/filesystem
  access. `upload_id` is always server-generated via `uuid.uuid4().hex`, so this
  closes the gap without changing the frozen "204 unconditionally, no error case"
  HTTP contract - an invalid id is now just treated the same as an unknown one.
  Traced every other `server_upload_dir`/`server_attachment_media_dir` call site
  (`janitor.py`, `media_queue.py`, the chunk-upload/complete routes) - all of them
  only ever operate on DB-sourced ids gated by an existence check first, never raw
  client input, so this was the one reachable entry point; did NOT add redundant
  validation there (nothing to guard against).
- **Had the same reviewer (already deep in this exact code) check my fix before
  push** - confirmed clean, one polish suggestion (`.fullmatch()` over `.match()`
  with `$`, since Python's `$` technically also matches before a trailing newline;
  not itself exploitable here, but worth the correctness). Applied. mypy/ruff/full
  pytest (1655/1655) all clean. Pushed directly to `cmd/workspace-00029` as `b472919`
  (matches the DM-integration-commit precedent for small, urgent, DM-owned fixes
  outside any Builder's active parcel).
- **Also caught while reviewing**: a MEDIUM finding for P6b (upload-cancel chip never
  calls `DELETE /uploads/{id}` on abort, leaking quota/disk until the 24h janitor) -
  relayed to P6b's Builder alongside the 3 HIGH findings (see update above), to fix
  together before their next FINAL HANDOFF.
- **Isolated review worktree** at
  `...__review-p6b\wixy` (detached HEAD, throwaway) is now stale/done - the reviewer's
  work there is complete; safe to remove at any point, not referenced by anything else.
- **This validates the extra Sol-review layer beyond just my own automated
  verification even more strongly than the first 3 HIGH findings did** - a genuinely
  critical, unrelated, already-merged vulnerability that had been sitting in the
  integration branch since P1/P2b merged, caught only because a dedicated reviewer
  was reading the code with fresh eyes rather than just running the existing test
  suite (which had 100% coverage of the "happy path" and the "unknown id" no-op case,
  but nobody had written a test for a malformed/malicious id before now).

## Update 2026-09-24 (DM `014c0ebc`) — P6b done (3 fix-forward rounds, 6 findings, merging)

- **P6b took 3 fix-forward rounds after the initial 4 findings** (3 HIGH + 1 MEDIUM),
  because the FIRST fix round (candidate `5fc2ef7`) introduced 2 NEW regressions of
  its own, both caught by the same `gpt-6-sol` reviewer re-checking the fix rather
  than just rubber-stamping it:
  1. The HIGH-2 fix (refresh signed media URLs by re-fetching history on reattach)
     merged fresh rows into `confirmedBySeq` but never removed retained rows absent
     from that refresh, then advanced the stream cursor past them - so a message
     deleted (or the whole chat wiped) while a client was locked would REAPPEAR on
     unlock, since the deletion event got silently skipped. Fixed in `e1a355f`:
     reconcile retained rows against the refreshed range before advancing the cursor.
  2. The HIGH-3 fix (dispose media on redraw/detach so playback can't survive panic)
     was too broad: `renderThreadList` still called `disposeAttachmentMedia` +
     `innerHTML = ""` on EVERY render, so an ordinary incoming message from anyone
     else would stop/reset any actively-playing voice note or video elsewhere in the
     thread. Fixed in `f373ea4`: rewrote the renderer as a real DOM-diff/reconciliation
     (keyed maps for message/separator/echo nodes, `insertBefore` only for genuinely
     new/moved nodes, dispose only for nodes actually being removed or changed) -
     playback now survives ordinary updates and only stops on lock/delete of that
     specific item.
- **Both regressions were things my own mechanical verification (mypy/ruff/tsc/
  pytest/vitest/e2e) could not have caught** - the delete/wipe reappearance can't be
  exercised until P8 merges (no real route to test against yet; covered by new unit
  tests exercising the reconciliation logic directly), and the playback-interruption
  bug doesn't fail any assertion, it's a UX regression a human would notice, not a
  test. This is now THREE separate real findings (the base-branch security bug +
  these 2 regressions) that only surfaced because of the dedicated review layer -
  strong, repeated evidence for keeping it on every remaining candidate.
- **P6b CLEARED** on final candidate `f373ea4` (base `7d6584b`, includes the security
  fix `b1c394f` and the Architect's `7d6584b`/v1.5.3 scrub ruling) - my own full
  verification green (mypy/ruff/tsc, pytest 1655/1655, vitest 1076/1076, bundle
  zero-drift, e2e 31/31) AND the Sol reviewer's independent 0-critical/0-high
  confirmation on this exact SHA. Pushed, PR #230 updated to this SHA, CI running.
  Merging once CI is green - not yet merged as of this entry.
- **Reviewer worktree pattern refined further**: reused the SAME isolated worktree
  path (`...__review-p6b\wixy`) across all 3 rounds by `git worktree remove` +
  re-`add --detach` at the new SHA each time, rather than creating a fresh one per
  round - keeps the throwaway-worktree count from growing unbounded across a
  multi-round fix cycle.
