# Decision: go-live guide's Part 2 must move the domain off Wix's nameservers first

## Symptom

Round 2 (decisions/00128) flagged, but didn't fix, a discovery from its own production check:
`cottageaesthetics.co.uk` still resolves through Wix, not Name.com. Re-measured fresh at the
start of this round (2026-08-10, `Resolve-DnsName ... -Server 8.8.8.8`, not a cached view) and
unchanged: NS = `ns0.wixdns.net` / `ns1.wixdns.net`, SOA primary `ns0.wixdns.net` / admin
`support.wix.com`, apex A = `185.230.63.{107,171,186}` (Wix's range), `www` CNAME →
`cdn1.wixdns.net`. The domain's nameservers were never switched away from Wix, so **Wix's DNS
zone, not Name.com's, is authoritative for the whole domain** — both the apex and `www` still
serve the old Wix site to real visitors.

`docs/go-live-github-pages.html`'s Part 2 told the operator to add A/AAAA/CNAME records on
Name.com's DNS Records page. While the nameservers point at Wix, that page has **zero live
effect** — the records would sit there, correctly entered, doing nothing, with nothing in the
guide's main flow explaining why. Worse, the guide's pre-existing "Using a different
nameserver?" callout anticipated a generic third-party case (e.g. Cloudflare) and told the
reader to "make these same DNS edits at *that* provider instead" — applied literally to the
measured Wix state, that instruction points exactly the wrong way: editing DNS inside Wix's own
manager would *work* (Wix is authoritative), but would permanently keep the site dependent on
Wix, which is the opposite of the entire point of this go-live effort.

## What was decided — a new first step in Part 2: take the nameservers back from Wix

Added "First: take the domain's DNS control back from Wix" ahead of the existing "remove
anything that conflicts" / "add these records" steps (now "Next" / "Then", for a First → Next →
Then read order). It states the measured fact plainly (dated), explains *why* the records below
currently do nothing, and walks the reader to Name.com's **Nameservers** section to switch back
to Name.com's own defaults — worded to tolerate UI label variance ("look for wording like
&hellip;"; not a claimed-verified exact button path) since Name.com's own interface text wasn't
independently verified pixel-for-pixel.

Framed as the actual switchover moment: once the nameserver change spreads, the old Wix site
stops resolving at the domain — that's the whole point, not a side effect to be surprised by.
Told to happen in the same sitting as adding the records, so the new site takes over rather than
the domain going dark in between. A reassurance line closes the step: the domain registration
itself lives at Name.com, untouched by anything at Wix, so the Wix subscription can be cancelled
once the new site is confirmed live, with no risk to domain ownership.

A sequencing note follows: the DNS records further down the page can (and should) be staged at
Name.com immediately, in the same sitting, without waiting for the nameserver switch to
propagate — Name.com accepts the record edits regardless, they simply start working once the
switch has spread.

## What was decided — the "different nameserver" callout now names Wix and warns against editing there

Rewrote the callout to reference the new first step directly for the (now-confirmed) Wix case,
and to explicitly warn against making the DNS edits inside Wix's own manager as an alternative —
doing so would "work" in the narrow technical sense but defeats the purpose of this whole guide.
Kept one generic sentence for a genuine, deliberate third-party nameserver (e.g. Cloudflare)
other than Wix. Added a matching troubleshooting row ("you added the records but nothing
changed" → nameservers still Wix's → check with `nslookup -type=NS`, redo the step) and a Part 4
checklist item (the old Wix site no longer appearing is expected, not a bug).

## What was discovered — the new troubleshooting row overflowed the page on its own

The new troubleshooting-table cell embeds a full `nslookup -type=NS cottageaesthetics.co.uk
8.8.8.8` command in inline `<code>`. The stylesheet's `code { white-space: nowrap; }` is
deliberate elsewhere (e.g. `.records-table`'s IP/CNAME values, which look wrong split
mid-address) — but inside a narrow three-column table cell, an unbreakable ~50-character
command is wider than the column's share of the page's 760px content width, and a `table {
width: 100%; }` with `table-layout: auto` grows past its container to fit unbreakable content
rather than clipping it. Caught by rendering the guide in headed Chrome (system channel,
`headless: false`) at 900px and seeing the table's right edge cut off mid-character; confirmed
mechanically with an element-boundary scan (`getBoundingClientRect` vs viewport width) at
1400px/390px. Fixed at the root — scoped `white-space: normal; word-break: break-word` to
`code`/`.domain` inside any `<table>` that isn't `.records-table` — rather than rewording the
troubleshooting cell to dodge the bug; re-scanned afterward and confirmed the new row no longer
appears in the overflow list at any tested width. The same element scan at 390px still lists
five **pre-existing** long-URL `<code>` spans (Part 3's TXT-record command, four of Part 4's
checklist URLs) that already overflowed a narrow mobile viewport before this round, untouched by
this change and out of scope for a DNS-delegation fix.

## What was decided — correct round 1/2's overstated verification claim

decisions/00126 recorded "production health confirmed... GitHub Pages deployment verified
end-to-end" — true for what it checked (the built pages' own domain-stamping: canonical link,
sitemap, robots.txt, all correctly emitted for `cottageaesthetics.co.uk`), but read as though it
covered real-world DNS resolution to that domain, which it didn't measure. Appended (not
rewrote) a correction paragraph to decisions/00126 pointing here, per the standing append-only
audit-trail convention for decision entries.

## What to watch for

- This entry's DNS numbers are a point-in-time measurement (2026-08-10). The guide itself
  doesn't hardcode "today's" state as permanent fact — its new step tells the reader how to
  check the live state themselves (`nslookup -type=NS`) — so once the operator completes the
  nameserver switch, the guide keeps working unmodified; nothing here needs to be revisited
  purely because time has passed.
- The pre-existing mobile overflow on Part 3/Part 4's long `<code>` URLs (see above) is real and
  unfixed — a minor, separate responsive-design gap, deliberately left alone since fixing it is
  outside this round's DNS-delegation scope. Worth a dedicated docs-polish pass if the operator
  wants the guide fully clean on a phone.
- If a future edit touches the troubleshooting `<table>` or adds new inline `<code>` inside it,
  the `table:not(.records-table) code` wrap rule already covers it — no new CSS needed. If a
  future edit adds a long unbreakable string inside `.records-table` instead, that table's
  `white-space: nowrap` is unchanged and deliberate; don't blanket-remove it fleet-wide to "fix"
  a different table's problem.
