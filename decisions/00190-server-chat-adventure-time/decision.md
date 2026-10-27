# Ask (operator, workspace 00056)
A second game in the chat's ⋯ menu, "Adventure Time": spin a globe sideways then up/down (the
other person sees the finger as a fading pen-like trail), land, go to the nearest land if it is
sea, move 30 % inland and light up nearby countries at random (~4 a second) until someone presses
Stop, then the same with the country's top five holiday destinations, then an AI-researched
"holiday pack" (food, places to stay, culture, sights, things to do) that can be banked or rejected
for ever. Each destination has the would-you-rather game's mini chat, and the code must be shared
so improving the per-item mini chat improves every game. Brief: `spec/server-chat/08-adventure-time.md`.

# Decided
- **Client computes a move, the server stores it once, every screen replays it.** The spinner's
  client turns the flick into `{from, delta, durationMs}` and, on the second spin, the landing,
  nearest land, inland centre and candidate countries (d3-geo over the Natural Earth map); the
  server validates bounds/shape and stores it; the other screen animates the stored values against
  server time. One geometry implementation (TypeScript), no hand-synced Python port (Inv 20's
  drift risk avoided). The server's job here is consistency (one outcome, stored once), not
  anti-cheating — the two players are the chat's trusted pair (Inv 40).
- **Roulettes are shared, deterministic and "what you see is what you get".** The server stores a
  seed and a start time; both screens compute the same lit item every 250 ms from server time
  (`serverNow` in every view, smallest-round-trip clock offset). Stop posts the id the presser saw
  lit; the server checks it is a candidate and that the roulette had started.
- **Coastal bias fix is the operator's own**: sea → nearest eligible land → 30 % of the way to that
  landmass part's pole of inaccessibility (precomputed per polygon part) → every eligible unit
  within 500 km (at least 4, at most 10) lights up. Inland neighbours get the same odds as the
  coast that the sea funnelled the landing onto.
- **Map units, not only sovereign countries.** Natural Earth 50m countries, with France, Portugal,
  Norway, the Netherlands, Tanzania and the UK replaced by their map units (overseas departments,
  Madeira, Azores, Svalbard, Zanzibar, England/Scotland/Wales/Northern Ireland), so a landing in
  Martinique picks Martinique, not Paris, and Scotland is a holiday country of its own. 256 units,
  ids permanent. A unit with no destinations in the bank (uninhabited, or — by default — under a
  whole-country "advise against all travel") is treated as sea.
- **Destination bank is static repo content** (like the WYR question bank): ranked per unit,
  AI-written by region, then machine-validated against the same map (every point inside its unit or
  within 25 km of it) by a pytest, so the bank can never drift from the map. Ids
  `<unit>.<slug>`, append-only.
- **Two-level map.** One TopoJSON with a `coarse` object (spinning globe, fast) and a `detail`
  object (zoom + every geometry decision), shared ids, served as a hashed admin static file and
  loaded lazily. `d3-geo` and `topojson-client` are bundled (libraries, not a framework; no CDN).
- **Schema v20** `adv_rounds` (anchor-keyed, `ON DELETE CASCADE`, explicit wipe — the Inv 54
  pattern) + `adv_rejected(destination_id)`: the never-again list holds destination ids only, no
  dates, no FK, so it survives deleting the trip's message ("never appears again") and is cleared
  by a wipe (a wipe forgets everything about the pair). Banked trips are derived from
  `adv_rounds.state = 'banked'` — no second table; deleting the message removes it from the bank.
  Banked destinations also stop coming up in later draws.
- **Game chat reuses `wyr_chat`** (already a generic message → anchor-message table) and the wire
  keeps `wyrSeq`/`wyrRef`, now meaning "the game-chat anchor of any game": renaming them would
  break cached clients across a blue/green swap for no capability.
- **Shared game frame.** `gameTabs.ts` (Chat + one tab per open game) and `itemChat.ts` (the mini
  chat strip + the one pop-up chat with the one re-parented composer) are extracted from the WYR
  tab; both games embed a strip and share the pop-up (decisions/00184's rules carried over intact).
- **Holiday pack through cmd only** (Inv 13): a hidden, unparented `chat-spawn` run on Sonnet 5.5
  with web search/fetch allowed and every file/shell/agent tool denied, in an empty non-git folder;
  the prompt names only the bank destination; the final message must be one JSON object, parsed
  defensively and stored on the round row. Single-file spawns (≤ 2 in flight, ≥ 5 s apart: cmd's
  parallel-spawn gotcha), polled, resumed after a restart from the stored run id, compare-and-set
  so a blue/green overlap stores once. Standalone edition: no researcher → `unavailable`; the game
  still works.
- **Live swipe trail** reuses the live-drawing relay (generalised to carry an SSE event name):
  `POST /adventure/live` → `adventure_live`, lossy, ≤ 20 frames/s, never stored or logged.

# Why not
- A server-side geometry port: a second implementation of nearest-coast/inland/candidate rules
  that must agree to the metre with the client — all risk, no capability.
- Pre-generating holiday packs: the operator explicitly wants a live lookup ("we won't index all
  of this ahead of time").
- Images in the pack: third-party image loads from a private chat leak the viewer's address to
  those sites; links (opened on purpose) are fine.
- Strict turn-taking: it would make the game unplayable alone; the UI shows whose turn it is
  instead (operator decision #2113 confirmed: either person may do any step).

# Operator decision #2113 (2026-10-28)
Second spin up/down; either person does any step; cmd's retained research copy is fine; places
under a whole-country "advise against all travel" are left out BY DEFAULT and the pair can switch
them back in (`adv_settings.include_advised`, a shared preference like `wyr_topics`: it names no
place or person, so a wipe leaves it alone). The bank records the advice per unit with the date it
was checked; the switch only decides eligibility.

# Honest limits
- cmd keeps its own copy of each research run (prompt = the destination; answer = the pack) in its
  hidden chat-spawn ledger and transcript; chat delete/wipe cannot reach it. It names no one and
  says nothing the bank does not, but its timestamp records that a pack was researched then
  (operator decision #2113 Q3).
- Latitude from the up/down spin is uniform in angle, so polar landings are over-represented
  against area; they route to the nearest eligible land (often Greenland, Svalbard, Patagonia).
- Live frames reach only screens on the same blue/green process (like live drawing).

# Watch for
- A new send path must still spread `gameTabs.chatTarget()` (`wyrSendFields()`), or game chat
  goes to the main chat only (decisions/00184).
- Never renumber unit ids or destination ids: rejected lists and banked rounds reference them.
- The bank's `advice` flags age: re-run the FCDO check when refreshing the bank.
