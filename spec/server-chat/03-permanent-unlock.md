# Server chat — "Keep this device unlocked" (permanent unlock)

Architect ruling, 2026-09-25. Binding for workspace 29 round 2. Folded into
`00-brief.md` (R6, §5, §6, Inv 41) at the next reconciliation.

**Operator request (verbatim):** "Button to permanent unlock, but you have to put the pin in
again."

## 1. What "permanent" means (ruling)

A per-device setting that, once switched on **with the PIN**, keeps the chat unlocked on
that device until someone locks it **on purpose**.

- **Suppressed while it is on — every automatic lock:**
  - the idle fade: 10 s, or 60 s with "Extend auto-lock to 1 minute";
  - ~~the tab or app going to the background (`visibilitychange` → hidden)~~ — **amended
    by §8 (2026-09-25):** going to the background is now governed by the two per-device
    checkboxes "Lock when I change tab" and "Lock when I lock my screen" in both modes,
    and a lock they cause pauses the grant;
  - navigating away from `/admin/server`;
  - a page reload or a discarded tab;
  - unlock-token expiry: the token is renewed silently, with no PIN.

  An idle-only version (the Orchestrator's default) is rejected. On a phone it would still
  lock on every app switch, every tab discard, every trip to another admin page, and every
  12 h, which is not "permanent" in any sense the operator would recognise.
- **Still locks, exactly as today — every deliberate lock:** the panic button, a multi-tap
  in the chat (R3), and Escape.
  - A deliberate lock also **pauses** the device's permanent unlock. It stays paused until
    the PIN is entered again, so a panic survives reloads and cannot be undone by a
    bystander.
  - Entering the PIN normally clears the pause, and the device is permanently unlocked
    again. The setting itself stays on.
- **Opening the Server tab** on a device with permanent unlock on and not paused shows the
  chat directly: there is no decoy step and no PIN. That is the point of the feature.
  - While paused, or when the setting is off, the decoy and PIN flow are unchanged (R2).
- **Unaffected:** push notifications, "Extend auto-lock to 1 minute" (disabled and greyed
  while permanent unlock is on, because it has nothing to extend), delete/wipe, and the
  owner-facing disguise elsewhere in the admin.

## 2. Why a server-side device grant, not a stored token

Surviving reloads and token expiry needs a credential that lives on the device. Storing the
12-hour unlock token in `localStorage` is rejected, for three reasons:
- it would break Inv 41 (tokens live only in JS memory);
- it would still expire, so it would not be permanent;
- it cannot be revoked.

The ruling is a **device grant**. It is a separate credential that is:
- **created only with the PIN** (the operator's gate), and additionally only from an
  already-unlocked session;
- **stored hashed on the server**, with the secret held only by that device;
- **bound to the CF Access identity** that created it;
- **individually revocable**, from the device itself or wholesale;
- **used only to mint** a normal unlock token.

Every chat route keeps requiring the in-memory token (Inv 41 is unchanged). The grant only
replaces *typing the PIN*.

## 3. Server

**Migration v7** — a new table, holding ids and hashes only, never content:

```sql
CREATE TABLE IF NOT EXISTS device_grants(
  id TEXT PRIMARY KEY,                 -- uuid4().hex
  secret_hash TEXT NOT NULL,           -- sha256 hex of the 32-byte random secret
  email TEXT NOT NULL,                 -- CF Access identity that created it ("" in dev)
  label TEXT,                          -- e.g. "Android · Chrome", from the client; display only
  created_at REAL NOT NULL,            -- epoch seconds
  last_used_at REAL NOT NULL,
  revoked_at REAL);
```

A secret is 32 bytes from `secrets.token_bytes`, sent to the client base64url-encoded
exactly once. The server keeps only the SHA-256: the secret is high-entropy, so a slow hash
adds nothing. All comparisons use `hmac.compare_digest`.

**Routes**, under `/api/admin/server`, behind CF Access. Each one runs the §5.1 v1.6
**unlock request guard** first (`Sec-Fetch-Site` same-origin when present,
`application/json`, `X-Wixy-Server-Unlock: 1`).

- **`POST /device-grants`** — needs a valid `X-Wixy-Server-Token` (you are inside the
  unlocked chat) **and** body `{"pin": str, "label": str|null}`.
  - The PIN goes through the same `PinVerifier` path as `/unlock`: cmd charges an attempt,
    and the same 401/429/409/503/422 mapping and copy apply.
  - On success → **201 `{"grantId": hex32, "secret": b64url, "token": str, "expiresAt":
    float}`**.
  - An identity may hold at most **5 live grants**. A sixth creation revokes the oldest.
- **`POST /unlock-with-grant`** — body `{"grantId": hex32, "secret": b64url}`. **No PIN,
  and cmd is not contacted.**
  - The grant must exist, be unrevoked, have been used within 30 days, match the hash, and
    belong to the requesting CF email. Then the server bumps `last_used_at` and returns
    **200 `{"token": str, "expiresAt": float}`**.
  - Anything else → **401 `{"error":"grant_invalid"}`**, with one reason-free message: never
    say *which* check failed.
  - Rate limit: 10 failures per identity per minute → 429. A 256-bit secret cannot be
    guessed; the limit only stops noise.
- **`DELETE /device-grants/{grantId}`** — token required; revokes it (sets `revoked_at`) →
  204, idempotent. Revocation is allowed only for grants of the requesting identity.
- **`DELETE /device-grants`** — token required; revokes **all** of the requesting
  identity's grants → 204. It backs the settings sheet's "Sign out other devices".

**Janitor (hourly):** grants unused for more than 30 days are revoked. Rows revoked more than
7 days ago are deleted.

**Invariant 48:** a device grant is created only by a PIN verified by cmd inside an unlocked
session; it is stored only as a hash; it is bound to its CF identity; it only ever mints a
normal unlock token; it is revocable. The unlock token itself never leaves JS memory
(Inv 41 unchanged).

## 4. Client

**localStorage**, under the existing `wx-srv-` prefix:
- `wx-srv-device-grant` = JSON `{"grantId": ..., "secret": ...}`. Present means the setting
  is on.
- `wx-srv-grant-paused` = `"1"` after a deliberate lock.

Unreadable or malformed storage means **off**, which fails safe to the normal PIN flow.

**Settings sheet**, in the unlocked chat, below "Extend auto-lock to 1 minute":
- a row **"Keep this device unlocked"** (a whole-row label, like the auto-lock row);
- **turning it on** opens an inline PIN pad titled "Enter PIN to keep this device
  unlocked", with the same keypad, copy and lockout countdown as the unlock pad →
  `POST /device-grants`. The result is stored, and the row shows "On · Lock with the ✕ or
  a double-tap";
- **turning it off** → `DELETE /device-grants/{id}` (a local clear happens even if the call
  fails, and the server's 30-day expiry mops up), then both keys are removed;
- a small link **"Sign out other devices"** → `DELETE /device-grants`. This device's grant is
  revoked too, so it turns itself off here as well.

**Lock model** (`lockModel.ts` + `panel.ts`):
- **On panel mount:** if a grant exists and is not paused, skip the decoy and call
  `unlock-with-grant` → `chat`.
  - A 401 `grant_invalid` → clear both keys and show the decoy (the grant was revoked or
    expired).
  - A network error → show the decoy. The user can still use the PIN.
- **While the grant is active**, the automatic-lock inputs (the idle timer, `hidden`,
  `routeAway`) are **ignored**. The reducer takes `grantActive: boolean` as an input; there is
  no second state machine.
- **Token renewal:** 5 minutes before `expiresAt`, or on any 401 `locked`, call
  `unlock-with-grant` once, silently.
  - Success → swap the in-memory session, with no visible change.
  - Failure → lock normally, and clear the grant if the reason was `grant_invalid`.
- **Deliberate locks** (panic, multi-tap, Escape) → lock as today **and** set
  `wx-srv-grant-paused = "1"`.
- **A successful PIN unlock** (`/unlock`) clears `wx-srv-grant-paused`.

**Route-away while active:** the panel is torn down as today; nothing is detached into
memory. On return, the mount path re-mints silently. Keeping the chat alive across routes
is not required.

## 5. Tests

**pytest:**
- **Creating a grant:** create requires both the token and a cmd-verified PIN (a wrong PIN
  charges an attempt and creates no grant); creating more than 5 revokes the oldest.
- **Using a grant:**
  - `unlock-with-grant` rejects an unknown id, a wrong secret, a revoked grant, one unused
    for 30 days, and one belonging to another CF identity — all with the same 401 body;
  - it never calls cmd (assert the fake saw zero verify calls);
  - it rate-limits.
- **Storage:** only the hash is stored; the raw secret appears in no row and no log.
- **Revocation and cleanup:** revocation is idempotent; revoking another identity's grant
  fails; the janitor revokes and deletes on its schedules.
- **Guard:** the guard applies to all three POST/DELETE grant routes.

**vitest (lock model):**
- With a grant active, idle, hidden and route-away do not lock.
- Panic, multi-tap and Escape do lock and set the pause.
- A PIN unlock clears the pause.
- Renewal happens at `expiresAt` − 5 min; renewal failure locks; `grant_invalid` clears the
  keys.

**e2e (Playwright, desktop and mobile):**
- Turn the setting on with the PIN; reload → the chat appears with no PIN.
- Hide the tab and come back → still unlocked. Idle 2 minutes → still unlocked.
- Panic → locked. Reload → decoy (paused). Enter PIN → unlocked, still permanent.
- Turn the setting off → reload → decoy.
- "Sign out other devices" → the next reload shows the decoy.

## 6. Security review

This is new authentication surface: a new credential type and new routes. It must go
through the opus-tier `audit` before merge, with this file as the acceptance criteria.

**Threat-model delta (honest):** anyone holding this device while its CF Access session is
signed in can open the chat without the PIN. That is exactly what the operator asked for, on
his chosen device. A script running in the admin origin could read the grant; that is the
same exposure class as reading an unlocked chat's DOM. Panic and multi-tap still close the
chat instantly and keep it closed across reloads until the PIN is entered.

## 8. "Lock when I change tab" / "Lock when I lock my screen" (operator request, 2026-09-25)

Operator request (verbatim): "We need checkboxes for: - Lock when I change tab - Lock when I lock my screen."

(1) PLATFORM — confirmed, with one real exception
- No standard, universally supported API tells a tab or app switch from a screen lock. Both
  fire the same `visibilitychange → hidden`. On desktop, a Windows screen lock may fire
  nothing at all.
- The one real technique is the **Idle Detection API** (`IdleDetector`). It reports
  `screenState: "locked" | "unlocked"` in Chrome/Edge on desktop and Android (not Safari,
  not Firefox). It needs a one-time permission (`IdleDetector.requestPermission()`, from a
  tap) and `threshold >= 60000` ms; the threshold only affects `userState`, and we use
  `screenState` only.
- Its event timing while a page is backgrounded on Android is **not proven**, so it must be
  measured on the operator's phone before we claim it works (see "Live check").

(2) SEMANTICS — two independent per-device checkboxes, always shown, both modes
- Both live in the settings sheet: **"Lock when I change tab"** and **"Lock when I lock my
  screen"**.
- **Default ON**, which is today's behaviour: fail-closed for a disguised chat. The operator
  unticks what he doesn't want.
- Keys: `wx-srv-lock-on-tab` and `wx-srv-lock-on-screen`, set to `"0"` meaning off.
  Absent or unreadable → ON.
- **They govern the `hidden` trigger in BOTH modes.** This AMENDS 03 §1: permanent unlock no
  longer blanket-suppresses "tab or app going to the background". It still suppresses idle,
  route-away, reload and token expiry.
- **A checkbox-caused lock while a device grant is active PAUSES the grant**, exactly like a
  deliberate lock, so the PIN is needed on return. Otherwise the grant would silently
  re-mint on return and the lock would mean nothing.
- The R7 exemptions still apply: the file picker being open, or the mic-permission prompt,
  never lock.

Decision rule (a pure function in lockModel, inputs `lockOnTab`, `lockOnScreen`,
`screenEvidence`):
- **Both ON:** `hidden` → lock at once, as today.
- **Both OFF:** `hidden` → never lock. The idle timer still applies unless permanent unlock
  is on.
- **The two differ:** `hidden` → lock at once and **fail closed** (a "shield"). On return
  (`visible`), keep the decoy up for up to **500 ms** so queued IdleDetector events can
  arrive. Then the cause is:
  - **"screen lock"** — if a `screenState = "locked"` was observed between the hide and now.
    This is positive evidence.
  - **"tab change"** — only if there is no such event **and this device is proven** (see
    below).
  - **"ambiguous"** — no event, and the device is not proven.

  **Restore silently only when the cause is known and its box is OFF:** re-attach the
  detached view with the in-memory session, or re-mint via the grant. If the cause's box is
  ON, **or the cause is ambiguous**, stay locked and pause the grant if one is active.
  **Fail closed on ambiguity** (amended 2026-09-25 on the Orchestrator's catch: the first
  version defaulted a missing event to "tab change", so a real screen lock the phone did not
  report in time would have reopened the chat).

  **A proven device** (`wx-srv-screenlock-proven = "1"`):
  - **Why proof is needed:** there is never positive evidence of a *tab* switch, only of a
    screen lock. So "no event means tab change" can only be trusted on a device that has
    shown it really does deliver screen-lock events across a hide-and-return cycle.
  - **When the key is set:** the first time a `screenState = "locked"` event is observed
    during a hidden interval (permission granted), set the key.
  - **When it is cleared:** whenever the IdleDetector permission is lost or the detector
    becomes unavailable.
  - **Until proven**, the combination "change tab OFF + lock my screen ON" still locks on
    every switch, fail-closed. The row says so plainly: "Lock your screen once so this phone
    can learn to tell a screen lock from a tab switch — until then, switching away also
    locks." The note disappears once the device is proven.
  - The combination "change tab ON + lock my screen OFF" needs no proof: it restores only on
    positive screen-lock evidence.
- An IdleDetector **`screenState → "locked"` event while visible** (desktop Win+L, which may
  not fire `hidden` at all) locks immediately when "Lock when I lock my screen" is ON.

Permission and availability:
- The IdleDetector permission is requested only when the user makes the two settings
  **differ**, from that tap.
- **Unsupported browser, or permission denied:** the screen checkbox is disabled and follows
  the tab checkbox. Show the plain line "This browser can't tell a screen lock from a tab
  switch, so both follow 'Lock when I change tab'." Never pretend the distinction works.

Tests:
- vitest with a fake IdleDetector and a fake clock:
  - every setting combination × cause (screen lock / tab change / ambiguous) × proven or
    unproven device;
  - an ambiguous cause always stays locked, including "change tab OFF + screen ON" on an
    unproven device — the regression test for the fail-open gap;
  - the proof key is set on the first observed hidden-interval screen lock, and cleared
    when the permission is lost;
  - the shield holds for 500 ms, then restores or stays locked;
  - a checkbox lock pauses an active grant;
  - an unsupported or denied detector gives the mirrored behaviour;
  - a screen-lock event while visible locks.
- e2e: covers visibility plus a stubbed `IdleDetector` via `addInitScript`.

Live check (required before shipping the two-checkbox distinction):
- On the operator's Android phone, log the order and timing of `visibilitychange` and
  IdleDetector events for:
  1. a power-button lock and unlock;
  2. an app switch;
  3. a tab switch.
- If the screen-lock evidence is not observed within the 500 ms window on return, ship the
  mirrored (combined) mode on that platform and tell the operator plainly that his phone
  can't tell the two apart.

## 7. Release notes

Every commit carries `Release-note: General bug fixes and improvements.` (R14a).
