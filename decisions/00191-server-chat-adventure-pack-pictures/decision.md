# Ask (operator, workspace 00056, 2026-10-28)
"Make the holiday pack include pictures." Spec: `spec/server-chat/08-adventure-time.md` §4.3a.

# Symptom that shaped the design
Measured on real Kotor runs: asked to find pictures itself, the research AI supplied only 9 picture
URLs for 24 items AND dropped almost every item link; its URLs were Wikimedia originals up to
5,750 px / 4.9 MB and 8 of 9 plain fetches got `429`; the same files through the Commons API's
thumbnails all loaded. Fetching each item's linked page for `og:image` worked for only 6 of 19
(travel/booking sites answer 403/429 to automated fetches; article images are generic banners).

# Decided
- **The AI names things; the server finds the pictures.** The prompt asks for NO image links. Each
  item keeps `url` (the venue's OWN official site where it has one) and gains an optional
  `wikipedia` (an English Wikipedia article title: places, sights, museums, festivals, famous
  dishes); the pack gains `wikipedia` for the destination. `clean_wikipedia_title` reduces an
  `en.wikipedia.org/wiki/...` link to its title and refuses other URLs and non-article namespaces.
- **Fetched by this server, never the browser** (a viewer's device must not contact a third-party
  host from a private chat). ONE chokepoint, `livechat/safe_fetch.py`, for every picture and page.
- **Sources per slot, in order** (`livechat/adventure_pictures.py`): the Wikipedia REST summary's
  lead image taken as its Commons file (the name parsed from the thumb URL's path AFTER the two hash
  directories, never the last segment) and fetched as the Commons API's 1600 px THUMBNAIL; the
  venue page's `og:image` / `twitter:image` (HTML <= 1 MB; 403/429 skipped quietly); for the hero
  and the sights only, a Commons file-namespace search (`filemime:image/jpeg`, short side >= 900,
  no map/flag/logo titles, landscape first). The hero is the destination article's lead image plus
  search photos up to 5 (cap 6); items are served round-robin across sights, food, stay, culture,
  do (at most 20 attempts), after the local dishes (below); at most 22 pictures per pack (hero 6 +
  dishes 6 + other items 10); credits from the file's `extmetadata` (Artist HTML stripped, `User:`
  prefix dropped, + licence) or the site's `og:site_name`.
- **Never an original.** The REST summary's `originalimage` is only mined for the file NAME. If the
  Commons API's `thumburl` for a file smaller than the thumbnail step is the original (Wikimedia
  serves such a file as itself), the API is asked again for the next standard step down; a file with
  no step below it is skipped. Measured: the `thumburl` is on `thumb.wikimedia.org` (not
  `upload.wikimedia.org`) with a `?utm_...` query, and a 1600 px request is snapped UP to the
  1920 px standard step; the finder downsizes to 1600 itself.
- **SSRF rules** (the full list is in Inv 56): `http(s)` and ports 80/443 only; the URL is parsed
  once and the request is built from the parsed parts; IP-literal hosts in any spelling refused; the
  host is resolved ONCE inside the network backend's `connect_tcp`, EVERY address must be a public
  address (deny by default: IPv6 only inside `2000::/3`, which refuses mapped / compatible / NAT64 /
  6to4 / Teredo outright), and the socket is dialled to the vetted address literal, so there is no
  second lookup (DNS rebinding) while TLS verifies the certificate against, and sends the SNI of,
  the HOSTNAME; redirects by hand, re-vetted, <= 3, never https -> http; 15 s from the request's
  start, 8 MB image / 1 MB HTML / 2 MB JSON streamed under a hard cap; `Accept-Encoding: identity`
  and any other `Content-Encoding` refused; no cookies, auth, proxies or connection reuse. It drives
  `httpcore` directly (httpx's transport has no hook between the DNS lookup and the connect and reads
  the environment for proxies). One request at a time per host, <= 4 hosts at once, one honoured
  `Retry-After` (<= 10 s); a host that answers 429/503 three times is left alone for the job.
  Audit round 3 (F2): only `SafeFetchError` ever escapes `get()` — `Retry-After` and
  `Content-Length` need ASCII digits (`"²".isdigit()` is true and `int()` raises), a malformed redirect
  `Location` (`urljoin` raises `ValueError`) or a lone-surrogate URL is a clean failure — and
  `get(refuse_host_suffixes=...)` refuses any hop (the URL or a redirect target) on a named domain
  before connecting.
- **The resolver, the address policy, the allowed ports and the TLS context are CONSTRUCTOR
  arguments** of `SafeFetcher` (tests point it at a local fake web server through them). There is no
  environment variable, setting or module switch that relaxes any of it, and the production finder
  is built only on the path that builds the cmd researcher (fleet edition, cmd AI backend) with
  `SafeFetcher()` defaults; an injected researcher never reaches the internet unless the test also
  injects a finder.
- **Image check** (`prepare_picture`, in a thread, ONE at a time): content type `image/*` checked
  before the body is read, the bytes sniffed as JPEG/PNG/WebP, then the size the FILE'S OWN HEADER
  declares is read from the bytes (PNG IHDR; JPEG: the single start-of-frame, found by walking the
  marker segments, two frames refused; WebP: the VP8X canvas or a bare VP8/VP8L frame header) and
  checked BEFORE `Image.open` — <= 16 MP, short side >= 480 px, aspect <= 3:1 — because for WebP
  `Image.open` itself allocates libwebp canvas buffers from the declared size; Pillow must then agree
  with the header (same format, same size), one frame. It is rebuilt by the LEAN, shrink-first path
  (`processing.reencode_still_as_jpeg`; the chat-upload `process_photo` is untouched): a JPEG is
  decoded at 1/2-1/8 scale (`draft`), everything else is decoded once and resized to <= 1600 px
  straight away, and only then are the orientation, sRGB conversion, alpha flatten and metadata
  rebuild applied, so no step runs on a second or third full-size copy.
- **Measured memory (audit round 3, F1; psutil peak working set / peak commit over the baseline of
  a fresh 61 MB process, Python 3.14, Pillow 12.3, this box).** BEFORE (36 MP cap, full-size
  copies): a 6000x6000 flat RGBA PNG +654 MB working set / +656 MB commit for ONE decode, +1302 / +1310
  for two; JPEG +1296 for two; WebP +1810 for two; and a 140-byte animated WebP declaring a
  16384x16384 canvas committed +2056 MB inside `Image.open` before anything checked it. AFTER (16 MP
  cap, header-first, lean path), the largest accepted input, one decode: RGBA PNG +158 MB, RGB PNG
  +99 MB, JPEG +53 MB, lossy WebP +248 MB, lossless/alpha WebP +282 MB (the worst case: peak working
  set 344 MB, commit 331 MB, in 0.31 s). Two decodes at once measured +311 (RGBA PNG) / +492 MB
  (WebP), so decoding is SERIALISED (`DECODE_PARALLELISM = 1`): the worst case is ~280 MB transient,
  and 6000x6000 PNG/JPEG/WebP and the 16384 canvas are refused with +0 MB. The 22 finished JPEGs a
  pack holds in memory are a few MB; the bound does not grow with the picture count (a test counts
  concurrent decodes across a whole hunt).
- **Storage = the would-you-rather pattern.** The pictures are ORDINARY private photo attachments on
  the round's ANCHOR message, staged at `uploads/<id>/assembled` and attached with the slot map in
  ONE transaction (`create_adventure_picture_attachments`, a compare-and-set on the round still
  being `chosen`/`banked`, its pack `ready` and `images = 'pending'`), so renditions, signed URLs,
  quota and delete/wipe erasure (Inv 46) are the attachment machinery's. Excluded from the Gallery
  like the would-you-rather pictures. Schema: `adv_rounds.images` (`none|pending|done|failed`) and
  `adv_rounds.pictures` (JSON slot map: `{v, slots:[{slot, ordinal, credit, page, caption}]}`) were
  added to the v20 DDL IN PLACE (v20 was never deployed); `_ensure_adventure_picture_columns` adds
  them to a database that ran the earlier text, so there is no version bump.
- **Flow.** `finish_adventure_pack(ready, pictures_pending=True)` sets `images = pending` (and the
  hunt's start time and try count) in the same write; `AdventurePackRunner.run_job` then runs
  `AdventurePictureJob.run` OUTSIDE the research slot (still a contained task, Inv 47). Rejecting
  ends the wait (`images = failed`); the job re-checks the round before the hunt, between phases and
  at the attach. Every other exit ends the wait.
- **A pending wait heals itself (audit round 3, F4).** Startup redo alone left a hole: during a
  blue/green overlap the OLD process can win the pack, set `images = pending` AFTER the new process's
  startup redo, and be stopped mid-hunt — nobody would look again until a restart. Now
  `adv_rounds.images_started_at` / `images_tries` record the current hunt, and a supervised loop
  (`livechat-adventure-pictures-watch`, Inv 47; `AdventurePictureJob.watch_forever`) sweeps every 60 s:
  a round pending longer than `JOB_BUDGET_S + 120 s` (360 s) is re-claimed by a compare-and-set
  (`claim_adventure_pictures`: stamps the start time, counts a try, so two sweepers start one hunt)
  and hunted again; a round already at three tries is ended as `failed` instead. A hunt this process
  is running is never started twice. Startup redo is the same claim, unconditional. This also covers
  `fail_adventure_pictures` itself failing (the round simply stays pending until the next sweep).
  The v20 DDL was amended in place again (still undeployed): `images_started_at REAL`,
  `images_tries INTEGER NOT NULL DEFAULT 0`.
- **Page text is parsed off the loop, with a vetted charset (audit round 3, F3).** `page_meta` cuts
  the BYTES to the first 200 KB before decoding, decodes only with a web encoding (`codecs.lookup`
  name in an allow-list: UTF-8/16/32, ASCII, ISO-8859-N, Windows 125x, KOI8, the common CJK ones;
  anything else — `punycode` (15.6 s for 1 MB, measured), `idna` (raises), `utf-7`, `unicode_escape`,
  an unknown name — is read as UTF-8) and catches `ValueError` as well as `LookupError`. `page_meta`,
  the JSON loads, the Commons credit stripping and the article captions all run via
  `anyio.to_thread.run_sync`; no third-party text is parsed on the event loop. Measured: Python's
  `HTMLParser` over 200 KB of pathological markup takes <= 82 ms, and 4000 characters <= 2 ms.
- **Wikimedia is only asked for thumbnails, even through a venue (audit round 3, F5).** An image tag
  on a venue page that points at a Wikimedia host goes through `commons_file_name` + the API
  thumbnail (credited as the Commons file) or is skipped; the venue image fetch refuses to be
  redirected onto Wikimedia (`refuse_host_suffixes`); a venue `url` that is a wikipedia.org article
  is reduced to its title (source 1) and never fetched as a page.
- **Wire.** `pack.images` is `"pending"` while the hunt runs or a stored picture is still
  processing, else `"done"` (also for "no pictures are coming"); `pack.pictures = {hero: [Picture],
  items: {"<section>:<index>": Picture}}`, `Picture = {thumbUrl, fullUrl, credit, page, caption|null}`
  built from the anchor message's signed media URLs, ready attachments only. The round's `rev` moves
  as each picture becomes ready (`finish_attachment`), so a client that re-fetches on a `rev` change
  sees them; the view reads the round and its attachments in ONE transaction.

# Addendum 2026-10-28: local food to try (spec §4.3b; operator: "food is essential")
- **Schema.** A new FIRST section `dishes` ("Local food to try": 4-6 signature dishes and drinks,
  each `{name, detail, url: null, wikipedia: <the English article title OF THE DISH>}`); `food` is now
  "Where to eat". Keys: `dishes|food|stay|culture|sights|do|practical` (`MAX_SECTIONS` 7); the
  sanitiser puts `dishes` first and drops a dish's link; a pack without `dishes` is still valid.
- **Pictures.** `livechat/adventure_dishes.py` holds the pure rules. A dish's lead image is taken
  ONLY when the summary's `description` or the first sentence of its `extract` mentions food or drink
  (a 121-term whole-word list: the spec's, plus what Commons categories really say); otherwise a
  Commons search for `"<dish>"` then `<dish> <unit name>` (the bracketed gloss dropped) accepts a hit
  ONLY when its TITLE contains a significant token of the dish (accent-folded, >= 4 letters, not a
  colour/method/nationality word) AND its extmetadata `Categories` or `ImageDescription` mention food;
  JPEG, short side >= 480; at most 3 hits downloaded per dish; a dish that lost a photo to a duplicate
  looks again. There is NO "other images of the article" fallback. A dish with no qualifying photo
  stays text-only: a wrong photo is worse than none.
- **Why two checks.** "Buzara" (a shellfish stew) is a genus of MOTHS on English Wikipedia: the
  article's other images and a title-only Commons match both returned moths. The moth's lead image
  fails the summary check ("Genus of moths"); its Commons file is titled `Buzara ...` but
  categorised `Moths of Africa`, so the title check passes and the category check fails.
- **Budget.** Hero <= 6, dishes <= 6, every other item <= 10: at most 22 pictures (was 16), dishes
  keyed `dishes:<i>` in `pack.pictures.items` like any other item. The memory bound above does not
  depend on the total (one decode at a time); the hunt still gives up after 240 s.
- **Measured on the real services, Kotor, 2026-10-28** (production `SafeFetcher`, 12 dishes in two
  packs of six, whole hunt 10-14 s, 42 requests): 9 of 12 got a photo and all 9 were the right
  dish — cevapi, Njeguski prsut (lead image, caption "Dry-cured ham from Montenegro"), black risotto
  (`Risotto al nero di seppia`, search), priganice (`Priganice 02`), kacamak, Vranac wine, rakija,
  burek, pljeskavica; Buzara, riblja corba (fish soup) and rastan stayed text-only (Buzara
  correctly).

# Why not the alternatives
- Letting the AI supply image URLs: measured to cost most item links and to return huge originals
  that are rate-limited (above).
- httpx with a custom transport: no seam between resolution and connect, and `trust_env`;
  `httpcore`'s network backend is exactly that seam and reads no environment.
- Dialling the IP and rewriting the URL host: breaks the certificate / SNI / Host binding; here the
  URL keeps the hostname and only the TCP dial is redirected to the vetted address.
- Progressive attach (a picture at a time): more transactions and a half-filled round after a
  crash; one transaction is the precedent and the hunt is ~15-60 s.

# Watch for
- Any new code that fetches a URL it did not build MUST use `SafeFetcher`; never add a bypass,
  environment switch or looser default (the audit-critical property is that nothing relaxes it).
- Wikimedia's thumbnail policy (standard steps, `Retry-After`) and the REST summary shape are
  external; `test_livechat_adventure_pictures.py` encodes the measured shapes.
- The client must not draw the anchor message's photo attachments as a normal photo strip (they are
  the pack's pictures).
