# Decision log

- 2026-09-30: Single organization (not multi-tenant) for v1.
- 2026-09-30: Firestore first; move to Postgres if analytics queries outgrow it.
- 2026-09-30: OpenAI CAPI key stored only in Cloud Function secrets.
- 2026-09-30: OpenAI-reported and internal attribution are always shown separately.
- 2026-09-30: One map with a metric switcher, not nine separate maps.
