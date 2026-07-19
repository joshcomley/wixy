# `deploy/standalone/` — the portable Docker deployment target

Everything needed to run Wixy anywhere Docker runs, tuned for a small DigitalOcean
droplet. This is the independence-phase standalone edition's home; the fleet's
existing blue/green Slots deploy (`install.py`, `launcher.py`, `deploy.py` at the repo
root) is untouched and lives entirely outside this directory.

Full specification: `spec/independence/03-standalone-deploy.md`. Contents land in
milestone 3 of the independence work plan (`spec/independence/09-work-plan.md`):

- `Dockerfile` — the single image both editions run (`WIXY_EDITION=fleet|standalone`).
- `docker-compose.yml` — `wixy` + `cloudflared` + `watchtower` + `backup` (+ `worker`
  from milestone 6).
- `setup.sh` / `verify.sh` / `update.sh` / `logs.sh` — the only commands the HTML guide
  (`guide/`, milestone 8) ever shows a human.

Nothing here is wired up yet — this file exists so the directory has a place in the
repo ahead of milestone 3's real content (spec/independence/09-work-plan.md, row 1).
