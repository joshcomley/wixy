# CF Access JWT validation allows 30s clock skew (leeway)

## Symptom

On 2026-07-21 every service-token call to `https://ca.cinnamons.uk/api/admin/*`
failed with `401 {"detail":"The token is not yet valid (iat)"}` — while the
operator's browser admin sessions kept working fine. The `verify` skill's
documented service-token path had worked when written and then silently broke.

## Root cause

Two different JWT lifecycles against one strict validator:

- **Browser logins** get ONE JWT minted at sign-in; its `iat` is comfortably in
  the past by the time any request uses it.
- **Service-token requests** (the `CF-Access-Client-Id/Secret` header pair used
  by automation, e.g. the `verify` skill) get a FRESH JWT minted by the CF edge
  **per request**, with `iat` = edge-now.

The hub's clock was ~3s behind the CF edge (measured against the HTTP `Date`
header). `verify_access_jwt` called `jwt.decode` with no `leeway`, so PyJWT
rejected any token whose `iat` was even a second in the future — i.e. every
service-token call, whenever the origin clock lags the edge. Whether the path
"works" at any moment depends on the sign of the instantaneous NTP drift —
exactly why it was green when documented and dead later.

## Decision

`verify_access_jwt` now passes `leeway = _CLOCK_SKEW_LEEWAY_S` (**30 seconds**)
to `jwt.decode` (applies to `iat`, `exp`, and `nbf` uniformly in PyJWT). 30s
covers realistic NTP drift on any fleet box by an order of magnitude without
meaningfully widening the replay window (CF JWTs are 1h-lived; an extra 30s of
post-expiry acceptance changes nothing operationally, and the edge still
gates every request upstream of us anyway).

We deliberately did NOT "fix" this by chasing the hub's clock: sub-minute skew
against any given edge POP is normal on healthy NTP clients, so tolerance —
not tighter sync — is the durable fix.

## What to watch for

- The existing `test_expired_token_is_rejected` uses `exp = now - 60`: that
  still rejects under a 30s leeway. If the leeway is ever raised past 60s that
  test must move with it.
- `WIXY_DEV_NO_AUTH=1` remains the dev/test bypass and is untouched.
