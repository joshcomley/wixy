# 08 — The independence drill + acceptance criteria

## 1. The drill

Performed by the implementer **following the HTML guide verbatim** on the **drill kit**
(Track J provisions it — 07/09: a drill GitHub org with the bot invited, a DO droplet
on a fleet-held account/API token, one cheap test domain in a drill Cloudflare account,
a $5-capped Anthropic key; ~£10–15 total, spend-gated). Then REPEATED for real by
Purdi+Josh with her real accounts (the implementer's run de-bugs the guide first).

1. Org + repos in place: site repo (transferred/copied for drill), `ca-business`,
   engine fork (Actions + schedule enabled per 04 §1), `ca-state-backup`.
2. Droplet provisioned via the `curl | bash` one-liner → `verify.sh` all green.
3. Test hostname serves through her tunnel; `/admin` behind her Access.
4. Edit → publish → live on her hostname; restore → previous version live.
5. **Engine update**: upstream ships a trivial change during the drill → "Get engine
   updates" → deployed within minutes (image rebuilt via the PAT-pushed sync — the
   full C3-fixed path). Then **"Undo last update"** → previous engine serves (04 §3).
6. AI conversation on the drill key ships a real content PR → merged (fork/site CI
   green, tokenless builder checkout per 01 §3) → visible in draft → published.
7. **Engine feature-lane proof**: one small engine change requested through the AI
   lane → PR into the fork → CI → merged → deployed (04 §4).
8. Backup ran; restore-from-snapshot exercised onto a second scratch droplet
   (Appendix A path) — same content serves.
9. **No-fleet-dependency proof (pre-cutover-safe — the fleet wixy IS production until
   cutover, so no long fleet outage here)**: inspect zero egress from her containers
   to any fleet host (conntrack/netstat sweep + config grep — there should be no such
   endpoint anywhere), plus a SHORT (~5 min, operator-agreed window) fleet-wixy stop
   during which her stack is fully exercised. The ONE-HOUR kill test moves to the real
   run's post-cutover phase, when the fleet genuinely is just staging.

## 2. Reversibility proof (real run only)

After DNS flips to her stack: flip BACK once (planned), then forward again — both
directions observed before calling cutover done.

## 3. Acceptance criteria (binding)

1. Drill §1.1–1.9 pass; evidence (URLs, SHAs, screenshots, ledger entries, the
   rollback proof) in the final PR.
2. The guide worked as written — every deviation fed back before sign-off; linkcheck
   green.
3. Security gates (02, 03, 04, 06/07-key-scope, 05) each carry Fable approval on the
   PR (09 §3).
4. Fleet deployment green throughout; existing suites (pytest/vitest/parity) pass;
   spec/08 §5 criteria unregressed.
5. **Upstream CI boots the published image** with `WIXY_EDITION=fleet` (fake cmd) and
   `standalone` on every main merge (03 §5) — the same-image-both-editions proof.
6. Engine public + MIT; fork sync green; `/api/version` shows edition + baked SHA +
   sync base on both sides (no git shell in-image).
7. Quality bars per the CMS spec (typed, tested incl. backend-contract suite,
   mypy/tsc strict, capped pytest).
8. Docs: public engine README; decisions/ per 01 §5; todos; the "operator decisions
   for the real run" list (DNS timing, real account emails, real-run one-hour kill
   test scheduling) recorded.
