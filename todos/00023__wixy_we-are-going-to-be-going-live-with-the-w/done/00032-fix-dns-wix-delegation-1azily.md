# 00032 — Round 3: fix go-live guide for Wix DNS delegation

Planner session 74703766-f2a8-4255-aafd-430ff10ba9a4. Docs-only round, one wixy PR, branch
`fix/domain-dns-still-on-wix` off `origin/main` @ e21c46e.

## Discovery (round 2 flagged it; round 3 fixes the guide)

Measured 2026-08-10 via `Resolve-DnsName ... -Server 8.8.8.8` (re-measured fresh at the start
of this round, unchanged): `cottageaesthetics.co.uk` NS = `ns0.wixdns.net` / `ns1.wixdns.net`
(Wix), SOA primary `ns0.wixdns.net` / admin `support.wix.com`, apex A = `185.230.63.{107,171,186}`
(Wix's range), `www` CNAME → `cdn1.wixdns.net`. The domain's nameservers were never switched
away from Wix, so Name.com's own DNS Records page (Part 2 of the guide) is not authoritative —
edits there have zero effect while this is true. Visitors to the real domain still see the old
Wix site.

## Scope (brief §2)

- `docs/go-live-github-pages.html`: new "take DNS back from Name.com's control" step 0 inside
  Part 2, a sequencing note, rewritten "different nameserver" callout, a troubleshooting row, a
  Part 4 checklist item.
- New `decisions/00129-.../decision.md` + an appended correction paragraph on
  `decisions/00126-github-pages-go-live/decision.md` (append-only).
- Answers Q-005 amended in place after merge (not before — the guide fix has to exist first).

## Plan

1. Branch off main (done — `fix/domain-dns-still-on-wix` @ e21c46e).
2. Edit the guide (6 sub-edits per brief §2.A).
3. Decisions entry 00129 + append to 00126.
4. Visual check in headed Chrome.
5. Quality gates (ruff/mypy/pytest — unaffected but CI runs them), push, PR, `Release-note:`
   trailer.
6. FINAL HANDOFF to planner; merge only after `FINAL HANDOFF CLEARED` naming the exact SHA.
7. Post-merge: amend Q-005, confirm worktree pulls merged main so the raw-fs link serves the
   updated guide, close todos, POST-RELEASE DONE REPORT.

## Outcome — DONE

wixy PR #185 (https://github.com/joshcomley/wixy/pull/185), candidate 419248b, merged as
478ff5d. FINAL HANDOFF cleared by planner (0 critical/0 high) before merge. All 6 CI checks
green (e2e, frontend, guide-linkcheck, image-boot-proof, python, release-note); local
ruff/mypy/pytest also green (1134 passed). Self-found + fixed a table-overflow CSS bug
introduced by the new troubleshooting row (see decisions/00129). Worktree fast-forwarded to
origin/main (tree already matched — merge commit introduced zero extra diff); raw-fs link
verified serving the merged file (HTTP 200, all five new-content markers present). Answers
Q-005 (internal id 247) amended in place, twice — first pass wrongly collapsed the
answer/detail field split, second pass corrected it; final render is clean and matches the
entry's original structure.
