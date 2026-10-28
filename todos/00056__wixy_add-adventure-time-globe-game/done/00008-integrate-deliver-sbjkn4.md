# 00008 [sbjkn4] Integrate, review, live verify, ONE delivery merge; record merge SHA (delivery task ca26a3d7)

Spec: spec/server-chat/08-adventure-time.md
Status: DONE

- Delivery merge: PR #342 (head 1c8ba05), merge SHA `eb14931d9628debf29bb7d0b97dc6ee68f332b78`
  on main, 2026-10-28 02:42:35Z; cmd delivery_state `delivered`.
- Candidate evidence (a2199b4 + todo-only 1c8ba05), local Windows: pytest 3986 passed, vitest
  3249, tsc clean, ruff/mypy clean, Playwright e2e 263/263. Security audit relation
  `bed05761-f3fd-423a-a559-a9d7800081eb` clean (round 5).
- Live verified (CF Access, no chat unlock): served admin.js carries Adventure Time / Local food
  to try / Holiday bank; `/api/admin/server/adventure/settings` 401 (PIN-gated), unknown route
  404; world json 200; prod DB `user_version` 20 with `adv_rounds`/`adv_rejected`/`adv_settings`.
- CI on eb14931 went RED (python: 1 failed / 3985 passed): PR #342 was merged 4 s after creation,
  before any check ran (wixy main has no branch protection, and the delivery merge did not wait).
  The failure was a platform-dependent test, not product code:
  `test_the_spawn_body_is_exactly_what_the_spec_asks_for` fed `Path("D:\\Servers\\...")` and
  expected forward slashes; on Linux a backslash is a filename character, so `as_posix()` keeps
  it. Fixed in the follow-up PR from branch `adv/fix-pack-test-linux-path` (test input now
  `D:/Servers/...`, still native backslashes on Windows so the conversion stays proven).
