# Changelog

All notable changes to AI AdTracker are recorded here. This project is **pre-release**: it has
never been published, tagged or deployed, so every entry below is unreleased work on `main`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers
will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once the first release is
cut. Entries are reconstructed from the repository history and the dated phase reports in
[`docs/`](docs); they describe what changed, not what has been proven to work against a live
service.

## [Unreleased]

### Added

- **Repository repair** — the default branch now contains the application. `main` previously
  held documentation only (7 files); the application lived on a separate development branch.
  Reconciled by pull request #1, with no file on `main` deleted and no history rewritten.
- **Community and repository health files** — this changelog, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue templates and a pull-request template.
- **Private Research Mode (slice 1, off by default)** — a per-run provider key and seed terms
  for editor, admin and owner roles, gated by `PRIVATE_RESEARCH_ENABLED`. The key is held in
  memory for the request only; seeds and responses are not persisted; the audit record carries
  metadata only. Fixed provider and model allowlists, bounded requests, no custom base URLs.
  Status precedence: flag off returns `404 not_configured` before authentication; flag on
  returns `401`, `404` for an outsider, `403` for a missing permission, and only then reaches
  the provider. Verified against a stub provider, not a real one.
- **Multi-tenant agency model** — organization → workspace (one per client) → sources,
  campaigns, topics, leads; roles and permissions enforced server-side; a read-only workspace
  panel; per-organization plan indicator.
- **Guided research reports** — server-computed reports that label every section `observed`,
  `none found` or `not measurable yet`, with saved snapshots.
- **Read-only HubSpot connector** — OAuth with two read scopes, contacts imported as leads, one
  deal stage imported as a qualification under trust rules, webhook signature verification.
  Tested against a fake provider; never run against a live portal.
- **Attribution and lead lifecycle** — consent handshake, server-to-server event ingest with an
  HMAC key, idempotency, qualification trust and attribution windows.
- **CI** — four jobs on every push and pull request: verify (lint, format, types, tests, build
  and the runtime guard scripts), supply-chain (licence, vulnerability, SBOM), browser
  end-to-end (Chromium) and container (non-root user, healthcheck, graceful shutdown).

### Changed

- **Design tokens** — added `subtle`, `danger` and `dangerSoft`. Secondary text previously used
  a hardcoded `#80868b`, which measured 3.68:1 on white and failed WCAG AA at 10.5–11px; it now
  measures 4.65:1.
- **README** — rewritten to state the audience, what the product does today, the verified
  versus unverified status, the supported commands and the known limitations.

### Removed

- Dead `adGroupOf()` helper in `src/lib/demo.ts` (no callers).
- Triplicated "demo data / no account connected" status text; the connection bar is now the
  single place that reports connection state.
- A stale `e2e-not-run` legend in `docs/FEATURES.md` and a stale "Private Research Mode is
  coming soon" claim in the README.

### Fixed

- Contrast failure in secondary text across nine components (see design tokens above).
- Footer separator rendering a dangling `·` at a wrap point on narrow viewports.
- A broken relative link to `docs/CONNECTORS.md` in the README.

### Not yet done

- No license has been chosen; no `LICENSE` file exists, so no reuse rights are granted.
- No release, tag or deployment. Nothing is verified against a real OpenAI Ads account, a real
  HubSpot portal or a real Firestore project, and no load or recovery testing has been run.
  See [Status](README.md#status) and [`docs/BASELINE_AND_GAPS.md`](docs/BASELINE_AND_GAPS.md).
