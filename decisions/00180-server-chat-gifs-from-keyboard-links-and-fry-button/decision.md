# Symptom
Operator (workspace #42): choosing a GIF from the phone keyboard's GIF picker in the Server chat only
put a link (`https://static.klipy.com/.../2KTnFTI6.gif`) into the message. He wants it attached as a
proper animated GIF, plus a More-menu button that attaches the Futurama Fry squint GIF.

# Root cause
Android keyboards insert a GIF into a plain web text box as a URL (text), not as image content. Separately,
even an uploaded animated GIF showed only its first frame in the bubble: the bubble always used the
still `thumb` rendition.

# Decision
1. **Detect GIF links in the composer and fetch them in the browser**, not on the server. Only https `.gif`
   links on `klipy.com`, `tenor.com`, `giphy.com` (and subdomains) are taken - the providers keyboards use.
   All three serve media with `Access-Control-Allow-Origin: *` (measured 2026-10-13), so the bytes come
   down client-side and go through the normal chunked photo upload. Rejected: a server-side "attach from
   URL" route - it would add an SSRF surface (the server fetching attacker-chosen URLs) for no gain, and
   would make the server, not the phone that already talked to the GIF host, contact a third party.
   Rejected: converting any `.gif` URL on any host - arbitrary hosts usually lack CORS, and silently
   fetching every pasted link is a privacy leak.
2. The bytes must start `GIF87a`/`GIF89a` and fit the 30 MiB photo cap; otherwise the link is put back in
   the text with a reason and never retried for that draft.
3. **Wire flag `animated`** on `<Attachment>`: ready + mime `image/gif` + `full` in renditions. Processing
   already stores only animated GIFs as GIF (still GIFs become PNG), so mime is a reliable signal. The
   bubble shows `full` for these. View-once rows have no renditions, so the flag is false there (Inv 52).
4. **Fry**: the exact GIF the operator picked from KLIPY (640x468, 45 frames, 650 KB) is bundled at
   `wixy_server/static/server-chat/fry-squint.gif` and staged (not auto-sent) via the same path.

# Watch for
- A keyboard switching to a new GIF host: add its domain to `GIF_LINK_HOSTS` (and confirm it sends CORS).
- A host serving `.gif` URLs as WebP/MP4 bytes: those are refused (signature check); processing would
  turn animated WebP into a still PNG anyway.
- The Fry GIF is third-party (Futurama) artwork bundled for a private chat feature.
