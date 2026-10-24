# AdTrack

Ask one plain-language question about your ChatGPT ads and get one answer:
spend → leads → customers → revenue → where. Plus a context-hint research
workspace, because ChatGPT Ads has no keyword targeting.

## Status

Working single-page app on a single Node API. It runs on **demo data** until keys
exist on the server, then switches to the **live** account. Every route except
`POST /api/track` and `GET /api/health` requires an auth token; production
(`NODE_ENV=production`) refuses to start without `AUTH_MODE=firebase`.

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
| `POST /api/consent` | public, origin-checked | returns a signed consent id |
| `POST /api/track` | consent id | origin allowlist, per-IP rate limit, body cap |
| `GET /api/dataset` | token | insights → dataset in integer minor units |
| `GET /api/adgroups` | token | current hint sets |
| `POST /api/adgroups/:id/hints` | token, **admin/owner** | replaces hints, returns the previous set |
| `POST /api/dev/session` | dev mode only | 404 in production |

Details in [docs/API.md](docs/API.md).

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
explicit confirm, then an **Undo** that re-pushes the previous set. Every attempt is
appended to an audit log.

## Stack

React 18 · Vite 6 · TypeScript (strict) · Tailwind 3 · Vitest + jsdom ·
Node 22 API (`node:http`, no framework) · ESLint + Prettier · GitHub Actions.

Firebase is **not** in the runtime path yet: there is no browser auth and no Firestore.
`firebase-admin` is a dependency only for verifying ID tokens when `AUTH_MODE=firebase`.

## Deploy

The API is stateless and ships as a container (non-root, healthcheck, tini):

```bash
gcloud run deploy adtrack-api --source . --region asia-south1 \
  --set-secrets OPENAI_ADS_API_KEY=ads-key:latest,OPENAI_CONVERSIONS_API_KEY=capi-key:latest,OPENAI_PIXEL_ID=pixel-id:latest,CONSENT_SECRET=consent-secret:latest
```

Build the web app separately and serve `dist/` from a static host, with
`VITE_API_BASE` pointing at the API (or front both with one domain and keep `/api`).

## Docs

| File | Contents |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Review, architecture, slices, risks |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature research: what shipped, demo vs live-verified |
| [docs/API.md](docs/API.md) | Endpoints, guards, deployment, what is not verified |
| [docs/METRICS.md](docs/METRICS.md) | Metric dictionary and attribution windows |
| [docs/TRACKING_PLAN.md](docs/TRACKING_PLAN.md) | Events, dedupe, cookies, delivery guards |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Data map, consent, retention, roles |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision log |
| [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md) | How the build was split, and the contracts |

Rules of engagement, all enforced in code: no secrets in the repo; the browser never
sees an API key; native and internal attribution are never blended; money is integer
minor units; geography is aggregated to city level; nothing is pushed to an ad account
without a diff, a confirm and an audit trail.
