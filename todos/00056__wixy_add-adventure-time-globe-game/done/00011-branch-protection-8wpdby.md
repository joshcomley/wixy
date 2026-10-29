# 00011 [8wpdby] wixy main branch protection

Operator decision #2123 (2026-10-28): "Yes, turn it on". Required status checks on main:
python, frontend, e2e, guide-linkcheck, release-note, image-boot-proof; strict=false (no
"branch must be up to date"); no required reviews; not enforced for admins. cmd's merge
route answers a protected-repo refusal with a retryable 409 merge_awaiting_checks.
Order: after PR #343 (green main) and the guide link-check PR (decisions/00193) merge.

**Done 2026-10-28 ~22:59Z.** Protection enabled on main exactly as above. PR #357 (00017) was the first change gated by it.
