# Settings > Contact tab + real Get In Touch (no more fake form) — DONE

The operator, looking at the live Contact page: "I don't believe [the contact form] would
be wired up to anything because this is going to run as a GitHub Pages page... it should
just [give] the email address and phone number... and the address of the company... AND
THE EMAIL ADDRESS SHOULD BE STORED IN A SETTINGS TAB IN WIXY AS THE CONTACT EMAIL AND THE
SAME WITH THE CONTACT PHONE NUMBER AND THE SAME WITH THE CONT[ACT] ADDRESS."

## What shipped

New `GET /api/admin/global` route (a direct sibling of `GET /api/admin/theme`) + a new
**Settings > Contact** admin tab where the owner edits phone/email/address in one
discoverable place — `content/_global.json`'s phone/email/address were already a single
shared source every page referenced, the only gap was no admin UI to edit them. Address
renders as a `<textarea>` with `\n <-> <br>` conversion (decisions/00075's convention).
Companion site-repo change: removed the Contact page's non-functional "send a message"
form (never wired to real email delivery — its own copy admitted it was a demo) and
promoted phone/email to prominent Call/Email cards. Full rationale: wixy decisions/00127,
site decisions/00014.

- wixy engine PR #180 (merge `04828610a9b47ce3dfd2d18477196a3d904a6a20`)
- site repo PR #33 (merge `39785a76748a405b79ca3578b2bd8a7e4a7c4443`)
- Published v48 (sha matches site main tip); live-verified.

## A real HIGH-severity bug caught by the planner's FINAL HANDOFF, not by me

First draft committed only the DISPLAY keys (`phone`/`email`) on change. `_global.json`
stores the actual clickable `tel:`/`mailto:` target as a SEPARATE key each
(`phoneHref`/`emailHref`) — every real link on the site (footer, the new Call/Email
cards) binds `data-wx-href="@phoneHref"`/`"@emailHref"` independently of the `data-wx`
text binding. Editing phone/email through the tab exactly as intended would have
silently stranded every real link at the OLD contact, forever, with no error anywhere —
the actionable half of the feature desyncing from the visible half on first use. Green
CI on both PRs did NOT catch this; it only surfaces when reading the diff against what
the site actually binds to.

Fixed: `ContactFieldConfig.hrefKey`/`hrefKind` + an exported pure `deriveContactHref`
make `commit()` enqueue both keys in the same batch and Reset discard both then reload
the whole tab from the server (which also fixed a lower-severity gap: Reset previously
restored the value on screen at mount, not the true post-discard server state). New
reproduction-invariant unit test: deriving from the real seeded `_global.json` values
reproduces the real stored hrefs byte-for-byte. e2e extended to prove both keys persist
together through a real publish and revert together on Reset. Second FINAL HANDOFF round
cleared 0 critical/0 high — the planner independently verified the fix at the diff level
before clearing it.

Also caught along the way: origin/main moved (an unrelated GitHub Pages go-live feature,
workspace 00023) while this was in flight, colliding on decision numbers (wixy 00126,
site 00013) — renumbered to 00127/00014, rebased both branches cleanly, no functional
overlap.

## Live verification (real production, both surfaces now that 00023's Pages deploy exists)

- `ca.cinnamons.uk/contact.html`: form confirmed gone, Call/Email cards present,
  `href="tel:07401562462"` correct (email link CF-edge-obfuscated as expected).
- `https://joshcomley.github.io/cottage-aesthetics-preview/contact.html` (the GitHub
  Pages mirror): same content, unobfuscated `href="mailto:cottageaestheticshartlebury@
  gmail.com"` also correct. Custom domain DNS cutover (`WIXY_PUBLIC_DOMAIN=
  cottageaesthetics.co.uk`) is set but not yet the live Pages cname — separate,
  unstarted, out of scope here.
- Admin round-trip against real production via direct API calls (same op shape the UI
  sends): staged `phone`+`phoneHref` together, confirmed both landed in one PATCH;
  discarded both, confirmed both reverted to the real values; final `draft.opCount==0` —
  no real contact-detail change left published.

## What to watch for

- The phone/email <-> phoneHref/emailHref derived-pair invariant (decisions/00127) is
  the load-bearing fact of this whole tab — any future field added to `CONTACT_FIELDS`
  with a real link elsewhere needs its own `hrefKey`/`hrefKind` from day one.
- `e2e/tests/section-panel.spec.ts`'s "align a photo pair" test failed a 3rd time during
  this feature's local verification, now under measured 100.0% CPU contention (was
  89.7%) — GitHub's own pinned CI runner stayed green on this exact test throughout,
  including both PR candidate SHAs. Pre-existing, timing-sensitive, not a regression;
  recorded in decisions/00127; planner agreed not to loop on it further. A genuine
  follow-up candidate if this box's contention keeps recurring.
