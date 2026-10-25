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
| session required first, bound to IP + user agent | 30 min (`SESSION_TTL_SECONDS`) | `consent.createSession` |
| consent id bound to that one session | — | `payload.sid` + store record |
| consent id lifetime | 15 min (`CONSENT_TTL_SECONDS`) | `payload.exp` |
| single use | first `/api/track` consumes it | `store.consents.consume` |
| origin allowlist on both routes | `TRACK_ORIGINS` | `assertOrigin` |
| per-IP rate limit on both routes | `RATE_LIMIT_PER_MINUTE` | `createRateLimiter` |

A replay, a use from another session, an expired id, a retired signing key and a forged
signature all produce a stable error code:

`session_required` · `session_invalid` · `consent_required` · `consent_invalid` ·
`consent_expired` · `consent_scope_missing` · `consent_unknown` ·
`consent_session_mismatch` · `consent_replayed`

Consent is **not** a boolean. `consent: true` in an event body is rejected with
`403 consent_required`, because a client can always send `true`.

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
| `consents` | `save`, `get`, `consume` | compare-and-set in a Map | **transaction** inside `runTransaction` |
| `audit` | `append`, `list({adGroupId, limit})` | capped array, newest first | `adtrack_audit`, ordered by `at` |

`consume` is compare-and-set in both implementations, so two concurrent replays cannot
both win. `STORAGE=memory` in production is a startup error: replay protection and the
audit log must survive a restart and be shared across instances. Tests use the memory
store; `store.test.ts` also drives the Firestore adapter against a fake instance.

`GET /api/audit` exposes push history to any authenticated role; the browser copy in
`src/lib/hints.ts` is only a cache for the signed-out demo.

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

Not verified, stated plainly:

- **No real Firebase project was contacted.** Token verification, custom claims and
  `set-role.mjs` are covered by injected fakes only.
- **No Firestore instance was contacted.** The adapter is tested against a fake that
  implements `doc`/`get`/`set`/`runTransaction`; real emulator or production behaviour
  (rules, indexes, quota) is untested.
- **No real ad account was contacted.** Push semantics are still unproven against the
  live API (see `docs/API.md`).
- **Rate limiting is per instance.** Cloud Run with more than one replica multiplies the
  effective limit; a shared counter is not implemented.
- **`firebase-admin` optionality is asserted structurally** (package.json + injected
  import failure), not by uninstalling it in a real deployment.
- **No container build was run.** The Dockerfile's first real check is CI.
