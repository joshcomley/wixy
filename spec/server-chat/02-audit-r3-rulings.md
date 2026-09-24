# Server chat — Architect rulings on audit round 3 (F2 photos, F11 delete/wipe timeouts)

Architect, 2026-09-24. Binding for the audit-fix builders; folded into the brief (§7 and §17.4)
at the next reconciliation. Every other round-3 finding is unambiguous against the brief as
written and needs no ruling — F1 in particular is a missed requirement (§8 + §11
`server-push.spec.ts`), not a design question.

## F2 — photo pipeline: normalise the pixel mode first, choose the format by transparency

**What is wrong today** (`processing.process_photo`, read at `origin/cmd/workspace-00029`):
- The metadata strip rebuilds the image with `Image.frombytes(image.mode, image.size,
  image.tobytes())`. For palette modes (`P`, `PA` — every static GIF and every PNG-8) that
  keeps the palette *indices* but drops the palette, so the colours come out wrong, typically
  black.
- The same path also mishandles transparency:
  - a non-PNG source with alpha (a transparent WebP, for example) goes to JPEG via
    `.convert("RGB")`, which turns transparent pixels black;
  - every thumbnail is `.convert("RGB")` → JPEG, so transparent PNG and GIF thumbnails get
    black backgrounds;
  - the animated-GIF thumbnail has the same problem.
- The embedded colour profile (ICC) is dropped **without converting the pixels**. iPhone
  photos are Display P3, so stripping the profile alone makes them look washed out. This is
  the same "wrong colours" defect class as F2, and it is fixed in the same pass.

**Ruling — the order inside `process_photo` for a still image:**
1. `ImageOps.exif_transpose` (as now).
2. **Colour-manage to sRGB.** If `info["icc_profile"]` is present, convert with
   `PIL.ImageCms.profileToProfile(img, <embedded>, sRGB, renderingIntent=perceptual,
   outputMode=...)`. If the conversion raises, log a WARNING and continue with the pixels
   as-is — never fail the upload for this.
3. **Normalise the mode to exactly `RGB` or `RGBA`**:
   - `has_alpha` = mode ∈ {`RGBA`, `LA`, `PA`}, *or* `"transparency" in img.info` (a
     palette or grey image with a tRNS/GIF transparent index);
   - 16-bit greyscale (`I;16*`, `I`) is first scaled to 8-bit (`L`);
   - CMYK and every other mode go through Pillow's own `convert()`, which applies the
     palette/transparency correctly;
   - result: `img = img.convert("RGBA" if has_alpha else "RGB")`.
4. **Only now strip metadata** by rebuilding from the normalised pixels. `frombytes` is
   lossless for RGB/RGBA. The ICC profile is not re-attached: the pixels are already sRGB,
   which is what a browser assumes for untagged images.
5. **Choose the output format by transparency, not by source format:**

   | Source | `full` | `thumb` |
   |---|---|---|
   | has alpha (any format) | `full.png` | `thumb.png` |
   | opaque PNG, opaque **static** GIF | `full.png` (lossless; screenshots and graphics suffer under JPEG) | `thumb.jpg` |
   | every other opaque source (JPEG, HEIC, WebP) | `full.jpg` q88 | `thumb.jpg` |
   | animated GIF | original bytes as `full.gif` (unchanged rule) | first frame through steps 2–5 |

6. `routes_livechat_media._RENDITION_FILENAMES["thumb"]` becomes `("thumb.png",
   "thumb.jpg")`. The resolver already serves whichever exists, and `.png` is already in
   `_MEDIA_TYPE_BY_SUFFIX`.

**Tests (red first).** Build each fixture with Pillow in the test and compare pixels at
known coordinates against Pillow's own `convert()` of the source (and against `ImageCms`
for the P3 case):
- PNG-8 opaque;
- PNG-8 with tRNS;
- static GIF with a transparent index;
- `LA` PNG;
- RGBA WebP;
- 16-bit greyscale PNG;
- CMYK JPEG;
- a Display-P3-tagged JPEG, whose colours match `ImageCms`'s sRGB conversion within ±2 per
  channel.

For every fixture also assert:
- alpha is preserved exactly where the source had it;
- the output has no EXIF, no ICC profile, and no text chunks;
- the file name follows the table above;
- the uploaded original is still deleted only after the renditions verify.

## F11 — delete/wipe client timeouts: the stream is the source of truth

**What is wrong today:** `api/messages.ts` `deleteMessage`/`wipeChat` go through the default
fetch policy (10 s). The server's own bound is 10 s from the commit, *plus* the
`scrub_guard` wait and network time. So a slow but successful delete can be aborted by the
client, which then treats it as a failure and restores the bubble: a message that no longer
exists reappears. Raising the timeout alone is not enough, because any network drop after the
request was sent has the same effect.

**Ruling:**
- **One timeout for both:** `deleteMessage` and `wipeChat` use a dedicated policy with a
  **30 s** timeout and no automatic transport retry inside `fetchWithRetry`. The retry rules
  below are explicit.
- **Delete (idempotent on the server — §17.3):**
  - **204/202** → done. The bubble stays removed; 202 needs no extra UI, as now.
  - A **definite HTTP failure before the commit** (4xx other than 401, or 5xx) → restore
    the bubble with the plain error line. A 5xx can only happen *before* the commit, since
    post-commit errors return 202 (containment ruling C2).
  - **401** → lock (R6).
  - **Timeout or network error** (unknown outcome) → retry the same DELETE up to 3 times
    (1 s, 2 s, 4 s). If all fail, restore the bubble with "Couldn't confirm the delete — try
    again".
  - If the delete *did* commit, the stream's `message_deleted` event removes the bubble
    anyway. Truth always arrives over the stream.
- **Wipe (NOT idempotent — a repeat would delete anything sent since; R14a note):**
  - **Never auto-retry.**
  - **204/202** → as now.
  - **Definite pre-commit failure** → restore the pre-wipe thread from memory (keep a
    snapshot until the response) with "Couldn't delete everything — try again".
  - **Timeout or network error** → show "Couldn't confirm — checking…". Then refetch
    history (`GET /messages`):
    - no messages, or only messages newer than the wipe request → treat as done, and start
      the `/usage` erasure poll;
    - older messages still present → the wipe did not commit, so restore and show the retry
      message.
  - A `wiped` event from the stream settles it either way.
- **Tests:**
  - vitest with a fake fetch/clock:
    - a delete timing out then succeeding on retry → bubble never restored;
    - a delete timing out 3 times → restored with the copy above;
    - a later `message_deleted` event → removed;
    - a wipe timeout where the history refetch is empty → done;
    - a wipe timeout where it still holds older messages → restored;
    - a wipe is never re-POSTed.
  - e2e: a delete whose response is delayed 12 s (add a response-delay hook to `e2e/fixture_server.py` if none exists) still ends
    removed on both clients.
