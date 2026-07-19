# 06 — Backups & monitoring (hers, automatic; key-scope Fable-checked with M4/M7 gate)

## 1. What needs backing up

Git already holds: site content/templates/theme (site repo, incl. `images/`), engine
(fork), owner docs (`ca-business`). Residual droplet state: `live.json`,
`publishes.jsonl`, draft overlay, chat transcripts, staged media. NOT backed up to any
repo: `.env`/keys (password manager is their recovery path) and `builds/`
(reproducible).

## 2. Nightly state snapshot (bounded by design — no history growth)

`backup` container: nightly, copies `/data` (minus `builds/`, minus secrets) as a
PLAIN FILE TREE into a checkout of `<org>/ca-state-backup` and **force-pushes a
single-commit `snapshot` branch** (history never accumulates); the 1st of each month
it also pushes a `monthly/YYYY-MM` tag (12 kept, oldest tag deleted). Text state
diffs well; media stages are small. After push it re-clones shallowly and checksums —
a backup that isn't verified isn't a backup. Deploy key: write-scoped to
`ca-state-backup` ONLY (gate checklist item). Restore path (guide Appendix A): fresh
droplet + `setup.sh` + copy the snapshot tree into the volume. Until cutover, an
equivalent scheduled hub job mirrors fleet Storage the same way — her backup custody
starts BEFORE her hosting does.

## 3. Monitoring that reaches HER

- **UptimeRobot free** (her account, guide step): HTTPS check on the site + keyword
  check on `/api/version` (works in-image via the baked SHA — 03 §1), alerts to her
  email.
- **In-admin System card**: last backup age (banner when > 48 h), disk usage, last
  publish, engine version/edition.
- Publish failures: drawer (exists) + optional email if SMTP env set (guide offers a
  free SMTP signup as optional, never a dependency).
