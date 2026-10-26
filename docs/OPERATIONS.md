# Operations: running, watching, and rolling back

Written for whoever is on call. Every number here is a *starting threshold*, not an SLO —
no SLO has been agreed with a customer, and none is claimed in this repository.

## 1. Logs

The API emits one line per request (plus start-up, retention and outbox events). Set
`LOG_FORMAT=json` in staging and production; the default is `json` when
`NODE_ENV=production`, `text` elsewhere.

```json
{"ts":"2026-10-26T10:26:39.492Z","level":"info","message":"request","requestId":"8522d00a-…",
 "method":"GET","route":"/api/health","status":200,"durationMs":6,"ip":"127.0.0.1"}
```

Fields that matter:

| Field | Use |
|---|---|
| `requestId` | Correlates a log line with the `X-Request-Id` response header a client reports |
| `route` | Query strings are stripped; never use the raw URL for grouping |
| `status`, `durationMs` | Error-rate and latency alerting |
| `slow` | Present when the request exceeded `SLOW_REQUEST_MS` (default 2000) |
| `level` | `warn` for 4xx, `error` for 5xx — filter on this, not on prose |

Never logged: request bodies, `Authorization`, tokens, provider payloads, query strings,
response bodies. Connector/provider errors are passed through `redactError()` before they
reach a log or an API response, and `X-Request-Id` is validated (`[A-Za-z0-9_-]{8,64}`)
before it is echoed.

## 2. Alerts (proposed; none are wired to a pager yet)

| Alert | Signal | Starting threshold | First thing to check |
|---|---|---|---|
| Elevated 5xx | `level=error` on `message=request` | > 1% of requests over 5 min | Recent deploy; `/api/health`; datastore status |
| Sync failures | audit `connector.sync` with `ok=false`, or `lastSyncStatus=failed` | 3 in 15 min for one connection | Provider status page, `lastError.code`, token refresh |
| Stale data | `window.dataFreshness = stale` for a workspace, or `lastSyncAt` older than the client's expectation | per workspace, agreed with the client | Last sync run; webhook deliveries |
| Datastore unavailable | `/api/health` returns 503, or `store.kind` errors | any sustained 503 | Project status, credentials, quotas |
| Shutdown failure | `drain deadline … passed` in logs, or a non-zero exit on stop | any occurrence | Long provider call; increase `SHUTDOWN_TIMEOUT_MS` or fix the hang |
| Webhook throttling | `connector.webhook_rate_limited` audit rows | sustained for > 5 min | A retry storm or a misbehaving integration |

## 3. Limits (explicit, not implicit)

| Limit | Default | Configuration |
|---|---|---|
| Body size | 256 KiB | `MAX_BODY_BYTES` |
| Per-IP request rate (`/api/track`, `/api/session`, ingest) | 60/min **per process** | `RATE_LIMIT_PER_MINUTE` |
| HubSpot webhook deliveries per connection | 120/min, counted in the store (shared) | `HUBSPOT_WEBHOOK_PER_MINUTE` |
| HubSpot sync | 100 records/page, 20 pages/run, 3 attempts, 2-min lease | connector `limits` |
| Token endpoint timeout | 15 s | connector `oauth.requestTimeoutMs` |
| Shutdown drain | 15 s | `SHUTDOWN_TIMEOUT_MS` |
| Slow-request marker | 2 s | `SLOW_REQUEST_MS` |
| Retention sweep | every 6 h, 396/760 days | `RETENTION_SWEEP*`, policy in `server/store.mjs` |

**Known limitation:** the per-IP limiter is per process. Behind N replicas the effective
limit is N×. A shared limiter is not implemented; if the tracker is exposed to untrusted
traffic, put a platform WAF/rate limit in front of it and treat this row as accepted risk.

## 4. Backup and restore

Firestore has no in-database backup switch; the export path is the supported one.

```bash
# export (run from a host with gcloud authenticated to the staging project)
gcloud firestore export "gs://$BUCKET/firestore-$(date +%Y%m%d-%H%M)" \
  --project "$STAGING_PROJECT" --collection-ids='adtrack_organizations,adtrack_workspaces,adtrack_sources,…'

# restore into a *fresh* project, never over the live one
gcloud firestore import "gs://$BUCKET/firestore-YYYYMMDD-HHMM" --project "$RESTORE_PROJECT"
```

Record in the release evidence: the export command, object count, the restore target, one
post-restore read that matches pre-restore output, and how long the restore took. A backup
that has never been restored is an assumption.

Application-level retention (the sweep) is separate from provider TTLs: Firestore TTL
policies are not configured, so expiry is enforced by the sweep alone. If the sweep stops,
data accumulates — the alerts above should catch that via audit/log gaps, but nothing
currently alerts on "sweep has not run".

## 5. Rollback

1. **Application:** Cloud Run keeps revisions; route traffic back with
   `gcloud run services update-traffic adtrack-api --to-revisions <previous>=100`.
   Each image tag is immutable, so a rollback is a traffic switch, not a rebuild.
2. **Data:** this application ships no destructive migrations. The only write that shrinks
   data is the retention purge (owner-initiated, audited). A rollback therefore does not
   need a schema step; if a purge ran with a wrong day count, restore from the export above.
3. **Secrets:** rotating `CONNECTOR_ENCRYPTION_KEY` makes existing sealed tokens
   unreadable — every connector must be reconnected. Rotate only with that expectation
   stated to the client, and keep the old key available until the last connection is
   re-established.

## 6. Incident response (first 30 minutes)

1. Confirm scope from `/api/health` (public and authenticated views) and the error-rate
   alert's `route` field.
2. If it is a deploy: roll back first, diagnose afterwards.
3. If it is the datastore: the service fails closed; traffic will 503. Communicate rather
   than retrying aggressively (retries against a failing datastore make recovery slower).
4. If it is a connector: disconnect the affected connection (stops syncs and revokes
   tokens) rather than deleting data; imported events are the client's records.
5. Preserve evidence: the `requestId`s from the affected window, the audit rows
   (`connector.*`, `retention.purge`), and the log lines at `level=error`.
6. Write down what was unknown during the incident — that list is the next quarter's
   observability work.

## 7. What is not monitored yet

No metrics endpoint, no tracing, no synthetic uptime probe, no alert delivery. Everything
in §2 is a definition to be wired, not a working system. This is stated as a gap in the
Phase 4 report rather than implied by a table.
