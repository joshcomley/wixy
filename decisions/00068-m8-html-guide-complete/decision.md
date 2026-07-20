## Context

M8 (spec/independence/07-html-guide.md) is the flagship deliverable: a self-contained,
zero-JS-framework HTML guide walking Purdi through independence, `guide/` in the engine
repo. The build system (`guide/build.py`, `manifest.py`, `linkcheck.py`, templates,
assets) plus two reference chapters (`start-here`, `track-j`) were built and tested by
the prior session in this chain. That session delegated the remaining 11 chapters to
four parallel background agents, then ran out of context before any of them confirmed
completion, and handed over.

This session picked up the handover, found (via the auto-snapshot commit taken at the
handover boundary, `fc94cb8`) that two of the four agents had in fact finished —
`track-p-1-password-manager.html` + `track-p-2-github.html` and
`track-p-3-digitalocean.html` + `track-p-4-cloudflare.html` — while the other two
groups (`track-p-5-anthropic` / `track-p-6-droplet-setup`, and
`track-p-7-drill` / `track-p-8-go-live` / all three appendices) were still 2-line
placeholders. Per the handover's own instruction, no attempt was made to resume the
dead agents; the remaining seven chapters were written directly in this session instead
of re-delegating, specifically so the cross-chapter consistency issues found below
(spanning P.2, P.5, P.6, P.7, P.8) could be resolved by one author holding the whole
picture, rather than re-explained into fresh agent prompts.

## What was found and fixed, closing three real content gaps

Close reading of `spec/independence/00-mission.md`, `04-fork-sync-dual-control.md`,
`06-backups-monitoring.md`, `deploy/standalone/setup.sh`, and the already-written
chapters surfaced three places where the guide, as scaffolded, would not actually have
worked end-to-end:

1. **`ca-state-backup` repo was never created anywhere.** `setup.sh` prompts for its
   SSH URL early (3rd question), but neither Track J (`track-j.html`, already-shipped,
   not touched) nor the original P.2 draft ever has anyone create it — only
   `ca-business` is created there. Fixed by adding its creation as
   `track-p-6-droplet-setup.html` step 1 (an empty private repo, same naming
   convention as the org/fork names in P.2), immediately before the chapter gathers
   both repos' SSH URLs in step 2.
2. **Appendix C promises to revoke Josh from "org/Access/Anthropic"
   (spec 07 §2's literal wording) but nothing ever grants him org or Anthropic
   access.** `track-p-4-cloudflare.html` already lists his email on the Access
   policy, but P.2 never invites him to GitHub and P.5 didn't exist yet. Fixed by
   adding an "invite Josh as an outside collaborator" step to the end of
   `track-p-2-github.html` (Write access, site repo only — mirrors the bot PAT's own
   least-privilege scoping one step earlier in that same chapter) and an optional
   "invite Josh to your Anthropic console" step in the newly-written
   `track-p-5-anthropic.html`. Appendix C now reverses exactly these three grants,
   nothing more, nothing assumed.
3. **The temporary test hostname chapter 7 needed would have left `/admin` publicly
   unauthenticated.** Cloudflare Access apps match by exact hostname; the Access app
   P.4 creates is scoped to the real domain's `/admin` + `/api/admin` only, so a
   `test.<domain>` hostname added in chapter 7 for drill purposes would bypass Access
   entirely unless added to that same app's domain list. Fixed by making that
   addition `track-p-7-drill.html` step 2, immediately after adding the test Public
   Hostname route in step 1.

None of these three were flagged in the handover — they surfaced only from
cross-referencing chapters against each other and against the scripts/spec they claim
to match, which is the standard this milestone's own truthfulness clause (07 §3: "the
guide worked as written... any step that confused the implementer gets rewritten") sets.

## The Track J / M6-R2 forward obligations — both confirmed intact, not re-touched

- **M2 (ca-business population)**: `track-j.html` step 4 already carries the literal
  `git checkout 7c4fa3c02957599...` command as an executed step. Verified present,
  not re-touched (per the prior session's own handover flag).
- **M6/R2 (branch protection, illustrated, both repos, before P.6)**:
  `track-p-2-github.html` steps 9-10 cover both `cottage-aesthetics-site` and
  `wixy-engine`, each with the one-sentence why. Verified present. (The Josh-invite
  step added above is step 11, after both — ordering preserves this obligation's
  "before P.6" requirement unchanged.)

## The tunnel public-hostname design (chapters 7 and 8)

`spec/independence/01-architecture.md` line 86 ("lower TTL → her stack green on a
**test** hostname (drill, 08) → move **www**") establishes that the drill and go-live
use *different* hostnames on the same tunnel — confirmed against the fleet's own
`tooling/provision_ca_cloudflare.py` (same CNAME-to-`<tunnel-id>.cfargotunnel.com`
mechanism, there driven by API for `ca.cinnamons.uk`; here, by hand, via the Tunnel's
"Public Hostname" dashboard tab, since Purdi's tunnel is a remotely-managed one created
via `--token`, with no local `config.yml` to edit). Chapter 7 adds a `test.<domain>`
route as scaffolding; chapter 8 adds the real `www` + apex routes, replacing whatever
Cloudflare imported from Wix when the domain was first added in chapter 4 — chapter 8
step 2 has her note down the current DNS record values *before* changing anything,
since overwriting a record loses the old value, and that note is the guide's own "undo"
path (spec 07 §2 item 8's "undo = flip it back" box), not a re-run of any script.

## The repo-visibility / linkcheck resolution

`python -m guide.linkcheck` failed on exactly one of the guide's four real `<a href>`
links: `github.com/joshcomley/wixy` (the P.2 fork step), 404ing because the repo was
still private. `track-j.html` step 1 (already shipped) already has Josh publish the
engine before Purdi ever starts, and spec 02 §3 permits the flip once the M2 audit PR
merges — which it already had. Before touching visibility, re-ran the secrets scan
spec 02 §2.1 requires rather than trusting `decisions/00054`'s scan (run at 123 commits,
before M3-M7 added real credential-handling code): `gitleaks git` over full history at
164 commits, clean; `gitleaks dir` over the working tree (covering this session's own
uncommitted chapters), clean; manual grep for real emails/API-key/SSH-key/PAT shapes in
the new guide content, clean. Operator confirmed via AskUserQuestion to flip visibility
now rather than add a linkcheck exception or hold the PR — the automation `gh` PAT
turned out to lack the `Administration:write` scope the flip needs (deliberately, same
least-privilege pattern this guide teaches throughout), so the actual click is the
operator's, not this session's.

## What to watch for

- If `joshcomley/wixy`'s visibility hasn't actually been flipped by the time this PR's
  CI runs, `guide-linkcheck` will legitimately fail on this one link again — that's the
  check doing its job, not a flake; re-run it once the flip lands, don't retry blindly.
- The `ca-state-backup` repo-creation step now lives in P.6, not P.2 — if a future edit
  moves repo-creation steps around, keep it ahead of the point `setup.sh` first asks for
  that URL (its 3rd question).
- Chapter 7's Access-app domain addition and chapter 8's DNS-note-then-replace step are
  both easy to silently drop in a future edit since neither has independent test
  coverage (the guide's own test suite proves every chapter *renders*, not that its
  prose is procedurally correct) — this entry is the record of *why* each exists.
