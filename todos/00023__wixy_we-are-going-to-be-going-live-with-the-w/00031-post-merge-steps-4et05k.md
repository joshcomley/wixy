# 00031 [4et05k] post-merge operational steps (brief §6)

Full context: sidecar 00017.

## What (in order, only after clearance + both merges)

1. Confirm Slots deployed engine (`curl http://127.0.0.1:9380/api/version` → sha matches
   merge commit); confirm resolver live on OLD build (`/about`→200, `/about/`→404,
   `/about.html`→200 on ca.cinnamons.uk).
2. Operator-sanctioned Pages redeploy: check if a Purdi publish already moved things
   (`git ls-remote origin wixy-live` vs sha in `D:\Servers\Wixy\Storage\projects\ca\live.json`,
   read-only) — skip dispatch if already clean-URL. Else
   `gh workflow run pages.yml --ref main -R joshcomley/cottage-aesthetics-preview` (PowerShell,
   full gh.exe path), watch to green.
3. Verify deployed Pages site: canonical shapes, nav hrefs extensionless, sitemap.xml
   extensionless, `/about`→200, `/about.html`→200, `/about/`→404. Footer/CTA content links
   remain `.html` until Purdi's next Publish — expected, note in DONE report.
4. Run workspace `verify` skill against ca.cinnamons.uk — green required.
5. Record operator's question in cmd Answers log (`answers` skill) — quote verbatim,
   answer-first.
6. Mark todos done.
