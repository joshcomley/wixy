# Item 14: Verifiable and honest Android push notifications

**ID**: p8x4z1
**Status**: done
**Workspace**: 00033

## Mission
Make Android push notifications verifiable and honest on the operator's own phone.

## Deliverables
1. Honest state: On load and after enable/disable, derive state from browser as well as server:
   - `Notification.permission` (denied -> blocked, with allow in site settings text)
   - SW registration at scope `/admin/`
   - `pushManager.getSubscription()` endpoint matching server record
   - If server says subscribed but browser lacks live subscription/permission: "needs re-enabling" state, one tap repairs it.
2. "Send me a test notification" control, visible only when enabled:
   - Token-gated route (`POST /api/admin/server/push/subscriptions/{deviceId}/test` and alias `POST /api/admin/server/push/test/{deviceId}`)
   - Sends payloadless push to calling device's subscription only
   - Rate limited per device (a few seconds)
   - Returns push service's status code and ok flag
3. Round-trip evidence:
   - SW push handler sends confirmation via postMessage/BroadcastChannel when `showNotification` resolves
   - UI reports:
     - "Your phone received the test and showed it"
     - "Google accepted it but your phone did not confirm within ~10 seconds"
     - "The push service rejected it (status N)"
   - Short plain hints for troubleshooting
4. Docs & Tests:
   - Update `docs/ai/livechat.md` and `docs/ai/contracts.md`
   - Unit tests: pytest for route, vitest for pushToggle & serverSw
   - E2E test for test flow and state derivation
