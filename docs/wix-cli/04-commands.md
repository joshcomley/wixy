# 04 — Every command, every flow, every option

This is the exhaustive command reference. For each command:

- **Flow** — which project flows expose it.
- **Synopsis** — exact `Usage:` line.
- **Options** — every visible AND hidden flag, default, parser, conflicts.
- **Arguments** — positional args, required vs optional.
- **Behaviour** — what it does, side effects, file writes, network calls.
- **Exit codes** — when the CLI surfaces 0/non-0 (the CLI raises `CliError` with named codes; the process exits 1 on any thrown error).
- **JSON mode** — when applicable.

Hidden options/commands are marked **(hidden)** — they work but don't appear in `--help`.

---

## Global commands (always available)

### `wix login`

- **Flow**: every flow (registered last on every program).
- **Synopsis**: `wix login [options]`
- **Options**:
  - `--api-key <token>` — Authenticate using an API key for automations and CI environments.
  - `--refresh-token <token>` **(hidden)** — Authenticate using a refresh token; conflicts with `--api-key`.
- **Behaviour**:
  - With `--api-key`: writes `~/.wix/auth/api-key.json` and exits.
  - With `--refresh-token`: exchanges the token at `POST https://manage.wix.com/v1/oauth/token` and writes `~/.wix/auth/account.json`.
  - Bare (interactive): device-code OAuth flow — requests `POST /v1/oauth/device/code` (client ID `6f95cec8-3e98-48b9-b4e5-1fb92fcd9973`, scope `offline_access`), displays a verification URL + user code, polls `/v1/oauth/token` until the user approves, then writes `~/.wix/auth/account.json`.
  - **AI-agent detection**: when `@vercel/detect-agent` reports an AI agent, the bare invocation runs the non-interactive variant instead of opening the Ink UI.
- **Errors**: `FailedToGetDeviceCode`, `FailedToGetAuthToken`, `InvalidResponseData`.

### `wix logout`

- **Flow**: every flow.
- **Synopsis**: `wix logout`
- **Behaviour**: `rm -rf ~/.wix/auth/`. Deletes the legacy `~/.wix/auth.json` if present. Server-side refresh tokens are NOT revoked.

### `wix whoami`

- **Flow**: every flow.
- **Synopsis**: `wix whoami`
- **Behaviour**: Reads `~/.wix/auth/account.json` (or `~/.wix/auth/api-key.json`) and prints the email under `userInfo.email`. Non-zero exit if no auth file is present.

### `wix token`

- **Flow**: every flow.
- **Synopsis**: `wix token [options]`
- **Options**:
  - `-s, --site <site-id>` — Get a site-scoped access token. Value must be a valid UUID (`zod.string().uuid()`).
  - `--json` **(hidden)** — Output as `{"accessToken": "..."}`.
- **Behaviour**: Loads account auth, refreshes the token if expired, prints to stdout (no trailing newline beyond `\n`). For `--site`, calls `authenticateWithSiteId` server-side and caches the result at `~/.wix/auth/<siteId>.json`.
- **Exit non-zero**: `AuthenticationRequired` (no auth file).

### `wix telemetry <on|off>`

- **Flow**: every flow.
- **Synopsis**: `wix telemetry <state>`
- **Positional arg**: `state` — one of `on`, `off` (choices enforced by commander).
- **Behaviour**: Writes `~/.wix/user.config.json` with `{ telemetry: true|false }`. Prints `Telemetry has been turned <state> successfully.`.

---

## ASTRO flow commands

Visible only when `wix.config.json` declares a `projectType` (either `Site` or `App`) AND `astro.config.{js,cjs,mjs,ts}` exists. Provided by `@wix/cli-astro-commands` (bundled).

### `wix dev` (ASTRO)

- **Synopsis**: `wix dev [options]`
- **Options**:
  - `--port <port>` — Specify which port to run on. Defaults to `4321`. Parsed as `parseInt(value, 10)`.
  - `--allowed-hosts <allowedHosts>` — Comma-separated list of allowed hosts, or `all` for any hostname.
  - `--base-url <url>` **(hidden)** — Base URL for static files when uploaded to an external CDN. Must be a valid URL.
- **Behaviour**: Wraps the Astro dev server. Renders an Ink-based menu prompting the user to open the site/dashboard in a browser. Hot reload via Astro. For Wixy: this is a long-lived foreground process — fork it if you want to manage it.

### `wix build` (ASTRO)

- **Synopsis**: `wix build [options]`
- **Behaviour**: Spawns `astro build` via the project's package manager (`npm`/`yarn`/`pnpm`/`bun` — auto-detected from lockfile). Passes through ALL CLI args (commander is configured with `allowExcessArguments(true).allowUnknownOption(true).passThroughOptions(true)`), so `wix build --whatever` forwards to Astro.
- **Output**: Astro's normal build artefacts under `dist/` + writes `<project>/.wix/build-metadata.json`.

### `wix preview` (ASTRO)

- **Synopsis**: `wix preview [options]`
- **Options**:
  - `--base-url <url>` **(hidden)** — base URL for CDN-hosted statics.
  - `-l, --label <label>` **(hidden)** — Custom label for this preview (max 200 chars).
  - `--site <site>` **(hidden, deprecated)**.
  - `--json` **(hidden)** — Non-interactive JSON output (returns preview URL etc.).
- **Behaviour**: Uploads build output to Wix, creates a preview deployment, prints a shareable URL. Each preview URL points to an immutable snapshot — later previews don't affect older URLs.
- **Caveat**: Some extensions don't work in `preview`. Embedded scripts, site widgets, and site plugins are only wired up on `release` (Wix server requires an `appVersion` to register those).

### `wix release` (ASTRO)

- **Synopsis**: `wix release [options]`
- **Options**:
  - `-c, --comment <comment>` — Release comment, max 250 chars. Not visible to users; for your own logs.
  - `-t, --version-type <type>` — `major` or `minor` (choices enforced). Determines version bump.
  - `--base-url <url>` **(hidden)**.
  - `-l, --label <label>` **(hidden)**.
- **Behaviour**: Creates a new immutable app version (apps) or publishes a new version of the headless project (sites). Interactive prompt for `--version-type` if missing. The release command supersedes the older `create-version` command (removed in v1.1.68, 2025-02-23).

### `wix generate` (ASTRO)

- **Synopsis**: `wix generate [options]`
- **Options**:
  - `--type <type>` — Extension type to generate. Choices: `DASHBOARD_PAGE`, `DASHBOARD_MODAL`, `DASHBOARD_PLUGIN`, `DASHBOARD_MENU_PLUGIN`, `EMBEDDED_SCRIPT`, `CUSTOM_ELEMENT`, `SITE_PLUGIN`, `EVENT`, `SERVICE_PLUGIN`. Conflicts with `--params`.
  - `--params <json>` — Generate non-interactively from a JSON object. Conflicts with `--type`. Implies `--json`. Parsed via `JSON.parse`.
  - `--experimental` **(hidden)** — Include experimental generators in the picker.
  - `--json` **(hidden)** — Output result as `{success: true, ...}` or `{success: false, error: ...}` on stdout.
- **Subcommand (hidden)**: `wix generate manifest` — `createCommand("manifest")`. Regenerates extension manifest. Used internally during release.
- **Behaviour**: Reads templates from `<cli>/templates/astro/<extension-type>/files/*.ejs`, renders with the provided/prompted params, writes under `src/extensions/<route>/`. See [05-extensions.md](05-extensions.md) for the full schema of each extension type's params.

### `wix env` (ASTRO)

- **Synopsis**: `wix env [command]`
- **Default subcommand**: `pull` (so `wix env` ≡ `wix env pull`).
- **Subcommands**:

#### `wix env pull`

- **Synopsis**: `wix env pull`
- **Options**: `--json` **(hidden)** — emit env-vars JSON to stdout instead of writing the file.
- **Behaviour**: Fetches the project's server-side env vars from Wix, **merges** them into `<project>/.env.local` (doesn't replace).

#### `wix env set`

- **Synopsis**: `wix env set --key <key> --value <value>`
- **Required options**: `--key`, `--value` (both `requiredOption`; commander errors if missing).
- **Behaviour**: Writes a single env var to Wix's server-side storage. Visible to all collaborators on the project.

#### `wix env remove`

- **Synopsis**: `wix env remove --key <key>`
- **Required option**: `--key`.
- **Behaviour**: Deletes a single server-side env var.

### `wix connect` (ASTRO)

- **Synopsis**: `wix connect`
- **Behaviour**: Connects the project to GitHub so Wix Vibe (AI-assisted visual editing) can read the source. Opens an interactive OAuth flow in the browser to the Wix Vibe / GitHub install. No options.

### `wix skills` (ASTRO)

- **Synopsis**: `wix skills <command>`
- **Subcommands**:

#### `wix skills add`

- Adds Wix Vibe skills to the project. Internally shells out to `npx --yes skills add wix/skills -y` (NPX path overridable via `WIX_CLI_NPX_PATH` env var).

#### `wix skills update`

- Updates installed skills to the latest. Shells out to `npx --yes skills update`.

### `wix schema` (ASTRO)

- **Synopsis**: `wix schema [command]`
- **Subcommands**:

#### `wix schema generate`

- **Synopsis**: `wix schema generate [options]`
- **Options**:
  - `--type <type>` — Print the schema for a single extension type instead of the full schema. Choices: same as `wix generate --type`.
  - `--json` **(hidden, default `true`)** — Always JSON-formatted (this is the whole point of the command).
- **Behaviour**: Prints a JSON schema describing every supported extension type and its required inputs. Wixy can use this to build a generic "create extension" UI — fetch the schema, render a form, submit via `wix generate --params <json>`.
- **Requires**: Auth (errors with `AuthenticationRequired` if not logged in).

### `wix promote` (ASTRO, hidden)

- **Synopsis**: `wix promote [options]`
- **Options**:
  - `--base-url <url>` **(hidden)**.
  - `-l, --label <label>` **(hidden)**.
- **Behaviour**: Internal Wix-only operation to promote a preview to a release without going through the full interactive `release` flow. Not in `wix --help`. Don't depend on this in Wixy without confirming with Wix support.

### `wix translation` (ASTRO, hidden)

- **Synopsis**: `wix translation <command>`
- **Subcommands**:

#### `wix translation pull` (hidden)

- Pulls Wix Multilingual translations into `<project>/src/translations.json`. `--json` (hidden) for non-interactive output.

#### `wix translation push` (hidden)

- Pushes `<project>/src/translations.json` to Wix Multilingual. `--json` (hidden).

---

## Legacy APP flow commands (`wix app *`)

Visible when `wix.config.json` has `appId` but no astro config, AND `@wix/cli-app` is installed in the project. Provided by `@wix/cli-app` (loaded from project's `node_modules` — version-pinned to `@wix/cli`).

### `wix app dev`

- **Synopsis**: `wix app dev [options]`
- **Options**:
  - `-s, --https` — Start local dev server on HTTPS.
  - `--port <port>` — Specify which port the dev server should listen to. Validated to int in `[1000, 65535]`.
  - `--origin <url>` **(hidden)** — Override the dev origin (for tunneling proxies). Must be a valid URL.
- **Behaviour**: Starts a local Vite-based dev server, builds extensions, opens an Ink menu for the user to pick which extension to view on the development site.
- **Note**: Pressing `C` while running re-assigns the development site.

### `wix app build`

- **Synopsis**: `wix app build`
- **No options**. Builds the project's extensions for release. Output under `dist/`.

### `wix app preview`

- **Synopsis**: `wix app preview [options]`
- **Options**:
  - `-s, --site <site-id>` — Site ID to preview on. Defaults to the current selected development site. Accepts a UUID or the literal `current`.
  - `--base-url <url>` — Base URL for CDN-hosted statics.
  - `--json` **(hidden)** — JSON output.
- **Behaviour**: Uploads build output, registers extensions in preview mode, prints preview URL.

### `wix app generate`

- **Synopsis**: `wix app generate [options]`
- **Options**:
  - `--type <type>` — Extension type to generate. Same choices as ASTRO `wix generate`.
- **Behaviour**: Interactive Ink picker if no `--type`. Generates a new extension under `src/extensions/{dashboard,site,backend}/...`.

### `wix app logs`

- **Synopsis**: `wix app logs --version <x.y.z>`
- **Required option**: `--version` — must match semver regex `^(0|[1-9]\d*)\.(0|[1-9]\d*)(\.(0|[1-9]\d*))?$`.
- **Behaviour**: Streams production logs from Wix's server for the named app version. Useful for debugging issues post-release.

### `wix app release`

- **Synopsis**: `wix app release [options]`
- **Options**:
  - `-s, --site <site-id>` — Site to release for (default: current selected dev site). `current` literal accepted.
  - `--base-url <url>` — CDN base URL.
  - `-c, --comment <comment>` — Release comment, max 250 chars.
  - `-t, --version-type <type>` — `major` or `minor`.
  - `--json` **(hidden)** — Non-interactive JSON output.

### `wix app serve` **(hidden)**

- **Synopsis**: `wix app serve`
- **Behaviour**: Deprecated `serve` command. Internal. Prints a `ServeCommandDeprecated` Ink component telling the user to use `dev` instead.

### `wix app add-permission` **(hidden)**

- **Synopsis**: `wix app add-permission [-p <id>]`
- **Options**: `-p, --permission-id <id>`.
- **Behaviour**: Adds a Wix permission to the app's manifest. Internal tool.

---

## Modern SITE flow commands

Visible when `wix.config.json` has `siteId` (UUID) and no `uiVersion`. Provided by `@wix/cli-site` (bundled).

### `wix dev` (SITE)

- **Synopsis**: `wix dev [options]`
- **Description**: "Open the Local Editor that runs your local code"
- **Options**:
  - `--tunnel` — Open an HTTPS tunnel for the local dev server. Useful for testing webhooks or accessing dev server from another machine.
- **Behaviour**: Launches the Local Editor (Wix's local editing UI for Velo sites) wired to the local code.

### `wix preview` (SITE)

- **Synopsis**: `wix preview [options]`
- **Description**: "Create a shareable version of your site before going live"
- **Options**:
  - `-f, --force` — Skip build errors and proceed.
- **Behaviour**: Creates a preview deployment of the site.

### `wix publish` (SITE)

- **Synopsis**: `wix publish [options]`
- **Description**: "Publish your site to production"
- **Options**:
  - `-y, --approve-preview` — Approve preview automatically (conflicts with `--force`).
  - `-f, --force` — Skip build errors.
- **Behaviour**: Publishes the site live.

### `wix install [package]` (SITE)

- **Synopsis**: `wix install [package]`
- **Description**: "Install a supported NPM package"
- **Argument**: optional npm package name. Without it, interactively pick from supported packages.
- **Behaviour**: Installs a package from Wix's curated allow-list (not arbitrary npm packages). Updates `wix.lock`.

### `wix uninstall <package>` (SITE)

- **Synopsis**: `wix uninstall <package>`
- **Description**: "Uninstall an NPM package"
- **Argument**: required package name.

---

## Legacy SITE / Velo flow commands

Visible when `wix.config.json` has `siteId` + `uiVersion`. Provided by `@wix/cli-site-old` (bundled). Superset of the modern SITE flow.

### `wix dev` (SITE-OLD)

- **Synopsis**: `wix dev [options]`
- **Options**:
  - `-s, --https` — Start local dev server on HTTPS.
  - `--tunnel` **(hidden)** — HTTPS tunnel. Conflicts with `--https`.

### `wix preview` (SITE-OLD)

- **Options**:
  - `-f, --force`.
  - `--source <local|remote>` — Where to read the source code from for the preview. Choices: `local`, `remote`.

### `wix publish` (SITE-OLD)

- **Options**:
  - `--source <local|remote>` — Where to read source from.
  - `-y, --approve-preview` — Auto-approve.
  - `-f, --force` — Skip errors.

### `wix install [package]` (SITE-OLD)

- Options: `--yarn`, `--npm` — pick the package manager explicitly.

### `wix uninstall <package>` (SITE-OLD)

- Options: `--yarn`, `--npm`.

### `wix sync-types` **(hidden)**

- **Synopsis**: `wix sync-types`
- **Behaviour**: Regenerates TypeScript definitions for Velo APIs based on the current `uiVersion`. Internal, used during install/upgrade.

---

## SITE-LIVE flow commands

Visible when `wix.config.json` has `siteId` + `veloAppId` AND env var `WIX_CLI_SITE_LIVE=true`. Provided by `@wix/cli-site-live`.

### `wix dev` (SITE-LIVE)

- **Synopsis**: `wix dev`
- **Behaviour**: "Site Live dev command" — the only command in this flow. No options. Internal Wix feature, not generally exposed.

---

## Help & version

These are commander built-ins available everywhere:

- `wix --help` / `wix -h` — flow-dependent listing of available commands.
- `wix --version` / `wix -v` — prints the @wix/cli version (e.g. `1.1.197`).
- `wix help [command]` — commander's auto-generated help. Note: the top-level program *disables* the help command (`helpCommand(false)`) but child commands may still have it.

## Hidden top-level option: `--json`

Several commands respect a hidden `--json` flag for non-interactive output. The flag name is `--json` (literally `NO_TTY_JSON_OUTPUT_OPTION` in the source). It only does something on commands that wire it up; on others it's accepted but ignored.

Commands that *do* honour `--json`:

- ASTRO: `preview`, `release`, `generate` (when paired with `--params`), `env pull`, `translation pull`, `translation push`, `schema generate` (default), `token`.
- Legacy APP: `app preview`, `app release`.

See [06-automation-for-wixy.md](06-automation-for-wixy.md#json-output-mode) for the exact JSON shapes.

## Command-name conflict gotcha

Both ASTRO flow and SITE-old flow expose a command called `install`/`uninstall` — but they do completely different things:

- **SITE `install`**: installs a Wix-curated npm package + updates `wix.lock`.
- (Legacy) **APP** has no `install`/`uninstall`.

There is no `install` command on the ASTRO flow.

Similarly `dev`, `preview`, `release` exist in multiple flows with **different options and different semantics** (e.g. SITE `preview` has `-f, --force`; ASTRO `preview` has hidden `--base-url` and `--label`; APP `preview` has `-s, --site`).

For Wixy: **never assume an option exists by name across flows.** Always check `wix.config.json` first, then drive the flow-correct option set.
