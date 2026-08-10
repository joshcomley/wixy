# Decision: Settings > Contact tab, and retiring the non-functional contact form

## Symptom

The operator, looking at the live Contact page: "Does the remove button have a themed
confirmation pop-up?" led into the real question — "I don't believe [the contact form]
would be wired up to anything because this is going to run as a GitHub Pages page, it
won't be on to send out any emails not without exposing a key in JavaScript." The
premise was checked, not assumed: this deployment is NOT GitHub Pages (it's the real
Wixy engine, a Python backend, confirmed live all session) — but the conclusion was
right anyway. The form's own copy admitted it: `content/contact.json`'s `form.thanksText`
said "(Demo preview: live email delivery is wired up when the site goes live.)" — that
never happened. Real server-side email delivery was possible but out of proportion: a
new unauthenticated public POST endpoint, SMTP credentials, spam/abuse protection, for a
small clinic site where a phone number and a mailto: link already do the job. The
operator's own fallback ask matched exactly: replace the form with clear phone/email/
address, and store those three centrally with a dedicated place to edit them.

## What was decided — Settings > Contact, not a new top-level concept

Investigation found most of the "single source of truth" requirement ALREADY true:
`content/_global.json` already held `phone`/`email`/`address`, and every page
referencing them (`footer.html`, `index.html`, `contact.html`) already used the SAME
`@phone`/`@email`/`@address` global bindings — never hardcoded per-page. The inline
overlay editor already wrote edits back there correctly
(`opTargeting.directOpTarget`, `@key` -> `{file:"_global", path:key}`). What was
missing was a DISCOVERABLE place to edit them — she'd otherwise have to know to click
the text directly on some live page.

A `router.ts` `SettingsPage` framework already existed (`general`/`appearance`/
`shortcuts`/`engine`/`ai`/`system`, spec/independence/04-06) with a real tab strip
(`settingsPanel.ts`) mixing local-only tabs (theme mode, zoom — browser prefs) and
server-backed tabs (Engine/AI/System status). Adding a NEW `"contact"` tab there —
rather than inventing a separate top-level "Settings" concept, or overloading the
UNRELATED `general` tab (which is about the ADMIN APP's own preferences, not site
content — mixing the two would be a category error) — reuses the existing route,
tab-strip, and panel-mount plumbing entirely. This is the first tab in that panel to
WRITE server content via `opQueue`/draft ops (every sibling tab is either local-only or
read-only status); `SettingsPanelDeps.opQueue: OpQueueLike | null` threads it through,
mirroring `shell.ts`'s existing "theme" route null-guard rather than gating the whole
settings route (which would regress the OTHER tabs' load speed for one tab's need).

## What was decided — `GET /api/admin/global`, the missing read-side counterpart

The draft-op WRITE side already treated `_global` as an ordinary `file` bucket
(`file: "_global"` PATCH ops already worked, confirmed by test before writing any new
code). The READ side had no equivalent: `GET /api/admin/content/{page}` looks up
`merged.page_contents[slug]` (real page slugs only) and also returns a `bindings` map
that has no meaningful equivalent for `_global` (a binding means "this ONE page's
template uses this key"; `_global` keys are referenced from arbitrary, unbounded pages).
A new `GET /api/admin/global` — a direct sibling of the existing `GET /api/admin/theme`,
same shape of problem (one non-page-slug content bucket) — is the missing counterpart,
not a new concept. An untouched `_global.json` reads as `{}` (200), never a 404: unlike
`theme` (optional, absent on pre-migration checkouts), `_global.json` always exists once
a site is migrated, and an empty object is a normal, valid state.

## What was decided — the address field is a `<textarea>`, not a plain text input

`_global.json`'s `address` stores a literal `<br>` for its one line break (the
plain-text-render-ready-HTML convention, decisions/00075) — editing that as a raw
single-line text input would show her a literal `"<br>"` she'd have to understand and
never accidentally break. A plain `<textarea>` where each line she TYPES becomes one
`<br>` on save is the honest UI for a short multi-line address:
`addressToTextareaValue`/`textareaValueToAddress` (`settingsPanel.ts`, exported for
direct unit testing) are the whole of that translation — decode `<br>` to `\n` for
display, join non-blank trimmed lines with `<br>` on save.

## What was decided — the Contact page: remove the form, promote phone/email

`pages/contact.html`'s "Send a message" form (name/email/phone/message/consent
checkbox, a fake client-side-only "Thank you" with no real submission) is removed
entirely, along with its now-dead `content/contact.json` `form.*`/`formIntro.*` keys and
`site.css`'s now-unused `.cform` rules. The page's single remaining content column
("Get in touch") keeps everything the info column already had (address, parking note,
hours, socials, Book Online) and adds two prominent CALL/EMAIL cards at the top — the
SAME `@phone`/`@email` bindings the plain text links below already used, just given
visual priority since they're now the page's primary action instead of a fallback
next to a form. `pageHero.tag`'s "Send a message, call, or book online" also updated
(a stale reference to the removed form) to "Call, email, or book online."

## What was decided — the phone/email <-> phoneHref/emailHref DERIVED PAIR contract

**Caught by a FINAL HANDOFF review before merge, not self-found**: the first draft of
this tab committed only the DISPLAY keys (`phone`/`email`) on change. `_global.json`
stores the actual clickable `tel:`/`mailto:` target as a SEPARATE key each
(`phoneHref`/`emailHref`) — `footer.html`'s link and the site repo's Contact-page
Call/Email cards both bind `data-wx-href="@phoneHref"`/`"@emailHref"`, independently of
the `data-wx="@phone"`/`"@email"` text binding on the same or a sibling element. A
display-only commit would silently strand every real link at the OLD contact, forever,
the moment she used this tab exactly as intended — the actionable half of the feature
desyncing from the visible half on first use, with no error anywhere to surface it.

Fixed by making the derivation a config-level fact (`ContactFieldConfig.hrefKey`/
`hrefKind`, `settingsPanel.ts`) `commit()` and Reset both apply uniformly, not a
one-off: on commit, `phone`/`email`'s new display value ALSO derives and enqueues its
paired href in the SAME batch (`deriveContactHref`, exported pure function — phone
formatting stripped to bare digits with a genuine leading `+` preserved, e.g.
`"07401 562 462"` -> `"tel:07401562462"`; email prefixed `"mailto:"` as-is; a blank
display yields a blank href, never a bare scheme). `address` has no href pair —
`hrefKey`/`hrefKind` are simply absent from its `CONTACT_FIELDS` entry, so `commit()`'s
`if (config.hrefKey !== undefined)` guard skips it entirely, no special-casing needed.

Reset was ALSO upgraded as part of this fix: it now discards both keys of a pair, then
`await`s `opQueue.flushNow()` and reloads the whole tab from `GET /api/admin/global`
(`load()`, re-invoked) rather than resetting the input locally to whatever value was on
screen at initial mount. This closes a second, lower-severity gap the same review found:
this tab reads DRAFT-merged content, so the locally-remembered "original" value could
already be stale relative to what a discard actually reverts to — reloading from the
server after the round-trip is the only way "Reset" is guaranteed accurate.

**The invariant that must never regress**: display and href can never move independently
through this tab. Any FUTURE field added to `CONTACT_FIELDS` that has a real link
elsewhere on the site needs its own `hrefKey`/`hrefKind` from day one — the unit test
suite's reproduction-invariant test (`settingsPanel.test.ts`, deriving from the real
seeded `_global.json` values and asserting a byte-for-byte match against the real stored
hrefs) is what would catch a regression here, not a general "does it render" check.

## What to watch for

- **`e2e/tests/section-panel.spec.ts`'s "align a photo pair" test is a pre-existing,
  timing-sensitive flake under real CPU contention on this shared dev box — NOT caused
  by this feature.** Observed failing 3 separate times across this feature's development
  (two different failure modes: a dialog-close timeout, a publish-endpoint non-200) —
  every occurrence correlated with `read-cpu`-measured heavy contention (89.7% then,
  100.0% most recently) from an unrelated process on the box, and the SAME test passed
  cleanly both in isolated local re-runs once contention eased AND on GitHub's own
  pinned `ubuntu-latest` CI runner every time (which doesn't share this box's local
  contention) — including the run that gated this PR's own merge. Its own code comments
  already acknowledge tight timing assumptions ("on localhost the whole bake→upload→
  stage chain can complete within one Playwright tick"). Deliberately not fixed as part
  of this feature — a pre-existing test's timing robustness is separate work. If it
  fails again locally: check `read-cpu` first: contended → sufficient explanation, don't
  loop on re-investigating; CI is the authoritative gate and has been green throughout.
- Any future page that needs to show phone/email/address should reference `@phone`/
  `@email`/`@address` (or `@phoneHref`/`@emailHref`) — never hardcode a fresh copy. This
  was already the convention before this change; nothing new to remember, just don't
  regress it.
- **The phone/email <-> phoneHref/emailHref pair above is the load-bearing invariant of
  this whole tab** — see the dedicated section above before touching `CONTACT_FIELDS` or
  `commit()`/Reset again.
- If a genuine real-time contact-form need arises later (e.g. the operator wants actual
  form submissions, not just click-to-call/email), that's a materially different,
  security-sensitive feature (a public unauthenticated endpoint sending real email) and
  should get its own design pass — not a reason to second-guess THIS decision, which was
  scoped to "the form currently does nothing and shouldn't pretend to."
- `renderContact`'s error-message extraction (`err instanceof Error ? err.message : …`)
  is the CORRECT pattern already used by `renderEngine`/`renderSystem` in this same
  file — `renderAi` still has the older, slightly uglier `String(err)` pattern (an
  existing, low-severity, unrelated inconsistency noticed but deliberately left alone
  here to keep this change scoped).
