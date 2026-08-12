# 00001 [bfx6zs] Audit search indexing

## What

Audited `cottageaesthetics.co.uk` and the `ca.cinnamons.uk` staging host for search-engine crawlability, indexing signals, page metadata, structured data, redirects, internal links, assets, mobile performance, and public search visibility.

## Outcome

The public site is technically indexable: its robots file, nine-URL sitemap, status codes, canonicals, unique page metadata, HTTPS redirects, crawlable HTML, internal links, and assets all passed. A Google verification TXT record is present. Public search sampling did not yet surface the new site, which is unsurprising immediately after the August 2026 cutover and must be confirmed in Search Console.

Priorities found: submit and inspect the sitemap in Google Search Console and Bing Webmaster Tools; add direct permanent redirects for the meaningful old Wix paths; stop combining a crawl block with page-level `noindex` on staging; improve mobile image delivery (especially the 13.6 MiB gallery); add `WebSite` and `LocalBusiness` JSON-LD plus an explicit favicon; and create focused treatment pages for stronger query coverage. A Wixy change merged after the last public build already adds fuller social-preview metadata on the next publish.

## Relevant files and commits

- Production site: `https://cottageaesthetics.co.uk/`
- Staging site: `https://ca.cinnamons.uk/`
- Engine indexing configuration: `projects/ca.json`, `builder/sitemap.py`, `builder/templates.py`
- Social-preview enhancement already merged: `d318cd4`

## Links

- Operator request and full evidence-backed report in cmd workspace 00027.
