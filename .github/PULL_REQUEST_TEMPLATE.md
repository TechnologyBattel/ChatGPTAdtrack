## What and why

<!-- The user-visible behaviour that changes, and the reason. One concern per pull request. -->

## Scope

<!-- Anything a reviewer should know is deliberately NOT in this pull request. -->

## How it was verified

Paste the exact commands and their real results. `BLOCKED` and `NOT RUN` are acceptable
answers; an invented result is not.

| Command | Result | Exit |
|---|---|---|
| `npm run verify` | | |
| `npm run e2e` | | |
| other: | | |

If a check could not be run, say what was missing (credentials, a service, a browser binary).

## Tests

- [ ] Behavioural changes are covered by a test that fails without the change.
- [ ] No test was deleted, skipped or loosened to make this pass.
- [ ] Any changed test expectation is explained above, with the reason the old one was wrong.
- [ ] Test counts are stated (added / modified / removed).

## Security

- [ ] Authorization and tenant boundaries are still enforced **on the server** from membership,
      not from request input or a client-side guess.
- [ ] No secret is exposed to the browser, browser storage, a URL, a log line or telemetry.
- [ ] No security control, consent check, audit record or production guard was weakened or
      bypassed for convenience.
- [ ] Provider and storage failures are still reported as failures, not as success.
- [ ] This pull request contains no credentials or customer data.

Security impact of this change:

<!-- What it touches: auth, tenancy, secrets, audit, persistence, consent, headers. -->

## Documentation

- [ ] Documentation is updated where behaviour changed.
- [ ] Nothing in the docs now claims a capability that was never verified.
- [ ] Verified, implemented-but-unverified and planned items are still labelled differently.

## Release hygiene

- [ ] `CHANGELOG.md` updated under `[Unreleased]` if this is a notable change.
- [ ] No new dependency without a stated reason and a licence that passes the supply-chain gate.
- [ ] No version bump, tag or release in this pull request (those are separate, owner-approved).
