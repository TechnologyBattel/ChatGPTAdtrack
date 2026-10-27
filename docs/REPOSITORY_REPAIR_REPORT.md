# AI AdTracker — repository professionalization and default-branch repair

_2026-10-27. Executed against `TechnologyBattel/ChatGPTAdtrack`._

**Final status: PASS WITH BLOCKERS.** The default branch now contains the verified application,
the rebrand and community files are merged, and CI is green on `main`. Blockers that remain are
**owner decisions and unverified integrations**, not repository defects — see §9.

---

## 1. Before and after

| | Before | After |
|---|---|---|
| Default branch | `main` — **7 files, documentation only** @ `a984a6f` "Create PRIVACY.md" | `main` — **182 files, full application** @ `6a202ac` |
| Application branch | `arena/b0e01b66-chatgptadtrack` — 165 files @ `52d71bb`, **15 commits ahead of main** | same branch, now `020cece`, 14 commits ahead (the gap is closed by merge, not by rewriting) |
| Default-branch setting | `main` | `main` — **unchanged** |
| Local working tree | 52 uncommitted entries (application entirely untracked) | clean, 0 entries |
| CI on `main` | last run was the docs-only tree | 4/4 jobs green on `6a202ac` |

The report of a "165-file application branch" was **accurate for the remote branch**, but
incomplete: the local working tree additionally held **10 files** (Private Research Mode slice 1
and a cleanup report) and **38 modified** files that had never been pushed. That work is now
committed as `a7f8b6b` and merged.

`main` was a **strict ancestor** of the application branch: all 7 of its commits were already
in the branch's history, and all 7 of its files existed there in newer form. Nothing unique to
`main` existed, so preserving it was automatic — verified, not assumed.

## 2. Backup and recovery

Created **before** any Git state change:

- `backups/repo-all-refs-20261027-082038.bundle` — 677 KB, `git bundle verify` reports
  *"The bundle records a complete history"*; holds all 6 refs including `a984a6f` (original
  `main`) and `52d71bb` (original application-branch tip).
- `backups/worktree-20261027-082038.tar.gz` — 488 KB, the working tree including every untracked
  file, excluding `node_modules`, `dist` and `.git`.
- `backups/SHA256SUMS.txt` — checksums for both.

Both live outside the repository working tree (`/home/user/backups/`) and were deliberately not
committed. Recovery is `git clone <bundle>` or `tar -xzf` into a fresh directory.

## 3. Pull requests

| PR | Title | Result |
|---|---|---|
| [#1](https://github.com/TechnologyBattel/ChatGPTAdtrack/pull/1) | Restore the application to the default branch | **MERGED** 2026-10-27T08:24:45Z, merge commit `56a234d` |
| [#2](https://github.com/TechnologyBattel/ChatGPTAdtrack/pull/2) | AI AdTracker rebrand, community files and repository health | **MERGED**, merge commit `6a202ac` |

Both were merged with `--merge` (history preserved, no rebase, no squash, no force-push). Both
satisfied the merge gate before merging: application present on the resulting default branch,
unique `main` content preserved, all four CI jobs green, and no destructive change or secret in
the diff.

## 4. Files created or modified

**PR #1 — 175 files, +42,509 / −45 lines. 168 added, 7 modified, 0 deleted.**

- 165 application files that already existed on the branch.
- 10 new: `server/private-research.mjs` + `.d.mts`, `src/lib/private-research.ts`,
  `src/components/PrivateResearchPanel.tsx`, two test files, `docs/PRICING.md`,
  `docs/PRIVATE_RESEARCH_MODE.md`, `docs/PRIVATE_RESEARCH_MODE_PLAN.md`, `docs/CLEANUP_REPORT.md`.
- 7 updated in place: `.env.example`, `.gitignore`, `README.md`,
  `docs/{DECISIONS,METRICS,PRIVACY,TRACKING_PLAN}.md`. The 45 deleted lines all belong to these
  updated files; **no file on `main` was removed.**

**PR #2 — 8 files, +825 / −147 lines. 7 added, 1 rewritten.**

| File | Change |
|---|---|
| `README.md` | Rewritten: audience, what it does today, verified vs unverified status, `npm ci` quick start, command table, security/privacy pointers, known limitations. Fixed a broken `docs/CONNECTORS.md` link. |
| `SECURITY.md` | New: private reporting, supported-version policy, scope, accepted limitations. No invented contact address. |
| `CONTRIBUTING.md` | New: setup, commands, conventions, test rules, PR expectations. |
| `CODE_OF_CONDUCT.md` | New: Contributor Covenant v2.1, CC BY 4.0 attribution retained. |
| `CHANGELOG.md` | New: truthful `[Unreleased]` history, no invented releases. |
| `.github/PULL_REQUEST_TEMPLATE.md` | New: scope, verification table, tests, security, docs, release hygiene. |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | New: valid issue form, 10 fields, preflight checks. |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | New: valid issue form, 8 fields, security/tenancy impact required. |

No rename of the package (`adtrack`), environment variables, API routes, Firestore collections,
`x-adtrack-*` headers or `adtrack.*` storage keys. Branding is public copy only.

## 5. Rebrand summary

"AI AdTracker" was already the title in the README; what was missing was the *substance a
public reader needs*. The new README states who it serves (agencies and teams managing client
campaigns, attribution and qualified leads), what works today (questions and answers, context-hint
research with diff/confirm/undo, guided reports, attribution and lead lifecycle, read-only HubSpot,
Private Research Mode off by default), and separates **verified** from **UNKNOWN** in a way that a
reader can act on.

Claims deliberately avoided: "production-ready", "enterprise-grade", "real-time", "all
integrations verified". The README instead says the application has never been run against a real
OpenAI Ads account, a real HubSpot portal or a real Firestore project.

## 6. License — PENDING OWNER DECISION

No `LICENSE` file was created, and none was inferred. What the inspection found:

- `package.json` has **no `license` field** and is `"private": true`.
- **No** SPDX identifier, copyright header or "all rights reserved" statement anywhere in the
  source.
- Dependencies are permissive and already gated by `security/license-allowlist.json`:
  MIT 336, Apache-2.0 51, ISC 22, BSD-3-Clause 14, BSD-2-Clause 8, MIT-0 1, 0BSD 1,
  Python-2.0 1, CC-BY-4.0 1.

The consequence, stated in the README, `CONTRIBUTING.md` and `CHANGELOG.md`: **no rights to
reuse, modify or redistribute are currently granted**; absent a license the code is
all-rights-reserved by default.

| Option | Choose this if |
|---|---|
| **MIT** | Intended as open source, ownership is established, maximum adoption is the goal. Simplest and most compatible with the current dependency set. |
| **Apache-2.0** | Open source, but you want an explicit patent grant and a trademark clause — attractive because 51 dependencies are already Apache-2.0. |
| **Proprietary / no public license** | The code stays closed-source or is licensed commercially. In that case add a copyright notice and keep `private: true`; optionally add a `LICENSE` stating "All rights reserved". |

**Needed from the owner:** the chosen option, the copyright holder's legal name, and the year.

## 7. Repository metadata — PROPOSED, NOT APPLIED

Per the authorization boundary in the brief, remote metadata changes are proposed for approval
rather than applied. The repository currently has **no description** and **no topics**.

- **Description:** "AI-assisted ad attribution and campaign analytics for agencies and marketing teams."
  — accurate against the verified functionality (attribution, campaign analytics, agency-shaped
  tenancy). It does not claim live third-party integration.
- **Topics:** `ai-adtracker`, `ad-attribution`, `campaign-analytics`, `lead-tracking`,
  `typescript`, `react`. Consider adding `chatgpt-ads`, `multi-tenant`, `privacy` if you want the
  scope to be discoverable.

No badges were added. The only badge-worthy fact would be CI status, and a badge pinned to a
workflow that later changes name becomes a lie; the CI links are in §8 instead.

## 8. Verification

Run twice: by CI, and locally from a **fresh worktree of the exact commit with its own
`node_modules`**.

| Command | Result | Exit |
|---|---|---|
| `npm ci` | clean install from the lockfile | **0** |
| `npm run verify` | lint, format:check, typecheck, 27 files / **577 passed, 2 skipped**, build, server guards (13 ok), production start-up guards (5 refusals), push/undo stub, Dockerfile static checks (13 ok), supply-chain self-test | **0** |
| `npm run e2e` | **9 passed** (Chromium) | **0** |
| `npm run supply-chain` | licences + SBOM ok; 11 moderate advisories reviewed, 2 formally accepted, gate passes by design (moderate never blocks) | **0** |
| `npx prettier --check .` | all files conform, including the new Markdown and YAML | **0** |
| Relative-link audit of new docs | 42 links checked, 0 broken | — |
| Issue-form YAML parse | both parse; field ids unique | **0** |

**The 2 skipped tests** are `src/lib/__tests__/firestore.test.ts`, guarded by
`describe.skipIf(!canRun)` with the reason recorded in the code: `FIRESTORE_EMULATOR_HOST` is not
set and `firebase-admin` (an optional dependency) is not installed. They skip rather than pretend.
**This is also why Firestore is not verified.**

**CI runs, all green:**

| Run | Scope | Jobs |
|---|---|---|
| [40473032608](https://github.com/TechnologyBattel/ChatGPTAdtrack/actions/runs/40473032608) | push to application branch (`a7f8b6b`) | 4/4 |
| [40473161836](https://github.com/TechnologyBattel/ChatGPTAdtrack/actions/runs/40473161836) | PR #1 | 4/4 |
| [40473311426](https://github.com/TechnologyBattel/ChatGPTAdtrack/actions/runs/40473311426) | push to `main` (merge of #1) | 4/4 |
| [40473678838](https://github.com/TechnologyBattel/ChatGPTAdtrack/actions/runs/40473678838) | PR #2 | 4/4 |
| [40473812014](https://github.com/TechnologyBattel/ChatGPTAdtrack/actions/runs/40473812014) | push to `main` (merge of #2) | 4/4 |

### The 529-versus-527 discrepancy — resolved by measurement

Measured the original application-branch tip (`52d71bb`) in an isolated worktree rather than
trusting either document:

| Point | Files | Passed | Skipped | Total |
|---|---|---|---|---|
| Phase 4 report **and** the real `52d71bb` measurement | 25 | 525 | 2 | **527** |
| Private Research Mode planning baseline | 25 | **529** | 2 | 531 |
| Today (`main` @ `6a202ac`) | 27 | **577** | 2 | 579 |

Both numbers are correct and neither is a test change:

- **527 is a total** (525 passed **+ 2 skipped**) at the Phase 4 commit — reproduced exactly.
- **529 is a passed count** four tests later. The four are the per-organization plan indicator
  work: *"puts a new organization on the free plan, and says so on every read"*, *"reports free
  for an organization written before the plan field existed"*, *"shows the organization plan
  beside the selector, and defaults to free"*, *"still says free when the server sends an
  organization with no plan"*.
- **577 = 529 + 48** Private Research Mode tests (41 logic/client + 7 panel).

The arithmetic closes exactly. **No test was edited, skipped or weakened to reconcile the
numbers** — the documentation was measuring different things at different commits.

## 9. Remaining blockers

| # | Blocker | Severity | Owner |
|---|---|---|---|
| 1 | **No license chosen** — no reuse rights are granted, and this blocks a public release | **High** | Owner decision |
| 2 | **Never exercised against a real OpenAI Ads account** | **High** | Needs paid credentials |
| 3 | **Firestore never run** — the 2 emulator tests skip; storage is proven only in memory | **High** | Needs a GCP project or emulator |
| 4 | **HubSpot never connected to a live portal** — tested against a fake provider only | Medium | Needs a HubSpot app |
| 5 | **No deployment, load or recovery testing** — nothing is deployed; no numbers claimed | Medium | Needs an environment |
| 6 | **Legal sufficiency of consent/retention unassessed** (GDPR/DPDP) | Medium | Legal review |
| 7 | CI warnings: `actions/checkout@v4` and `setup-node@v4` run on a deprecated Node 20 runtime; the `ubuntu-latest` label migrates in Oct 2026 | Low | Maintenance |
| 8 | Description and topics not applied (proposed in §7) | Low | Needs approval |
| 9 | Pre-existing doc overlap: 4 phase reports plus 7 status docs, 5,395 lines | Low | Follow-up |

## 10. What was *not* done, deliberately

- No force-push, no history rewrite, no squash of existing commits.
- No `LICENSE` file, no release, no tag, no `v0.1.0` — release requires the license decision, CI
  on the release commit, real notes, and documented blockers.
- No change to GitHub's default-branch setting: `main` was repaired *by giving it the
  application*, which is reversible, instead of repointing the setting at a development branch.
- No product features added, no code copied from other projects, no paid feature enabled.
- No production configuration changed; Private Research Mode remains **off by default**.
- No invented contact address in `SECURITY.md` or `CODE_OF_CONDUCT.md` — both state the gap and
  where it will be filled.
