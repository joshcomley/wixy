# Symptom
Operator report 2026-10-15 (v316): the admin sat on "Loading…" on the Contact tab with no error toast, while the server log showed `/api/admin/state` returning 200.

# Root cause (of the silent state, not of the one-off trigger)
`loadState` wrapped the fetch AND the render (`renderTopBar`, `handleRoute`) in one try/catch, but assigned `state` before rendering. If the render threw on the first load, the catch retried — and the retry saw `state !== null`, so `isFirstLoad` was false and `handleRoute` never ran again. The shell stayed on its initial "Loading…" forever.

# Decided
Fetch failures and render failures are handled separately. A render failure after a successful fetch resets `state` to null so the retry re-runs the whole first-load mount, and shows the same "Can't reach the server — retrying…" toast, so it is never silent.

# Watch for
The trigger of the 2026-10-15 incident was never established (server healthy since the 21:28 deploy; fixture and real-data copy both loaded). If it recurs, the toast now appears and the browser console has the real error.

# Delivery
Shipped as pull request 314 (merge b9d4848) and live as version 317 on 2026-10-15.
