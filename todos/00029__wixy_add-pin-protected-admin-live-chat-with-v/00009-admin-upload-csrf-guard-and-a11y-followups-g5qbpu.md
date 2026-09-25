# 00009 [g5qbpu] Separate follow-up: cross-site guard on the admin upload routes, plus two owed accessibility checks

## What
Three items the Server-chat security builder (bs12) reported but did not fix, deliberately outside workspace 29's scope.
Not started. Needs its own workspace or task, a security consult before implementation, and an audit before merge.

1. **L10 (low, verified present on main 2026-09-25):** a cross-site HTML `<form enctype="multipart/form-data">` POST needs no
   custom header and reaches the handler on `POST /api/admin/media` (`wixy_server/routes_admin_api.py` ~683),
   `POST /api/admin/chat/uploads` (`wixy_server/routes_chat.py` ~336) and
   `POST /api/admin/chat/conversations/{id}/attachments` (`routes_chat.py` ~288). The reviewer reproduced a real file landing in DRAFT
   media (unpublished). Every other admin mutation takes a JSON body, which a forged form cannot send (see the comment on
   `_require_json_content_type` in `routes_engine.py`); multipart uploads are the exception. Impact is low because the forged request
   needs the owner's Cloudflare Access cookie to ride along (SameSite=Lax mostly prevents that), and the result is an unpublished file.
   Pre-existing since v1; not introduced by the Server chat.
2. **L2:** an `aria-live="off"` span sits inside the `role="alert"` lockout message. Needs a manual NVDA/VoiceOver check; not guessable headlessly.
3. **L8 (composer error part only):** the composer's error line has no `role`/`aria-live`, so the voice-note auto-discard message is silent to screen
   readers. The element is in the SHARED `admin-ui/src/chatComposer.ts` (also the AI chat), so it needs a screen-reader-validated change
   and the AI chat's own specs.

## Why
Same class as audit item F14 (the unlock CSRF hole, fixed in `71cb2946`): a state-changing request a hostile page can fire from the
owner's browser. F14 was medium because it could lock her out of the PIN screen; L10 is low because it can only add an unpublished file.

## Context+current-state
Recommended fix for item 1 (from bs12, confirmed by the DM): require a custom header (for example `X-Wixy-Admin-Upload: 1`, which a
cross-site simple request cannot set without a CORS preflight that wixy does not grant) and a `Sec-Fetch-Site` of `same-origin` when
present, on those three routes, red-first, mirroring `unlock_request_refusal` in `wixy_server/livechat/tokens.py`; the admin UI's upload
clients must send the header, and the frontend bundle must be rebuilt and committed. Security/auth change: consult (Opus) first, audit before merge.

## Relevant files+commits
`wixy_server/routes_admin_api.py`, `wixy_server/routes_chat.py`, `wixy_server/livechat/tokens.py` (the model), `admin-ui/src/` upload clients,
`admin-ui/src/chatComposer.ts`; `decisions/00158` (F14); bs12 report: intercomm 6d57956f64fc4f1282ebaf77e8488ee7.

## How to continue + acceptance
Acceptance for item 1: a cross-site multipart form POST to each of the three routes is refused (403 or 415) before the body is read and
nothing lands on disk; the admin UI still uploads; docs/ai/contracts.md and invariants.md updated in the same PR; tests red-first.
