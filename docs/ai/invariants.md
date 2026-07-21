# Invariants

Numbered, load-bearing rules the engine depends on. **Known exceptions are listed next to
the invariant** — there are no silent carve-outs. Cross-referenced from
[CLAUDE.md](../../CLAUDE.md) and the deep-dives. When you add or change one of these, update
this file and the code together.

### Inv 1 — Engine is generic over projects; no site-specific literals
No `cottage`/`ca`-specific string literals in `builder/` or `wixy_server/` code paths.
Everything site-specific lives in the site repo + `projects/ca.json`. All *state and paths* are
per-slug (no code hardcodes a slug), so a future multi-project deploy is not precluded.
*Enforced by:* `test_uses_cmd_project_from_registry_not_hardcoded` and the registry design.
*Known exception / scope (important):* **v1 serving is single-project by construction.**
`app.py:create_app` raises `RuntimeError` unless exactly one project is registered, and the
public routes (no slug in the path), the admin UI, `app.state.publish_job`, `tree_lock`, the
upstream watcher, and the single `WIXY_CF_ACCESS_AUD` are all single-project. "Nothing may
assume one project" holds for the **builder/state** layer — the **serving** layer *does* assume
exactly one (per-slug state is future-proofing, not active multi-tenancy). Tests and fixtures
may name `ca`/the mini-site.

### Inv 2 — Frontend bundles are committed; CI fails on drift
`wixy_server/static/{admin,editor}/*` are built by esbuild and **committed**. After touching
`admin-ui/src` or `editor/src` you must `npm run build` and commit the regenerated output;
CI runs `git diff --exit-code -- wixy_server/static` and fails on any difference.
*Exception / subtlety:* `.gitattributes` forces `* text=auto eol=lf` specifically so a
Windows-built sourcemap's `sourcesContent` doesn't differ from CI's Ubuntu build (decisions/
00016). Never revert that.

### Inv 3 — `data-wx-*` is strict: a missing key fails the build
Every binding key must exist in the JSON; the builder raises `BuildError` (build) or records
a `binding-error` (validate) on a missing key — no silent fallback to template text.
*Exception:* unbound literal text is allowed for pure structure/decoration (e.g. `❦`,
`★★★★★`) — and even those should be bound if trivially possible (`spec/02` §2).

### Inv 4 — Build output is deterministic
`build(templates, content, theme)` is a pure function; `hash_output_tree` must be stable.
`content.write_json_canonical` = 2-space indent, `sort_keys=True`, `ensure_ascii=False`,
trailing `\n`; all outputs written UTF-8 `newline="\n"`; `build_nav` sorts by
`(navOrder, slug)`; sitemap sorts slugs; `generate_fonts_url` sorts+dedupes weights.
*Exception:* the generated Google-Fonts URL need not byte-match the hand-written one — parity
gates *rendering*, and tests must not assert the URL string (`spec/02` §4).

### Inv 5 — The builder tolerates a partially-migrated site
`SiteSource.theme` may be `None`; any page's content may be `{}`. With no theme, no
`theme.css` is emitted and `apply_head` leaves the page's existing fonts `<link>` untouched
(never overwrites it with a font-less URL). `SiteSource.content_dir` lets `validate`
distinguish "not migrated yet" (file absent → skip) from "migrated but malformed" (present
but missing `meta` → error). *Do not reintroduce a hard content/theme requirement*
(decisions/00004).

### Inv 6 — Draft overlay is last-writer-wins per key; no CRDT
Single-operator tool. `merge_overlay` applies overlay ops over `origin/main` per key; an AI
upstream edit to a key you haven't touched flows into your draft, a key you *have* touched
keeps your draft value until published or discarded. Do **not** build multi-user conflict
resolution.
*Exception / rule:* collections overlay as the **whole array** (no path indexes into an
array); scalar/meta/theme keys overlay per dotted leaf.

### Inv 7 — Live is an immutable per-SHA build; the swap is one atomic pointer write
`builds/<sha>/` is immutable and content-addressed. Going live = `save_live_pointer`
(tmp+`os.replace`) only. Publish steps 1–4 never touch the serving pointer; a crash, bad
merge, or half-publish cannot mutate the live site.
*Known caveat (not a violation):* publish **step 5** is a sequence of four individually-atomic
writes (live → ledger → overlay → prune), not one transaction — a kill mid-sequence can leave
`live.json` advanced while the ledger/overlay lag (recoverable, but not atomic as a set).

### Inv 8 — The Storage checkout is fast-forward-only
`ensure_checkout` does `git fetch` + `git merge --ff-only`; a non-ff local state raises
`CheckoutError` and is **never force-updated**. The initial clone is a full clone (no
`--depth`/`--single-branch`) because restore needs arbitrary historical trees.
*Exception:* restore uses a detached scratch `git worktree add` at an arbitrary sha — a
separate working tree sharing only the object DB, safe alongside a fetch/merge.

### Inv 9 — Optimistic concurrency: every overlay mutation checks & bumps `rev`
`apply_patch`, `add_page`, `delete_page`, and `discard_all` all validate `expected_rev` and
return an overlay at `rev+1`. This makes a racing stale PATCH always 409.
*Exception:* none — even an idempotent-in-effect `delete_page` and a `discard_all` still bump
`rev` (so an in-flight stale PATCH after a discard still 409s).

### Inv 10 — `data-wx-if` differs between publish and preview
**publish** extracts falsy branches (they vanish and their subtree is not walked); **preview**
keeps them, marks `data-wx-hidden="1"`, and *still walks/validates* their bindings.
`validate` deliberately runs in preview mode so a currently-hidden branch's bindings are
still checked.
*Exception:* none — this asymmetry is intentional and load-bearing for the editor.

### Inv 11 — `version` is monotonic and never reused
`next_version = max(version)+1` across the whole ledger; a restore consumes a **new** version
even though it revisits an old sha. Every ledger entry (publish or restore) consumes one.

### Inv 12 — CF Access JWT is the only auth; loopback-only; internal surface hidden
Bind `127.0.0.1` only (the tunnel is the sole ingress). `/admin*` + `/api/admin*` require a
verified CF Access JWT (`aud` = the app AUD, `iss` = the team domain, signature vs cached
JWKS). `/internal/*` + `/healthz` return a bare 404 when a `Cf-Ray`/`Cf-Connecting-Ip`
header is present (they answer loopback probes only). The embedded AI chat has **no publish
tool** — it cannot publish.
*Exception:* `WIXY_DEV_NO_AUTH=1` bypasses auth for local dev/tests **only** — the app
refuses to start if it's set while `WIXY_ENV=prod`. `/api/version` is public by design.

### Inv 13 — All AI inference goes through cmd; never the Anthropic API
No direct Anthropic/Claude API calls anywhere in the engine. `wixy_server/cmdchat.py` is the
single chokepoint to cmd (localhost `9320`/`9321`, unauthenticated, no keys). Every wixy
conversation is a real cmd chat.
*Exception (roadmap only):* the not-yet-built independence phase's *standalone* edition
(`spec/independence/05`) adds an optional `anthropic` backend using the owner's own key — an
operator-decided exemption that applies only to that separate edition, never to this engine.

### Inv 14 — The code requires Python ≥ 3.14 (PEP 758 syntax)
`bootstrap.py:52` (`except CheckoutError, BuildError:`) and `cmdchat.py:186`
(`except json.JSONDecodeError, TypeError, UnicodeDecodeError:`) use **unparenthesized
multi-exception `except`**, legal only on Python ≥ 3.14 (PEP 758). This is **not** Python-2
syntax and **not** a bug — it catches all listed types. `pyproject.toml` pins
`requires-python = ">=3.14"` and the deploy uses the pythoncore-3.14 interpreter.
*Verified:* `py_compile` of both files is clean on 3.14. It **would** be a `SyntaxError` on
≤3.13 — do not "fix" it, and do not run this repo on an older interpreter.

### Inv 15 — Tests parallelize at a fixed `-n 4`, never `-n auto`
`pyproject.toml` `addopts = "-n 4 -m 'not live_cmd'"`. The cap is deliberate — the suite runs
on the hub VM next to production cmd, and `-n auto` caused a real outage (2026-07-07). Never
pass `-n auto`, never lower the cap to "fix" a rare full-suite flake, never add per-test
skips/retries (decisions/00025, 00027). See [testing.md](testing.md).

### Inv 16 — Media: SVG rejected, EXIF stripped, content-hash dedupe, no transient data loss
`media.py:process_upload` rejects SVG (XSS) and non-image MIME, rejects >15 MB, strips EXIF
(client-photo privacy), auto-orients, downscales to the project's `maxLongSidePx`, and names
the file by the sha256 of the **final re-encoded bytes** (re-upload dedupes). At publish, a
staged file is copied into `images/` **before** `builder validate`, and the staged original
is deleted only **after** validate passes — so an aborted publish (`git reset --hard`) never
loses data (decisions/00024).

### Inv 17 — Builds are pruned to the last 20 ledger versions; restore can rebuild
`_prune_builds` keeps the build dirs referenced by the last `_MAX_KEPT_VERSIONS = 20` ledger
entries (by count) plus always the live one. A pruned version is reconstructable via
`restore.ensure_build` from its sha (annotated tag `wixy-publish-v<N>` is pushed for every
publish — even a pure-upstream one with no new commit — so history survives Storage loss).

### Inv 18 — Two-tier locking; `tree_lock` never held across build/verify
Intra-process = the re-entrant `treelock.py:tree_lock()` over the Storage working tree, held
one mutation-step at a time and for the duration of a tree read — **never across the
multi-second build/verify** (which read a committed, quiescent tree). Cross-process = the
`locks/publish.lock` file, owned by `run_publish` for the whole pipeline; the watcher checks
it first and yields. A hard process-kill orphans the lock, which **self-heals after
`_LOCK_STALE_AFTER_S = 600s`** so the watcher resumes (decisions/00030).

### Inv 19 — Never author in the deployment target
Never edit `D:\Servers\Wixy\` — it's a Slots blue/green deployment target. Branch in this
repo → PR → merge `main`; Slots deploys. A machine-check hook (`worktree-guard`) hard-denies
Edit/Write into a primary checkout under the Servers tree.
*Exception:* the site-repo checkout at `Storage\projects\ca\repo\` is machine-managed runtime
data written only by the publisher + fetch loop — it is *not* an authoring clone and the
"never author in D:\Servers" rule doesn't make it one (agents get cmd worktrees instead).

### Inv 20 — Hand-synced client/server ports must not drift
Two pairs are deliberately duplicated and must be kept identical by hand:
(a) `admin-ui/src/protocol.ts` ≡ `editor/src/protocol.ts` (the postMessage protocol, byte-
identical, decisions/00015); (b) `admin-ui/src/themeVars.ts` / `googleFonts.ts` are TS ports
of `builder/theme.py:generate_theme_css` / `generate_fonts_url` and must produce byte-
identical output to the server (so the theme panel previews without a round-trip;
`googleFonts.test.ts` mirrors the Python tests). A third pair joined in decisions/00075:
(c) `builder/markdown_inline.py` ≡ `editor/src/markdownText.ts` (inline-markdown render
for text bindings) — locked by ONE shared fixture, `builder/tests/fixtures/
markdown-inline.json`, which both pytest and vitest load.

### Inv 21 — Deploy scripts avoid two Windows footguns
`launcher.py` runs the slot's venv as a **blocking `subprocess.run`**, never `os.execv` (on
Windows `execv` spawns a separate process and orphans the server from Devfleet's Job Object —
decisions/00037). `deploy.py:_pip_install_venv` builds `<slot>/.venv.new` fresh and
**atomically swaps it in** (`_atomic_swap_dir`), never `shutil.rmtree` in place (an in-place
delete fails because the build-step runs *using* that venv's interpreter — decisions/00039).
`deploy.py` hooks are `fn(ctx)`-arity (decisions/00040).

### Inv 22 — Every `/admin/static/*` URL referenced from served HTML is content-fingerprinted
Any `src`/`href` into `/admin/static/` must carry `?v=<sha256(file)[:10]>`
(`staticcache.fingerprinted_url`), and the document carrying those URLs must itself be
non-heuristically-cacheable (`GET /admin` is `Cache-Control: no-cache`; preview HTML is
`no-store`). Otherwise a redeployed bundle is invisible behind the browser's heuristic cache
for days — the bug decisions/00069 fixed. The shell is rewritten by construction
(`app.py:_fingerprint_shell_assets`); anything new that references `/admin/static/*` from a
served document must go through `fingerprinted_url` too. *Enforced by:*
`test_staticcache.py` (incl. the no-bare-references guard). *Known exception:* the
`?uxer=`-gated Uxer compliance-bridge `import()` (AI-tooling-only surface, gitignored
local build) — see decisions/00069's "what to watch for".

### Inv 23 — Overlay chrome is stripped before any DOM value crosses into a draft op or editor seed
The overlay injects chrome INTO content elements (today: the `data-wx-if` eye
toggle, `OVERLAY_CHROME_SELECTOR` in `editor/src/dom.ts`). Any value read from the
live DOM — whole-array list reconstruction, popover/composer seeds, link labels —
must go through the chrome-free readers (`chromeFreeInnerHtml` /
`chromeFreeTextContent` in `editor/src/contentModel.ts`), never raw
`innerHTML`/`textContent`, or the chrome's markup and label land in committed
content (the 2026-07-21 incident: 👁️-and-button pollution staged in the prod
draft, decisions/00073). Corollary: any code path that overwrites an if-bound
element's `innerHTML` must re-attach its eye toggle (`ensureIfToggle`).

### Inv 24 — The admin shell's root document never scrolls; chrome sizes to the dynamic viewport
The admin is an app shell: ONLY the middle content (`.wx-main`, the preview iframe's
own document) may scroll. `admin-ui/src/style.css` (and the mirrored pre-paint inline
rule in `admin_shell.html`) sets `html, body { overflow: hidden; overflow: clip;
overscroll-behavior: none; }` — no touch/wheel/keyboard pan, URL-bar pan, scroll
chaining out of the preview iframe, pull-to-refresh, or (with `clip`) even a
programmatic `scrollTop` can move the chrome. Fixed chrome sizes to the DYNAMIC
viewport (`.wx-shell`, `.wx-drawer`: `height: 100vh; height: 100dvh`; the loading
screen's mins; toasts at `bottom: calc(20px + 100vh - 100dvh)`), because `100vh` is
the LARGE mobile viewport — with the URL bar shown it left the shell taller than the
visible area and the whole page scrolled the bars off (the operator's second
edit-chrome report, decisions/00085). *Enforced by:* `e2e/tests/mobile-edit-chrome.
spec.ts`'s "shell root no-scroll" describe (forced-overflow shell attacked with a
real wheel gesture AND programmatic scrolls; served-bundle dvh assertions;
middle-still-scrolls guard). *Watch for:* anything new fixed-bottom reuses the
`calc(… + 100vh - 100dvh)` offset pattern; panels scroll inside `.wx-main`, never
the root; the preview document is intentionally NOT overflow-constrained (it is the
middle that must scroll).

