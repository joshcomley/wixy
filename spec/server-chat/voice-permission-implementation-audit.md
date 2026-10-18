# Focused implementation audit: cached permission policy completion

- Frozen head: `a2030d5410042b60ebfb0b4c0543c1ef9e1edd7f`
- Comparison base: `b2c01b60eb7bb4b11e9b1dde335f245c452cf625`
- Reviewer: independent GPT-6 Astra session `3e7ebbce-15e4-4298-9893-b9453d0d7cc9`.
- Scope: the cached hidden-policy lifecycle delta in `admin-ui/src/server/panel.ts`, its actual controller/view/hooks/reducer composition, affected tests, generated assets and documentation. No new transport, authorization or audio implementation audit.
- **Findings: C 0 / H 0 / M 0 / L 0.**
- **Code verdict: PASS for this bounded delta at the exact frozen head.** No concrete defect or required repair identified. This is not release acceptance.

## Independent assessment

The packet was treated as intent and disclosed evidence limits. The implementation and its composition were inspected directly; proposal and merge report files were not read. The worktree was clean and at the requested head before inspection, and remained so before writing this report.

1. **Listener order and synchronous policy completion.** `panel.ts:1023` establishes the cached restoration marker before completing an earlier exempt hide or processing a new hide. `panel.ts:1047` rechecks only a pending cached exemption whose last picker/microphone holder has gone. `panel.ts:709` makes release idempotent, decrements the holder count, then invokes the helper. With the panel first, controller teardown releases permission into this helper and locks immediately; with the controller first, release sees no cached marker and the subsequent panel handler applies ordinary hidden policy. An earlier visibility hide is also completed when persisted pagehide arrives after permission release. `panel.ts:1094` repeats the guarded completion before visible policy and presence restoration. It does not add another policy owner.

2. **Bounded reentrancy and resource ownership.** `call/controller.ts:115` stops and nulls audio before releasing microphone permission. The resulting panel lock can synchronously enter `chatView.ts:156` and `controller.ts:299` again. This is bounded: the release closure has already marked itself released; `panel.ts:1055` marks the transition handled before effects; and `panel.ts:229` clears the restore marker before calling the view's detach. The nested disconnect closes/nulls the socket, so the outer disconnect has no second socket to close. The new four-cell real-panel/real-controller test asserts one detach and one socket close before visible return, one audio stop, and no replacement presence socket. The controller's preparation epoch/identity checks at `controller.ts:200` reject late readiness after teardown.

3. **Actual owner integration and exemptions.** `chatView.ts:68`, `:119`, `:156` and `:167` wire the same panel hooks to the actual controller and forward attach/detach/dispose. The integration regression uses a small view adapter around the real panel and real controller, not the full real thread; actual view forwarding was therefore checked in source. `panel.ts:696` counts both picker and microphone holders. A remaining holder prevents completion; ordinary non-cache release cannot trigger it without `restorePresencePending`. The helper adds no timer. Initialization is safe: hidden state is initialized before the final render/grant-unlock startup can create the view and use its hooks.

4. **Original hide evidence, shield and ignore mode.** `panel.ts:1053` skips timestamp replacement and causal re-proving on recheck; `panel.ts:937` seeds the shield from the original hide. The delayed-release causal-screen-lock regression at `panelGrant.test.ts:1305` passes. Ignore policy remains handled without detaching, allowing one presence restoration through `panel.ts:1038`. Shield creation detaches and clears that marker, leaving shield restoration as the sole owner. Re-hide taint, cancellation of a pending shield resolution, and invalidation of renewal-dependent restoration remain in `panel.ts:1067`, `:963` and `:989`; this change does not reset that evidence on completion.

5. **Renewal, expiry, unload and terminal ownership.** `panel.ts:539` keeps shielded renewals detached and restores only a still-valid visible shield decision. `:564` rejects renewal results after session replacement/lock/disposal. Cached restoration at `:1038` checks owner attachment, state, visibility and expiry before attaching. Nonpersisted pagehide clears the cached marker and enables the existing unload guard. Real detach clears it before callbacks; teardown at `:1152` clears it before route-away/disposal. Late suspension releases therefore cannot reopen a retired owner. The reducer's shield and lock effects (`lockModel.ts:256`, `:301`) remain consistent with these lifetimes.

## Verification performed in this review

- `npm test -- tests/server/panel.test.ts tests/server/panelGrant.test.ts tests/server/callController.test.ts`: **262 passed across the two existing panel files**. The last selector names no file; it did not run controller tests.
- Corrected controller selection: `npm test -- tests/server/call.test.ts tests/server/callRepairs.test.ts`: **31 passed across two files**. Total independently run: **293 tests**.
- `npm run typecheck`: **passed**, including the service-worker TypeScript project.
- `git ls-files --eol` confirms LF for changed panel source, committed `admin.js` and its map. The committed map's embedded `server/panel.ts` was independently compared with the actual source and matches exactly.
- Reviewed the changed documentation against the implementation. It accurately describes cached completion, original hide evidence, held exemptions and the limits of injected browser events.

No full CI, blanket suite, source modification, build rewrite, branch, commit, push, PR, merge or new agent was used. A fresh byte-for-byte bundle rebuild was not run in this read-only pass; the parent's strict LF build result remains disclosed evidence, separate from the source-map check above. The parent's broader 1,724-test run and Chromium cache/draft/presence recovery predate the final defensive visible-helper invocation; neither was represented as independently rerun here.

## Findings and acceptance boundary

No finding requires a reproduction or repair. The tests and source support the bounded code verdict, not physical browser or deployment behavior. Physical Android/iPad/actual iPhone browser acceptance, production Access/tunnel across networks, 15-minute speakerphone/duplex quality, measured latency/jitter/loss, and actual Slots blocked-worker shutdown **remain open**. Mocks, injected lifecycle events, synthetic audio and declared configuration do not close them. Parent retains final acceptance and the actual delivered SHA; this report certifies no merge or deployment.
