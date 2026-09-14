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
