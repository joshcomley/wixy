# 00012 [mvta5o] M12 CA — Cutover

## What
Point Wixy's project checkout at CA main, first real publish from the admin, retire GH
Pages (`deploy.yml`, `.nojekyll` removed), README updated with new home; reword the
contact page's "Demo preview: live email delivery…" line to match reality.

## Why
The moment ca.cinnamons.uk becomes the real, owner-operated live site instead of a build
target no one has pressed Publish on yet.

## Context / current state
Depends on 00011 (install & deploy) being live, and 00003-00005 (CA migration) fully
merged to CA main.

## Relevant files
- spec/03-site-migration.md §3 step 5 (deploy.yml two-phase retirement)
- spec/07-hosting-deploy.md (deploy target)
- spec/09-work-plan.md row 12 (exact deliverable text incl. contact page wording note)

## How to continue + acceptance
**MILESTONE 12 IS COMPLETE.** All five spec/09 row-12 deliverables done and verified for
real:

1. Wixy's project checkout at CA main — already true from M11's `install.py` clone
   (verified: `Storage\projects\ca\repo` HEAD == `origin/main` HEAD, both `0b648b9`
   before this session's publish).
2. First real publish from the admin — driven via the real `/api/admin/*` HTTP surface
   through the live Cloudflare edge (not the browser UI directly — see decisions/00042
   for why: the allow-listed operator email for OTP login isn't a mailbox this session
   has IMAP access to, and the documented fleet service-token file/script paths were
   stale on this box). Used Loom's own already-active CF Access service token
   (additively policy-attached to the Wixy Admin app, existing policy untouched) to
   PATCH the draft then POST publish for real: `bootstrap` v0 → `editor` v1, sha
   `f79b056`, tag `wixy-publish-v1`. **The full click-through-the-browser UI drill is
   spec/08 §4's own explicit M13 acceptance item ("a real text edit → publish → live
   change → restore") — deliberately not duplicated here; M13 owns proving the
   admin-ui/editor frontend against the live deploy specifically.**
3. Retire GH Pages — `deploy.yml` + `.nojekyll` deleted, CA repo PR #15, merged.
4. README added (previously absent) pointing at ca.cinnamons.uk as the new home, old
   Pages URL noted as intentionally stale — same PR #15.
5. Contact page wording fix — same publish as #2 (`content/contact.json`
   `form.thanksText`), old "Demo preview: live email delivery…" replaced with honest
   copy directing to phone/email (spec/00's non-goals confirm no delivery backend is
   ever coming in v1). Full before/after + reasoning in decisions/00042.

Verified for real, not just trusted from a 200: live public `/contact.html` (cache-busted,
through the edge) shows the new text; the real `cottage-aesthetics-preview` GitHub repo's
`main` branch (via `git ls-remote`, not just the Storage checkout) advanced to `f79b056`;
ledger (`GET /api/admin/publishes`) shows both versions correctly with v1 live.

`indexable` stays `false` (07 §5 — Wix remains canonical until a later, separate
real-domain cutover decision; explicitly out of scope here).

Next: milestone 13 (live verification + polish) — spec/08 §4's full checklist including
the interactive edit→publish→restore drill this entry deliberately deferred, Lighthouse,
`verify` skill evidence, final docs/decisions sweep, acceptance list, and the
`@pytest.mark.live_cmd` smoke test.

## Links
PR (CA repo, GH Pages retirement + README): https://github.com/joshcomley/cottage-aesthetics-preview/pull/15 (merged f638a27)
PR (wixy repo, decisions + todos): (fill in when opened)
