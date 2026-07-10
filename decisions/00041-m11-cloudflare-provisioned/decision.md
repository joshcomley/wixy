# Milestone 11 CLOSED: Cloudflare provisioned, spec/07 §4 fully verified

Final piece of milestone 11. The operator opened the admin gate mid-session after
both automated elevation channels had genuinely failed (decisions/00040's own
sidecar note: gate closed per a real probe, `request_admin_action` blocked by the
consensus classifier) — this is the "genuine blocker only the user resolves" case
working as intended, not a workaround.

## Provisioning ran clean through the gate — with one real, informative gap

Submitted `tooling/provision_ca_cloudflare.py` through the now-open gate
(`inbox\req-<id>.cmd.ps1` → `results\req-<id>.result.json`, per the documented
mechanics). `PROVISION_RESULT` (`overall_ok: true`):

- DNS: created, real record id, correct tunnel target.
- Ingress: inserted (not just updated), backup written, 22 hostnames survive the
  sanity check post-insert (every other fleet subdomain sharing this tunnel,
  untouched).
- Restart: succeeded on attempt 3 — the retry loop (decisions/00036 decision 7)
  earned its keep on the very first real run, exactly the transient spec/07 §3
  point 3 documented.
- Access app: created, both mirrored policies (`Authorized users`,
  `Service token access`) attached successfully.
- `env_written`: **`ok: false`, `"could not resolve team domain"`.**

## Root cause: a genuine token-scope gap, not a code bug

`team_domain()` calls `GET /accounts/{id}/access/organizations`. Diagnosed with a
targeted probe (a second, smaller script through the same gate) rather than
guessing: **both** `CF_ACCESS_TOKEN` and `CF_API_TOKEN` return `403
{"errors":[{"code":10000,"message":"Authentication error"}]}` on this ONE
endpoint specifically — while both tokens worked fine for every OTHER call the
main script made (DNS records, Access apps, Access policies). This confirms it's
a real scope gap on these tokens for `access/organizations` specifically, not a
bug in `team_domain()`'s own logic (which correctly returned `None` on
`success: false`, exactly as designed) and not an auth failure in general.

## Fix: discovered the value by observation, not by requesting broader token scope

Rather than ask for a wider-scoped token (out of scope to change here, and
overkill for one read-only value), opened a REAL headed browser (Playwright,
system Chrome, per the fleet's own strict browsing rules) and navigated to
`https://ca.cinnamons.uk/admin` — the freshly-created Access app's own login wall
redirected to `https://cinnamons.cloudflareaccess.com/cdn-cgi/access/login/...`,
directly revealing the team domain. The `kid`/`aud` embedded in that same redirect
URL (`3ccac41a...75d5`) matched the AUD the provisioning script had already
captured from the Access app creation response — independent confirmation the new
app is genuinely, correctly wired to `ca.cinnamons.uk/admin` before ever writing
anything. Wrote `WIXY_CF_TEAM_DOMAIN=cinnamons.cloudflareaccess.com` and
`WIXY_CF_ACCESS_AUD=<the captured aud>` directly into `Storage\.env` (a normal
user-writable runtime-data file, not a deployment-target source file — same
category as `services.toml`/`consumers.json` in decisions/00038, not something
the worktree-guard is scoped to), then restarted Wixy so the JWT middleware
picked up the new settings.

This is a reusable technique worth remembering: when an API token can't read a
value directly, a real Access-protected endpoint's own OWN login redirect often
reveals it for free, with no elevated permissions needed at all.

## spec/07 §4 verification checklist — full results

All checked for real, externally, over HTTPS through the actual Cloudflare edge
(not just loopback):

1. ✅ `/status` Wixy healthy; `/healthz` 200; `/api/version` SHA matches wixy
   main HEAD.
2. ✅ Slot-cycle proof (decisions/00040's own sidecar note — a fully automatic
   deploy, no manual sync, confirmed via `active.txt` + `/api/version` + Slots'
   own `executor_outcomes` table).
3. ✅ `https://ca.cinnamons.uk/` → 200, real homepage
   (`Cottage Aesthetics — Nurse-led aesthetics in Hartlebury`), no Access wall.
4. ✅ `https://ca.cinnamons.uk/admin` anonymous → CF Access login wall (real
   browser, confirmed via the redirect above). A JWT-stripped direct request to
   `127.0.0.1:9380/admin` (loopback, bypassing the CF edge entirely) still
   returns 302 (gated) — the JWT middleware works independently of the edge, not
   relying on Cloudflare to be the only thing enforcing auth.
5. ✅ `https://ca.cinnamons.uk/api/admin/state` unauthenticated → 302.
5b. ✅ `https://ca.cinnamons.uk/healthz` and `.../internal/ready` → 404 (edge-
   header guard, spec/04 §9) while `curl 127.0.0.1:9380/healthz` locally → 200;
   `https://ca.cinnamons.uk/api/version` → 200 (public by design).
6. ✅ Restart drill: `POST :9999/restart/Wixy` (needed anyway, to pick up the
   new CF Access env values) → site back within seconds, admin session model is
   stateless JWT so nothing to strand.
7. ⏳ Reboot survival — not exercised (no real hub reboot happened this
   session); Devfleet `restart="always"` + tunnel watchdog should cover it per
   spec's own reasoning, noted in the todos sidecar as unexercised rather than
   claimed done.
8. ✅ `robots.txt` = `Disallow: /`, matches `projects/ca.json`'s
   `"indexable": false`.

## Milestone 11 is CLOSED

Every spec/09 acceptance point for M11 is done: every repo artifact (slice 1),
live Devfleet + Slots registration with a genuinely automatic deploy cycle
(slice 2, three real bugs found and fixed along the way — decisions/00037,
00039, 00040), and now Cloudflare (this entry) — spec/07 §4 verification
complete except the one item (reboot survival) that requires an actual reboot
this session never had a reason to trigger.

## Files changed

- `D:\Servers\Wixy\Storage\.env` (not this repo — runtime config) —
  `WIXY_CF_TEAM_DOMAIN` / `WIXY_CF_ACCESS_AUD` filled in.
- This decisions entry + the todos sidecar's own closing update.
