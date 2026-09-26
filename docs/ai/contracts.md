# Contracts

The literal wire shapes wixy programs against: the HTTP route table, response
envelopes, error conventions, the two SSE streams, the browser↔iframe postMessage
protocol, and the named fixtures/entrypoints tests bind to. This documents **code
reality** (read from the actual return statements); [`spec/04-server.md`](../../spec/04-server.md)
§8 is the intent, [`spec/02-content-model.md`](../../spec/02-content-model.md) §8 the
draft/overlay semantics, [`spec/06-ai-chat.md`](../../spec/06-ai-chat.md) the chat contract.

> Anti-drift rule: adding/renaming/removing a route, or changing a response envelope or
> error status, updates **this file** — the canonical route table — in the same PR. CLAUDE.md's
> documentation map links here rather than duplicating the table, so update CLAUDE.md too only
> if the change alters what that map says.

## 1. Surfaces & auth

One FastAPI app (`wixy_server/app.py:create_app`) binds `127.0.0.1` only (uvicorn;
the cloudflared tunnel is the sole ingress). Three surfaces:

| Surface | Prefix | Auth |
|---|---|---|
| Public site | `/`, `/{path}` | none (must load with zero auth) |
| Admin | `/admin*`, `/api/admin/*` | CF Access JWT (`wixy_server/auth.py`) |
| Internal | `/internal/*`, `/healthz`, `/api/version` | none; loopback-only (`/internal*`+`/healthz` 404 if a CF edge header is present) |

**Auth mechanism** (`wixy_server/auth.py`): Cloudflare Access issues the JWT at the edge;
wixy only *verifies* it — no cookies, no login, no token issuance. Header
`CF-Access-Jwt-Assertion` → `verify_access_jwt(token, jwks, audience, team_domain)` →
`jwt.decode(..., algorithms=["RS256"], audience=<WIXY_CF_ACCESS_AUD>, issuer="https://<WIXY_CF_TEAM_DOMAIN>")`
(signature + `aud` + `iss` + expiry). `JwksCache` fetches `https://<team>/cdn-cgi/access/certs`,
TTL 6h. `is_admin_path` gates a path that equals or starts with `/admin/` or `/api/admin/`
(segment-matched — `/admin2` does **not** match). `WIXY_DEV_NO_AUTH=1` bypasses (refuses to
start if set while `WIXY_ENV=prod`). Verified author identity = `request.state.access_email`
(`claims["email"]`, else `claims["sub"]`; `"editor"` under dev bypass).

## 2. Route table

Handler column is `file:func`. "Auth: CF" = gated by the admin middleware. Response is the
**literal** success envelope (from the return statement). Error statuses per §3.

### Internal / version

| Method | Path | Handler | Auth | Response |
|---|---|---|---|---|
| GET | `/internal/ready` | `routes_internal.py:get_ready` | none | `{"ready": true}` — **404 (no body)** if a `Cf-Ray`/`Cf-Connecting-Ip` header is present |
| GET | `/healthz` | `routes_internal.py:get_healthz` | none | `{"ready": true}` (delegates to `get_ready`; same CF-edge 404) |
| POST | `/internal/warmup` | `routes_internal.py:post_warmup` | none | `{"warm": true}`; **503** on `CheckoutError`; 404 CF-edge |
| GET | `/api/version` | `routes_version.py:get_version` | **none (public by design)** | `{"commit": {"sha_full": "<engine HEAD sha>"\|null, "count": <int\|null>}, "slot": <str\|null>, "version": <int\|null>, "edition": "fleet"\|"standalone", "syncBase": <str\|null>}` — `commit.count` (decisions/00109) is the engine's `v N` display number (first-parent count of HEAD; baked `WIXY_ENGINE_VERSION` preferred, git fallback, null on a gitless image); `version` is the SITE's live pointer, unrelated. Adds `X-Robots-Tag: noindex` when the project is non-indexable (Inv 37) |
| GET | `/api/version/notes?since=<sha>` | `routes_version.py:get_version_notes` | **none (public by design)** | `{"notes": [<plain-English line>, …]}` (decisions/00112) — the update popup's "What's new": `Release-note:` trailers from `<since>..HEAD`, deduped, chronological, ≤8; `since` hex-validated (anything else ignored → recent history), unknown `since` → recent history, no trailers/gitless → `["General bug fixes and improvements."]`; never a changelog, never a 500. Adds `X-Robots-Tag: noindex` when the project is non-indexable (Inv 37) |

### Admin API (`/api/admin/*`, all Auth: CF)

| Method | Path | Handler | Request | Response |
|---|---|---|---|---|
| GET | `state` | `routes_admin_api.py:get_state` | — | `{"project":{slug,name,domain}, "pages":[{slug,meta,lastModified,editable,pendingDelete}], "draft":{rev,opCount (SAME formula as publish/preview's — content ops + staged page adds/deletes + staged media replacements/deletions, decisions/00108)}, "live":{version,sha}\|null, "upstream":{aheadOfPublished:[{sha,subject,author,when}],fetchedAt}, "publishJob":{...}\|null, "chats":[<summary>], "adminSections":[<admin section>], "chatAttachmentsSupported":bool}`; 503 |
| GET | `content/{page}` | `get_content` | — | `{"content": <JsonObject>, "bindings": <dict>}`; 503, 404 |
| GET | `theme` | `get_theme` | — | `{"theme": <dict>}`; 503, 404 |
| GET | `global` | `get_global` | — | `{"global": <JsonObject>}` (`content/_global.json`, overlay-merged; an untouched file reads as `{}`, never 404 — decisions/00127) — the Contact main tab (decisions/00129) reads/writes `phone`/`email`/`address`/`mapCoords`/`mapSrc` here; 503 |
| PATCH | `draft` | `patch_draft` | `{"expectedRev":int, "ops":[{file,path,value}\|{file,path,discard:true}]}` | `{"rev": int}`; 503, **409** (RevConflict), **422** (`DraftValidationError` — the batch is structurally invalid against `builder/schemas/*.json`, e.g. a collection item missing a required field; rejected whole, the overlay is left untouched — decisions/00095) |
| DELETE | `draft` | `delete_draft` | — | `{"rev": int}`; 503 |
| POST | `draft/repair` | `post_draft_repair` | `{"expectedRev":int}` | `{"rev":int, "actions":[str], "validate":{"ok":bool,"errors":[<err>]}}`; 503, **409** (publish running, or RevConflict) — decisions/00095/00096, see §8 |
| GET | `media` | `get_media` | — | `{"media":[{name,url,contentSrc,source,sizeBytes,width,height,references:[...], stagedReplace?,stagedDelete?}]}` (a staged replacement's `url` serves the staged bytes from `/admin/draft-media-replace/<name>`); 503 |
| POST | `media` | `upload_media` | `multipart/form-data` field `file` | `{name,url,contentSrc,source:"draft",sizeBytes,width,height,references:[]}`; **422** (MediaUpload) |
| DELETE | `media/{name}` | `delete_media` | — | `{"deleted": true}` (draft upload) OR `{"stagedDelete": true}` (repo image — staged for the next publish); 503, 404, **409** (referenced) |
| PUT | `media/{name}` | `replace_media` | raw image body (≤15MB, PIL-verified, re-encoded per project media config) | `{name,url:"/admin/draft-media-replace/<name>",contentSrc,sizeBytes,width,height,stagedReplace:true}`; 404 (no such image), **422** (MediaUpload) |
| DELETE | `media-replace/{name}` | `unstage_replace_media` | — | `{"deleted": true}`; 404 (nothing staged) |
| DELETE | `media-deletion/{name}` | `unstage_media_deletion_route` | — | `{"deleted": true}`; 404 (nothing staged) |
| POST | `publish` | `start_publish` | `{"message":str, "expectedRev":int}` | `{"version":int, "sha":str}`; **409** (running/RevConflict), **422** (two distinct causes — a blocked draft: `validate_merged_for_publish` fails preflight, same check the review drawer previews, decisions/00095; OR nothing to publish: no staged changes AND no upstream commits pending), **502** (Publish/Checkout/Build) |
| POST | `report` | `post_report` | `{"context":str, "note":str\|null}` | `{"saved":true, "emailed":bool}` — always 200; a report is never "lost" over an SMTP hiccup (decisions/00096), see §8 |
| GET | `publish/stream` | `publish_stream` | — | **SSE**, see §4 |
| GET | `publish/preview` | `get_publish_preview` | — | `{"changes":{<fileKey>:[{key,kind,old,new}]}, "opCount":int (content ops + staged page adds/deletes), "validate":{ok:bool,errors:[<err>]}}`; 503 |
| GET | `publishes?limit=` | `get_publishes` | query `limit?` | `{"publishes":[{...LedgerEntry, "live":bool}]}` newest-first; 503 |
| GET | `publishes/{version}/diff` | `get_publish_version_diff` | — | `{"version":int, "of":int\|null, "changes":{<fileKey>:[{key,kind,old,new}]}}` (publish-preview's `changes` shape; `of` = the previous ledger entry's version, the diff baseline); 503, 404 |
| GET | `pages/{slug}/thumbnail` | `get_page_thumbnail` | — | `image/jpeg` bytes + `Cache-Control: no-cache` (client pins `?v=<draftRev>`); **404** (never captured) |
| PUT | `pages/{slug}/thumbnail` | `put_page_thumbnail` | raw JPEG body (≤2MB, PIL-verified, re-encoded) | `{"ok": true}`; **422** (oversize/unreadable) |
| POST | `restore` | `post_restore` | `{"version":int}` | `{"version":int, "sha":str, "of":int}`; **409** (running), 503, **422** (Restore) |
| POST | `pages/duplicate` | `post_pages_duplicate` | `{"from":str, "slug":str, "navLabel":str, "expectedRev":int}` | `{"rev":int}`; 503, 409, 404, **422** (PageOp) |
| POST | `pages/delete` | `post_pages_delete` | `{"slug":str, "expectedRev":int}` | `{"rev":int}`; 503, 409, 404 |
| POST | `chat/conversations` | `routes_chat.py:create_conversation` | `{"firstMessage":str\|null, "attachmentIds":[str]}` (`attachmentIds` optional, default `[]` — staged beforehand via `POST chat/uploads`; decisions/00110) | `<conversation summary>`; **422** (non-empty `attachmentIds` against a backend with `supports_attachments=False`), **502** (CmdChat) |
| GET | `chat/conversations` | `list_conversations` | — | `{"conversations":[<summary>]}` newest-first |
| POST | `chat/conversations/{id}/messages` | `send_message` | `{"text":str, "idempotencyKey":str, "attachmentIds":[str]}` (`attachmentIds` optional, default `[]`) | `{"accepted":true, "buffered":bool}`; 404, **422** (non-empty `attachmentIds` against a backend with `supports_attachments=False`), 502 |
| POST | `chat/conversations/{id}/attachments` | `upload_attachment` | `multipart/form-data` field `file` (image, ≤5MB) | `{"attachmentId":str, "width":int\|null, "height":int\|null}` (`width`/`height` are cmd's own CONVERTED-image dims, not the original upload's); 404, **422** (backend unsupported, or `AttachmentError` — oversize/wrong-type/unreadable), **502** (`AIBackendError` — cmd upload failed) |
| POST | `chat/uploads` | `upload_attachment_unscoped` | same multipart shape as the scoped route | same response shape — the session-less stage for the "New conversation" compose (no conversation exists yet; cmd treats the session id as an optional janitor hint only). **422** (backend unsupported, or `AttachmentError`), **502** |
| GET | `chat/uploads/{upload_id}/bytes` | `get_upload_bytes` | — | the upload's served (converted) bytes, proxied from cmd's own `GET /api/uploads/{id}/bytes` — what the transcript's thumbnails/lightbox point at (decisions/00110). `Cache-Control: private, max-age=31536000, immutable` (bytes never change after the upload-time conversion); **404** (unknown/expired id, mirroring cmd's own 404/410 via `UploadNotFoundError`), **422** (backend unsupported), **502** |
| POST | `chat/conversations/{id}/rename` | `rename_conversation` | `{"title":str}` | `<conversation summary>`; 404 |
| GET | `chat/conversations/{id}/stream?includeThinking=` | `conversation_stream` | query `includeThinking?` | **SSE**, see §4; 404 |

`<conversation summary>` = `{convId, title, createdAt, status, failureReason, failureMessage,
working}` (`chats.py:conversation_summary`; `status ∈ pending|ready|failed`). `working`
(decisions/00097, 00099, 00100) is a live "is the assistant actively working on this right
now" flag — TTL-cached (~5s, `chat_working.WorkingCache`) from the same cmd `activity ==
"active"` check the open conversation's own stream-driven UI uses (`activity` is cmd's own
enum — `"active"|"idle"|"done"|"unknown"`, a session-store mtime-age threshold computed by
`engine/chats/session_introspect.py:_activity`, never a timestamp wixy parses itself);
always `false` for a `pending`/`failed` conversation
(never polled — only a `ready` one has a live cmd status worth checking). **Freshness differs
by call site**: `GET chat/conversations` actively refreshes stale entries (bounded 2s per
batch, regardless of cmd's own patience); `GET state`'s `chats` field reads the SAME cache
read-only (never triggers a refresh, zero added latency) — see [ai-chat.md](ai-chat.md).

`state.chatAttachmentsSupported` (decisions/00103) mirrors `app.state.ai_backend.
supports_attachments` — a cheap, non-I/O bool read (no live cmd call), gating whether the
chat composer's attach affordance renders at all. `true` for `CmdAIBackend` (the fleet
edition, the only one live at `ca.cinnamons.uk`); `false` for `AnthropicAIBackend`
(standalone/milestone 6, no attachment mechanism of its own yet).

`<admin section>` = `{id, navLabel, title, description, page, collections:[<admin
collection>]}`; `<admin collection>` = `{path, label, itemNoun, schema, alignAspect, tab,
fields:[<admin field>]}` — `alignAspect` is `{w, h} | null` (from the registry's
optional `"alignAspect": "W:H"`); when non-null AND the collection has ≥2 `image`
fields, the section panel offers the before/after aligner on its cards and in its add
flow (decisions/00111); `tab` is `string | null` (decisions/00125) — collections sharing
the same `tab` text render together under a switchable tab strip when a section has more
than one distinct group; `null`, or every collection sharing one group, renders exactly as
before (no tab UI); `<admin field>` = `{key, kind:"image"\|"text"\|"choice"\|"toggle"\|"url",
label, options:[{value,label}], optionsFrom:string\|null, required:bool}` (decisions/00098;
`toggle` added decisions/00117; `url` added decisions/00120 — same plain-input UI as `text`
plus an "Open ↗" link once the value looks like a real URL; `optionsFrom`/`required` added
decisions/00124) — a plain camelCase mirror of
`builder.config.ProjectConfig.admin_sections`
(`routes_admin_api.py:_admin_sections_snapshot`), registry-driven (Inv 1: no site literals
in engine code — `ca.json`'s `adminSections` array declares the actual "Before & After"
section; an empty registry reads as `[]`, never absent). Drives `admin-ui`'s dynamically
rendered nav entries + `sectionPanel.ts`'s management screen for each declared section —
see [editor-and-admin-ui.md](editor-and-admin-ui.md).

For a `choice`-kind field, `optionsFrom` (non-null) names another collection's dotted
path (e.g. `gallery.categories`) whose OWN current items supply the selectable options at
render time (each item's `value`/`label` text fields become one option), taking priority
over the static `options` array when both are present — this is what lets a project make a
choice set itself admin-editable (a category list) instead of a registry literal only a
developer can change (decisions/00124). `required` (default `false`) gates whether the
add-new-item wizard's Save button stays disabled while that field is blank
(`sectionPanelModel.isNewItemComplete`) — see [editor-and-admin-ui.md](editor-and-admin-ui.md).

`state.pages[].editable` = `(source.pages_dir / "<slug>.html").exists()` — a page is editable
iff its template is on disk, so a duplicated-but-unpublished page (staged only in the overlay)
is `editable:false` until publish (decisions/00024 §4 — page duplicate/delete; the pages panel
disables Edit rather than linking to a preview that would 404). The whole `state` read runs under `tree_lock()`
(`_build_state` → `_build_state_locked`) so a snapshot never observes a template
mid-replacement — see [serving-and-overlay.md](serving-and-overlay.md) §Concurrency.

### Engine (`/api/admin/engine/*`, all Auth: CF, **standalone edition only**)

spec/independence/04 §2. `wixy_server/routes_engine.py`. **404s entirely on the fleet
edition** (`settings.edition != "standalone"` or `settings.engine_repo` unset) — these
routes don't exist there, not merely gated. Talks to GitHub via `wixy_server/github.py`'s
`GitHubClient`, one shared `app.state.github_client` instance for the app's whole
lifetime (not constructed per request — decisions/00057).

| Method | Path | Handler | Request | Response |
|---|---|---|---|---|
| GET | `engine/status` | `get_engine_status` | — | `{"engineRepo":str, "currentSha":str\|null, "commitsBehind":int\|null, "changelog":[{sha,subject,author,when}], "checkedAt":float\|null, "stale":bool, "checkError":str\|null, "updateRun":{status,conclusion,htmlUrl,createdAt}\|null}`; **404** (not standalone) |
| POST | `engine/update` | `post_engine_update` | requires `Content-Type: application/json` (no body) | `{"triggered": true}`; 404, **415** (missing/wrong Content-Type — CSRF guard, no other admin mutation takes zero body so this is the one route a forged form POST could otherwise fire), **502** (GitHubApiError) |
| POST | `engine/rollback` | `post_engine_rollback` | requires `Content-Type: application/json` (no body) | `{"triggered": true}`; 404, **415**, **502** (GitHubApiError) |

`commitsBehind`/`changelog` are cached 15 min (`EngineStatusCache`, one process-lifetime
slot) — a stale/unreachable GitHub API falls back to whatever's cached (`checkError` set,
never a 5xx for the whole endpoint: "never blocking state"). `update`/`rollback` both
dispatch `.github/workflows/sync-upstream.yml` (lives in the engine repo, ships to her
fork via a normal sync) with a `mode` input — `sync` merges upstream and, on a clean
merge, re-tags the current GHCR `:latest` as `:rollback` before pushing; `rollback` does
no git/build at all, it just re-points `:latest` back at `:rollback` (a pure registry
retag) so Watchtower's own poll redeploys it. Neither route waits for the workflow to
finish — the Engine admin-ui card polls `status`'s `updateRun` field for progress.

### AI (`/api/admin/ai/*`, all Auth: CF, **anthropic backend only**)

spec/independence/05 §2. `wixy_server/routes_ai.py`. **404s entirely when
`settings.ai_backend != "anthropic"`** (the fleet's `cmd` backend has no
monthly-budget concept at all) — same "this feature doesn't exist here, not a
permission problem" reasoning as the Engine routes above.

| Method | Path | Handler | Request | Response |
|---|---|---|---|---|
| GET | `ai/budget` | `get_ai_budget` | — | `{"monthToDateUsd":float, "monthlyBudgetUsd":float}`; **404** (backend isn't anthropic), **502** (worker unreachable) |

### System (`/api/admin/system/*`, Auth: CF, **both editions**)

spec/independence/06 §3. `wixy_server/routes_system.py`. NOT edition-gated
(unlike Engine/AI above) — a system-health summary is meaningful on the
fleet edition too, which just reports `backup: {stale: true, ...}` always
(no `backup` compose service runs there). One combined fetch for the whole
Settings → System card.

| Method | Path | Handler | Request | Response |
|---|---|---|---|---|
| GET | `system/status` | `get_system_status` | — | `{"backup":{"lastAttemptAt":str\|null,"ok":bool\|null,"verified":bool\|null,"error":str\|null,"stale":bool}, "diskUsage":{"totalBytes":int,"usedBytes":int,"freeBytes":int}, "lastPublish":{"version":int,"when":str}\|null, "engine":{"currentSha":str\|null,"edition":str}}` |

`backup.stale` is `true` whenever no backup has ever run, the last run
failed or wasn't verified, or the last successful run is more than 48h old
(spec's own "banner when > 48 h") — computed server-side so the frontend
never does its own date math. Reads `wixy_server/backup/status.py`'s status
file (written by the separate `backup` compose service, never by this
process) off a fixed, non-configurable container path — see that module and
`routes_system.py`'s own docstrings.

### Server chat (`/api/admin/server/*`, Auth: CF **plus** a second in-app gate)

spec/server-chat/00-brief.md. `wixy_server/routes_livechat.py` +
`wixy_server/routes_livechat_media.py`. The PIN-protected admin live chat (disguised as a
"Server" nav tab) — see [livechat.md](livechat.md) for the full picture. **Every route below
except `POST unlock`, `POST unlock-with-grant` and `GET media/*`** requires the header
`X-Wixy-Server-Token` (a signed, 12h-lived unlock token minted by `POST unlock` — or by
`POST unlock-with-grant` on a device that keeps itself unlocked, livechat.md §16 — held only in the browser's JS
memory — never localStorage/cookies/URLs); a missing/invalid/expired token (including a header
value that is not pure ASCII), or one passed as a query parameter instead of the header, is
**401** `{"error":"locked"}`. `GET media/*` is
signed per-URL instead (`?exp=&sig=`), since `<img>`/`<video>`/`<audio>` tags can't send a
header.

| Method | Path | Handler | Request | Response |
|---|---|---|---|---|
| POST | `server/unlock` | `unlock` | `{"pin":str(4-16 ASCII digits)}` — first a CSRF guard (no token exists yet to gate this route): the request must be `Content-Type: application/json`, must carry `X-Wixy-Server-Unlock: 1`, and a `Sec-Fetch-Site` header that is present must be `same-origin`; each of those three headers must appear exactly once, and a duplicated line is refused rather than decided by whichever value comes first (`unlock_request_refusal` in `livechat/tokens.py`); a refusal happens before the body is read or cmd is contacted, charging nothing; then the route parses the raw JSON body itself — any other body or PIN (invalid/empty/non-UTF-8 JSON, a non-object, a missing or misspelled `pin`, a non-string or nested `pin`, a shorter/longer/non-digit PIN) is answered locally and wixy never calls cmd for it | 200 `{"token":str,"expiresAt":float}`; 415 `{"error":"unsupported_media_type"}` (body not JSON); 403 `{"error":"forbidden"}` (guard header missing, or `Sec-Fetch-Site` not `same-origin`); **422 `{"error":"invalid_pin"}`** (every rejected body/PIN shape above — one redacted body, the submitted value is never echoed or logged); 401 `{"error":"wrong_pin","attemptsLeft":int\|null}`; 429 `{"error":"locked_out","retryAfterS":int}` + `Retry-After` header; 409 `{"error":"pin_changed"}` (cmd's PIN rotated mid-check, nothing spent); 503 `{"error":"not_configured"}` (unknown app key, or no verifier on standalone) / `{"error":"pin_service_unavailable"}` (cmd unreachable/faulted) |
| POST | `server/device-grants` | `create_device_grant` | `{"pin":str(4-16 ASCII digits),"label":str\|null(≤80, control characters dropped, no lone UTF-16 surrogate)}` — the same request guard as `unlock` first (JSON content type, `X-Wixy-Server-Unlock: 1`, `Sec-Fetch-Site` same-origin), then the unlock token, then the label (a bad one — including a lone surrogate, audit F5 — is refused BEFORE cmd is asked), then cmd verifies the PIN exactly as for `unlock` — an attempt is charged — through the same helper, so the mapping cannot drift | **201 `{"grantId":hex32,"secret":b64url(43 chars),"token":str,"expiresAt":float}`** with `Cache-Control: no-store` (the secret is returned here and nowhere else; the server keeps only its SHA-256); the returned `token` is BOUND to `grantId` (§9/audit F4 — the device is going into permanent mode at once, so an unbound token here would reopen the hole a later revoke is supposed to close); 401 `{"error":"locked"}` (no/invalid token — cmd is never asked); the guard's 403/415; 422 `{"error":"invalid_pin"}` (malformed PIN or body) / `{"error":"invalid","detail":…}` (bad label); and every PIN outcome of `unlock` with the SAME status and body (401 `wrong_pin`, 429 `locked_out` + `Retry-After`, 409 `pin_changed`, 503). An identity holds at most five live grants: a sixth revokes the oldest |
| POST | `server/unlock-with-grant` | `unlock_with_grant` | `{"grantId":hex32,"secret":b64url(43 chars)}` — the request guard first; **no token (the device is locked when it asks), no PIN, cmd is never contacted** | 200 `{"token":str,"expiresAt":float}` with `Cache-Control: no-store` — the token is BOUND to `grantId` (§9/audit F4); **401 `{"error":"grant_invalid"}` — one reason-free body for an unknown id, a wrong secret, a revoked grant, one unused for 30 days, another CF identity's grant, or any malformed `grantId`/`secret`**; 429 `{"error":"rate_limited","retryAfterS":int}` + `Retry-After` (10 failures per identity per minute, counted in memory per process; a refused guard or a non-object body is not a failure); 422 `{"error":"invalid","detail":…}` (body is not a JSON object); 403/415 the guard |
| DELETE | `server/device-grants/{grantId}` | `revoke_device_grant` | — (the guard headers, INCLUDING `Content-Type: application/json` even with no body, plus the token) | 204 (idempotent: revoking an already-revoked own grant is 204 again *while its row still exists* — see the known limit below); 404 `{"error":"not_found"}` for an unknown id, a malformed id, and another identity's grant — indistinguishable; 401 locked; 403/415. Revoking the grant a BOUND token is itself bound to ends that session too (§9/audit F4): the server never mints a replacement token here, so the client locks and re-asks for the PIN. **Known limit (audit F3, accepted, not fixed):** the janitor deletes a revoked row after 7 days; a repeat DELETE for that same now-gone id past that point is 404 `not_found`, indistinguishable from an id that never existed — idempotency in practice, not in the literal response code, past that window. Harmless: the client already clears its local keys on ANY non-2xx response to this route |
| DELETE | `server/device-grants` | `revoke_all_device_grants` | — (guard headers + token) | 204 — revokes every OTHER live grant of the requesting identity ("Sign out other devices"); a caller whose OWN token is bound to a grant keeps that one grant (§9/audit F4 sub-ruling (ii) — the button signs out *other* devices, not the one that clicked it); an unbound caller (a plain PIN session) revokes all of them; 401 locked; 403/415 |
| GET | `server/messages?before=&limit=` | `get_history` | query `before?:int`, `limit?:int(1-100,default 50)` | `{"messages":[<Message>], "hasMore":bool, "cursor":int}`, ascending by `seq`; 422 (`limit` out of range) |
| POST | `server/messages` | `send_message` | `{"clientId":str(8-64),"sender":str(1-32,trimmed),"deviceId":str(8-64),"text":str\|null(≤4000),"attachmentIds":[hex32](0-10),"replyToSeq":int(≥1)?}` — `replyToSeq` optional, omitted for an ordinary message; a target that no longer exists (or never did) is silently dropped, sending as a plain message, never a 500 | 201 `{"message":<Message>}` (200 + the SAME message on a replayed `clientId` — idempotent); 422 `{"error":"invalid","detail":str}` (empty text with no attachments, too long, bad sender, an unknown/already-used/failed attachment id, or `replyToSeq` present and not an integer ≥1 — booleans rejected) |
| PUT | `server/messages/{seq}/reactions` | `set_reaction` | `{"emoji":str,"sender":str(1-32,trimmed,no control chars),"reacted":bool}` — no other keys; `emoji` must be one of the six in `livechat/reactions.py`, compared as exact code points (the heart is U+2764 U+FE0F); `reacted` is the DESIRED state, not a toggle | 200 `{"message":<Message>}` — the message as the server now holds it; a request that changes nothing is still 200 but writes **no** `message_updated` event; 404 `{"error":"not_found"}` (unknown, deleted, or too-large `seq`; never a 500); 422 `{"error":"invalid","detail":str}` (emoji off the list, bad sender) or FastAPI's validation shape (unknown key, non-boolean `reacted`); 401 `{"error":"locked"}` |
| DELETE | `server/messages/{seq}` | `delete_message` | — | 204 when DB scrub and media cleanup are complete; otherwise 202 `{"erasurePending":true}`; idempotent even when the message is already gone |
| POST | `server/messages/view-once` | `send_view_once_message` | `{"clientId":str(8-64),"sender":str(1-32,trimmed),"deviceId":str(8-64),"attachmentId":hex32,"durationS":2\|5\|30\|null,"spotlight":bool,"replyToSeq":int(≥1)?}` — exactly one attachment (photo or video), no text; `spotlight` permitted only for photos; 422 `not_ready` if attachment is not ready | 201 `{"message":<Message>}` (200 on replayed `clientId`); 422 `{"error":"invalid","detail":str}` or `{"error":"not_ready"}` |
| POST | `server/messages/{seq}/view-once/open` | `open_view_once` | `{"claimId":hex32,"sender":str(1-32,trimmed)}` — claims the single view; sender cannot claim own message (403 `own_message`) | 200 `{"durationS":int\|null,"spotlight":bool,"kind":"photo"\|"video","mime":str}`; 403 `{"error":"own_message"}`; 404 `{"error":"not_found"}`; 409 `{"error":"already_opened"}`; 422 `{"error":"invalid","detail":str}` |
| GET | `server/messages/{seq}/view-once/content` | `get_view_once_content` | — (`X-Wixy-View-Claim: <claimId>` header required; verified against claim and claimant identity; expires after 600s) | 200 raw stream (`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`); erased via Inv 46 upon complete delivery; 403 `{"error":"forbidden"}` (missing/malformed/wrong claim header or wrong email); 404 `{"error":"not_found"}`; 410 `{"error":"expired"}` |
| POST | `server/wipe` | `wipe_chat` | exactly `{"confirm":"WIPE"}` | 204 when DB scrub and media cleanup are complete; otherwise 202 `{"erasurePending":true}`; every other body, including extra keys, is 422 |
| GET | `server/stream?after=` | `stream` | query `after?:int` (event cursor) | **SSE**, see §4 |
| GET | `server/usage` | `usage` | — | `{"usedBytes":int,"quotaBytes":int,"freeBytes":int,"mediaAvailable":bool,"erasurePending":bool,"transcriptionAvailable":bool}` — the last is true only while cmd's capability probe answers `{"private":true}` (cached 60 s; always false on the standalone edition); it is what shows the Transcribe control |
| POST | `server/uploads` | `init_upload` | `{"kind":"photo"\|"video"\|"voice","mimeType":str,"sizeBytes":int(≥1),"filename":str\|null}` | 201 `{"uploadId":hex32,"chunkBytes":int,"maxBytes":int}`; 413 `{"error":"too_large","maxBytes":int}`; 415 `{"error":"unsupported_type"}`; 422 (FastAPI validation error — e.g. `sizeBytes` 0 or negative; nothing is reserved); 507 `{"error":"storage_full"}`; 503 `{"error":"media_unavailable"}` (ffmpeg, ffprobe or `pillow-heif` unavailable; text chat is unaffected) |
| PUT | `server/uploads/{id}/chunks/{index}` | `put_chunk` | raw `application/octet-stream` body, ≤`chunkBytes` | 204; 413 `{"error":"too_large","maxBytes":int}`; 422 (index out of range); 404 (unknown upload) |
| POST | `server/uploads/{id}/complete` | `complete_upload` | — | 202 `{"attachment":<Attachment>}` (status `processing`; idempotent on retry); 409 `{"error":"incomplete","missing":[int]}`; 422 `{"error":"size_mismatch"}`; 404 (unknown upload) |
| DELETE | `server/uploads/{id}` | `delete_upload` | — | 204 (always — a no-op once already promoted to an attachment) |
| POST | `server/attachments/{id}/transcribe` | `transcribe_attachment` | — (opt-in, one voice note; **asynchronous** — Cloudflare cuts a proxied response at 100 s) | 202 `{"transcript":{"status":"pending"}}` (a job was started, or one already owns it; the finished transcript arrives as a `message_updated` stream event); 200 `{"transcript":{"status":"done","text":str}}` (already stored — no cmd call); 404 `{"error":"not_found"}` (malformed/unknown id, not a voice attachment, or not yet sent in a message); 409 `{"error":"not_ready"}` (still processing / failed processing); 429 `{"error":"rate_limited","retryAfterS":int}` + `Retry-After` (more than 6 new jobs a minute for this identity); 503 `{"error":"not_configured"}` (cmd cannot promise its private mode, or standalone — nothing is sent anywhere). A `failed` transcript is retried by calling this again. Inv 50 |
| GET | `server/media/{attId}/{rendition}?exp=&sig=[&g=]` | `get_media` | `rendition ∈ full\|thumb\|poster\|play`; query `exp:int`, `sig:b64url`, `g?:hex32` — present only on a URL minted from a BOUND session (§9/audit F4), and part of the signed message (`media\|{attId}\|{rendition}\|{exp}\|{email}\|{g}`), so a caller can neither add nor strip it | 200/206 (Range-aware `FileResponse`, `Cache-Control: private, no-cache`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`); 403 (bad/expired signature, email mismatch, malformed `g`, or — when `g` is present — the grant it names is no longer live); 404 (malformed id, unknown rendition, deleted/unknown attachment, view-once attachment, or missing file) |

`<Message>` = `{seq:int, clientId:str, sender:str, text:str\|null, attachments:[<Attachment>],
reactions:[<Reaction>], createdAt:float, replyTo:<ReplyTo>\|null,
viewOnce:{durationS:int\|null, spotlight:bool}\|null}`. `<Reaction>` =
`{emoji:str, count:int, senders:[str]}` — only emoji with at least one reactor, in the
allowlist's order, `senders` oldest first; the reactor's `by_email` audit value is never
returned. `<Attachment>` = `{id:str, kind:"photo"\|"video"\|"voice",
status:"processing"\|"ready"\|"failed", width:int\|null, height:int\|null,
durationS:float\|null, peaks:[float]\|null, urls:{full?,thumb?,poster?,play?},
transcript:null\|{status:"pending"}\|{status:"failed"}\|{status:"done",text:str}}` — `urls`
carries only READY renditions, each a freshly per-response HMAC-signed path (never
precomputed/stored); view-once attachments carry `urls: {}` (fail closed, Inv 52). `transcript` is `null` until someone asks for one (voice notes only); the
machine `failure` reason is never on the wire.

`<ReplyTo>` = `{seq:int, sender:str, text:str\|null, truncated:bool, media:<ReplyToMedia>\|null}`
(round 2 ruling item 10 §(3), Inv 51) — built fresh from the target's LIVE row on every read,
never stored on the reply itself. `text` is the target's text cut to 300 Unicode code points
(`truncated` is true exactly when it was cut); `null` for an attachment-only target.
`<ReplyToMedia>` = `{kind:"photo"\|"video"\|"voice"\|"mixed", count:int, durationS:float\|null,
thumbUrl:str\|null, viewOnce?:bool}` — `null` for a text-only target; `kind` is the quoted attachments' shared
kind or `"mixed"`; `durationS` is the single voice note's or video's duration only when
`count===1`; `thumbUrl` is a freshly signed URL for the FIRST attachment's `thumb` (photo) or
`poster` (video) rendition, only when that attachment is `ready` and not view-once (`null` for view-once) —
never `full`/`play`, and never present for a voice note; `viewOnce: true` is set when quoting a view-once target.
One level only: `<ReplyTo>` never nests another `<ReplyTo>`. `GET media/*`'s signature/expiry rules apply to
`thumbUrl` exactly as to any other signed media URL.

### Preview / versions / shell / public

| Method | Path | Handler | Auth | Response |
|---|---|---|---|---|
| GET | `/admin/preview/{page}.html` | `routes_preview.py:get_preview_page` | CF | `HTMLResponse` (draft-merged page, **editor injected**), `Cache-Control: no-store`; 503, 404 |
| GET | `/admin/versions/{n}/{path}` | `routes_versions.py:get_version_asset` | CF | `FileResponse` (archived build, editor **not** injected); 503, 404 |
| GET | `/admin`, `/admin/` | `app.py:get_admin_shell` | CF | `HTMLResponse` (`admin_shell.html` instant-render shell, all `/admin/static` asset refs content-fingerprinted `?v=<hash>` at import), `Cache-Control: no-cache` |
| GET | `/admin/{rest:path}` | `app.py:get_admin_shell_deep_link` | CF | same shell for every SPA panel path (`/admin/pages`, `/admin/edit/<page>`, … — decisions/00087; registered AFTER the static/guide/draft-media mounts so those win, BEFORE the public site catch-all) |
| GET | `/uxer-style.json` | `app.py:uxer_style` | none | `FileResponse` (Uxer MCP dev tooling) |
| GET | `/.uxer-web-port` | `app.py:uxer_web_port` | none | port string (the file read runs in a worker thread), or `"0"` 404 |
| — | `/admin/static/uxer/*`, `/admin/draft-media/*` | `StaticFiles` mounts | CF | file bytes / 404 |
| — | `/admin/static/*` | `staticcache.FingerprintedStaticFiles` mount | CF | file bytes / 404; requests carrying `?v=` get `Cache-Control: public, max-age=31536000, immutable`, others get StaticFiles defaults (ETag/Last-Modified) — decisions/00069 |
| GET | `/admin/guide/*` | `StaticFiles` mount (`html=True`) | CF | file bytes; `/admin/guide/` root and extension-less paths resolve `index.html` — spec/independence/07's HTML guide (milestone 8), built by `guide.build` from `guide/chapters/*.html`, committed output under `wixy_server/static/guide/` |
| GET,HEAD | `/` | `routes_public.py:get_root` | none | `FileResponse index.html` from live build; **503 plain text** `"Site not yet published"` if no live pointer |
| GET,HEAD | `/{path}` | `routes_public.py:get_path` | none | `FileResponse` from live build (**registered last** — catch-all); 503 plain text; 404 → `404.html` or `"Not found"`. HTML `Cache-Control: public, max-age=300`; `site.css`/`site.js`/`theme.css` requests whose `?v=` is VERIFIED against `content_fingerprint(resolved)` (not merely present — fingerprinted by `builder/assetcache.py` at build time) get `public, max-age=31536000, immutable`, others (a bare or mismatched `?v=`, and every other asset) get `public, max-age=86400` — decisions/00130. `/images/*` responses (any status, including a 404) additionally get `X-Robots-Tag: noindex` when the project is non-indexable (Inv 37); every other path under this catch-all — HTML pages, `site.css`/`site.js`/`theme.css`, any other static asset — never does |

Clean URLs (decisions/00128): `/{path}` resolves an extensionless path (`/about`) to
`<path>.html` with no redirect when the literal path misses — `builder.serving.
resolve_site_path`, shared with the dev server (`builder/cli.py:cmd_serve`). A trailing
slash (`/about/`) never falls back and 404s, matching GitHub Pages' own behavior (verified
live) — no directory-index resolution either. The legacy `/<slug>.html` shape keeps
resolving forever (never redirected away).

**Robots header (Inv 37, `wixy_server/robots_header.py`):** a project-wide middleware
(registered alongside the admin-auth middleware in `create_app`) adds `X-Robots-Tag:
noindex` to exactly two path categories, only when the project is non-indexable: `/images/*`
(above) and the two version-JSON routes (`/api/version`, `/api/version/notes`, above) — the
non-HTML sibling of the per-page HTML `noindex` meta tag (Inv 35), which can't be observed
inside a non-HTML response body. Classification is by request path alone, never response
status or content-type. **Deliberately narrow — not a blanket "every non-HTML route"
rule:** `/admin*`/`/api/admin*` (already CF-gated) and `/internal/*`/`/healthz` (already
404 to any externally-headered request) are excluded unconditionally; `/uxer-style.json`
and `/.uxer-web-port` (both public, non-HTML, listed above) and every other static asset
(`site.css`/`site.js`/`theme.css`, any file outside `/images/`) remain outside this
follow-up's scope and carry no `X-Robots-Tag` regardless of `indexable` — a future addition
to the allowlist is its own deliberate decision, not an automatic consequence of a route
being public.

Router include order in `create_app` is load-bearing: internal → version → preview →
admin_api → chat → engine → ai → system → versions → (inline `/admin`, uxer) →
static mounts → **public last**.

## 3. Error conventions

- **Default envelope**: every in-handler `raise HTTPException(status, detail=...)` yields
  FastAPI's standard **`{"detail": "<string>"}`**. This covers all 503/404/409/422/502 above.
- **Auth 401 is a different shape** (`auth.py:_unauthorized_response`): on `/api/*` admin
  paths → **401** `{"error": "unauthorized", "detail": "<why>"}`; on non-`/api/` admin (page)
  paths → **302 redirect to `/`**, no body.
- **Body validation**: unhandled `RequestValidationError` → FastAPI default **422**
  `{"detail": [<per-field>]}` (no custom override).
- **Public serving errors are plain text**, not JSON: 503 `"Site not yet published"`,
  404 `"Not found"` or a served `404.html`.
- **One global exception handler is registered** (`app.py`, added for the server-chat
  feature): `@app.exception_handler(HTTPException)` — when a route raises
  `HTTPException(status_code=…, detail=<dict>)`, the dict is returned **verbatim** as the
  top-level JSON body (not wrapped under `"detail"`). A `str` detail (every OTHER route's
  own usage, unchanged) still gets the default `{"detail": "<string>"}` envelope. This is
  how `/api/admin/server/*`'s literal shapes (`{"error":"locked"}`, `{"error":"invalid",
  "detail":...}`, …) coexist with every other route's plain-string convention. Every domain
  exception below is still caught **per-handler** and mapped — this global handler only
  changes how an already-raised `HTTPException`'s BODY is serialized, it never decides
  which status code to raise:

| Exception (module) | → HTTP |
|---|---|
| `CheckoutError` (`checkout.py`) | 503 (inside publish it is **wrapped** as `PublishError("pulling")` → 502, not raw) |
| `BuildError` (`builder/errors.py`) | 404 (content/theme/preview/pages) / 502 (publish) |
| `RevConflictError` (`overlay.py`) | 409 |
| `DraftValidationError` (`draft_validate.py`) | 422 (`PATCH draft` only — `exc.summary`; the fuller `exc.details` is logged, not returned) |
| `MediaUploadError` / `MediaNotFoundError` / `MediaReferencedError` (`media.py`) | 422 / 404 / 409 |
| `PublishError` (`publisher.py`) | 502 |
| `RestoreError` (`restore.py`) | 422 (admin) / 503 (versions asset, version diff) |
| `PageOpError` | 422 |
| `CmdChatError` (`cmdchat.py`) | 502 |
| `ChatNotFoundError` (`chats.py`) | 404 |
| `AttachmentError` (`chat_attachments.py`) | 422 |
| publish already running | 409 (raised directly) |

Validation errors from the builder are surfaced verbatim: `ValidationError.to_dict()` =
`{code, message, file?, key?}`; `validate` responses carry `{"ok": bool, "errors": [...]}`.

## 4. SSE streams

Both are `text/event-stream`; each event is `data: <json>\n\n`. The browser opens an
`EventSource`; **the browser never talks to cmd** — wixy polls and fans out.

**Publish** — `GET /api/admin/publish/stream`. Each `data:` = a job snapshot
`{"id","stage","log","version","error","isRunning"}`, or `{"stage": null}` when no job is
running. `stage ∈ pulling|merging|committing|building|verifying|swapping|done|failed`
(`publisher.py:PublishStage`).

> **`POST /api/admin/publish` is synchronous, and the stream is a *separate* progress
> channel.** `routes_admin_api.py:start_publish` stores the new job at `app.state.publish_job`,
> then awaits `run_publish` to completion on a worker thread (`anyio.to_thread`) and returns
> the terminal `{version, sha}`. A client tails `GET /api/admin/publish/stream` (which reads
> that same single app-wide `publish_job`) concurrently for live stages. A second overlapping
> `POST` → **409** (`"a publish is already running (job <id>)"`). So the `{version, sha}`
> envelope and the SSE stream are not redundant — one is the awaited result, the other the
> progress feed for the same job.

**Chat** — `GET /api/admin/chat/conversations/{id}/stream?includeThinking=<bool>`
(`routes_chat.py:_stream_events`). Four event kinds (discriminated by `type`):
- `{"type":"message","message":{index,role,kind,text,timestamp,toolName,truncated}}` —
  `kind ∈ text|tool_use|tool_result|thinking|error`; `thinking` omitted unless `includeThinking=true`.
  An assistant `text` message's `text` has any `wixy-tasks` fenced block already stripped out
  (decisions/00097) — the owner's bubble never shows raw protocol JSON.
  **`attachments` (decisions/00110)**: a user message carrying images adds
  `"attachments":[{uploadId,name,width,height}]` (present only when non-empty — a plain
  message's envelope is byte-identical to before this feature). Recovered server-side
  two redundant ways: cmd's driver-path `Attachments:` footer (parsed out of the text —
  the owner never sees raw machine paths) and wixy's own send log (`chat-sends.json`,
  covering stream-json sends whose image blocks cmd's decoder drops). Bytes via
  `GET chat/uploads/{uploadId}/bytes` (§2). A preamble-only first message that carries
  attachments (an image-only conversation start) is emitted with `text:null` rather
  than dropped — the bubble renders thumbnails-only.
- `{"type":"status","status":{activity,processKind,handoverState}}` — emitted only on change.
- `{"type":"tasks","tasks":[{label,status}],"messageIndex":int}` (decisions/00097) — the LATEST
  `wixy-tasks` block an assistant text message embedded, `status ∈ pending|doing|done`. Emitted
  independently of the `message` event for the same poll tick — gated on the TASKS changing,
  not the surrounding text (a re-emitted block with only a status change can leave the cleaned
  message text byte-identical to what was already sent, so this needs its own diff or a real
  progress update would never reach the client). The client keeps only the latest tasks array,
  not a history — a reconnect naturally replays whichever `tasks` event was most recently
  current.
- `{"type":"error","detail":...}` — cmd unreachable past the transcript grace window.

Server-side the stream diffs the latest message batch against `sent_messages` (cmd has no
`since=` filter), follows handover chains (adopts the leaf session, rewrites `chats.json`),
and distinguishes brand-new-session transcript lag (quiet retry) from a real outage.

**Messages are owner-filtered before emission** (`_owner_visible`, decisions/00093): the site
preamble is stripped out of the first user message, and a preamble-only first message is not
emitted at all — unless it carries attachments (decisions/00110: an image-only first message
survives as `text:null` + `attachments`, thumbnails-only). So the indices a client sees can
skip `0`, and a `text` may be shorter than what cmd's own `/messages` returns for the same
index. Upstream transcripts are unmodified.

**Server chat** — `GET /api/admin/server/stream?after=<cursor>`
(`routes_livechat.py:_stream_events`). **Structurally different from the two streams
above**: this is a real named-event SSE stream (`id: <n>` / `event: <type>` / `data:
<json>` lines, reconnect via `after=<last id>`), not the `data: {"type":...}` convention
Publish/Chat use — the client is a `fetch()` streaming reader carrying the
`X-Wixy-Server-Token` header (plain `EventSource` can't set custom headers).

- `event: message` / `id: <event_seq>` / `data: <Message>` (§2's `<Message>` shape) — a new
  message.
- `event: message_updated` / `data: <Message>` — an existing message's current state changed: an
  attachment changed status (e.g. `processing` → `ready`), a voice note's transcript changed state
  (`pending` when a job starts, then `done`/`failed`; also at startup for a job that died with its
  process), someone added or removed a reaction (the frame carries the full current `reactions`;
  a `PUT …/reactions` that changes nothing emits no event), or an attachment finished processing on
  a message that some OTHER message quotes — fired for every reply whose quote points at that
  message, so its rendered quote picks up the new thumbnail (Inv 51). Never fired for a reply on
  the TARGET's delete — see `message_deleted` below. The client patches a transcript-only,
  reactions-only, or quote-thumbnail-only change into the live bubble in place.
- `event: locked` / `data: {}` — the token expired mid-stream, OR (§9/audit F4) the
  connection's token is bound to a device grant that was revoked since the connection
  opened — checked on the same ~2s loop tick as the poll below; the server closes the
  connection right after sending this.
- `: ping` (a bare comment line, no `event:`/`data:`) every 15s, to keep the connection
  alive through proxies.
- `event: message_deleted` / `data: {"seq":int}` — the client removes that bubble if present;
  a missing bubble is a no-op. Also the LIVE-path signal a reply's quote needs to disappear
  (Inv 51 — one of three mechanisms, not the only one; see Inv 51's own text): the client
  removes the `.wx-srv-quote` element in place from every bubble/echo quoting that seq, and
  cancels the composer's pending reply if it targets that seq. This event is never delivered
  across a lock (the stream resumes from a fresh cursor on reattach); a reattach that refreshes a
  reply with `replyTo: null`, and `attach()`'s own check of a pending reply's target, cover that
  case instead.
- `event: wiped` / `data: {}` — the client clears loaded history and pending echoes; the stream
  remains open.

Per-connection loop: read `events_after(cursor)`; if any, look up each event's CURRENT
message content and emit one frame per distinct message (**coalescing** — a `message` +
`message_updated` for the same message in one poll batch collapse into a single frame,
typed `message`); if none, wait up to 2s on an in-process notifier (`LiveChatNotifier`)
before re-polling — this 2s re-check, not the notifier, is what a slot-swap overlap (two
processes, one SQLite file) relies on to never strand a message the notifier never fired
for.

## 5. Draft op contract (`DraftOp`)

The unit of edit shared by the editor overlay, the admin shell, the `PATCH /api/admin/draft`
body, and the overlay store on disk. Key = `<file>:<dotted.path>`:

```ts
type DraftOp =
  | { file: string; path: string; value: JsonValue }   // set
  | { file: string; path: string; discard: true };      // discard one key
```

`file ∈ <page-slug> | "_global" | "theme"`. **Scalar keys overlay per-key; a collection
(`data-wx-list`) overlays as the whole array** — there is no valid overlay path *inside* an
array (`dotted_get`/`dotted_set` descend dicts only). Overlay wins per key; any un-drafted
key flows through from `origin/main` (so AI-lane upstream edits appear in the draft). See
[`spec/02-content-model.md`](../../spec/02-content-model.md) §8 and
[serving-and-overlay.md](serving-and-overlay.md).

A collection item MAY carry an optional `visible: boolean` (Inv 28, decisions/00117) —
absent/`true` = shown, `false` = hidden from the public build but still present (marked) in
the draft preview. Canonical form: the key exists ONLY when `false`; a whole-array op that
re-shows an item must omit the key rather than send `true`.

## 6. Browser↔iframe postMessage protocol

The admin shell (`admin-ui/`) hosts the live-preview iframe; the editor overlay (`editor/`)
runs **inside** it. They communicate only by `postMessage`, always with the explicit
same-origin string (never `"*"`), runtime-validated after crossing the boundary. The
protocol file is **byte-identically duplicated** at `admin-ui/src/protocol.ts` and
`editor/src/protocol.ts` (deliberate — decisions/00015; keep them in sync by hand).

Every message is `{ wx: 1, type: <string>, ... }` — `wx: 1` is the protocol-version
discriminator (`isWxEnvelope`).

**Shell → overlay** (`ShellToOverlayMessage`): `init{page,bindings,draftRev,browseMode?}` ·
`applyOps{ops:DraftOp[]}` · `setDevice{device:"desktop"|"tablet"|"mobile", scale?}` ·
`themeVars{vars:Record<string,string>}` · `themeFonts{url}` · `select{key}` ·
`setBrowseMode{enabled}`.
(`setDevice.scale` is the whole-iframe viewport-simulation scale, optional and absent = 1;
the composer counter-scales by it — decisions/00075. `init.browseMode` is optional and
absent = off, same convention — browse mode, decisions/00091: while on, the overlay
suspends editing chrome/interception so every click just navigates or is inert, like
browsing the real site. The shell's edit-bar toggle owns the session-lifetime value —
`setBrowseMode` flips an already-loaded overlay live; `init.browseMode` carries the
current value to whatever overlay boots next, since a real iframe navigation wipes all
prior overlay JS state.)

**Overlay → shell** (`OverlayToShellMessage`): `ready{}` · `op{file,path,value}` ·
`navigate{page}` · `selected{key,kind,rect}` · `mediaRequest{key}`.

Supporting types: `BindingKind = "text"|"img"|"href"|"bg"|"attr"|"list"|"if"`;
`PageBindings = {page, fields: BindingField[]}`; `BindingField = {key, kind, attr?, items?}`.

The one-edit flow and the two special reuses of `applyOps` (media replace, theme live
preview) are in [editor-and-admin-ui.md](editor-and-admin-ui.md).

## 7. Named fixtures & entrypoints

- **`builder/tests/fixtures/mini-site/`** — a complete tiny site (pages, partials, content,
  `_global.json`, theme, images) the builder unit suite renders/builds/validates against;
  `builder/tests/fixtures/project.json` is its registry entry. `builder/tests/conftest.py`
  builds a `SiteSource` from it (function-scoped).
- **`builder/tests/parity/baseline/`** — per-page `desktop.png`/`mobile.png` screenshots +
  `probe.json` (resolved text/links/computed-style) captured from the reference site; the
  parity harness (`builder/tests/parity/{capture,compare,runner}.py`) diffs against these.
- **`wixy_server/tests/fake_cmd.py`** — `create_fake_cmd_app` (ASGITransport double of both
  cmd surfaces) + `FakeCmdServer` (real ephemeral-port uvicorn for the websocket). Makes the
  chat suite hermetic. The E2E fixture (`e2e/fixture_server.py`) wires one fake-cmd port into
  a real wixy app.
- **CLI entrypoints**: `python -m builder {validate|build|serve|parity}` (`builder/cli.py`);
  `python -m wixy_server` (`wixy_server/__main__.py:main` → `uvicorn.run(host="127.0.0.1",
  port=<WIXY_PORT>)`). `builder`'s public API is re-exported from `builder/__init__.py`
  (`build_site`, `validate_site`, `render_page`, `load_site_source`, `SiteSource`, `Theme`, …).
- **`live_cmd` pytest marker** — the one test needing a real local cmd (9320/9321); excluded
  by the default `addopts` (`-m "not live_cmd"`), run explicitly during deploy verification.

## 8. Draft write gate, repair & report (decisions/00095, 00096)

Three layers close the gap the 2026-07-28 gallery publish-corruption incident exposed — a
structurally-broken overlay op could be written, and a blocked publish surfaced as a raw
error dump with no recovery path. `wixy_server/draft_validate.py` is the shared core all
three read from.

- **The write gate** (`draft_validate.normalize_set_ops` → `check_structural`, run inside
  `_apply_draft_patch` before `apply_patch`): every `SetOp` in a `PATCH draft` batch is first
  silently NORMALIZED (leading-slash repo-image src rewritten to the relative form **iff** the
  file exists — `rewrite_leading_slash_src`; an ALREADY-PUBLISHED staged upload re-pointed
  `/admin/draft-media/<name>` → `images/<name>` **iff** the staged copy is gone and
  `images/<name>` exists — `rewrite_published_draft_media_src`, decisions/00115; an nbsp-only
  text placeholder collapsed to `""` —
  mirrors `editor/src/contentModel.ts`'s `normalizeEmptyText`), then checked
  STRUCTURALLY — type/required/properties/`additionalProperties` against
  `builder/schemas/*.json` for a `COLLECTION_RULES` key (plus `treatments.sections`' `cards`
  and `_global.footer.*`, the two nested shapes `builder.validate` also special-cases) —
  **deliberately without `pattern`** (`jsonschema_lite.validate_against_schema`'s new
  `skip_pattern=True`), so a freshly-added, not-yet-filled-in list item is still a valid draft
  state. A violation raises `DraftValidationError` (`summary` + `details: tuple[str,...]`);
  the whole batch is rejected, the overlay untouched — never a partial write.
- **Publish preflight** (`start_publish`'s `_preflight`, before a job/lock exists) and the
  **review-drawer preview** (`GET publish/preview`) both call `draft_validate.
  validate_merged_for_publish(merged, paths)` — the FULL schema check, `pattern` included
  (`builder/schemas/gallery-slider.schema.json` / `gallery-tile.schema.json` require every
  image `src` to match `.*\S.*`, i.e. non-blank — the one field the incident's gutted items
  had gone fully empty). Same function, so "the drawer showed it as publishable" and "publish
  preflight agrees" can never drift.
- **`POST draft/repair`** (`draft_repair.run_repair`) — deterministic, no AI. Re-normalizes
  every existing op, then for a `COLLECTION_RULES` op repairs item-by-item against the FULL
  schema **and against whether each image ref actually resolves to a file** (decisions/00115 —
  a well-formed src pointing at nothing passes every schema check, and is exactly what blocks
  a publish): fill missing required fields from the base checkout's same-index item; else
  replace the item with base; else drop it if there's no base counterpart — a repaired array
  that ends up identical to base is DISCARDED as a whole op, not left as a same-valued `SetOp`
  (Inv 6: a later real upstream edit to that key must still flow through). An op that
  normalize ALONE corrected is still written back (the pre-00115 code skipped it when no item
  needed repairing, so a repair could report success having changed nothing). A non-collection
  op whose image ref still doesn't resolve after normalize is discarded outright. Returns
  `actions` — plain-English sentences built from the page's own `meta.navLabel` (never a raw
  field name, Inv 1) — and re-runs `validate_merged_for_publish` so the caller knows whether
  the draft is now actually publishable or still needs the owner's Report path.
- **`POST report`** (`reports.submit_report`) — gathers the current validate result, the raw
  overlay, the last publish job snapshot, the live pointer, the last 5 ledger entries,
  upstream-ahead commits, and the engine sha into one bundle, saves it unconditionally to
  `Storage/projects/<slug>/reports/<UTC yyyymmddTHHMMSSZ>.json`, and best-effort emails it
  (stdlib `smtplib` STARTTLS, `WIXY_REPORT_SMTP_*`/`WIXY_REPORT_EMAIL_*` env vars) — a send
  failure is logged and reported as `emailed: false`, never raised (the save already
  happened). `context` is a short caller-supplied tag (e.g. `"publish-blocked"`,
  `"publish-failed"`), not validated against an enum.
