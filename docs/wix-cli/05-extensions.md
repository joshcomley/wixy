# 05 — Extensions, templates, & generation

Wix Apps and headless projects are extended by writing **extensions** — typed building blocks that the Wix runtime registers automatically. `wix generate` scaffolds them from EJS templates bundled with the CLI; `wix schema generate` returns a machine-readable JSON schema describing every supported extension and its required inputs.

## Extension types (current set, ASTRO flow)

The choices accepted by `wix generate --type` and `wix schema generate --type`:

| Type identifier | What it is | Bundled template |
|---|---|---|
| `DASHBOARD_PAGE` | A page in the Wix dashboard. | `templates/astro/dashboard-page/` |
| `DASHBOARD_MODAL` | A modal dialog in the Wix dashboard. | `templates/astro/dashboard-modal/` |
| `DASHBOARD_PLUGIN` | A plugin for the Wix dashboard. | `templates/astro/dashboard-plugin/` |
| `DASHBOARD_MENU_PLUGIN` | A menu plugin for the Wix dashboard. | `templates/astro/dashboard-menu-plugin/` |
| `EMBEDDED_SCRIPT` | An embedded script extension (head/body injection). | `templates/astro/embedded-script/` |
| `CUSTOM_ELEMENT` | A custom HTML element. | `templates/astro/custom-element/` |
| `SITE_PLUGIN` | A plugin for Wix sites. | `templates/astro/site-plugin/` |
| `EVENT` | An event handler. | `templates/astro/event/` |
| `SERVICE_PLUGIN` | A service-plugin (SPI implementation). | `templates/astro/service-plugin/` |
| `EDITOR_REACT_COMPONENT` (templates only) | A React component injectable into the Wix Editor. | `templates/astro/editor-react-component/` |
| `DATA_COLLECTIONS` (templates only) | Velo data-collection definitions. | `templates/astro/data-collections/` |

`SERVICE_PLUGIN` is special — its template directory contains **per-SPI subtemplates** (one per service plugin SPI Wix supports):

```
templates/astro/service-plugin/
  booking-policy-provider/
  bookings-pricing-provider/
  ecom-additional-fees/
  ecom-discounts-trigger/
  ecom-payment-settings/
  ecom-shipping-rates/
  ecom-validations/
  gift-cards-provider/
  realtime-permissions-provider/
  staff-sorting-provider/
```

Each holds its own `files/*.ejs` and `dependencies.json`.

## Anatomy of a template

```
templates/astro/<extension-type>/
  dependencies.json    # additional npm deps to merge into project package.json
  files/
    <name>.ejs         # rendered with EJS; frontmatter contains `to: <output-path>`
    ...
```

### `dependencies.json` shape

```jsonc
{
  "dependencies":    { "@wix/design-system": "^1.111.0" },
  "devDependencies": { "@types/react": "^18.3.1", "@types/react-dom": "^18.3.1", "react": "18.3.1", "react-dom": "18.3.1" }
}
```

When `wix generate` finishes scaffolding, it merges these into the project's `package.json` and runs `npm install` (or yarn/pnpm depending on lockfile).

### EJS frontmatter

```
---
to: <%- route -%>.tsx
---
... template body ...
```

The `to:` line declares the output file path *relative to the extension directory*. Wix's generator reads the frontmatter, computes the target path, renders the body with the provided params, and writes the file.

### Params passed to templates

The most common params (varies per type):

- `route` — slug/route segment for the extension (e.g. `dashboard/my-page`).
- `config.id` — UUID for the extension component.
- `config.title` — Human title (dashboard pages, modals).
- `config.component` — Component module path.

See each template's `*.ejs` files for the exact set. Or — more reliably for an agent — call `wix schema generate --type <TYPE>` to get the canonical JSON Schema.

## `wix generate` flows

There are two ways to invoke the generator:

### Interactive

```bash
wix generate                  # full picker
wix generate --type DASHBOARD_PAGE   # skip the type picker; still prompts for params
```

The interactive UI is an Ink TUI. Each extension type has a per-type prompter — answers feed into the EJS render context.

### Non-interactive (`--params <json>`)

```bash
wix generate --params '{"type":"DASHBOARD_PAGE","route":"dashboard/my-page","config":{"id":"...","title":"My Page","component":"./page.tsx"}}'
```

`--params` implies `--json`, conflicts with `--type`. The JSON shape must match the schema for the named extension type. On success, the CLI prints to stdout:

```jsonc
{ "success": true, ... }
```

On failure:

```jsonc
{ "success": false, "error": "<message>" }
```

This is the path Wixy should drive — predictable IO, no Ink rendering, no interactive prompts. The cost is needing the right schema up front, which is what `wix schema generate` is for.

## `wix schema generate` — the canonical schema

```bash
wix schema generate                    # all extension types
wix schema generate --type DASHBOARD_PAGE   # one type
```

Output is a JSON Schema document (always JSON-formatted; `--json` flag is default-on). Structure is roughly:

```jsonc
{
  "extensions": {
    "DASHBOARD_PAGE": {
      "type": "object",
      "required": ["route", "config"],
      "properties": {
        "route":  { "type": "string", ... },
        "config": { "type": "object", "required": [...], "properties": {...} }
      }
    },
    "DASHBOARD_MODAL": { ... },
    ...
  }
}
```

The shape is generated dynamically from Zod schemas registered in `@wix/cli-astro-commands` — the exact field set may shift across CLI versions. Always fetch the live schema before scaffolding; never hard-code the field list in Wixy.

**Requires auth** — `wix schema generate` errors with `AuthenticationRequired` if not logged in. The schema generation runs a small server roundtrip to fetch extension-registry metadata.

## Service-plugin generation

For `SERVICE_PLUGIN`, the interactive picker shows a sub-menu of SPIs (booking policy, ecom discounts trigger, etc.). With `--params`, you pass the `serviceProviderSubType` (or similar; check the schema) to select.

## Where extensions land on disk

```
<project>/src/extensions/
  <route-or-id>/
    extension.ts        # registration (extensions.dashboardPage({...}) or similar)
    page.tsx            # implementation (for DASHBOARD_PAGE)
    widget.tsx          # implementation (for plugins/widgets)
    ...
```

Each extension is a self-contained subdir. Wix's Astro adapter scans `src/extensions/` at build time, reads each `extension.ts`, and assembles the extension manifest written to `.wix/build-metadata.json` → `extensionsTopology`.

## `wix app generate` (legacy APP flow)

Same shape but lives under the legacy flow:

```bash
wix app generate --type <TYPE>
```

The legacy flow's extension types and template params are similar but not identical (older registration API). No `--params` JSON mode — interactive only.

## For Wixy

To build a "create extension" feature in Wixy:

1. On project detection, call `wix schema generate --json` (cached per-CLI-version) to learn the live extension catalogue.
2. Render a form per type from that schema (use a JSON-Schema → React form library; the schema is well-formed JSON Schema).
3. On submit, run `wix generate --params <stringified JSON>` and parse the `{success: bool}` response.
4. After success, optionally trigger `wix build` to confirm the new extension compiles before showing the user.

Doing the generation server-side via `wix generate --params` (rather than rolling Wixy's own template renderer) means every Wix-supported extension type works out of the box, and Wix's own template updates flow to Wixy users for free with a CLI version bump.
