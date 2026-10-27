# Contributing to AI AdTracker

Thanks for taking a look. This document covers how to get the project running, what the code
conventions are, and what a pull request is expected to contain.

This is a pre-release project: it has not been exercised against a real OpenAI Ads account, a
real HubSpot portal or a real Firestore project. Please read [Status](README.md#status) before
proposing a change, so we do not describe unverified integrations as working ones.

## Development setup

Requires Node.js `>=22` (see `.nvmrc`) and npm `>=10`.

```bash
npm ci                   # install exactly what CI installs
cp .env.example .env     # fill in only the keys you actually have
npm run api              # API on 0.0.0.0:8787
npm run dev              # web app on 0.0.0.0:5173, proxies /api
```

The app runs on deterministic demo data until keys exist on the server. You do not need any
credentials to develop or to run the full test suite.

For the browser suite, install Chromium once:

```bash
npx playwright install chromium
npm run e2e
```

## Commands

| Command | What it does |
|---|---|
| `npm run verify` | The full gate: lint, format check, typecheck, tests, build, server guards, production start-up guards, push/undo stub, Dockerfile static checks, supply-chain self-test |
| `npm run test` | Vitest unit and component tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint`, `npm run format` | ESLint, Prettier |
| `npm run e2e` | Playwright browser suite |
| `npm run supply-chain` | Licence, vulnerability and SBOM gate |

CI runs these on every push and pull request, in four jobs: verify, supply-chain, browser
end-to-end, and container (non-root user, healthcheck, graceful shutdown). A pull request is
not ready while any of them is red.

## Code conventions

- **TypeScript strict.** No `any` to silence a type error; widen a type or fix the shape.
- **Formatting is not a review topic.** Run `npm run format` before pushing; CI runs
  `format:check`.
- **Focused edits beat rewrites.** Do not reformat or restructure a file you are only
  changing one line of — it makes the security review impossible.
- **No secrets, ever.** Ad-account keys, provider keys and consent secrets stay in server
  environment variables. `VITE_*` variables are public by definition, so a secret must never
  use that prefix. Do not put a key in browser storage, a URL, a log line or telemetry.
- **Money is integer minor units.** Do not introduce floating-point currency anywhere.
- **Unmeasured is not zero.** When a metric cannot be computed, render `unavailable` rather
  than `0`, and label sections `observed`, `none found` or `not measurable yet`.
- **Server-derived authorization.** Roles and tenant identity come from the caller's
  membership on the server, never from a request body, query parameter or client-side guess.
- **Errors stay honest.** Do not convert a provider or storage failure into a success state.
- **No new dependencies** unless the need is demonstrated; the supply-chain gate will ask for
  a licence decision if you add one.

## Tests

- Every behavioural change needs a test that fails without it. Security-relevant changes
  (authorization, tenant isolation, secret handling, persistence, audit) need a test that
  demonstrates the refusal, not only the success path.
- **Never weaken a test to get green.** Deleting an assertion, loosening a matcher, adding
  `.skip` or catching an error broadly to make the suite pass will be rejected.
- If a test must change because behaviour genuinely changed, say so explicitly in the pull
  request and explain why the old expectation was wrong.

## Pull requests

Please keep one concern per pull request and use the pull-request template. A reviewable pull
request states:

1. **What changed and why**, in terms of user-visible behaviour.
2. **How it was verified** — the exact commands you ran and their results, including anything
   you could not run and why. `BLOCKED` or `NOT RUN` is an acceptable answer; an invented
   result is not.
3. **Security impact** — what it touches (auth, tenancy, secrets, audit, persistence) and what
   you did to avoid weakening it. Write "none" only if that is true.
4. **Documentation impact** — which docs you updated. A behaviour change that leaves the docs
   contradicting the code is an incomplete change.

Do not describe the project as production-ready, and do not claim an integration is verified
unless it was exercised against the real service with evidence in the pull request.

## Commit messages

Use an imperative subject line, optionally prefixed with a type (`feat:`, `fix:`, `docs:`,
`test:`, `chore:`). Explain the *why* in the body when the change is not obvious. Do not mix a
refactor into a functional change.

## Reporting bugs and proposing features

Use the issue templates in `.github/ISSUE_TEMPLATE/`. For anything that looks like a security
vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

No license has been chosen for this repository yet, so no rights to reuse, modify or
redistribute the code are currently granted. By contributing you confirm you have the right to
submit the work, and you agree that the license decision — once the owner records it — will
apply to your contribution.
