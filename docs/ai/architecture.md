# Architecture

The mental model, data flow, and module map for the wixy engine. Read this first, then
follow the links into the per-subsystem deep-dives. The full, decided design is in
[`spec/`](../../spec/README.md) (start at `spec/01-architecture.md`); this file is the
navigable operator's map, not a substitute.

## 1. What wixy is

A **self-hosted CMS engine**: a lightweight content editor + live visual editor + embedded
AI chat + one-click publisher, for sites that are plain HTML/CSS/JS. The first (and, in v1,
only) site is **Cottage Aesthetics** (`ca.cinnamons.uk`). Five binding principles
([`spec/00-mission.md`](../../spec/00-mission.md)):

1. **Git is the database.** Templates, content JSON, theme, and images live in the *site*
   repo (`joshcomley/cottage-aesthetics-preview`); every publish is a commit; history,
   rollback, and AI collaboration all ride git. No parallel content DB.
2. **The public site stays plain static files.** The builder emits the same kind of
   HTML/CSS/JS the site already ships — no client framework, no runtime CMS on the visitor
   path.
3. **One human gate.** The editor and the AI both stage into a *draft*; only the owner's
   **Publish** button changes the live site. Restore is always available.
4. **Engine ≠ content.** This repo is generic over "projects"; everything
   Cottage-Aesthetics-specific lives in the site repo + one `projects/ca.json` registry
   entry. No `cottage` string literals in engine code paths (Invariant 1 in
   [invariants.md](invariants.md)).
5. **Fleet-native.** cmd spawns the AI chats, Slots deploys the engine, Devfleet supervises
   it, cloudflared exposes it, CF Access guards `/admin`.

## 2. System picture

```
                    Cloudflare edge (ca.cinnamons.uk)
                    /admin*  ── CF Access (JWT) ──┐   /  (public, no auth)
                                                  │
                         cloudflared tunnel (hub VM)
                                                  ▼
                    Wixy · FastAPI · 127.0.0.1:9380   (loopback only)
        ┌───────────────┬───────────────────────────┬─────────────────┐
        │ public serve  │ /admin shell + /api/admin/* │ chat proxy      │
        │ live build    │  draft overlay + preview    │   │             │
        │  (static)     │        │                    │   ▼             │
        └───────────────┘        ▼                cmd (9320/9321, localhost)
                    Storage\projects\ca\repo\  (clone of the SITE repo @ main)
                         ▲ fetch/ff-only     │ commit+push on Publish
                         │                   ▼
              github.com/joshcomley/cottage-aesthetics-preview  = SOURCE OF TRUTH
                         ▲ AI lane: PR → main (CI-gated, auto-merge)
```

- **wixy repo** (this repo) = the *engine*. Deployed as fleet service **`Wixy`** via Slots
  blue/green. Merging wixy `main` redeploys the engine — and never touches site content
  (published builds live in `Storage\`). See [runbook.md](runbook.md).
- **site repo** = templates + content JSON + theme + images. Single source of truth for
  everything the public sees.
- **Storage** (`D:\Servers\Wixy\Storage\`) = runtime state: the engine's own site-repo
  checkout, the draft overlay, immutable per-SHA builds, the publish ledger, chat registry.
  Nothing irreplaceable lives only here (repo + tags reconstruct it).

## 3. The core idea: two lanes, one merge point, one human gate

```
   editor PATCH (overlay op)            AI merge to main (PR → CI → main)
   draft view = origin/main ⊕ overlay ◄──────────────────────────────┐
        │ Publish (owner button)                                      │
        ▼                                                             │
   materialize overlay → commit → push → build(sha) → verify → swap   │
        │                                                             ▲
        ▼                                                             │
   live site = builds/<published-sha>  ── Restore(version) ──────────┘
```

- **Editor lane** (owner): a sparse **overlay** of per-key ops on top of `origin/main`.
  Publish *materializes* it into one commit. Last-writer-wins per key vs upstream — no CRDT
  (Invariant 6). See [serving-and-overlay.md](serving-and-overlay.md).
- **AI lane** (cmd agents): ordinary git work in worktrees → PR → CI (validate + build +
  parity) → `main`. Appears in the owner's draft preview on the next fetch; goes live only
  via the owner's Publish. See [ai-chat.md](ai-chat.md).
- **Live** is a pinned SHA's immutable build; the swap is one atomic pointer write
  (`live.json`). A crash, bad merge, or half-publish can never mutate it (Invariant 7).
  See [publish-pipeline.md](publish-pipeline.md).

## 4. Data flow: how a page becomes bytes

`build(templates, content, theme) → static site` is a deterministic pure function
(`builder`). Per page (`builder/render.py:render_page`):

1. Load template `pages/<slug>.html` + inject `partials/*` at the `<!-- wx:partial … -->`
   markers.
2. Resolve `data-wx-*` bindings against content JSON: plain key → `content/<slug>.json`,
   `@key` → `content/_global.json`, `.key` → current list item. Nav (`@nav`) is
   builder-generated, never stored.
3. `data-wx-if` in **publish** mode removes falsy branches; in **preview** mode it keeps
   them marked `data-wx-hidden="1"` so the editor can still reach them (Invariant 10).
4. Inject `<head>` (title/meta/OG/fonts/`theme.css`) from `meta` + theme; write `theme.css`
   from `theme/theme.json`.

The **normative** contract for all of this is
[`spec/02-content-model.md`](../../spec/02-content-model.md); the code walk-through is
[builder.md](builder.md).

## 5. Module map

### `builder/` — pure Python library (no server imports; importable standalone)

| Module | Responsibility |
|---|---|
| `render.py` | `render_page`, `load_site_source`, `SiteSource` — per-page orchestration |
| `build.py` | `build_site`, `hash_output_tree` (determinism) — full-site build + self-check |
| `validate.py` | `validate_site` → `ValidationResult` (collect-all, never raises for content) |
| `bindings.py` | the `data-wx-*` resolution engine (`apply_bindings`, `resolve_key`, `Mode`) |
| `bindings_map.py` | static value-free binding inventory (`extract_bindings_map`) for the editor |
| `templates.py` | template load / partial injection / `<head>` management (`apply_head`) |
| `theme.py` | `Theme`, `generate_theme_css`, `generate_fonts_url`, `theme_to_dict` |
| `content.py` | content JSON I/O + dotted paths (`dotted_get/set`, `atomic_write_json`) |
| `nav.py` | `build_nav` (derives `@nav`; never stored) |
| `sanitize.py` | `sanitize_rich_lite` over `nh3` (allowlisted rich-lite HTML) |
| `sitemap.py` | `generate_robots_txt`, `generate_sitemap_xml` |
| `collections.py` | the fixed collection-key → schema table (`COLLECTION_RULES`) |
| `config.py` | `ProjectConfig`, `load_project_config` (the `projects/*.json` registry) |
| `errors.py` | `BuildError` (fatal) vs `ValidationError`/`ValidationResult` (collected) |
| `jsonschema_lite.py` | dependency-free JSON-Schema subset validator |
| `cli.py` / `__main__.py` | `python -m builder {validate,build,serve,parity}` |
| `schemas/*.json` | the 8 collection item schemas |

Deep dive: [builder.md](builder.md).

### `wixy_server/` — FastAPI app (imports `builder`)

| Module | Responsibility |
|---|---|
| `app.py` | `create_app` — router wiring, lifespan (watcher + chat task group), auth middleware |
| `settings.py` | `.env` + env → frozen `Settings` (port, `WIXY_ENV`, CF Access AUD/team-domain, dev bypass) |
| `auth.py` | CF Access JWT verify middleware (`build_admin_auth_middleware`, `JwksCache`) |
| `registry.py` | server-side project registry (`load_registry`, `ProjectRegistry`) |
| `storage.py` | `ProjectPaths` — Storage path computation |
| `site_source.py` | project + checkout → `builder.SiteSource` |
| `checkout.py` | site-repo clone/fetch/ff-only manager (`ensure_checkout`, `run_git`) |
| `overlay.py` | sparse draft-overlay store + PATCH algebra (`apply_patch`, `RevConflictError`) |
| `merged_content.py` | `merge_overlay` — `content = checkout ⊕ overlay` |
| `preview.py` | draft preview render + editor-asset injection |
| `watcher.py` | 60s upstream fetch loop (`watch_upstream`, `fetch_once`) |
| `publisher.py` | the serialized publish pipeline (`run_publish`, `PublishStage`) |
| `restore.py` | restore-to-past-version (`run_restore`, `ensure_build`) |
| `ledger.py` | append-only publish ledger (`publishes.jsonl`) |
| `live_pointer.py` | atomic live-build pointer (`live.json`) |
| `treelock.py` | process-wide re-entrant working-tree lock (`tree_lock`) |
| `media.py` | Pillow upload pipeline + reference scanning |
| `cmdchat.py` | the single client to cmd (`CmdChatClient`) — all AI inference |
| `chats.py` | conversation store (`chats.json`) |
| `bootstrap.py` | first-serve "publish zero" (idempotent) |
| `routes_*.py` | route handlers (public, admin API, internal, preview, chat, version(s)) |

Deep dives: [serving-and-overlay.md](serving-and-overlay.md),
[publish-pipeline.md](publish-pipeline.md), [ai-chat.md](ai-chat.md),
[media.md](media.md). The HTTP contract is [contracts.md](contracts.md).

### `admin-ui/` + `editor/` — two independent strict-TS/esbuild bundles

- **`admin-ui/`** → `wixy_server/static/admin/` — the admin shell at `/admin`: owns session
  state, the single `OpQueue`, all `/api/admin/*` calls, and every panel (pages, edit,
  theme, media, chat, history, settings).
- **`editor/`** → `wixy_server/static/editor/` — the overlay injected *inside* the
  live-preview iframe: hover chrome, click→popover editing, op emission.

They talk only across the iframe boundary via a versioned `postMessage` protocol
(duplicated byte-for-byte in `admin-ui/src/protocol.ts` and `editor/src/protocol.ts`).
Bundles are **committed**; CI fails on drift (Invariant 2). Deep dive:
[editor-and-admin-ui.md](editor-and-admin-ui.md).

## 6. Storage layout (runtime state, survives slot swaps)

```
D:\Servers\Wixy\Storage\
  .env                         # WIXY_PORT, WIXY_CF_* etc. (secrets)
  logs\
  projects\ca\
    repo\                      # git clone of the SITE repo (fetch/ff-only main)
    draft\overlay.json         # the sparse draft overlay (spec/02 §8)
    draft\media\               # staged (unpublished) uploads
    builds\<sha>\              # immutable per-SHA build outputs
    live.json                  # {"sha","version","buildDir"} — the atomic live pointer
    publishes.jsonl            # append-only publish ledger
    chats.json                 # AI conversation registry
    locks\publish.lock         # cross-process publish lock (self-heals after 600s)
```

Paths are computed by `wixy_server/storage.py:ProjectPaths`; everything is per-slug (v1 runs
one project but no code assumes it — Invariant 1).

## 7. Beyond v1: the independence phase

[`spec/independence/`](../../spec/independence/README.md) is a **later, separate, not-yet-
implemented** phase: move Cottage Aesthetics' entire web presence onto owner-controlled
infrastructure (her GitHub org, a DigitalOcean droplet, her Cloudflare, MIT-relicensed
engine fork with an upstream-sync button, a pluggable AI backend, nightly state backups, and
a printable HTML setup guide). It reuses the v1 conventions; where its spec is silent, the
v1 spec governs. Nothing in it changes the engine described above yet — treat it as roadmap.
For any independence-phase work, read `spec/independence/` in full — its
[`README.md`](../../spec/independence/README.md), `09-work-plan.md`, and `KICKOFF-PROMPT.md`
are the entry points. `docs/ai/` documents only the shipped engine and deliberately does not
cover the independence subsystems (dual-control fork sync, standalone Docker deploy, pluggable
AI backend, state backups, the HTML guide) — those live entirely in `spec/independence/`.
