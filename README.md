# AdTrack

Ask one plain-language question about your ChatGPT ads and get one answer:
spend → leads → customers → revenue → where. Plus a context-hint research
workspace, because ChatGPT Ads has no keyword targeting.

## Status

Working single-page app on a single Node API. It runs on **demo data** until keys
exist on the server, then switches to the **live** account. Every route except the
tracking handshake (`/api/session`, `/api/consent`, `/api/track`) and the shallow
`GET /api/health` requires an auth token. The one-page rule survives login: the sign-in
screen is an overlay, not a route.

Production refuses to start without `AUTH_MODE=firebase`; dev auth refuses to start at all
when an ad account key is set on the same process, because dev auth hands a write role to
anyone who can reach it. Token storage, the consent handshake, roles and the CSP are
documented once, in [docs/SECURITY.md](docs/SECURITY.md).

`npm run verify` is the gate: lint, format, typecheck, tests, build, and three
run-it-for-real checks (server guards, production start-up guards, push/undo e2e).
CI runs the same command on every push.

## Run it

```bash
npm install
cp .env.example .env     # fill in the keys you actually have
npm run api              # API on 0.0.0.0:8787
npm run dev              # web app on 0.0.0.0:5173, proxies /api
npm run verify           # the full gate
```

Open the app. The bar under the search box says **Demo data** or
**live · <account>**; click it for key presence, auth state and a retry.

## How it works

```
browser ──/api/*──▶ server/server.mjs ──▶ OpenAI Ads API
                     keys + consent secret
```

The browser never holds an OpenAI key. `VITE_*` variables are public by
definition, so no secret uses that prefix.

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/health` | public | `{ok, mode}` only; details need a token |
| `POST /api/session` | public, origin-checked | short-lived session, step 1 of consent |
| `POST /api/consent` | session id | returns a signed, single-use consent id |
| `POST /api/track` | consent id | **low-value browser events only**; origin allowlist, rate limit, body cap |
| `POST /api/events` | HMAC ingest key | leads, orders and amounts, server-to-server, rotatable key |
| `GET /api/audit` | token | push history, failures included (`?ok=false`) |
| `GET /api/dataset` | token | insights → dataset in integer minor units |
| `GET /api/adgroups` | token | current hint sets |
| `POST /api/adgroups/:id/hints` | token, **admin/owner** | replaces hints, returns the previous set |
| `POST /api/dev/session` | dev mode only | 404 in production |

Details in [docs/API.md](docs/API.md).

## Multi-tenant foundation

The app now sits on an agency-shaped model: **organization → workspace (one per client) →
sources, campaigns, topics, leads**. Every route under `/api/orgs` resolves the tenant from
the caller's membership, never from the request, and a foreign or nonexistent id returns an
identical `404`. The **Workspace** button in the header opens a read-only panel showing the
workspace's currency/zone/markets, your role and permissions, the summary, and the
campaigns, topics, leads and sources the server actually holds — with unmeasured metrics
labelled `unavailable` rather than shown as zero.

| Document | What it settles |
|---|---|
| [docs/BASELINE_AND_GAPS.md](docs/BASELINE_AND_GAPS.md) | What the baseline contained, what was fixed, what is still UNKNOWN |
| [docs/AGENCY_MODEL.md](docs/AGENCY_MODEL.md) | Hierarchy, roles, permissions, every agency route |
| [docs/EVENT_SCHEMA.md](docs/EVENT_SCHEMA.md) | The eight-step lead lifecycle, idempotency, qualification trust, attribution |
| [docs/CONNECTORS.md](docs/CONNECTORS.md) | The connector contract — documented only; no provider integration exists |
| [docs/GLOBALIZATION.md](docs/GLOBALIZATION.md) | Countries, currencies, IANA zones, DST |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Collections, indexes, migrations, rollback |

## The interface

One page, modelled on search rather than a dashboard. On submit the box docks to the
top and the answer renders inline — no routes, no tabs. The question lives in the URL
(`?q=…&m=track`), so answers are shareable, and an unrecognised question falls back to
a full-funnel overview.

Answers cover spend, leads, CPL, CAC, ROAS, pacing, country, device, campaign and
ad-group rankings, plus "why do native and internal conversions differ". Every answer
carries its sources and a "where these numbers come from" panel.

## Research (the honest version of "keyword research")

ChatGPT Ads has no keyword box, no negatives and no search-terms report — only
free-form **context hints** at ad-group level. So research is:

`seeds → PII scrub + dedupe → intent tag → semantic cluster → weighted score → conversation-shaped hints → validators → CSV or push`

Pushing is a two-step operation: a diff modal (current vs proposed, with counts), an
explicit confirm, then an **Undo** that re-pushes the previous set. Every attempt —
successful or failed, with the actor and the upstream error — is audited server-side.
The push control is disabled for `analyst`/`viewer`, using the role the server reports in
`/api/health` (`auth.canWrite`), not a client-side guess.

The score shown next to a cluster is the sum of its displayed parts (relevance, intent,
size, coverage, safety × weights), and the panel prints the arithmetic. It does not claim
to use first-party conversion data, because none is connected: no fabricated inputs, no
made-up "researchable seeds" count.

## Stack

React 18 · Vite 6 · TypeScript (strict) · Tailwind 3 · Vitest + jsdom ·
Node 22 API (`node:http`, no framework) · ESLint + Prettier · GitHub Actions.

`firebase-admin` is an **optionalDependency**, imported only when `AUTH_MODE=firebase`;
the demo and the test suite run without it. The browser signs in over Firebase's public
REST endpoints (no SDK in the bundle) and keeps the token in `sessionStorage` — never
`localStorage`, never a cookie. Consent recording and push history sit behind one storage
interface with in-memory and Firestore implementations.

## Deploy

The API is stateless and ships as a container (non-root, healthcheck, tini):

```bash
gcloud run deploy adtrack-api --source . --region asia-south1 \
  --set-secrets OPENAI_ADS_API_KEY=ads-key:latest,OPENAI_CONVERSIONS_API_KEY=capi-key:latest,OPENAI_PIXEL_ID=pixel-id:latest,CONSENT_SECRETS=consent-secrets:latest,INGEST_KEYS=ingest-keys:latest \
  --set-env-vars AUTH_MODE=firebase,STORAGE=firestore,TRUST_PROXY=1
```

Serve `dist/` from the **same origin** as the API, reverse-proxying `/api` to the
container. Same origin is a decision, not a default: no CORS headers are sent, so the
browser's CSP stays `connect-src 'self'` and the page only ever calls relative URLs.
Putting the API on another domain means adding CORS *and* widening the CSP together.

## Docs

| File | Contents |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Review, architecture, slices, risks |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature research: what shipped, demo vs live-verified |
| [docs/API.md](docs/API.md) | Endpoints, guards, deployment, what is not verified |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth, roles, consent handshake, token storage, CSP, storage interface, verified/unverified |
| [docs/METRICS.md](docs/METRICS.md) | Metric dictionary and attribution windows |
| [docs/TRACKING_PLAN.md](docs/TRACKING_PLAN.md) | Events, dedupe, cookies, delivery guards |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Data map, consent, retention, roles |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision log |
| [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md) | How the build was split, and the contracts |

Rules of engagement, all enforced in code: no secrets in the repo; the browser never
sees an API key; native and internal attribution are never blended; money is integer
minor units; geography is aggregated to city level; nothing is pushed to an ad account
without a diff, a confirm and an audit trail.
