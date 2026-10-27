# Staging: setup and the checks that must pass there

This file is the instruction set for the parts of Phase 4 that cannot be executed from a
build sandbox: a container, a real Firestore project, and a real HubSpot portal. Nothing in
here is claimed as done — `docs/PHASE4_STAGING_VALIDATION_REPORT.md` records which items
have evidence and which are **UNKNOWN**.

## 0. What "staging" means here

| Property | Staging requirement | Why |
|---|---|---|
| Datastore | Firestore in a dedicated project (`STORAGE=firestore`) | The in-memory store cannot survive a restart and cannot be shared by two replicas |
| Auth | `AUTH_MODE=firebase` with a test tenant | Dev auth is refused in production by design |
| Secrets | Injected at runtime (`CONNECTOR_ENCRYPTION_KEY`, HubSpot client credentials) | Never baked into the image |
| Data | Synthetic agency/workspace records only | No customer data in staging, ever |
| Public origin | `PUBLIC_BASE_URL=https://…` | The HubSpot v3 signature covers the exact URL |
| Instances | At least two | Single-replica testing cannot show idempotency or lease behaviour |

## 1. Bring up the API

```bash
docker build -t adtrack-api:staging .
docker run --rm -p 8080:8080 \
  -e AUTH_MODE=firebase \
  -e FIREBASE_PROJECT_ID="$STAGING_PROJECT" \
  -e GOOGLE_APPLICATION_CREDENTIALS=/secrets/staging.json \
  -e STORAGE=firestore \
  -e TRACK_ORIGINS=https://staging.example.com \
  -e CONSENT_SECRETS="v1:$STAGING_CONSENT_SECRET" \
  -e PUBLIC_BASE_URL=https://api.staging.example.com \
  -e LOG_FORMAT=json \
  -v "$PWD/secrets/staging.json:/secrets/staging.json:ro" \
  adtrack-api:staging
```

Verify, in order:

```bash
curl -s http://127.0.0.1:8080/api/health | jq          # {ok, mode}
docker inspect -f '{{.Config.User}}' adtrack-api:staging   # node
docker exec adtrack-api:staging id                          # uid=1000(node)
docker stop --time 20 adtrack-api:staging                   # drain log then exit 0
```

Expected shutdown log lines: `SIGTERM received: draining for up to 15000ms` then
`drained: all connections closed`. A non-zero exit means the drain deadline was exceeded —
that is a finding, not a warning.

## 2. Run the staging harness

```bash
STAGING_BASE_URL=https://api.staging.example.com \
STAGING_TOKEN="$OWNER_TOKEN" \
STAGING_SECOND_TOKEN="$SECOND_USER_TOKEN" \
node scripts/staging-check.mjs
```

Exit codes: `0` all checks passed, `1` a check failed, **`3` not run** (no staging
credentials). The script refuses a base URL that looks like production.

## 3. Restart and multi-instance behaviour

```bash
# two replicas behind the same store
docker run -d --name api-a -p 8080:8080 <same env> adtrack-api:staging
docker run -d --name api-b -p 8081:8080 <same env> adtrack-api:staging

# the same webhook delivery sent to both must import once
for port in 8080 8081; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    "https://api.staging.example.com/api/connectors/hubspot/webhook/$ORG/$SOURCE" \
    -H "x-hubspot-signature-v3: $SIG" -H "x-hubspot-request-timestamp: $TS" --data "$BODY"
done
```

Expected: the first delivery imports, the second reports `duplicates: 1` (or `429` if the
per-connection delivery limit is reached — that is also correct). Then
`docker restart api-a` mid-sync and confirm the sync resumes from the stored checkpoint
rather than re-importing from the first page.

## 4. HubSpot sandbox (the provider gate)

1. Create a HubSpot developer test account (<https://developers.hubspot.com/>), separate
   from any customer portal.
2. Create a **private/public app** with the read-only scopes:
   `crm.objects.contacts.read`, `crm.objects.deals.read`.
3. Set the redirect URL to `https://api.staging.example.com/api/orgs/…/connect/complete`
   (https only; the server refuses an http redirect in production).
4. Add at least five contacts and three deals, at least one deal associated with a contact.
5. Record, for the report:

   | Check | Evidence to capture (sanitised) |
   |---|---|
   | OAuth authorize + callback | timestamp, `hub_id`, granted scope string |
   | Scopes are read-only | requested vs granted scope list |
   | Token refresh | timestamp of refresh, whether `connectionStatus` stayed `connected` |
   | Contacts/deals + association | counts imported, sample `hs_object_id`s only |
   | Pagination | page count, `imported`/`duplicates` totals |
   | Throttling | a deliberately fast sync: which status, whether backoff honoured `Retry-After` |
   | Webhook signature + timestamp | one accepted delivery, one stale (`401 webhook_timestamp_stale`) |
   | Duplicate delivery | second delivery → `duplicates: 1` |
   | Disconnect + revocation | status after disconnect, a sync refused with `409` |
   | Restart recovery | kill the process mid-sync, restart, confirm no duplicate leads |

   Never capture access tokens, refresh tokens, or full contact payloads. Object ids and
   counts are enough to prove the path.

## 5. Datastore-unavailable behaviour

```bash
# point the service at a project whose credentials are revoked/invalid
docker run --rm -p 8082:8080 -e FIREBASE_PROJECT_ID="$STAGING_PROJECT" \
  -e GOOGLE_APPLICATION_CREDENTIALS=/secrets/revoked.json … adtrack-api:staging
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8082/api/health      # expect 503
```

Expected: the process stays up, `/api/health` reports not-ok (503), authenticated routes
fail closed with a 5xx and a generic message — no internal project ids, credentials or stack
traces in the response body.

## 6. Backup and restore exercise

See `docs/OPERATIONS.md` §4. Record: export command, object count, restore target, a
post-restore read of one workspace, and the measured restore duration.

## 7. What this document does not do

It does not itself prove anything. A step is only done when the report cites the command,
its exit code and the sanitised output.
