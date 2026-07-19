# 07 — The HTML guide (flagship deliverable)

A self-contained static HTML site — **`guide/` in the ENGINE repo**, served by the
running admin at `/admin/guide/` (Access-gated) AND buildable to a standalone folder
she can keep anywhere (it must outlive every dependency it describes: plain HTML/CSS,
zero JS frameworks, images inlined or local, printable).

## 1. Voice & form (binding)

Written for a smart, busy, non-technical reader. One action per step. Every step:
a number, one sentence of WHAT, a screenshot or exact-text callout of WHERE, a
copy-paste block where any typing is needed (with a copy button), and a "You know it
worked when…" line. No jargon without a one-line gloss. British English, warm, zero
condescension. Time estimates per section. Every credential created gets an immediate
"save this in your password manager as '<exact name>'" step.

## 2. Structure

- **Start here** — what this guide achieves, the map (one diagram), total time
  (~2–3 hours across a week, no step urgent), and the reassurance paragraph (nothing
  breaks the live site until the final section, everything reversible).
- **Track J — Josh does this once** (≈1 h): publish the engine (post-audit click,
  02 §3) · **provision the drill kit** (~£10–15 total, spend-gated with the operator:
  a drill GitHub org with the implementer's bot invited, a DO API token/droplet
  allowance, one cheap test domain added to a drill Cloudflare account, a $5-capped
  Anthropic key) · run the pre-cutover backup job · initiate the site-repo transfer +
  create `ca-business` in her org · lower DNS TTL at the registrar · final DNS flip
  (with her, section 8).
- **Track P — Purdi does this** (each its own chapter, independent sittings):
  1. Password manager setup (if none).
  2. GitHub account + organisation; accept the site-repo transfer + the private
     `ca-business` repo; fork the engine; **enable Actions on the fork + enable the
     scheduled workflow** (forks ship with both off); org settings allow fine-grained
     PATs.
  3. DigitalOcean account + the droplet (exact plan/region screenshots; card step
     flagged with the ~£9.50/mo cost).
  4. Cloudflare account + **Zero Trust onboarding** (team-name choice; possible
     payment-method prompt on the free plan — £0) + add her domain + registrar
     nameserver change ("site keeps working during this" note) + create the tunnel
     (copy the token) + the Access app (her email + Josh's).
  5. Anthropic account + API key + set the monthly budget in HER Anthropic console
     too (belt and braces with 05 §2's app-side cap).
  6. The droplet setup: open the DO web console → paste the ONE-LINE
     `curl -fsSL … setup.sh | bash` (long-script pastes are flaky in that console) →
     answer its prompts from the password manager → paste each printed public key at
     the GitHub URL it names → watch `verify.sh` go green.
  7. **The drill** (08) on the test hostname — the guide IS the drill script.
  8. **Go live** (with Josh on the phone): DNS flip, checks, celebration; the
     "undo = flip it back" box.
- **Appendix A — If Josh disappears tomorrow** (the page she can hand any developer:
  what exists, where, how to restore, how to run — one page).
- **Appendix B — Costs** (~£9.50/mo DO + AI usage (capped, 05 §2) + ~£10/yr domain;
  everything else free — and the Wix subscription cancels at cutover, an offsetting
  saving).
- **Appendix C — Revoking access** (how she removes Josh from org/Access/Anthropic —
  included deliberately: the guide proving she CAN is the point).

## 3. Build & truthfulness discipline

Screenshots captured by the implementer via headed browser during the real
account-creation dry-runs wherever capturable without real personal data; where a step
can't be screenshotted (her card entry), an exact-text callout replaces it. Every
external URL in the guide verified live at build time (a `guide-linkcheck` CI job).
Provider UIs drift — the guide carries a "last verified" date per chapter and the
linkcheck keeps honesty. The drill (08) is executed BY FOLLOWING THE GUIDE — any step
that confused the implementer gets rewritten before acceptance; "the guide worked as
written" is an acceptance criterion, not an aspiration.
