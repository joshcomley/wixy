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

## Addendum - review rulings (workspace 00065, after the independent review)

An independent review found the issues below; the rulings are decided and implemented
(`wixy_server/tests/test_adventure_public_review.py`, `_codes.py`, `_limits.py`, `admin-ui/tests/...`). They amend
the original decision where they differ (the lengthen-both code rule, the IPv6 /64 client key).

1. **A pack stuck `pending` heals itself.** `PublicPackRunner` gains a supervised sweep
   (`adventure-public-research-watch`, Inv 47, beside `adventure-public-pictures-watch`) that re-claims `pending`
   rows untouched for `give_up_s + stale_margin_s` by compare-and-set (`store.claim_pending`) and reuses `run_job`
   (poll the known run, else start one). Interval and margin are `PackTiming.stale_sweep_interval_s` /
   `stale_margin_s` (the existing timing seam). `POST` handles `runner.start()` returning False: the row is settled
   as a transient failure (retryable in a minute) and the start given back, never left `pending` for nobody.
2. **The public side has its own thread budget** (`PublicThreads`, `CapacityLimiter(6)`) on every blocking call in
   the public routes; `/assets` and `/media` are read through it (`PooledFileResponse`, same headers and ranges);
   settled pack views are cached in memory per destination (bounded by the bank, dropped by any write in this
   process, a failed pack expires at `next_try_at`, nothing unsettled is ever cached - so blue/green cannot serve a
   stale state). *Scope note:* the runner's and picture job's store calls stay on the default pool (they are
   bounded by the research budget, not by visitors).
3. **The start budget pays for real runs only.** `ResearchUnavailableError` (cmd unreachable) gives the slot back
   (client and global); the client key is an IPv4 /24 / IPv6 /48; `StartLimiter.release` takes the `StartTicket`
   from `acquire` and removes the caller's own timestamp, not the newest (nit 8).
4. **Unprepared store = 503.** `service.status.ready` is set only by a successful `prepare()`; until then every
   public page and API route answers `503` plain text and creates nothing (assets/robots/manifest still serve).
5. **Independent loops.** In `app.py` the startup resume, the research sweep and the picture sweep each start in
   their own guarded, logged block.
6. **No public source map.** The public esbuild entries emit none, the committed `.map` files are gone, and
   `AssetTable.resolve` refuses any `.map` name.
7. Pack links carry `rel="noopener noreferrer nofollow"` (spec 2.6; the private game's tests asserted `noopener` /
   `noreferrer` with `toContain`, so none needed changing - a `nofollow` test was added).
9. **Codes are pinned.** `adventure_public/codes_pinned.json` holds today's code of every shipped destination;
   `build_public_bank` uses it, and only a newcomer is lengthened (8, 10, 12) when it clashes with a pinned code or
   another newcomer. `python -m wixy_server.adventure_public.pin_codes` (`--check`) appends missing ids; a test fails
   until every shipped destination is pinned to its current code.
10. **The client route mirrors `is_code` exactly** (`route.ts`): any `/d/...` that is not exactly a code is the same
    "not on the map" page the server renders, never a fresh game at that address.
11. **Re-banking keeps the existing entry** (its date and its place) in `memory.ts`.


## Addendum: the intermittent hang on CI's Linux runner (workspace 65, delivery PR #447)

**Symptom.** The delivery PR's `pytest` step ran 45+ minutes and never finished (the job has no
timeout); the same suite passed on Windows. On Linux (WSL, the CI image's Python 3.14), 1 run in 6
of the public-game tests hung in `TestOwnThreadBudget::test_a_saturated_public_budget_does_not_block_a_private_thread_call`,
at the TestClient's shutdown: its event loop stayed alive for one request still parked on the
public thread budget.

**Root cause.** `PublicThreads` made its `CapacityLimiter` lazily, on first read. The test read it
from its own thread while a startup job read it on the app's thread; both saw "not made yet" and
each made one. The test filled one limiter, the request parked on it, and the tokens were given
back to the other, so the parked request was never woken and shutdown waited for it forever.
`test_two_threads_reading_the_budget_at_once_see_one_limiter` forces that interleaving (red before
the fix). In production every read is on the one event loop, so it could not interleave there, but
the lazy creation was a hazard with no benefit.

**Decided.** The limiter is made once, in `PublicThreads.__init__` (anyio returns an adapter outside
an event loop that binds on first use). The saturation test now holds its parked request as a
`BackgroundCall` and, after giving the budget back, waits for it to be answered (200), so no test
leaves a request running into the client's shutdown.
