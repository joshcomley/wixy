# Cottage Aesthetics — tooling

Operational scripts for building/maintaining the Cottage Aesthetics Wix site.
These are **project tooling**, not site code (the live Velo code lives in the
separate `joshcomleywix/cottage-aesthetics` repo, synced to the site).

## Auth
All REST scripts authenticate with a Wix **account API key** for the account
that owns the site, read from the `WIX_API_KEY` environment variable, plus the
`wix-site-id` header. In PowerShell, the machine-scoped var must be pushed into
the child process env first:

```powershell
$env:WIX_API_KEY = [Environment]::GetEnvironmentVariable('WIX_API_KEY','Machine')
python tooling/provision_bookings.py
```

Site ID: `c721738f-2644-49e8-8865-fc10865db30f`
Default staff resource ("Business Owner"): `1c41ada4-0c28-47dc-8d76-bf31e0776abf`

## Scripts
- `provision_bookings.py` — idempotently creates the bookable treatments in Wix
  Bookings (Services v2 API). Safe to re-run; skips existing by name.
- `downscale_photos.py` — downscales `photos/*` to <=1280px JPEGs in
  `photos/ai-downscaled/` (keeps context/light and version-controllable).
