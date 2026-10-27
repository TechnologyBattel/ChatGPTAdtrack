# AI AdTracker

AI-assisted ad attribution and campaign analytics for agencies and marketing teams.

AI AdTracker answers plain-language questions about ChatGPT Ads performance — spend, leads,
cost per lead, CAC, ROAS, pacing, country and device breakdowns, campaign and ad-group
rankings, and why native and internal conversion counts differ — and gives you a
context-hint research workspace, because ChatGPT Ads has no keyword targeting.

> [!IMPORTANT]
> **Project status: pre-release, not deployed.** The application runs and is covered by an
> automated suite (unit, component, browser and supply-chain gates in CI), but it has never
> been exercised against a real OpenAI Ads account, a real HubSpot portal or a real Firestore
> project. Section [Status](#status) states exactly what is verified and what is not.

## Contents

- [Who it is for](#who-it-is-for)
- [What it does today](#what-it-does-today)
- [Status](#status)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [Architecture](#architecture)
- [Security and privacy](#security-and-privacy)
- [Known limitations](#known-limitations)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Who it is for

Agencies and in-house marketing teams that manage client campaigns and need to connect ad
spend to qualified leads and revenue. The data model is agency-shaped: an **organization**
contains one **workspace per client**, and each workspace holds its own sources, campaigns,
topics, leads and members. Every request resolves its tenant from the caller's membership,
never from the request body, so a client's data cannot be read from another client's session.

## What it does today

**Ask a question, get an answer.** One search box, no dashboards to configure. On submit the
box docks to the top and the answer renders inline. Answers cover spend, impressions, clicks,
CTR, CPC, CPM, leads, CPL, CAC, ROAS, budget pacing, country and device breakdowns, campaign
and ad-group rankings, and the native-versus-internal attribution gap. Every answer lists its
sources and a "where these numbers come from" panel. The question is stored in the URL
(`?q=…&m=track`), so an answer is shareable and re-openable.

**Context-hint research.** ChatGPT Ads has no keywords, no negatives and no search-terms
report — only free-form context hints at ad-group level. The research workspace runs
`seeds → PII scrub and dedupe → intent tag → semantic cluster → weighted score →
conversation-shaped hints → validators → CSV or push`. The displayed score is the sum of its
displayed parts and the panel prints the arithmetic. Pushing is two-step: a diff of current
versus proposed hints, an explicit confirm, then an **Undo** that re-pushes the previous set.
Every attempt, successful or not, is audited server-side.

**Guided research reports.** In research mode the server computes a report from the
workspace's own records and labels every section `observed`, `none found` or
`not measurable yet`. There is no progress percentage anywhere; unmeasured metrics are shown
as `unavailable`, never as zero.

**Attribution and lead lifecycle.** A consent handshake (`/api/session` → `/api/consent` →
`/api/track`) records low-value browser events, and a separate HMAC-authenticated endpoint
(`/api/events`) accepts leads, orders and amounts server-to-server. Lead lifecycle,
idempotency, qualification trust and attribution windows are documented in
[docs/EVENT_SCHEMA.md](docs/EVENT_SCHEMA.md) and [docs/METRICS.md](docs/METRICS.md).

**Read-only HubSpot connector.** Connect a HubSpot portal with two read scopes, import
contacts as leads, and import a deal stage as a qualification only when the source is trusted
and the stage is one you listed. Without credentials the feature is not hidden: the UI says
the server is not configured and names the missing variables.

**Private Research Mode (off by default).** An operator can enable a mode where an editor,
admin or owner supplies a per-run provider key and seed terms. The key is held in memory for
the request only, never persisted, never written to the audit log; seeds and responses are
not stored. It stays disabled unless `PRIVATE_RESEARCH_ENABLED=true` is set on the server, and
it uses fixed provider and model allowlists — there are no custom base URLs. See
[docs/PRIVATE_RESEARCH_MODE.md](docs/PRIVATE_RESEARCH_MODE.md).

## Status

**What is verified**

- Unit, component and server tests, type checking, linting, formatting, production build,
  server guard checks, push/undo against a stub, supply-chain (licence, vulnerability, SBOM)
  and a browser suite run in CI on every push and pull request.
- The application is exercised end to end through its own HTTP server against a **stub** of
  the OpenAI Ads API. That proves this repository's code, not OpenAI's contract.
- The consent handshake, role enforcement, tenant isolation and the demo/live switch have
  tests that fail when the behaviour regresses.

**What is not verified — treat as UNKNOWN**

- Any call to the **real** OpenAI Ads API. No ad account or credentials exist for this
  project, and the product never invents a connector.
- **Firestore** storage: the same storage interface is tested against an in-memory store; the
  Firestore implementation has never run against a real project.
- A **live HubSpot installation**. The connector is tested against a fake provider only.
- **Deployment, load and recovery**: nothing is deployed, no load test has been run, and no
  backup or restore has been exercised.
- **Private Research Mode against a real provider** — the request path is implemented and
  tested with a stub provider; it has not been run with a real key.
- Legal sufficiency of the consent and retention choices. A consent banner is not evidence of
  GDPR or DPDP compliance.

The honest per-item breakdown, including the gaps that remain open on purpose, is in
[docs/BASELINE_AND_GAPS.md](docs/BASELINE_AND_GAPS.md) and
[docs/STAGING.md](docs/STAGING.md).

## Quick start

Requires Node.js `>=22` (see `.nvmrc`) and npm `>=10`.

```bash
npm ci                   # install exactly what CI installs
cp .env.example .env     # fill in only the keys you actually have
npm run api              # API on 0.0.0.0:8787
npm run dev              # web app on 0.0.0.0:5173, proxies /api
```

Open http://localhost:5173. The bar under the search box reads **Demo data** or
**live · <account>**; click it to see key presence, auth state and a retry control.

With no keys configured the app runs on **deterministic demo data**. It switches to the live
account only when keys exist on the server. Demo mode is a real, tested mode — the numbers are
deterministic fixtures, not fabricated live responses.

## Configuration

All secrets are server-side. `VITE_*` variables are public by definition, so no secret uses
that prefix; the browser never holds an ad-account or provider key. Every variable, its
default and its effect is listed in `.env.example` and [docs/OPERATIONS.md](docs/OPERATIONS.md).

The two settings that matter for a first run:

| Variable | Effect |
|---|---|
| `AUTH_MODE` | `dev` hands a write role to anyone who can reach the server. Production refuses to start unless this is `firebase`, and dev auth refuses to start at all when an ad-account key is set on the same process. |
| `STORAGE` | `memory` keeps everything in-process; `firestore` needs a Google Cloud project. |

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Clean install from `package-lock.json` |
| `npm run verify` | The full gate: lint, format check, typecheck, unit tests, build, server guard checks, production start-up guards, push/undo against a stub, Dockerfile static checks, supply-chain self-test |
| `npm run test` | Vitest unit and component tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `npm run format:check` | ESLint / Prettier |
| `npm run build` | Typecheck then production bundle into `dist/` |
| `npm run e2e` | Playwright browser suite; run `npx playwright install chromium` once first |
| `npm run supply-chain` | Licence, vulnerability and SBOM gate against `security/*.json` allowlists |
| `npm run load:smoke` | Local smoke load script — a tool, not a capacity measurement |

CI runs the same checks in four jobs: verify, supply-chain, browser end-to-end, and a container
job that builds the image, asserts it runs as a non-root user and checks graceful shutdown.

## Architecture

```
browser ──/api/*──▶ server/server.mjs ──▶ OpenAI Ads API
                     keys + consent secret      HubSpot (read-only)
                     storage interface ──▶ memory | Firestore
```

A React 18 single-page app (Vite, TypeScript strict, Tailwind) served from the same origin as
a Node HTTP API with no framework. Same origin is a decision, not a default: no CORS headers
are sent, the CSP stays `connect-src 'self'`, and the page only ever calls relative URLs.
`firebase-admin` is an optional dependency imported only when `AUTH_MODE=firebase`, so demo
mode and the test suite run without it.

The endpoint list, guards and the not-verified notes live in [docs/API.md](docs/API.md).

## Security and privacy

- The browser never receives an ad-account or provider key; keys live in server environment
  secrets only.
- Production refuses to start without Firebase auth, and the dev-auth configuration refuses to
  run alongside real ad-account credentials.
- Tenant isolation is server-derived: organization and workspace ids in a URL must match the
  caller's membership, and a foreign or nonexistent id returns an identical `404`.
- Roles are read from the server's own response (`auth.canWrite`), never guessed client-side.
- Native and internal attribution are never blended; money is stored as integer minor units.
- Nothing is pushed to an ad account without a diff, an explicit confirm and an audit trail.

Details, including what is verified versus assumed: [docs/SECURITY.md](docs/SECURITY.md) and
[docs/PRIVACY.md](docs/PRIVACY.md). To report a vulnerability, see [SECURITY.md](SECURITY.md) —
please do not open a public issue for a security problem.

## Known limitations

- Deterministic demo data until keys are configured; there is no live account in this repo.
- No keyword targeting exists in ChatGPT Ads, so "research" means context hints, and the
  scoring is transparent arithmetic — it does not use first-party conversion data.
- The HubSpot connector is read-only and covers contacts and one deal stage.
- Private Research Mode is disabled by default and is not a general-purpose LLM proxy.
- No load, capacity or recovery numbers are claimed anywhere in this repository.
- Third-party licence obligations are summarised in
  [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md); it is a report, not a legal opinion.

## Documentation

| Document | Contents |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Review, architecture, slices, risks |
| [docs/API.md](docs/API.md) | Endpoints, guards, deployment, unverified areas |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth, roles, consent handshake, token storage, CSP |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Data map, consent, retention, roles |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Environment, runbook, recovery, limitations |
| [docs/BASELINE_AND_GAPS.md](docs/BASELINE_AND_GAPS.md) | What the baseline contained, what is still UNKNOWN |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature research: what shipped and how it was verified |
| [docs/AGENCY_MODEL.md](docs/AGENCY_MODEL.md) | Hierarchy, roles, permissions, agency routes |
| [docs/EVENT_SCHEMA.md](docs/EVENT_SCHEMA.md) | Lead lifecycle, idempotency, attribution |
| [docs/CONNECTORS.md](docs/CONNECTORS.md) | Connector contract and HubSpot verification status |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Collections, indexes, migrations, rollback |
| [docs/METRICS.md](docs/METRICS.md) | Metric dictionary and attribution windows |
| [docs/TRACKING_PLAN.md](docs/TRACKING_PLAN.md) | Events, dedupe, cookies, delivery guards |
| [docs/GLOBALIZATION.md](docs/GLOBALIZATION.md) | Countries, currencies, IANA zones, DST |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision log |
| [docs/STAGING.md](docs/STAGING.md) | What would have to be true for staging to be validated |
| [docs/PRIVATE_RESEARCH_MODE.md](docs/PRIVATE_RESEARCH_MODE.md) | Private research scope, controls and disclosures |
| [docs/PHASE2_REPORT.md](docs/PHASE2_REPORT.md) · [docs/PHASE3_PRODUCTION_READINESS_REPORT.md](docs/PHASE3_PRODUCTION_READINESS_REPORT.md) · [docs/PHASE4_STAGING_VALIDATION_REPORT.md](docs/PHASE4_STAGING_VALIDATION_REPORT.md) | Historical phase evidence, kept as dated records rather than current claims |

## Contributing

Development setup, conventions and pull-request expectations are in
[CONTRIBUTING.md](CONTRIBUTING.md). Participation is covered by
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

**No license has been chosen yet.** This repository contains no `LICENSE` file and no license
statement in `package.json`, so no rights to reuse, modify or redistribute this code are
granted. The owner is deciding between a permissive open-source license, Apache-2.0, and a
proprietary/no-public-license model. Until that decision is recorded, treat the code as
all-rights-reserved.

Third-party dependencies are separately licensed; see
[docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).
