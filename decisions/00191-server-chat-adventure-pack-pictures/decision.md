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
  do (at most 20 attempts); at most 16 pictures per pack; credits from the file's `extmetadata`
  (Artist HTML stripped, `User:` prefix dropped, + licence) or the site's `og:site_name`.
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
- **The resolver, the address policy, the allowed ports and the TLS context are CONSTRUCTOR
  arguments** of `SafeFetcher` (tests point it at a local fake web server through them). There is no
  environment variable, setting or module switch that relaxes any of it, and the production finder
  is built only on the path that builds the cmd researcher (fleet edition, cmd AI backend) with
  `SafeFetcher()` defaults; an injected researcher never reaches the internet unless the test also
  injects a finder.
- **Image check** (`prepare_picture`, in a thread, two at a time): content type `image/*` checked
  before the body is read, the bytes sniffed as JPEG/PNG/WebP, Pillow opens it as THAT format, <= 36
  MP declared (checked before decoding; tighter than the chat's 80 MP photo cap, because the decode
  and clean-up make several RGB copies), a single frame, short side >= 480 px, aspect <= 3:1; then it
  is rebuilt (`processing.reencode_still_as_jpeg`: upright, sRGB, flattened, no metadata) as a JPEG
  of <= 1600 px.
- **Storage = the would-you-rather pattern.** The pictures are ORDINARY private photo attachments on
  the round's ANCHOR message, staged at `uploads/<id>/assembled` and attached with the slot map in
  ONE transaction (`create_adventure_picture_attachments`, a compare-and-set on the round still
  being `chosen`/`banked`, its pack `ready` and `images = 'pending'`), so renditions, signed URLs,
  quota and delete/wipe erasure (Inv 46) are the attachment machinery's. Excluded from the Gallery
  like the would-you-rather pictures. Schema: `adv_rounds.images` (`none|pending|done|failed`) and
  `adv_rounds.pictures` (JSON slot map: `{v, slots:[{slot, ordinal, credit, page, caption}]}`) were
  added to the v20 DDL IN PLACE (v20 was never deployed); `_ensure_adventure_picture_columns` adds
  them to a database that ran the earlier text, so there is no version bump.
- **Flow.** `finish_adventure_pack(ready, pictures_pending=True)` sets `images = pending` in the same
  write; `AdventurePackRunner.run_job` then runs `AdventurePictureJob.run` OUTSIDE the research slot
  (still a contained task, Inv 47). Rejecting ends the wait (`images = failed`); the job re-checks the
  round before the hunt, between phases and at the attach. Startup redoes the hunt for every round
  still `pending` (the attach is all-or-nothing, so nothing is half-stored). A shutdown mid-hunt
  leaves the round `pending` for that. Every other exit ends the wait.
- **Wire.** `pack.images` is `"pending"` while the hunt runs or a stored picture is still
  processing, else `"done"` (also for "no pictures are coming"); `pack.pictures = {hero: [Picture],
  items: {"<section>:<index>": Picture}}`, `Picture = {thumbUrl, fullUrl, credit, page, caption|null}`
  built from the anchor message's signed media URLs, ready attachments only. The round's `rev` moves
  as each picture becomes ready (`finish_attachment`), so a client that re-fetches on a `rev` change
  sees them; the view reads the round and its attachments in ONE transaction.

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
