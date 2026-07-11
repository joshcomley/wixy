## Symptom / starting point

Slice 7 is the last of the 7 planned Uxer adoption slices (UXER-INTEGRATION.md's 9
mandatory subsystems, folded into 7 shipping units per decisions/00045): wire wixy's
admin-ui into Uxer's MCP compliance-bridge so `ui_ux_score` / `ui_ux_compliance` /
`ui_theme_analyze` / recording / element-level automation can all target the real
admin app. UXER-INTEGRATION.md's own "Web Application Integration" section (line 1862
onward) is written against a Jinja2-templated FastAPI app with a `base.html` and
`{% if request.query_params.get('uxer') %}` gate. wixy's admin isn't that shape.

## Root cause / what was decided

**1. `admin_shell.html` is a static, module-cached string — the gate had to move to
client-side JS.** `wixy_server/app.py`'s `get_admin_shell()` serves
`_ADMIN_SHELL_HTML`, read once at import time from `wixy_server/static/admin_shell.html`
— there is no per-request rendering anywhere in wixy's admin surface (confirmed by
reading `get_admin_shell`'s own docstring: "Routing is entirely client-side hash
fragments... every `/admin` sub-route the browser might deep-link to is this same
document"). The doc's `{% if request.query_params.get('uxer') %}` gate has nothing to
attach to. Rejected: restructuring `get_admin_shell` into a per-request Jinja2 render
just to support this one optional dev-tooling script — that's a real architectural
change to the admin-serving path for a feature real users never see, and
`admin_shell.html`'s whole design point (instant-render, spec/05 §1) is serving a
precomputed string with zero per-request work. Decided: reimplement the identical
guard client-side — a small `<script type="module">` at the end of the body reads
`new URLSearchParams(location.search).get("uxer")`, and only then does a **dynamic**
`import()` of the compliance bundle. Normal editor sessions (no `?uxer=`) fetch
nothing extra and run zero Uxer code; this was verified directly (see Verification).

**2. Load-event race in the dynamic-import gate — found and fixed, not worked around.**
The doc's own literal example does a **static** top-level `import {...} from '...'`
inside its module script, then `window.addEventListener('load', async () => {...})`.
Static imports inside a module script are part of what the browser's `load` event
waits for, so by the time that module's own code runs, `load` hasn't fired yet and the
listener is guaranteed to catch it. This integration deliberately uses a **dynamic**
`await import(...)` instead (see decision 1's reasoning — never fetch the ~530kb
bundle for a normal visitor), and dynamic imports are *not* part of that
load-blocking graph: the `await` yields to the event loop while the bundle fetches,
and `load` can fire (and be missed) during that gap. First verification run confirmed
this wasn't hypothetical: `bridgeConnect`/`registerAdapter` ran fine (they're called
synchronously right after the import resolves), but `runAndShow('/uxer-style.json')`
— which only runs inside the `load` listener — never fired; `style_fetched` was
false on every run until this was fixed. Fix: `runInit` now checks
`document.readyState === "complete"` (i.e. `load` already happened) and calls itself
immediately in that case, falling back to `addEventListener('load', runInit, {once:
true})` otherwise — correct under both orderings. Anyone reusing "gate an
Uxer/analytics/whatever bridge behind a dynamic `import()`" elsewhere should copy this
readyState check, not the doc's bare listener.

**3. Route/mount adaptation to wixy's real namespace.** `app.mount("/admin/static/uxer",
...)` (not the doc's literal `/static/uxer`) — placed before the existing
`app.mount("/admin/static", ...)` per the doc's own more-specific-first rule, same
adaptation pattern already used for slice 5's favicon paths. `/uxer-style.json` and
`/.uxer-web-port` stay at the bare root exactly as the doc specifies (protocol-level
paths Uxer's own tooling looks for by fixed convention, not namespaced under
`/admin/*`) — confirmed via `wixy_server/auth.py`'s `ADMIN_PATH_PREFIXES = ("/admin",
"/api/admin")` that these bare-root routes are correctly unauthenticated without any
auth-middleware change. `Uxer/` itself is cloned into the repo root and gitignored
(`.gitignore` addition, mirroring Uxer's own documented convention verbatim), built
locally via `cd Uxer/web && npm install && npm run build`. A fresh checkout or the
deployed slot simply won't have `Uxer/web/dist/` populated unless someone explicitly
builds it there — `_UXER_DIST_DIR.mkdir(parents=True, exist_ok=True)` before the mount
prevents a `StaticFiles` construction crash either way, and a missing bundle then just
404s the dynamic import — loud in the browser console **for the one person who
explicitly opted in via `?uxer=`**, invisible to everyone else. No try/catch was added
around that import on purpose: Uxer's own CLAUDE.md documents "a missing bundle is now
loud... not silent" as a deliberate design principle (P5.11), and suppressing the
failure here would just reintroduce the silent-degradation problem Uxer itself moved
away from.

**4. `uxer-style.json` — every mandatory field genuinely derived, not fabricated.**
Per-field provenance (all read from `admin-ui/src/style.css` post slice-6's contrast
fixes, or from other real, on-disk facts):
  - `color.background`/`foreground`/`accent`/`surfaces.root` ← `--wx-canvas` /
    `--wx-ink` / `--wx-brand-blue` / `--wx-surface` (light `:root` block).
  - `color.semantic.success`/`warning` ← `#16a34a` / `#d97706`, the literal (not
    custom-property-backed) colors already used by `.wx-chat-dot-ready` /
    `.wx-chat-dot-pending` for exactly this purpose (status indication) — genuinely
    present in the codebase, not invented; coincidentally identical to the template's
    own defaults. `semantic.error` ← `--wx-danger`; `semantic.info` reuses `accent`
    (wixy has no distinct info color anywhere — this mirrors the template's *own*
    convention of `info == accent` when a codebase has no separate info hue).
  - `darkMode.colors.*` ← the same properties' dark-mode values, including this
    slice's own `--wx-danger`/`--wx-muted` fixes (decisions/00049) — `success`/
    `warning` are reused unchanged because the real CSS has no dark-mode variant of
    those two literal colors either.
  - `typography.roots` sizes (18/14/13/12) ← the four font-sizes that actually
    recur across `style.css` for heading/body/secondary/label-ish text (grepped, not
    assumed); `contrast.roots.textContrast.ratio = 4.5` ← `admin-ui/src/contrast.ts`'s
    own `AA_NORMAL_TEXT` constant (the codebase's real, enforced save-gate minimum),
    not the template's unenforced AAA default of 7.0.
  - `spacing.roots` (16/12/8/20/16) and `shape.roots` (6/6/4) ← the actual, dominant
    padding/gap/border-radius values across the stylesheet. `controlRadius` and
    `containerRadius` are both 6 on purpose — wixy's real CSS has exactly one radius
    token (`--wx-radius: 6px`) used identically for buttons, inputs, and panels, so
    giving them different values would misrepresent the actual design.
  - `motion.roots.standard = 150` ← the *only* transition duration anywhere in
    `style.css` (two occurrences, both `150ms`/`0.15s`); `easing.exit`/`.standard` are
    literal CSS-spec translations of the two keyword eases actually used
    (`ease-out` → `cubic-bezier(0,0,0.58,1)`, `ease` → `cubic-bezier(0.25,0.1,0.25,1)`),
    not the template's untranslated defaults.
  - `responsive.breakpoints.medium = 720` ← wixy's one and only real `@media
    (max-width: ...)` breakpoint, where the admin layout goes mobile.
  - `identity.logo` points at `/admin/static/icon-512.png` (a real, existing asset
    from slice 5) rather than the template's default `static/uxer/logo.svg` path,
    which doesn't exist in this repo — pointing a declared field at a real file beat
    leaving Uxer's own placeholder in place.
  - Fields with no real per-tier signal to derive from (step ratios/levels for the
    generative size ramps, `elevation`'s `raised`/`overlay` tiers around the one real
    `floating` value taken from `--wx-shadow`, `identity.personality`'s 0–1 dials)
    keep the template's own generation parameters, or a plainly-reasoned qualitative
    estimate (e.g. `density: 0.5`, notably denser than the template's `0.2` default,
    reflecting the real 4–12px gap/padding survey across a genuinely dense admin
    UI) — called out here so a future agent knows which numbers are facts and which
    are judgment calls, rather than treating the whole file as uniformly measured.

**5. `ServerRenderedAdapter`'s `modules` list uses wixy's real routes.** The doc's own
example lists placeholder `home`/`about` pages at distinct URLs — wixy's admin has no
such structure (one served document, client-side hash routing, confirmed by reading
`admin-ui/src/router.ts`'s `Route` union directly). The six modules registered
(`pages`/`theme`/`media`/`chat`/`history`/`settings`) are exactly `router.ts`'s
top-level `Route.kind` values, hash-linked (`/admin#/pages` etc.) rather than
fabricated separate-page URLs.

## Verification

Wrote a scratch (uncommitted, matching this project's established
`verify_slice*.py` convention from prior slices — none of those scripts exist in the
repo either, by design) Playwright check against the real `e2e/fixture_server.py`
(port 8799, `WIXY_DEV_NO_AUTH=1`, a genuine `wixy_server.app` instance): confirmed (a)
loading `/admin` with no `?uxer=` param registers no adapter, fetches no Uxer
resources, and produces zero console errors; (b) loading `/admin?uxer=1` registers
`window.__uxerAdapter`, fetches both the compliance bundle and `/uxer-style.json`
(200), with the sole console message being the *expected* 404 from
`/.uxer-web-port` (no live MCP session in this test — exactly the documented
"absent outside an active session" case). Full project pytest suite (542 tests),
`ruff check`, `ruff format --check`, and `mypy --strict` all green after the
`wixy_server/app.py` + `admin_shell.html` changes.

Also worth recording: mid-verification, port 8799 was found already bound by a
`fixture_server.py` process from this same session's earlier slice-6 verification,
left running across the handover boundary (confirmed via its own background-task
completion notification firing later in this session). Killed it — an ephemeral,
stateless test fixture with no state worth preserving — before re-running; a future
agent hitting an unexplained "adapter never appears" result against this fixture
server should check for exactly this before assuming a code bug.

## What to watch for

- If the Uxer web bundle's public API changes (`runAndShow`/`bridgeConnect`/
  `registerAdapter`/`ServerRenderedAdapter`/`mountBridgeOverlay` signatures), this
  integration needs a matching update — there's no automated contract test against
  Uxer's own source since `Uxer/` isn't committed here.
- If `admin_shell.html` ever does become per-request-rendered for an unrelated reason,
  the client-side `location.search` gate in the bridge script should be revisited —
  it would still work, but a real `{% if %}`-equivalent server-side gate would then be
  strictly better (avoids shipping the tiny gate script itself to every visitor).
- Any other spot in this codebase (or a future one) that gates a dynamic `import()`
  behind page-load timing should use the `readyState === "complete"` pattern from
  this slice's bridge script, not a bare `addEventListener('load', ...)` — see
  decision 2.
