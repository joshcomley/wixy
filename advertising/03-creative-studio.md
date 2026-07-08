# 03 — Creative Studio (her words, her photos, generated posts & reels)

> Owner-driven design from Purdi's own brief (via the operator, 2026-07-08): other
> clinics' posts are "all AI" — AI wording, AI everything — and it shows. **Her wording
> is the driving force behind the mood and feel of every post and must come first.**
> AI is welcome for layouts, arrangement and production — never for her words.
> Platforms that matter right now: **Facebook and Instagram only.** She is overwhelmed;
> the bar is "type what I want to say, tap a couple of times, get a beautiful post."

## 0. Doctrine (binding, product-wide)

1. **Verbatim voice**: her text is published exactly as she wrote it. No rewriting, no
   "improving", no tone adjustment — ever. An optional "fix typos" pass exists but is
   OFF by default and shows a before/after diff she must approve word-by-word.
2. **AI reads, never writes**: models may *read* her words to pick fitting layouts,
   imagery, music mood and to *suggest* hashtags (from a saved, editable hashtag set +
   suggestions she taps to accept) — but generated prose never enters the post body.
   All inference runs through cmd-spawned chats (fleet rule: never the Anthropic API).
3. **Compliance still applies to organic**: ASA treats a clinic's promotional Instagram
   post as advertising — the [02-regulatory-guardrails.md](02-regulatory-guardrails.md)
   linter runs on HER words too. It NEVER rewrites; it flags ("this word can't legally
   appear in a promotional post — tap for why") and she rephrases. POM terms, 18+
   context, before/after rules, incentive rules all enforced pre-publish.
4. **Consent is data**: every before/after pair carries a consent record; nothing
   without consent is even offerable to a post.

## 1. The photo library

**Storage decision**: a dedicated **private GitHub repo** (`cottage-aesthetics-media`),
plain git — NOT Git LFS (unnecessary: uploads are recompressed server-side to ≤2000px
JPEG q85 ≈ 300–600 KB each, so even ~2,000 photos ≈ under 1 GB) and NOT the public site
repo (client photos must never sit in a public repo; the site repo keeps only the
already-published site imagery). Wixy's Storage holds the working checkout
(`Storage/projects/ca/media-library/`); the admin uploads through the same Pillow
pipeline as the CMS (auto-orient, **EXIF strip**, resize, re-encode), and Wixy commits +
pushes in batches — versioned, durable, restorable, consistent with git-is-the-database.

**Data model** (`library/index.json` + files under `library/<category>/`):

```json
{
  "assets": [
    {"id": "a7f3", "file": "clinic/room-2026-05.jpg", "category": "clinic",
     "caption": "treatment room", "added": "2026-07-08", "tags": ["interior"]},
    {"id": "b912", "file": "clinician/purdi-3.jpg", "category": "clinician"},
    {"id": "c440", "file": "work/lips-closeup-1.jpg", "category": "work"}
  ],
  "pairs": [
    {"id": "p22", "before": "ba/lips-04-before.jpg", "after": "ba/lips-04-after.jpg",
     "treatment": "Lip enhancement", "date": "2026-06",
     "consent": {"recorded": true, "scope": ["social"], "note": "signed 2026-06-14"}}
  ]
}
```

**Categories** (v1, extensible by adding a name — no schema change): `before-after`
(paired), `clinic` (The Cottage interiors/exterior), `clinician` (photos of Purdi),
`work` (close-ups of her treating clients). More categories = she types a new label.

**Upload UX** (built for overwhelm): drag/drop or phone-tap many photos at once → each
thumbnail gets four big category buttons → for before/afters: tap two photos → "Pair" →
tap which is the *before* → pick treatment label + confirm consent is on file. Bulk-safe,
no forms beyond that. Editing/re-categorising later is one tap. The library view filters
by category, shows consent badges on pairs, and flags anything unpaired/unconsented.

## 2. The post composer (the core flow — three steps, no more)

1. **Her words** — one big text box ("What do you want to say?"). Paste or type, rough
   is fine. Below it: the linter's live traffic light + the optional hashtag row
   (saved set + tappable suggestions). Her text is the post caption, verbatim.
2. **Her pictures** — either she picks from the library (filter chips: Before & After ·
   Clinic · Me · Work), or she types/taps what she wants ("a picture of me and a
   before/after") and the studio auto-selects (recently-unused first — a per-asset
   `lastUsed` stamp keeps posts fresh; shuffle button to re-roll).
3. **Looks** — the studio renders **4 layout options** as finished previews (square
   1080×1080 and portrait 1080×1350 as appropriate). She taps one and lands in the
   **hands-on layout editor** (§2b): drag, swap and resize by finger, or ask the AI box
   for changes — then **Approve**.

Then: publish now / schedule (per-platform toggle: FB, IG, both). Done state shows the
real post links.

**How layouts work** (why they'll look good AND on-brand): layouts are **HTML/CSS
templates rendered headlessly to pixels via Playwright** — typography and colour come
straight from the site's `theme.json` brand tokens (Cormorant Garamond / Jost / Pinyon
Script, the cream/olive/clay palette), so every post is automatically on-brand with the
website. The template family is a growing library (committed like code): quote-card,
photo-with-band, collage-2/3, B/A treatments (§3), seasonal variants. "AI does the
layouts" = (a) per-post, a cmd-spawned model reads her words for mood and picks/parameterises
templates (it writes CSS/config, not copy); (b) over time, new templates are authored via
the AI lane and reviewed like any code. Variation per post comes from template choice,
crop focus, accent colour, and type scale — deterministic to render, infinite-feeling in
practice.

**Output shapes**: single image post · carousel (up to 10 frames — each frame a rendered
template) · reel (§4). Captions: her words + hashtag block. First frame always carries
enough standalone meaning (feed preview).

## 2b. The layout editor — WXL markup + direct manipulation

**WXL ("Wixy Layout") is the studio's own markup**: a small JSON layout tree that every
template, every generated option, and every finished post IS. One document format means
her finger, the AI, and the renderer all speak the same language — a drag is a markup
mutation, an AI request is a markup mutation, and there is nothing else to keep in sync.
(JSON rather than an invented text syntax: it matches the JSON-everything architecture,
validates with a JSON Schema like all our content, diffs cleanly in git, and models edit
it reliably.)

```json
{
  "canvas": {"ratio": "4:5", "background": {"token": "cream"}},
  "slots": [
    {"id": "img1", "kind": "image", "asset": "a7f3",
     "frame": {"x": 0, "y": 0, "w": 1.0, "h": 0.62},
     "fit": "cover", "focus": {"x": 0.5, "y": 0.4}},
    {"id": "quote", "kind": "text", "source": {"from": "words", "lines": "auto"},
     "frame": {"x": 0.08, "y": 0.66, "w": 0.84, "h": 0.26},
     "type": {"font": "serif", "scale": 1.2, "align": "center", "color": "mocha"}},
    {"id": "ba1", "kind": "pair", "pair": "p22", "style": "diagonal-split",
     "frame": {"x": 0, "y": 0, "w": 1.0, "h": 0.62}},
    {"id": "badge", "kind": "badge", "preset": "consent-label", "locked": true}
  ]
}
```

- **Templates are WXL documents** with slot placeholders + constraints; a generated
  "look" is the template instantiated with her assets/words; her edited post is a fork
  of that document; **"Save as my template"** promotes any arrangement she likes back
  into her personal template family (which grows to fit her taste over time).
- **One compiler, one truth**: a single TypeScript WXL→HTML/CSS compiler renders (a) the
  live, editable canvas in the browser and (b) the final export — Playwright screenshots
  the same render route with editing chrome off. No drift between what she tweaked and
  what publishes (the same preview/publish-parity principle as the CMS).
- **Gesture vocabulary (mobile-first — thumb-sized, no precision needed):**
  drag a slot to move (snap grid + alignment guides) · corner handles to resize ·
  **drag one photo onto another to SWAP them** (the gesture she'll use most) · tap a
  photo → swap from library / drag its focus point · tap text → size stepper, alignment,
  palette-token colour, and which of her lines appear on-image (the rest stay in the
  caption) · long-press → duplicate/delete · "+" → add a slot (photo/text/badge) ·
  full undo/redo (WXL ops are reversible) · "reset to generated".
- **Brand-safe by construction**: colours and fonts are theme tokens only (no free hex,
  no font menus), minimum legible type sizes, safe-area margins, and the consent badge
  on before/after posts is `locked` (the linter refuses a B/A render without it). She
  cannot drag her way off-brand or out of compliance — the constraints are in the
  schema, not in her memory.
- **The AI box edits the same document**: "make the photo bigger and put my words at the
  bottom" → a cmd-spawned agent (headless chat-spawn; the WXL travels in the message,
  structured output back — per fleet doctrine for embedded inference) returns a mutated
  WXL doc → instant re-render. She never HAS to ask the AI to move something — her
  finger does it — but she can, and both paths leave the same kind of edit history.

## 3. Before/after treatments (static)

Consent-gated pairs only. Named looks, all templated:

- **Side-by-side split** (labels set in brand type, thin brass divider)
- **Top/bottom split** (portrait-friendly)
- **Diagonal split** (more editorial)
- **Carousel reveal** — frame 1 = before (full), frame 2 = after (full), frame 3 =
  side-by-side (the platform-native "swipe to reveal" pattern)
- **Detail zoom** — tight crop pair for lips/skin texture

Alignment tooling: the composer offers auto-crop to match the two photos' framing
(face-landmark-free v1: manual nudge handles + a grid overlay; keep it simple).
Every B/A render carries the small consent-safe label set ("Real client, shared with
consent" — wording from the guardrails doc).

## 4. Reels / video generation

**Pipeline**: **ffmpeg** on the hub composits stills → 1080×1920 MP4 (H.264, ~15–30 s):
Ken Burns pans/zooms over her photos, cross-fades, wipe-reveals for before/afters, her
words as timed text overlays (brand type), brand outro card (logo + "Nurse-led aesthetics
· Hartlebury"). Named styles v1: **Soft fade** (calm, slow pans), **Reveal** (B/A wipe),
**Cottage tour** (clinic shots sequence), **Quote** (words-led, photos behind).
Deterministic, fast, no generative video needed — her real photos ARE the content
(and generative footage would collide with the whole "not AI" positioning).

**Music** (the honest answer): platform music catalogs (the trending-audio pickers in
Instagram/Facebook) are **licensed for in-app use only — no API can attach them** to an
externally-published video [VERIFY at build time, expected to hold]. The plan:

- **Primary**: curate a small on-brand set (calm acoustic/spa) from **Meta Sound
  Collection** (facebook.com/sounds/collection) — Meta's own royalty-free library,
  free to use in content posted to Facebook/Instagram; tracks are downloadable and get
  baked into our MP4s. Stored in the media repo (`library/audio/`) with source noted
  per track. [VERIFY the licence text at build time — this is the load-bearing bit.]
- **Optional upgrade** (proposal card, real money): an Artlist/Epidemic-style
  subscription for a broader licensed catalogue.
- **Trending-audio path** (manual, still supported): publish the reel silent (or
  music-free voice/ambient) via API as a draft-style flow, and she adds in-app trending
  audio when reach-chasing matters — the studio's "send to my phone" handoff (§5) makes
  this a 30-second job.

## 5. Publishing (Facebook + Instagram)

**Target**: direct API publish. **Instagram Graph API content publishing** (feed images,
carousels, and Reels) + **Facebook Pages API** (page posts, scheduled posts).
Prerequisites (one-time, operator-assisted, documented as a setup checklist in the module
spec): Instagram account → professional/Business, linked to the Facebook Page; Meta app
with `instagram_content_publish` + `pages_manage_posts` through app review; media
ingestion happens by public URL — renders are served from our own domain (the CMS already
serves; renders get unguessable paths + expiry). Platform rate/volume limits and the
exact review scopes get verified when the module spec is written [VERIFY at build time].

**Fallback that ships day one** (so the studio never blocks on Meta app review): **Send
to my phone** — every approved render/reel gets a QR + short link; on her phone it opens
straight into the native share sheet → post to IG/FB manually (and add trending audio if
she likes). The generation is the hard part she's overwhelmed by; posting is two taps
either way. Scheduling: server-side scheduler drives API publishes; for the manual path
it sends her a nudge (email) at the scheduled time with the link.

Not in v1: Stories automation, TikTok, cross-posting elsewhere. The design leaves room
(render sizes + publisher interface are per-platform plugins) without building it.

## 6. Where it lives

The **Adverts → Studio** section of the Wixy admin (same shell, same CF Access, same
instant-render rules): `Library` (upload/categorise/pairs/consent) · `New post` (the
3-step composer + the §2b editor) · `Queue` (scheduled + published, with per-post
platform links) · `Templates` (the layout family: her saved templates first-class;
new designed families arrive via the AI lane). Template design is grounded in an audit
of her EXISTING Facebook/Instagram posts (`advertising/research/existing-posts/` —
screenshots + verbatim caption samples) so the system amplifies her current look rather
than replacing it.
The paid-ads surfaces from [00-master-plan.md](00-master-plan.md) §6 sit alongside but
ship AFTER the studio (roadmap reordered — see 00 §8): content is her actual pain today,
and organic posts are also the raw material the paid engine later boosts.

## 7. Build shape (for the eventual module spec — same rigour as spec/)

Python/FastAPI extension of `wixy_server` + TS admin panels (all existing conventions);
renderer = Playwright screenshots of templated HTML (already a project dependency);
video = ffmpeg (add to slot provisioning); media repo manager mirrors the site-repo
checkout machinery; publisher = Meta Graph client with token store in Wixy Storage
`.env` (never in git); linter shared with the paid-ads engine. Everything spend-adjacent
(the music subscription proposal, any boost button) keeps the human-gate doctrine.
The module spec gets written and adversarially reviewed like the CMS spec once the CMS
build lands — with every Meta API claim verified against current docs at that point,
not from memory.
