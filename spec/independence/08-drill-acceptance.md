# 08 — The independence drill + acceptance criteria

## 1. The drill (the phase's definition of done)

Performed by the implementer, **following the HTML guide verbatim**, using throwaway
stand-ins for her accounts where real ones don't exist yet (a fresh GitHub org, a
drill droplet, a test Cloudflare zone/hostname, a capped Anthropic key) — then
REPEATED for real by Purdi+Josh following the same guide (that run is the guide's
sections 2–8 happening for real; the implementer's run de-bugs it first).

From nothing but "her" accounts:
1. Org + transferred/forked repos in place (site, media, engine fork, backup).
2. Droplet provisioned via `setup.sh` → `verify.sh` all green.
3. Test hostname serves the site through her tunnel; `/admin` behind her Access.
4. Edit → publish → live change on her hostname; restore → previous version live.
5. "Get engine updates" pulls a real upstream commit (Josh's lane ships a trivial
   change during the drill) → deployed automatically within minutes.
6. AI conversation on her key ships a real content PR → merged → visible in draft →
   published.
7. Backup ran; restore-from-backup exercised onto a second scratch droplet
   (Appendix A path) — same content serves.
8. Kill test: stop the fleet's wixy (staging) entirely for an hour — nothing on her
   side notices.

## 2. Reversibility proof

During the real cutover: after DNS flips to her stack, flip BACK once (planned), then
forward again — both directions observed working before calling it done.

## 3. Acceptance criteria (binding)

1. Drill §1.1–1.8 all pass, evidence (URLs, SHAs, screenshots, ledger entries) in the
   final PR.
2. The guide worked as written — every drill deviation fed back into the guide before
   sign-off (07 §3); guide linkcheck green.
3. Security review gates (02, 03, 05) each carry Fable's review approval on the PR.
4. Fleet deployment still green throughout (ca.cinnamons.uk staging unaffected;
   existing pytest/vitest/parity suites all pass; no regression to spec/08 §5's
   criteria).
5. Same-image-both-editions proven: fleet staging runs the published image at least
   once with `edition: fleet`.
6. Engine public + MIT; fork sync green; `/api/version` shows edition + sync base on
   both sides.
7. All new code meets the CMS spec's quality bars (typed, tested incl. the
   backend-contract suite, mypy/tsc strict, capped pytest).
8. Docs: engine README (public-facing), decisions/ entries per 01 §5, todos updated;
   the residual "operator decisions during real cutover" list (DNS timing, her real
   account emails) recorded for the human run.
