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
| GET | `/api/version` | `routes_version.py:get_version` | **none (public by design)** | `{"commit": {"sha_full": "<engine HEAD sha>"\|null, "count": <int\|null>}, "slot": <str\|null>, "version": <int\|null>, "edition": "fleet"\|"standalone", "syncBase": <str\|null>}` — `commit.count` (decisions/00109) is the engine's `v N` display number (first-parent count of HEAD; baked `WIXY_ENGINE_VERSION` preferred, git fallback, null on a gitless image); `version` is the SITE's live pointer, unrelated |

### Admin API (`/api/admin/*`, all Auth: CF)

| Method | Path | Handler | Request | Response |
|---|---|---|---|---|
| GET | `state` | `routes_admin_api.py:get_state` | — | `{"project":{slug,name,domain}, "pages":[{slug,meta,lastModified,editable,pendingDelete}], "draft":{rev,opCount (SAME formula as publish/preview's — content ops + staged page adds/deletes + staged media replacements/deletions, decisions/00108)}, "live":{version,sha}\|null, "upstream":{aheadOfPublished:[{sha,subject,author,when}],fetchedAt}, "publishJob":{...}\|null, "chats":[<summary>], "adminSections":[<admin section>], "chatAttachmentsSupported":bool}`; 503 |
| GET | `content/{page}` | `get_content` | — | `{"content": <JsonObject>, "bindings": <dict>}`; 503, 404 |
| GET | `theme` | `get_theme` | — | `{"theme": <dict>}`; 503, 404 |
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
collection>]}`; `<admin collection>` = `{path, label, itemNoun, schema, alignAspect,
fields:[<admin field>]}` — `alignAspect` is `{w, h} | null` (from the registry's
optional `"alignAspect": "W:H"`); when non-null AND the collection has ≥2 `image`
fields, the section panel offers the before/after aligner on its cards and in its add
flow (decisions/00111); `<admin field>` = `{key, kind:"image"\|"text"\|"choice", label,
options:[{value,label}]}` (decisions/00098) — a plain camelCase mirror of
`builder.config.ProjectConfig.admin_sections`
(`routes_admin_api.py:_admin_sections_snapshot`), registry-driven (Inv 1: no site literals
in engine code — `ca.json`'s `adminSections` array declares the actual "Before & After"
section; an empty registry reads as `[]`, never absent). Drives `admin-ui`'s dynamically
rendered nav entries + `sectionPanel.ts`'s management screen for each declared section —
see [editor-and-admin-ui.md](editor-and-admin-ui.md).

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

### Preview / versions / shell / public

| Method | Path | Handler | Auth | Response |
|---|---|---|---|---|
| GET | `/admin/preview/{page}.html` | `routes_preview.py:get_preview_page` | CF | `HTMLResponse` (draft-merged page, **editor injected**), `Cache-Control: no-store`; 503, 404 |
| GET | `/admin/versions/{n}/{path}` | `routes_versions.py:get_version_asset` | CF | `FileResponse` (archived build, editor **not** injected); 503, 404 |
| GET | `/admin`, `/admin/` | `app.py:get_admin_shell` | CF | `HTMLResponse` (`admin_shell.html` instant-render shell, all `/admin/static` asset refs content-fingerprinted `?v=<hash>` at import), `Cache-Control: no-cache` |
| GET | `/admin/{rest:path}` | `app.py:get_admin_shell_deep_link` | CF | same shell for every SPA panel path (`/admin/pages`, `/admin/edit/<page>`, … — decisions/00087; registered AFTER the static/guide/draft-media mounts so those win, BEFORE the public site catch-all) |
| GET | `/uxer-style.json` | `app.py:uxer_style` | none | `FileResponse` (Uxer MCP dev tooling) |
| GET | `/.uxer-web-port` | `app.py:uxer_web_port` | none | port string, or `"0"` 404 |
| — | `/admin/static/uxer/*`, `/admin/draft-media/*` | `StaticFiles` mounts | CF | file bytes / 404 |
| — | `/admin/static/*` | `staticcache.FingerprintedStaticFiles` mount | CF | file bytes / 404; requests carrying `?v=` get `Cache-Control: public, max-age=31536000, immutable`, others get StaticFiles defaults (ETag/Last-Modified) — decisions/00069 |
| GET | `/admin/guide/*` | `StaticFiles` mount (`html=True`) | CF | file bytes; `/admin/guide/` root and extension-less paths resolve `index.html` — spec/independence/07's HTML guide (milestone 8), built by `guide.build` from `guide/chapters/*.html`, committed output under `wixy_server/static/guide/` |
| GET,HEAD | `/` | `routes_public.py:get_root` | none | `FileResponse index.html` from live build; **503 plain text** `"Site not yet published"` if no live pointer |
| GET,HEAD | `/{path}` | `routes_public.py:get_path` | none | `FileResponse` from live build (**registered last** — catch-all); 503 plain text; 404 → `404.html` or `"Not found"` |

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
- **No global exception handlers are registered.** Every domain exception is caught
  per-handler and mapped:

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
  file exists — `rewrite_leading_slash_src`; an nbsp-only text placeholder collapsed to `""` —
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
  schema (fill missing required fields from the base checkout's same-index item; else replace
  the item with base; else drop it if there's no base counterpart) — a repaired array that
  ends up identical to base is DISCARDED as a whole op, not left as a same-valued `SetOp`
  (Inv 6: a later real upstream edit to that key must still flow through). A non-collection op
  whose image ref still doesn't resolve after normalize is discarded outright. Returns
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
