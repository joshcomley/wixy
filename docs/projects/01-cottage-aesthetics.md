# Project 01 — Cottage Aesthetics

First project connected to Wixy, used as a real-world reference for the management portal's MVP.

## Site facts

| Field | Value |
|---|---|
| Site name | `cottage-aesthetics-1` |
| Display name | Cottage Aesthetics |
| Site ID | `c67e9533-423b-4a65-9adc-4dc8fa392ddd` |
| Account ID | `4829bbd6-7d29-4ef3-86c2-1a2736565192` |
| Owner email | cottageaestheticshartlebury@gmail.com |
| Live URL | https://www.cottageaesthetics.co.uk/ |
| Dashboard | https://manage.wix.com/dashboard/c67e9533-423b-4a65-9adc-4dc8fa392ddd |
| Editor type | **`EDITOR`** (regular Wix Editor — **not Velo / not Studio / not headless**) |
| Namespace | `WIX` |
| Locale | `en-GB`, currency `GBP`, timezone `Europe/London` |
| Vertical | Health & Wellness → Aesthetician |
| Created | 2025-10-21 |
| Last update | 2025-10-28 |
| Published | yes |
| Premium plan | yes |
| Domain connected | yes |

## Verticals enabled (REST endpoint probes)

| Vertical | Endpoint probed | Status |
|---|---|---|
| Site List | `POST /site-list/v2/sites/query` | 200 — works |
| Site Properties | `GET /site-properties/v4/properties` | 200 |
| Contacts | `POST /contacts/v4/contacts/query` | 200 (1 contact: owner) |
| Members | `POST /members/v1/members/query` | 200 |
| Bookings | `POST /bookings/v2/services/query` | 200 (0 services configured) |
| Stores | `POST /stores/v1/products/query` | 200 |
| Blog | `POST /blog/v3/posts/query` | 401 — not enabled |
| Forms (this path) | `POST /forms/v4/submissions/search` | 404 — wrong endpoint or not enabled |

The site has been set up but business data (bookings services, store products) is mostly empty — this is a near-greenfield Wix site.

## What managing this site looks like

Because the site's `editorType` is `EDITOR`, **the Wix CLI does not apply**. There is no local code workflow, no `wix.config.json`, no Velo source tree. Wixy will manage this site entirely through the Wix REST API:

- `https://www.wixapis.com/site-list/v2/*` — site discovery
- `https://www.wixapis.com/site-properties/v4/*` — site metadata
- `https://www.wixapis.com/contacts/v4/*` — contact CRM
- `https://www.wixapis.com/members/v1/*` — members
- `https://www.wixapis.com/bookings/v2/*` — booking services + sessions
- `https://www.wixapis.com/stores/v1/*` — products + orders
- `https://www.wixapis.com/business-tools/*` — analytics, etc.

Auth pattern: API-key header

```
Authorization: <api-key-IST-token>
wix-site-id:   c67e9533-423b-4a65-9adc-4dc8fa392ddd
wix-account-id: 4829bbd6-7d29-4ef3-86c2-1a2736565192   (for account-scoped calls)
```

The key is **identity.type=application** (not a personal user token) and **tenant.type=account** — so it acts as a service identity inside the account, with whatever permissions the user granted when minting it.

## Credentials

The API key lives in `<repo>/.env.local` (gitignored) as `WIX_API_KEY=…`. Mirroring it into `~/.wix/auth/api-key.json` is unnecessary for this site since the CLI won't be used on it.

**The current key was leaked into chat history and must be rotated** at `https://manage.wix.com/account/api-keys`. Once rotated, replace the value in `.env.local`.

## Implications for Wixy's architecture

This site is the realistic baseline customer: a small business, regular Wix Editor, bookings + stores enabled, no code, single-site account. The Wixy MVP should:

1. **Be REST-first.** The Wix CLI is a developer-tool layer that only fires for Wix Apps / Velo / Studio-with-code / headless projects. The vast majority of Wix-using small businesses will look like Cottage Aesthetics.
2. **Maintain CLI integration anyway.** A subset of Wixy's eventual customer base (agencies, developers) will have code-based projects, and the CLI reference in [`docs/wix-cli/`](../wix-cli/) is the source of truth for that subset.
3. **Treat the per-site dashboard as the primary UX**, with cross-site rollups (totals across an account's many sites) as the value-add over `manage.wix.com`.

## What we'd want to do FOR Cottage Aesthetics

A useful Wixy MVP for this exact customer might surface:

- Booking calendar overview (once services are created).
- Contact / member growth over time.
- Product / orders feed (Wix Stores).
- A "site health" snapshot — published status, last update, domain status, premium tier.
- Quick deep-links into the right Wix dashboard page for each section.

None of this needs the Wix CLI.
