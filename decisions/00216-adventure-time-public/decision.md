# 00216 - Adventure Time on an open URL (workspace 00065)

**Symptom / need.** The operator wants the Adventure Time globe game published on an open URL with no login
("a public URL ... you can still have the banking facility, but it's only going to be in your browser cache, and
you should be able to copy a short URL for any of the destinations that you land on"). The game so far is a
two-player game inside the PIN-locked Server chat (Inv 40, Inv 56): every round is chat content, erased with its
message. Spec: `spec/adventure-public/README.md`; code reality: `docs/ai/adventure-public.md`; invariant: Inv 61.

**Decided.**

1. **Same process, host-gated** (not a new service). The public game needs exactly what this process already owns -
   the bank, the cmd researcher, the picture finder - and `ca.cinnamons.uk` already tunnels to it. A host gate
   (`adventure_public/gate.py`) is the outermost ASGI middleware; a request for the public host goes to a SEPARATE
   public application and to nothing else, so the admin, `/api/admin/*`, `/internal/*`, the site and every socket
   are structurally unreachable from it (not merely "denied by a path check"). Any other host never sees the public
   routes. Off unless `WIXY_ADVENTURE_PUBLIC_HOST` is set; the standalone edition (no cmd) refuses a value.
2. **One shared pack cache keyed by destination.** The cost of the public game is research (a cmd run, Sonnet,
   minutes of web search). Keyed by destination, the most it can ever cost is one run per bank destination (1,412)
   plus bounded retries (10 min doubling, 3 per 24 h), on top of a global 30 starts/hour and 6/client/hour. The
   second visitor to a place gets the pack instantly and a short link means the same pack for everyone.
3. **Commons-only pictures** (`WebPictureFinder(allow_site_images=False)`). The private game may show a venue's own
   page image to two friends; publishing it to the world is a licensing problem. Only freely-licensed Wikimedia
   Commons files, each with credit and licence, are published; no venue page is fetched. The private game's finder
   is unchanged (the flag defaults to `True`).
4. **Browser-only bank.** No accounts, no server-side banking: the visitor's banked trips, "never again" list and
   settings are `localStorage`; the server keeps nothing per visitor (only in-memory rate-limit counters).
5. **A database of its own** (`adventure-public/public.db`, never `server.db`), with its own runner (own
   `CapacityLimiter(1)` so the public game can never starve the private one's two slots), its own cmd caller
   (`wixy-adventure-public-pack`), its own working folder and its own picture files. Public data never touching
   `server.db` is what keeps Inv 40/46/56's erasure promises intact.

**Details worth knowing.**
- Short code = first 6 chars of the base32 (`abcdefghijkmnpqrstuvwxyz23456789`) of `sha256(destination_id)`;
  a collision would lengthen both to 8. The shipped bank has none (test-pinned); four literal codes are pinned
  because codes live in people's bookmarks.
- cmd being unreachable is not counted as a try (a cmd outage must not lock a destination out for a day); a hunt
  that finds no pictures is final (`images = failed`), as in the private game.
- The client IP for rate limiting is `CF-Connecting-IP` when valid, else the peer; an IPv6 client counts as its
  /64; counters are in memory only and bounded.
- With no researcher (fleet on a non-cmd backend) a pack reads `failed` "Holiday packs aren't available right
  now" with `canRetry: false` - four states only (`none|pending|ready|failed`), no `unavailable`.

**Why not.** A separate deployment (a second process to run, a second tunnel app, a second copy of the bank and
the cmd client) for no isolation the host gate does not already give structurally; per-visitor server-side packs
(unbounded research cost, and a private-data surface); site-image pictures (licensing).

**Watch.**
- The host gate is the security boundary: any new middleware must be registered BEFORE it, never after; any new
  public route goes into `routes_adventure_public.py` (never the main app); the gate's tests are exhaustive on
  purpose - extend them, never relax them.
- If a venue-image source or any non-Wikimedia fetch ever reaches the public finder, Inv 61 is broken.
- The cache is permanent: a bad pack stays bad until its row is deleted (`runbook.md`); a picture hunt that failed
  on a transient Commons outage is not retried automatically.
- No Cloudflare Access app protects the host - on purpose. Nothing private may ever be routed through the public
  application.
