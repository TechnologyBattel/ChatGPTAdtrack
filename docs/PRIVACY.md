# Privacy notes

- Data collected: session id, UTMs, oppref/obref, device type, approximate location (country/region/city), lead form fields.
- Purpose: measure ad performance and lead outcomes.
- Consent: required before any tracking event is sent.
- Retention (default, configurable): raw events 13 months; lead/order records 25 months; aggregates indefinitely in anonymised form. A scheduled job enforces this and logs a dry-run report.
- Deletion and export requests: self-serve from /privacy, honoured within 30 days; deletion zeroes PII and records an audit entry.
- Consent: recorded as an immutable audit record (scopes, version, timestamp, country) before any cookie is written or event sent.
- Subprocessors: Firebase/Google Cloud, OpenAI. A data map is maintained in docs/PLAN.md §4.3.
- Applicable law to review: GDPR and India's DPDP Act (get proper legal advice before launch).
