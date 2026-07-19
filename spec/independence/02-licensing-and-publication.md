# 02 — MIT relicense + pre-publication audit (SECURITY-GATED milestone)

Operator confirmed MIT, 2026-07-19. Going public is practically irreversible — the
audit precedes the flip, and this milestone waits for **Fable PR review** (09 §3).

## 1. License

`LICENSE` — MIT, `Copyright (c) 2026 Josh Comley`. README: what Wixy is, the Cottage
Aesthetics story (one paragraph), quickstart pointer to `deploy/standalone/`, badge.

## 2. Pre-publication audit (scripted + eyeballed, evidence in the PR)

1. **Secrets scan** over FULL history (gitleaks-style). Real secret in history → STOP,
   consult Fable (history rewrite vs fresh-root is architectural). Expected clean —
   verify, don't assume. (Known non-secrets: Wix element ids in `tooling/set_hours.py`;
   the truncated AUD in decisions/.)
2. **Internal-infrastructure exposure**: fleet hostnames/ports/paths in docs are
   ACCEPTED (no credentials; services loopback/Access-gated; scrubbing would lobotomize
   the docs). Scrub only: full Access AUD values anywhere un-truncated.
   **Exemption**: the author-session id in `spec/independence/README.md` +
   `KICKOFF-PROMPT.md` STAYS until milestone 10 — milestones 3/4/6/7's peer-review
   gating needs it (it is a loopback-only cmd session id, worthless off-box); milestone
   10 scrubs it as its final docs sweep.
3. **Owner-material move — destination is the NEW PRIVATE repo `<org>/ca-business`**
   (the site repo is PUBLIC — it must not receive private business material). Exact
   move list (git history of these stays in the engine repo's past — acceptable, they
   were never secret, but going-forward they live privately): `photos/`, `brief.md`,
   `docs/DESIGN-AND-CONTENT.md`, `docs/google-reviews.json` (real reviewer names),
   `docs/booking-platform-comparison.md`, `reviews-demo.html`, and **`advertising/`**
   (her marketing strategy + the audit of her real posts). If any of these in HISTORY
   is judged sensitive enough to warrant it, that's the same Fable consult as §2.1.
   `spec/` + `todos/` + `decisions/` + `handover/` stay (engineering history).
4. **Dependency license check**: all deps MIT/BSD/Apache-compatible; list in the PR.

## 3. Visibility flip (guide Track J, one click, after this PR merges)

Order: audit → public → she forks (a fork of a public repo needs no org payment and is
itself public — 01 §1). Post-flip: enable Dependabot alerts.
