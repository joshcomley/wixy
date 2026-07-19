# Glossary

Domain terms and status machines. The normative source for the content-model terms is
[`spec/02-content-model.md`](../../spec/02-content-model.md).

## Content model

- **Site repo** — `joshcomley/cottage-aesthetics-preview`; the single source of truth for
  everything the public sees (templates, content, theme, images). Distinct from the **engine
  repo** (this repo, `joshcomley/wixy`).
- **Three layers** — **Templates** (`pages/*.html`, `partials/*.html`), **Content**
  (`content/*.json`), **Theme** (`theme/theme.json`). Published output =
  `build(templates, content, theme)`.
- **Binding** — a `data-wx-*` attribute on a template element that binds it to a content
  value. Kinds: `data-wx` (innerHTML/rich-lite), `-img` (`{src,alt}`), `-href`, `-bg`
  (background-image), `-attr` (`attr:key`), `-list` (collection array) + `-list-item`,
  `-if` (conditional). See [contracts.md](contracts.md) §6 for the `BindingKind` set.
- **Key resolution** — a plain key (`hero.title`) → the page's `content/<slug>.json`;
  an `@`-prefixed key (`@phone`) → `content/_global.json`; a `.`-prefixed key (`.title`)
  → the current `data-wx-list` item. Dotted paths descend dicts only, never index arrays.
- **`@nav`** — the navigation list. **Builder-generated, never stored** (`builder/nav.py:
  build_nav` derives it from pages' `meta.inNav`/`meta.navOrder` + `_global.navExtra`, then
  injects it before validation so `data-wx-list="@nav"` resolves like any key).
- **Collection** — a `data-wx-list` container bound to an array; edited as a whole unit
  (the overlay stores the entire array under the list key). Seven load-bearing collections
  after migration (`spec/02` §6, = the 7 `COLLECTION_RULES` rows); each item validated against
  one of the **8** `builder/schemas/*.json` — the 8th, `footer-link`, is applied by a
  special-case in `validate`, not a rule row.
- **Rich-lite text** — the restricted HTML fragment allowed in `data-wx` values: tags
  `a/em/strong/br/span`, `class` only `js-book` on `a`/`span`, URL schemes http(s)/mailto/
  tel. Enforced by `builder/sanitize.py:sanitize_rich_lite` (over `nh3`) on every draft
  write and every render.
- **`meta` block** — the reserved per-page content object (`title`, `description`,
  `ogImage`, `navLabel`, `inNav`, `navOrder`) the builder consumes for `<head>` injection
  and nav derivation. No binding annotation needed.
- **slug** — a page identifier `[a-z0-9-]+`; `pages/<slug>.html` → `/<slug>.html` (the home
  page's slug is **`index`** everywhere the model threads; `home` survives only in
  `<body data-page="home">`).
- **`theme.css`** — builder-emitted `:root{ --<color>:…; --shadow:…; --font-<role>:… }` from
  `theme/theme.json`; color keys are the CSS var names minus `--`. Linked before `site.css`.

## Draft / publish

- **Draft overlay** — the sparse per-key edit state at `draft/overlay.json`. Shape
  `{rev, baseSha, ops:{"<file>:<dotted.path>":{value,ts,by}}, pages:{added,deleted}}`. The
  visual editor never writes content files directly — it accumulates ops here.
- **op** (`DraftOp`) — one overlay edit: `{file, path, value}` or `{file, path, discard:true}`.
  `file ∈ <slug> | "_global" | "theme"`. Scalars overlay per key; collections overlay the
  whole array.
- **rev** — the overlay's monotonic revision. Every mutation bumps it; a PATCH carries the
  `expectedRev` it was based on; a stale one → **409** (optimistic concurrency).
- **baseSha** — opaque passthrough recording the overlay's base; merge is always computed
  against live `origin/main`, so this is informational.
- **Merged content** — `content = checkout ⊕ overlay` (`merged_content.py:merge_overlay`):
  overlay wins per key; un-drafted keys flow through from `origin/main` (so AI-lane upstream
  edits appear in the draft). Deletion is *not* applied here (takes effect at publish).
- **Preview mode vs publish mode** — the two builder render modes. **publish** removes falsy
  `data-wx-if` branches (byte-authoritative); **preview** keeps them (`data-wx-hidden="1"`)
  and still validates them. Preview injects the editor assets; publish does not.
- **live pointer** (`live.json`) — `{sha, version, buildDir}` naming the currently-served
  build. Written atomically; the **only** thing that changes the live site. Read fresh per
  request (no in-process cache).
- **build** — an immutable, content-addressed `builds/<sha>/` directory of static output.
- **Publish** — materialize the overlay into content/theme files → commit → push → build →
  verify → swap the live pointer → append a ledger entry → clear the overlay. See
  [publish-pipeline.md](publish-pipeline.md).
- **Restore** — flip the live pointer to a past version's build and set the overlay to the
  diff so the draft equals what's now live. No commit until the owner next publishes.
- **Ledger** — the append-only `publishes.jsonl` product-level history (one entry per
  publish/restore). `git log` + `wixy-publish-v<N>` tags are the forensic layer.
- **version** — the sequential ledger number (`next = max+1`, never reused, even by a
  restore that revisits an old sha). The first-serve bootstrap is version **0**
  (`bootstrap.py:BOOTSTRAP_VERSION`); real publishes are 1-based (the first human publish is v1).
- **Editor lane / AI (upstream) lane** — the two ways content changes: the owner's overlay
  edits (Editor lane) vs cmd agents' PR→main work (AI lane). Both merge into the draft; only
  Publish goes live.
- **Upstream watcher** — the 60s loop (`watcher.py`) keeping the Storage checkout
  fast-forwarded to `origin/main` so AI-lane merges surface in the draft.

## Deploy / fleet

- **Project registry** — `projects/*.json` in the engine repo (in-repo, code-reviewed). One
  per site; loaded at startup. Fields incl. `slug`, `repo`, `cmdProject`, `domain`,
  `indexable`, `media`. Deep dive of the `ca.json` shape in [runbook.md](runbook.md).
- **`cmdProject`** — the registry field naming the cmd clone directory used for the AI chat
  lane (`cottage-aesthetics-preview`). Selects *which* cmd project, never the cmd host.
- **cmd** — the fleet's self-hosted chat spawner (localhost `9320` portal + `9321`
  Cmd-Chats introspection). Every wixy AI conversation *is* a real cmd chat. See
  [ai-chat.md](ai-chat.md).
- **Slot / blue-green** — `Slots\blue` + `Slots\green` are two independent engine checkouts;
  `active.txt` points at the live one. Deploying = merge `main`; Slots builds the inactive
  slot, smoke-probes it, flips `active.txt`. **Never edit a slot** (Invariant 19).
- **Storage** — the runtime-state tree (`D:\Servers\Wixy\Storage\`) that survives slot
  swaps. The site-repo checkout under it is machine-managed runtime data, *not* an authoring
  clone (Invariant 19's exception).
- **CF Access** — Cloudflare Access; the only auth for `/admin*`. Wixy verifies the edge-
  issued JWT (`auth.py`); it issues nothing.
- **Slot anti-stale gate** — Slots' smoke probe requires `GET /api/version`'s
  `commit.sha_full` to match the just-deployed sha before flipping `active.txt`.

## Status machines

**Publish stages** (`publisher.py:PublishStage`, on `PublishJob.stage`):
```
pulling → merging → committing → building → verifying → swapping → done
   └──────────────── (any stage) ────────────────────────────────→ failed
```
`PublishJob.is_running = stage not in ("done","failed")`. `PublishError.stage` only ever
carries `pulling`/`merging`/`committing` (build/verify raise `BuildError`; swap doesn't
fail-raise). Only **swapping** changes the live site — any failure before it leaves live +
ledger + draft untouched.

**Ledger source kind** (`ledger.py:PublishSource`): `editor` | `upstream` | `mixed` |
`bootstrap`. Computed by `_publish_source_kind` from whether the publish carried draft ops
and/or upstream commits; `bootstrap` is authored only by the first-serve path.

**Chat conversation status** — `app.state.chat_runtime` maps convId →
`chats.py:ChatRuntimeEntry(status, failure_reason?, failure_message?)` (transient, never
persisted), where `status` is the `chats.py:ChatStatus` Literal `pending` → `ready` | `failed`.
(Distinct from `cmdchat.py:ChatStatus` — a *different* type: the cmd-client live status
`{activity, process_kind, handover_state}` returned by `get_status`.) A conversation absent
from the runtime map reads as `ready` (decisions/00032). On failure, `failure_reason ∈ workspace_failed |
cli_failed | timeout | unreachable` — `unreachable` (cmd down) is a distinct UI state from a
real provisioning failure (decisions/00031).

**Checkout state** (`checkout.py:ensure_checkout`, implicit): `.git` absent → full
`git clone` (never shallow — restore needs arbitrary history); `.git` present → `git fetch` +
`git merge --ff-only`. A non-fast-forward local state is a hard `CheckoutError`, never forced
(Invariant 8).
