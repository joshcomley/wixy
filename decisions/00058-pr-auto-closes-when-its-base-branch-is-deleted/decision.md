# GitHub auto-closes (does not retarget) open PRs when their base branch is deleted

## Symptom

Three PRs were stacked: #67 (M1, base `main`) <- #69 (M3, base
`indep/m1-scaffold-config-audit`) <- #70 (M5, also base
`indep/m1-scaffold-config-audit`). #67 merged via `gh pr merge 67 --merge
--delete-branch`. Immediately after, both #69 and #70 — still legitimately open,
with real, already-in-progress review status (#69 was Fable-APPROVED) — showed
`state: CLOSED`, `mergeable: CONFLICTING` when queried.

## Wrong assumption

The expectation going in (stated explicitly in this session's own working notes
before it was tested against reality) was that GitHub "automatically retargets
pull requests based on a deleted branch to the repository's default branch." That
is not what happened here. Confirmed via the REST API directly
(`gh api repos/.../pulls/69 --jq '{base: .base.ref, ...}'`) that #69's `base.ref`
was still the literal string `indep/m1-scaffold-config-audit` — a branch that
`gh api repos/.../branches/indep/m1-scaffold-config-audit` now 404s — and its
`state` was `CLOSED`. GitHub closed the PR rather than retargeting it.

Neither recovery path GitHub normally offers works once this has happened:
- `gh pr edit 69 --base main` -> `GraphQL: Cannot change the base branch of a
  closed pull request.`
- `gh pr reopen 69` -> `GraphQL: Could not open the pull request.` (a PR can't be
  reopened against a base ref that no longer exists.)

## What actually recovers it

The PR's **branch and commits are untouched** — only the base-branch merge target
of the PR *object* was deleted, not the head branch or its history. Verified via
`gh api repos/.../branches/<head-branch> --jq '{name, sha: .commit.sha}'` before
doing anything else, confirming the exact commit SHA the earlier (Fable-approved,
for #69) review had verified was still there. Recovery is simply: open a **new**
PR from the same head branch, base `main` directly —
`gh pr create --base main --head <same-branch> ...` — and reference the old PR
number + commit SHA in its body so anyone tracing the history can follow the link.
A prior review verdict (e.g. Fable's APPROVED on the old #69) is unaffected by the
renumbering since it was a verdict on the *commit content*, not the PR number.

## Rule going forward

**Never `--delete-branch` (or otherwise delete) a branch that is the `base` of
another still-open PR.** Before merging any PR with branch deletion, check
`gh pr list --state open --json baseRefName` (or equivalent) for anything based on
the branch about to be deleted. If something is, either: merge/retarget that PR
first, or merge the current PR *without* deleting its branch until the dependent
PR has been retargeted (`gh pr edit <dependent> --base main` works fine on an
**open** PR, before the base branch disappears — it only breaks once the PR has
already been auto-closed).

This bit twice in the same session (M3's #69 and M5's #70, both stacked on M1)
purely because M1 happened to be the base of two still-open PRs at merge time —
worth checking for on every future stacked-PR merge in this repo, not just this
one incident.
