The public site deploys to GitHub Pages from a server-owned `wixy-live` mirror ref — never
from the site repo's `main` HEAD — so the owner's Publish/Restore gate still decides what the
public sees; a `WIXY_PUBLIC_DOMAIN` repo variable gates the deploy on/off per fork.
