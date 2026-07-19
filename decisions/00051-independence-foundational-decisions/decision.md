# Nine foundational independence-phase decisions

## Context

The INDEPENDENCE phase (`spec/independence/`) gives Cottage Aesthetics' owner Purdi
total infrastructure independence from Josh's fleet — her own hosting, domain, AI
billing, and engine-update path — while keeping both development lanes first-class
(neither can block or be cut off by the other). The nine decisions below were fixed
during spec authoring (session `c42ea1cb-a9d6-413d-bdcb-fc77fc49abba`, Fable 5,
adversarially reviewed 2026-07-19 — 6 critical + 11 major findings folded in) and live
in `spec/independence/01-architecture.md` §5 — this entry is the durable, repo-local
record, matching the precedent set by `decisions/00001` for the base CMS build's own
foundational table.

## Decisions

| # | Decision | Because |
|---|---|---|
| 1 | Fork-sync dual control: her fork is production's source of truth; `joshcomley/wixy` stays the dev upstream; updates cross the boundary only via her button | Keeps Josh's dev lane frictionless; gives her unilateral custody + veto — the asymmetry that actually answers "what if we fall out" (spec/independence/00) |
| 2 | Cloudflare Tunnel container for ingress, not a published port | Zero inbound surface on her droplet, free tier, the same CF Access UX already proven on `ca.cinnamons.uk` |
| 3 | Watchtower image-pull polling IS the deploy mechanism | No inbound surface, and no CI credentials ever need to reach her droplet — it only ever pulls |
| 4 | Site repo TRANSFERRED (history preserved); engine FORKED; owner docs moved to a NEW private `<org>/ca-business` | Her content keeps its history under her ownership; the engine gets two independent dev homes; her private business material must never ride a now-public engine repo |
| 5 | MIT license (operator-confirmed 2026-07-19) | Dissolves the licensing dependency entirely; gated by the pre-publication audit (02) before the flip, since going public is practically irreversible |
| 6 | One image, both editions, selected at runtime by `WIXY_EDITION` | No standalone-specific code drift; upstream CI boots the SAME image both ways on every merge (03 §5), so container breakage is visible to Josh before she can ever pull it |
| 7 | GHCR package visibility PUBLIC | The engine is MIT anyway — this keeps private-registry auth off both the droplet and Watchtower (both would otherwise need it independently; a refuted claim caught during the adversarial review) |
| 8 | Sync-workflow pushes use a dedicated `SYNC_PUSH_TOKEN` fine-grained PAT, never `GITHUB_TOKEN` | GitHub silently suppresses downstream-workflow triggers on events authored by `GITHUB_TOKEN` — the image build and any conflict-PR CI would simply never fire, with no error to notice |
| 9 | The scheduled sync run is notify-only (refreshes commits-behind + opens an issue); only her explicit button click ever merges/deploys | "Updates land when SHE chooses" is the whole promise (spec/independence/00) — auto-deploying upstream on a weekly timer is a silent-breakage / supply-chain vector, not a convenience |

## What to watch for

- **Decision 1** is the load-bearing one: every later milestone (04's sync workflow,
  the Engine admin card, engine-update rollback) exists to make this asymmetry real
  and demonstrable, not just asserted in a doc. A future change that makes upstream
  sync automatic, or bypassable without her explicit action, silently breaks the
  mission — not merely a feature regression.
- **Decision 6**: `WIXY_EDITION` must stay a pure runtime switch (an env var consumed
  at request/startup time — see `wixy_server/settings.py`'s `edition` field, added
  milestone 1), never a build-time fork in the Dockerfile or the source tree. Two
  Dockerfiles, or an `if standalone:` fork deep in application code paths, would
  reintroduce exactly the drift decision 6 exists to prevent.
- **Decision 7**: if GHCR visibility is ever flipped back to private for any reason,
  both the droplet's `docker pull` and Watchtower's polling break simultaneously and
  silently (no inbound alert) — re-verify this decision's premise (the engine being
  MIT) before ever touching it.
- **Decision 8**: any new GitHub Actions workflow added later that pushes to a branch
  on her behalf (in `wixy-engine` or in the site repo) must reuse this exact
  dedicated-PAT pattern — it's an easy trap to fall into by copying a more ordinary
  workflow's default `GITHUB_TOKEN` idiom, since that idiom looks correct and simply
  fails silently downstream instead of erroring where the mistake was made.
- **Decision 9**: resist ever adding an "auto-apply when the merge is clean" fast path
  to the scheduled sync run, even behind an opt-in setting — spec/independence/04 §1
  fixes this as unconditional, and it's the mechanism that makes decision 1's asymmetry
  actually true rather than aspirational.
