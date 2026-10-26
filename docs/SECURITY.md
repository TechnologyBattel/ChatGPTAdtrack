# Security model

Single source of truth for how this app authenticates, authorises, stores consent
and holds credentials. Other docs link here instead of repeating it.

Scope: what the code enforces today, what a test proves, and what is still
unverified. Anything in the last column is a known gap, not a claim.

## 1. Credentials and where they live

| Secret | Lives | Never |
|---|---|---|
| `OPENAI_ADS_API_KEY`, `OPENAI_CONVERSIONS_API_KEY`, `OPENAI_PIXEL_ID` | server process env / Cloud Run secret | in the bundle, in a response, in a log line |
| `CONSENT_SECRETS` | server process env / secret | in the browser |
| Firebase **Web** API key (`VITE_FIREBASE_API_KEY`) | browser bundle | treated as a secret: it is public by design and grants nothing without a password |
| Auth token | `sessionStorage`, memory fallback | `localStorage`, cookies |

The server refuses to start in `AUTH_MODE=dev` when any of the three OpenAI values is
set. Dev auth mints a write-capable token for anyone who can reach
`POST /api/dev/session`; pointing that at a real ad account would be an unauthenticated
write path. The combination is a startup error, not a warning
(`config.mjs`, proven by `src/lib/__tests__/config.test.ts` and
`scripts/check-prod-guards.mjs`).

## 2. Auth modes

| `AUTH_MODE` | Token source | Allowed when |
|---|---|---|
| `dev` | `POST /api/dev/session` returns the shared `DEV_AUTH_TOKEN` (or a generated one printed at startup) | local only; refused under `NODE_ENV=production` and with any ad account key |
| `firebase` | Firebase ID token, verified by `firebase-admin` with revocation checking | production |

Roles come from the Firebase `role` custom claim: `viewer` → `analyst` → `admin` →
`owner`. Unknown or missing claim ⇒ `viewer`. Only `admin` and `owner` may write.
`firebase-admin` is an **optionalDependency**, imported lazily and only when
`AUTH_MODE=firebase`; if it is missing, startup fails with
`AUTH_MODE=firebase but firebase-admin is not installed` rather than an unhandled
module error (`createAdminLoader`, proven in `security.test.ts`).

### First-admin bootstrap

Nobody can promote themselves: the app has no role-editing route on purpose. To create
the first owner:

1. Invite the person in the Firebase console (or have them sign in once).
2. From a machine holding a service account key:

   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa.json \
     npm run set-role -- owner@example.com owner --project my-project
   ```

3. They sign in again. `set-role.mjs` sets the claim **and revokes refresh tokens**, so
   an existing session cannot keep a stale `viewer` claim for the rest of the hour.

`npm run set-role -- --help` lists roles and flags. `--revoke` removes the claim;
`--dry-run` prints the before/after claims without writing.

## 3. Tracking consent: who can obtain a consent id

Anyone who can reach `POST /api/session` from an allowed origin, then `POST /api/consent`
with `granted: true`. That is deliberate — the visitor's own browser is the only party
that can grant consent, and there is no account to authenticate a visitor against.
Safety therefore comes from constraints, not secrecy:

| Constraint | Value | Where |
|---|---|---|
| session required first, bound to the **user agent** (IP recorded, not enforced) | 30 min (`SESSION_TTL_SECONDS`) | `consent.createSession` |
| consent id bound to that one session | — | `payload.sid` + store record |
| consent id lifetime | 15 min (`CONSENT_TTL_SECONDS`) | `payload.exp` |
| single use, consumed only after delivery | claim → forward → consume | `store.consents.claim` / `consume` |
| origin allowlist on both routes | `TRACK_ORIGINS` | `assertOrigin` |
| per-IP rate limit on both routes | `RATE_LIMIT_PER_MINUTE` | `createRateLimiter` |

A replay, a use from another session, an expired id, a retired signing key and a forged
signature all produce a stable error code:

`session_required` · `session_invalid` · `consent_required` · `consent_invalid` ·
`consent_expired` · `consent_scope_missing` · `consent_unknown` ·
`consent_session_mismatch` · `consent_replayed`

Consent is **not** a boolean. `consent: true` in an event body is rejected with
`403 consent_required`, because a client can always send `true`.

The user agent is hashed and stored with the session; presenting the session from a
different user agent is `403 session_client_mismatch`. The IP is stored and compared, but
a change is only reported (`ipChanged`) — refusing on it breaks commuters and shared NATs,
where the address is not a stable property of the person. That makes the binding a real
claim in this document rather than an aspiration.

A consent id is **claimed** for an attempt, not burned by it: the record gets
`pendingAt`, a second concurrent attempt is `403 consent_in_flight`, and only an upstream
acceptance sets `consumedAt`. A retryable upstream failure keeps the claim (the outbox
holds the event and retries with it); a non-retryable failure releases it so the visitor
is not silently burned.

### Server events are not consent-gated by a browser id

`lead_created`, `order_created` and any amount cannot come from a browser at all:
`POST /api/track` refuses them with `403 server_event_required`. They arrive on
`POST /api/events`, authenticated with a rotating HMAC key over the raw body
(`INGEST_KEYS`, ≥32 chars per secret, minus a ±300 s replay window), and must declare a
`consentBasis`:

| Basis | Accepted when |
|---|---|
| `granted` | the request carries the `consentId` + `sessionId` the visitor actually granted; the same claim/consume rules apply |
| `first_party_record` | the sender's own record is the lawful basis; `eventId` is required for dedupe |

An unconfigured server returns `503 ingest_not_configured` rather than accepting unsigned
events. The signature covers the bytes received and the route parses those same bytes, so
a body edited after signing is `401 ingest_signature_invalid`. Key versions rotate the same
way as consent secrets: list both while senders move, then retire the old version
(`401 ingest_key_unknown`).

### Key rotation

`CONSENT_SECRETS` is an ordered list, `v2:<new>,v1:<old>`, and `CONSENT_SECRET_VERSION`
names the one used to sign. Verification tries the version recorded inside the token, so
ids issued before a rotation keep working until they expire (≤15 min). Retiring a version
makes its ids fail as `consent_invalid` — never as "expired", so rotation cannot be used
to probe history. Rotate by prepending a version, waiting out the TTL, then removing the
old one.

## 4. Client IP and `TRUST_PROXY`

`X-Forwarded-For` is attacker-controlled on the left. It is believed **only** when
`TRUST_PROXY` says how many proxies of our own sit in front, and the client is then read
from the right:

| `TRUST_PROXY` | Header `X-Forwarded-For` | Client used |
|---|---|---|
| 0 (default) | `1.2.3.4` | socket address — header ignored |
| 1 | `1.2.3.4, 203.0.113.9` | `203.0.113.9` |
| 2 | `spoofed, 198.51.100.4, 10.1.1.1` | `198.51.100.4` |

Asking for more hops than the header has clamps to the leftmost entry instead of
inventing an address. `TRUST_PROXY` is validated 0–10 at startup. Rate limiting keys on
this value, so with the wrong number a client can pick its own bucket.

Set it to the real hop count for the deployment (Cloud Run behind a global load
balancer is typically 1–2; verify, do not guess).

## 5. Request bodies and headers

- The body cap (`MAX_BODY_BYTES`, default 256 KB) is enforced **while streaming**, so a
  chunked body with no `Content-Length` is stopped mid-read and the connection is closed
  (`413 payload_too_large`). A declared `Content-Length` over the cap is rejected before
  any read. Proven over a real socket in `transport.test.ts`.
- API responses carry `Content-Security-Policy: default-src 'none'`, `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- The app shell carries its own CSP from `server/csp.mjs` (one definition, used by the
  Vite dev/preview servers and by tests). Production forbids inline script:

  `script-src 'self'` · `style-src 'self'` · `connect-src 'self' identitytoolkit.googleapis.com securetoken.googleapis.com`

  Static hosting must send those headers; `productionHeaders` in `server/csp.mjs` is the
  exact string. Dev relaxes `script-src`/`style-src` to `'unsafe-inline'` for the React
  refresh preamble and Vite's injected styles, and adds `ws:` for HMR — dev only, and
  asserted by a test so the two cannot silently converge.

## 6. Token storage in the browser

`sessionStorage`, in-memory fallback (`src/lib/token-store.ts`), **never**
`localStorage` and **no cookies**.

- `localStorage` is readable by any XSS payload and outlives the tab.
- An `httpOnly` cookie would resist XSS better but brings CSRF back, and this app has no
  CSRF token machinery. Cookies without CSRF would be a net loss, so there are none.
- Memory alone would sign the user out on every reload. `sessionStorage` keeps the tab
  usable and dies with it; blocked storage falls back to memory.

`sessionStorage` is still readable by script in the page. The mitigation is the CSP plus
short-lived Firebase tokens (1 h, refreshed), not the storage location.

The login screen (`src/components/LoginScreen.tsx`) is an **overlay on the single page**,
not a route: signing in never changes the URL. Firebase sign-in uses the public REST
endpoints through `createFirebaseRestProvider` rather than the ~150 KB SDK. Providers sit
behind one `AuthProvider` interface (`dev` and `firebase`), so the screen does not know
which one it has.

## 7. Storage interface

Consent records and push history go through one contract (`server/store.mjs`):

| Area | Methods | Memory | Firestore |
|---|---|---|---|
| `sessions` | `create`, `get`, `count` | Map, swept on read | `adtrack_sessions/{id}` |
| `consents` | `save`, `get`, `claim`, `consume`, `release` | compare-and-set in a Map | **transaction** inside `runTransaction` |
| `audit` | `append`, `list({adGroupId, ok, limit})` | capped array, newest first | `adtrack_audit`, ordered by `at` |
| `outbox` | `enqueue`, `get`, `due`, `list`, `markDelivered`, `markFailed` | Map, capped at 1,000 | `adtrack_outbox`, ordered by `nextAttemptAt` |
| `records` (global) | `put`, `create`, `get`, `list`, `update`, `remove`, `purgeWhere`, `purgeBefore` | Map keyed `{orgId}|{id}` | `adtrack_{collection}` for global, `adtrack_orgs/{orgId}/{collection}` for tenant data |

Two collections are global **on purpose**, because the lookup is the question: `memberships`
(one row per organization+user, so "which orgs am I in?" is answerable) and `ingestKeys`
(a request arrives with a key and no tenant, so the key must resolve to one). Both
re-verify tenancy on use — a membership row names its organization and an ingest key's
stored tenant overrides the request body. Tenant data in Firestore lives in a
**subcollection** per organization, so a query cannot cross tenants by accident. See
`docs/AGENCY_MODEL.md` and `docs/DATA_MODEL.md`.

`claim` and `consume` are compare-and-set in both implementations, so two concurrent
attempts cannot both win.

### Firestore deployment artefacts

- `firestore.rules` — **deny all**. The browser never talks to Firestore; every access
  goes through the API with the Admin SDK, which bypasses rules. Denying everything means
  no client query can exist to be exploited, and a leaked project id buys nothing.
- `firestore.indexes.json` — one entry per query in `server/store.mjs` that would
  otherwise fail with `FAILED_PRECONDITION`: audit by `adGroupId`+`at`, audit by `ok`+`at`,
  outbox `status`+`nextAttemptAt` (the drain), outbox `status`+`createdAt` (the counters).
  `firestore.test.ts` asserts each of those queries has an index and that no unused index
  is declared, so the file cannot silently drift from the code.
- **TTL policies** (console or `gcloud firestore fields ttls update`, not expressible in
  `firestore.indexes.json`):

  | Collection | TTL field | Why |
  |---|---|---|
  | `adtrack_sessions` | `expiresAt` | sessions are useless after 30 min |
  | `adtrack_consents` | `expiresAt` | expired ids are already refused; this is storage hygiene |

  `adtrack_audit` has **no** TTL — it is the audit trail; retention there is a policy
  decision (13 months, see PRIVACY.md) with a scheduled export. `adtrack_outbox` has no
  TTL either: a pending event must never vanish on a timer, so delivered/dead rows are
  pruned by a job instead.

  TTL deletion is best-effort and may lag by up to ~24 h; nothing in the code depends on
  the row disappearing, because both checks also compare timestamps. `STORAGE=memory` in production is a startup error: replay protection and the
audit log must survive a restart and be shared across instances. Tests use the memory
store; `store.test.ts` also drives the Firestore adapter against a fake instance.

`GET /api/audit` exposes push history to any authenticated role; the browser copy in
`src/lib/hints.ts` is only a cache for the signed-out demo.

## 7a. Connector credentials and the CRM webhook

**Outbound (OAuth tokens).** HubSpot access and refresh tokens are encrypted at rest with
AES-256-GCM (`server/connectors/crypto.mjs`). The key comes from
`CONNECTOR_ENCRYPTION_KEY` (32 bytes, hex or base64) and is validated at startup; a
malformed key is a startup error, not a runtime surprise. The ciphertext is bound to
`organizationId:workspaceId:sourceConnectionId` as additional authenticated data, so a
sealed value moved to another tenant fails to open instead of decrypting. `open()`
returns `null` on any failure — tampering, wrong key or wrong tenant — and no code path
treats `null` as "empty token". Tokens are never returned by an API response, never
logged, and `redactError()` strips `access_token=`, `refresh_token=` and `Bearer …` from
provider messages before they reach a log or a response.

**Inbound (webhook).** The HubSpot webhook is the only public *write-shaped* route besides
`/api/track`, and it is guarded differently because the provider's mechanism is different:

| Guard | Implementation |
|---|---|
| Signature | `Base64(HMAC-SHA256(clientSecret, method + fullUrl + rawBody + timestamp))`, compared with `timingSafeEqual` |
| Replay window | `X-HubSpot-Request-Timestamp` within 300 s; a stale delivery is `401 webhook_timestamp_stale` |
| Raw body | The signature covers the bytes received; the route never re-serialises a parsed object to check it |
| URL | Reconstructed from `PUBLIC_BASE_URL`; if it is unset the route answers `503` rather than verifying against a guess |
| Size | At most 50 events per delivery (`413` above that) |
| Identity | Tenant from the path **and** the stored source row; the body can never choose an organization |
| Idempotency | Each delivery re-reads the record and writes deterministic event ids, so a retry is a duplicate, not a second lead |
| Scope | The connection must still be `connected`; a disconnected one is `409` |

**Why a shared HMAC helper would be wrong.** Our ingest keys sign
`timestamp.rawBody` in hex with a per-source secret. HubSpot signs method + URL + body +
timestamp in base64 with the app's client secret. Reusing one verifier for both would mean
inventing a scheme neither party documents.

## 8. Verified vs unverified

| Claim | Proof |
|---|---|
| dev mode refuses ad account keys | `config.test.ts`, `check-prod-guards.mjs` |
| consent ids are session-bound, single-use, expiring | `security.test.ts`, `check-server.mjs` |
| rotation keeps live ids valid and retires old ones | `security.test.ts` |
| spoofed `X-Forwarded-For` is ignored unless trusted | `security.test.ts`, `transport.test.ts` |
| chunked bodies are capped mid-stream | `transport.test.ts` |
| token never enters `localStorage`; storage failure falls back to memory | `auth.test.tsx` |
| production CSP has no inline script; `index.html` has none | `auth.test.tsx` |
| push history is server-side and readable by role | `e2e-push.mjs` |
| failed pushes are audited with actor, error and upstream status | `security.test.ts` |
| a browser cannot report a lead, an order or an amount | `security.test.ts`, `check-server.mjs` |
| only a correctly signed, in-window server event is forwarded | `security.test.ts` |
| consent is consumed only after the upstream accepts; retryable failures queue | `security.test.ts` |
| a dead letter releases the consent and is visible in the audit log | `security.test.ts` |
| composite indexes cover every Firestore query; rules deny all | `firestore.test.ts` |
| OAuth tokens are sealed, tenant-bound and unreadable after tampering or a tenant swap | `hubspot.test.ts` |
| a sealed token never appears in a source record, a status response or an audit entry | `hubspot.test.ts` |
| the webhook is reachable without a bearer token and refused without a valid v3 signature | `connector-routes.test.ts` |
| a stale, oversized, replayed or disconnected-connection webhook is refused | `hubspot.test.ts` |
| a non-member cannot read, sync or disconnect another organization's connector | `connector-routes.test.ts` |

Not verified, stated plainly:

- **No real Firebase project was contacted.** Token verification, custom claims and
  `set-role.mjs` are covered by injected fakes only.
- **No Firestore instance was contacted.** The adapter is tested against a fake that
  implements `doc`/`get`/`set`/`runTransaction`. The emulator suite in `firestore.test.ts`
  skips unless `FIRESTORE_EMULATOR_HOST` is set *and* `firebase-admin` is installed
  (Java + `firebase-tools` are not available here), so rules and index deployment are
  asserted structurally, not executed.
- **No real ad account was contacted.** Push semantics are still unproven against the
  live API (see `docs/API.md`).
- **Rate limiting is per instance.** Cloud Run with more than one replica multiplies the
  effective limit; a shared counter is not implemented.
- **`firebase-admin` optionality is asserted structurally** (package.json + injected
  import failure), not by uninstalling it in a real deployment.
- **No container build was run.** The Dockerfile's first real check is CI.
- **No real HubSpot account was contacted.** The connector, its OAuth state machine and
  its webhook are proven against a fake provider client and a locally reproduced
  signature; a real install (credentials, one sync, one delivery) is still UNKNOWN.
- **The browser-level flow was not executed.** Chromium could not be downloaded in this
  environment, so `e2e/` specs exist but their results are UNKNOWN.
