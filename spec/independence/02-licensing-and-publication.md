# 02 — MIT relicense + pre-publication audit (SECURITY-GATED milestone)

Operator confirmed MIT, 2026-07-19. Making `joshcomley/wixy` public is irreversible in
practice (clones/caches) — so the audit precedes the visibility flip, and this milestone
waits for **Fable PR review** (09 §3).

## 1. License

- `LICENSE` — MIT, `Copyright (c) 2026 Josh Comley`.
- README gains: what Wixy is, the Cottage Aesthetics story (one paragraph), quickstart
  pointer to `deploy/standalone/`, license badge. No contribution solicitation needed.

## 2. Pre-publication audit (scripted + eyeballed, evidence in the PR)

1. **Secrets scan**: `gitleaks`-style scan over FULL history (not just HEAD). Any hit →
   assess: real secret in history = STOP, consult Fable (history rewrite vs fresh-root
   publication is an architectural call, not the implementer's). Expected state: clean —
   the repo was built secretless by design (all secrets in Storage/.env), but verify,
   don't assume.
2. **Internal-infrastructure exposure review**: the repo deliberately documents fleet
   internals (specs cite hub paths, ports, cinnamons.uk hostnames, cmd APIs). Policy:
   ACCEPTED for publication — none of it is a credential, the services are
   loopback/Access-gated, and scrubbing would lobotomize the docs. Two exceptions to
   scrub: any Access AUD values and this-session/peer IDs in specs (replace with
   `<redacted>`); the `todos/` + `handover/` + `decisions/` trees stay (engineering
   history is part of the product's value).
3. **Media check**: confirm no client photos/consented imagery anywhere in the engine
   repo (they live in site/media repos; `photos/` here are the OWNER'S brief images —
   they were provided for the build; move `photos/` + `brief.md` + client-specific
   `docs/` into the PRIVATE site repo before publication — the brief is her business
   material, not engine code).
4. **Dependency license check**: all Python/npm deps MIT/BSD/Apache-compatible (they
   are — verify and list in the PR).

## 3. Visibility flip (guide step — Josh does it, one click, after the audit PR merges)

Settings → Danger zone → make public. The guide places this AFTER her fork exists?
No — forking requires public (private forks need paid org seats): order is
audit → public → she forks (07 sequences it). Post-flip: enable Dependabot alerts.
