# Review & publish drawer: dropped CSS rule, revalidation persistence, layman wording, kind resolution

## The ask (operator, 2026-07-21)

"When I click the '6 changes' button, on desktop and mobile, it's a mess,
layout wise. Also on desktop, when I am on the changes view, then I change
Chrome tab and go back, it goes back out of the changes view. Also, the
wording isn't very easy for a total layman to understand ('upstream' etc.).
Does this mean we have unpublished changes?"

## Root causes (four, one per symptom)

**1. The "mess": a stray CSS fragment made browsers drop `.wx-drawer`
entirely.** `admin-ui/src/style.css` had an orphaned

```
  border: none;
  display: block;
}
```

sitting between `.wx-preview-iframe{...}` and `.wx-drawer{...}` (a botched
partial edit). esbuild bundled it faithfully, and per CSS error recovery the
browser consumed the fragment plus `.wx-drawer` as ONE qualified rule whose
selector (`border: none; display: block; } .wx-drawer`) is invalid — so the
drawer's real block was discarded with it. Every other `.wx-drawer-*` rule
survived (they parse as fresh rules after the discarded block), which is why
the drawer still laid out its header/body/diff rows but had no positioning,
no z-index, and a transparent background: it rendered in normal flow with the
nav and topbar bleeding through — on every viewport. Fix: fragment deleted.
Regression pin: `builder/tests/test_admin_css_integrity.py` scans the source
(negative brace depth / declaration-like preludes) — jsdom never applies CSS,
so only a source scan catches this class. (First attempted as a vitest with a
`?raw` import: vitest stubs `.css` imports to EMPTY modules in jsdom, so the
test silently scanned nothing — the scan lives in pytest instead, where file
reads are natural.)

**2. Tab-switch exits the changes view: the revalidation remount closed the
drawer.** `visibilitychange` (and the 60s interval) calls `revalidate()`,
which re-renders the mounted pages panel via `mountPanel(activeRoute)` — and
`mountPanel` opened with `closeDrawer()`. So on the pages route the publish
drawer was destroyed every ≤60s and on every tab return; the tab switch just
made it immediate. Fix: `mountPanel(route, { preserveDrawer })` — the two
same-route background-refresh call sites (revalidate, refreshPagesPanel) pass
`preserveDrawer: true`; genuine route changes still close the drawer. This is
also why it mattered that the drawer is appended to the shell container, not
`main` — a remount of `main` needn't touch it.

**3. Jargon: "6 changes · 2 upstream commits".** The chip is the one place a
non-developer should be able to answer "is anything not live yet?". Reworded:
`N unpublished changes` (+ ` · M updates waiting` when commits are ahead of
the published SHA). The drawer gained a one-line intro ("Nothing below is on
your live website yet…"), the upstream box is now "N updates waiting to go
live" with a plain-English note ("Made outside this editor… included
automatically when you publish") above the technical commit list, and diff
group labels map `_global → Site-wide`, `index → Home` (raw slugs stay for
other pages). Technical docs (`docs/ai/*`, spec) keep "upstream commits" —
that's agent-facing vocabulary for the mechanism.

**4. The hours diff rendered as a raw JSON dump.** Two stacked causes:
(a) templates spell global bindings `@hours` while overlay ops/diff paths use
the bare content key `hours`, so kind resolution missed; (b) deeper,
`binding_kind_lookup` synthesised the `_global` kinds map by copying the
FIRST SORTED page's bindings on the theory partials make every global binding
visible on every page — false in the real content repo (`@hours` is bound on
contact+index only, not about), so `_global` lacked `@hours` entirely.
Fix: `_global`'s map is now the UNION of every page's `@`-prefixed bindings,
and a new `binding_kind_for` helper (used by both the publish preview and the
version diff) retries `_global` misses with the `@` spelling. `draft_sanitize`
already bridged this gap its own way; the two diff producers now share one
helper. Result: the hours row renders "7 item(s)" like every other list.

## Answers for the operator

Yes — the pill means there is unpublished work: your own edits-in-progress
(the count of changes) plus updates made outside the editor (the "updates
waiting"). Nothing on it is on the live site until Publish.

## What to watch

- The bundle drift check (CI: fresh `npm run build` must match the committed
  `wixy_server/static/admin/*`) means any `admin-ui/src/*` edit must rebuild
  and commit the bundle in the same PR — as this one does.
- The CSS integrity scan is a source scan, not a renderer: it catches brace
  imbalance and declaration-like preludes, not every conceivable malformed
  rule. If the stylesheet ever gains a legitimately weird construct
  (e.g. `;` inside an attribute-selector string), the string-stripping in the
  scan is what keeps it a non-false-positive — extend that, don't disable.
