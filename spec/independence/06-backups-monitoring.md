# 06 — Backups & monitoring (hers, automatic)

## 1. What needs backing up (and what doesn't)

Git already IS the backup for: site content/templates/theme (site repo), media +
consent records (media repo), engine code (fork). The residual state on the droplet:
`live.json`, `publishes.jsonl`, git tags (already pushed), the draft overlay, chat
transcripts, staged media, and `.env` (the one thing that must NOT go to a repo).

## 2. Nightly state mirror

`backup` container (03 §2): nightly, bundles `/data` minus builds/ and .env into a
dated tarball, commits it to `<org>/ca-state-backup` (private; keep last 30 nightly +
12 monthly, pruned by the job), via its own deploy key. Also verifies (not just
copies): after push, downloads the blob back and checksums. Restore path documented in
the guide's appendix ("give this page to any developer"): fresh droplet + setup.sh +
untar into the volume = full state. `.env` recovery = her password manager (03 §4).
Until cutover, an equivalent scheduled job on the hub mirrors the fleet Storage the
same way — so her backup custody starts BEFORE her hosting does.

## 3. Monitoring that reaches HER

- **UptimeRobot free** (guide signup, her account): HTTPS check on the public site +
  keyword check on `/api/version`, alert to her email. External to everything.
- **In-admin health**: Settings → System card — last backup age (red > 48 h), disk
  usage, last publish, engine version (04 §2). The admin shell shows a banner when the
  backup is stale — self-diagnosing before anyone has to be asked.
- Publish failures already surface in the publish drawer; additionally email her
  (SMTP env optional — if unset, banner only; the guide offers a free Brevo/SMTP2GO
  signup as an optional step, not a dependency).
