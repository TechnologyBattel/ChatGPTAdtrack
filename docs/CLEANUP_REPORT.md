# Cleanup and hardening report

_2026-10-27. Branch `arena/b0e01b66-chatgptadtrack`, HEAD `a984a6f`. No commit, no push,
no deploy, no configuration change._

This report records a read-only inspection followed by a deliberately small set of
consistency fixes. Nothing was redesigned for the sake of looking different, and no
application behaviour, API contract, authorization rule or security control was altered.

---

## 1. KEEP / SIMPLIFY / REMOVE / INVESTIGATE

### KEEP — evidence: imported and/or covered by tests

| Item | Evidence |
|---|---|
| All 12 components in `src/components/` | import-map scan over the tree: every component is imported; **zero unused components** |
| `server/private-research.mjs`, `src/lib/private-research.ts`, `PrivateResearchPanel.tsx` | 48 dedicated tests (41 + 7) |
| `server/csp.mjs`, `server/core.mjs`, `server/research.mjs`, `src/lib/research.ts`, `src/lib/hints.ts`, `firestore.rules` | security / attribution / deterministic-pipeline boundaries — out of scope by mandate |
| `e2e/` specs (9 tests) | verified running, 9/9 |

### REMOVE — done, with dependency evidence

| Item | Why | Dependency check |
|---|---|---|
| `adGroupOf()` in `src/lib/demo.ts` | dead helper, never called | repo-wide grep `adGroupOf`: **definition only**; `tsc` and 577 tests still pass |
| Duplicate status sentence in `src/components/SearchBar.tsx` | "Demo data, no account connected" appeared 3× on one screen — here, in the connection bar, and in the footer | no test asserts the string; connection bar states it 20 px below |
| Duplicate status sentence in `src/components/Chrome.tsx` (`Footer`) | footer repeated page-level connection status | no test asserts the string |

The canonical statement of demo/connection state is now **only** `ConnectionBar`, which also
owns the expandable `details` disclosure.

### SIMPLIFY — done

| Item | Before | After |
|---|---|---|
| Muted-grey text | raw `#80868b`, **3.68:1** on white — fails WCAG AA (4.5:1), used at 10.5–11 px in 9 places across 9 files | single `subtle` token `#70757a`, **4.65:1** — passes AA |
| Error colour | `#b3261e` (8×) and `#fce8e6` (6×) hardcoded across 2 files, no semantic token existed | `danger` / `dangerSoft` tokens; 14 call sites migrated |
| Keyboard hint | `Press / to focus · Demo data, no account connected` | `Press / to focus` |
| Footer wrapping | dangling `·` separator left at a line end on narrow viewports | separators hidden when the footer wraps |

### INVESTIGATE — deliberately not changed

| Item | Status / reason |
|---|---|
| `previewUtm()` in `src/lib/agency.ts:169` | **zero callers**, but it is the only client document of the live `POST …/utm` contract. Removing it is an API-surface decision, not a cleanup one → left for owner sign-off. |
| Remaining one-off hex values (GuidedResearch 8, Research 7, PushHints 7, Chart 6, Answer 5, LoginScreen 3, Chrome 2, SearchBar 1, ConnectionBar 1, App 1) | intent-specific tints/accents; each needs a design decision, not a mechanical swap |
| `#d93025` in `PushHints.tsx` | a third, slightly different error red (4.77:1). Consolidating changes an error affordance's appearance → owner decision |
| `docs/`: 25 files, 5 395 lines | four phase reports (`PHASE2_REPORT`, `PHASE3_BASELINE`, `PHASE3_PRODUCTION_READINESS_REPORT`, `PHASE4_STAGING_VALIDATION_REPORT`) overlap `WORKSTREAMS.md` / `FEATURES.md` / `BASELINE_AND_GAPS.md`. Consolidation proposed, **not executed** — it is a substantive editorial change. |

### No removals found for

Pages, routes, nav items, API routes, data models, permission checks, audit paths — the
inventory did not produce evidence that any of these is dead. Nothing was removed merely
because it is not on the home screen.

---

## 2. Documentation corrections

| File | Change |
|---|---|
| `README.md:5` | "Private Research Mode is coming soon" → **false** (it is implemented). Now states it is implemented and off by default, gated by `PRIVATE_RESEARCH_ENABLED=true`. |
| `docs/FEATURES.md` | removed the `e2e-not-run` legend row: no table row uses that mark any more, and the browser suite does run (9/9), so the legend asserted something untrue. |

---

## 3. Changed files

| File | Reason |
|---|---|
| `tailwind.config.js` | added `subtle`, `danger`, `dangerSoft`; comment records the contrast measurement |
| `src/components/GuidedResearch.tsx` | `subtle` ×1, `danger`/`dangerSoft` ×10 |
| `src/components/PushHints.tsx` | `subtle` ×2, `danger` ×2 |
| `src/components/LoginScreen.tsx` | `danger` ×1 |
| `src/components/PrivateResearchPanel.tsx` | `danger` ×1 |
| `src/components/Research.tsx`, `Chart.tsx`, `Answer.tsx`, `ConnectionBar.tsx`, `App.tsx` | `subtle` ×1 each |
| `src/components/SearchBar.tsx` | `subtle` ×1 + duplicate status sentence removed |
| `src/components/Chrome.tsx` | duplicate footer status removed; wrap-safe separators |
| `src/lib/demo.ts` | dead `adGroupOf` removed |
| `README.md`, `docs/FEATURES.md` | stale claims corrected |

**Type-only, text-only and class-name-only edits.** No logic branch, prop contract, request
or response shape changed.

---

## 4. Verification — baseline vs final

| Command | Baseline | Final | Exit |
|---|---|---|---|
| `npx vitest run` | 27 files, 577 passed, 2 skipped | **27 files, 577 passed, 2 skipped** | 0 |
| `npx tsc --noEmit` | clean | **clean** | 0 |
| `npx eslint .` | clean | **clean** | 0 |
| `npx prettier --check .` | clean | **clean** | 0 |
| `npx vite build` | clean | **clean** | 0 |
| `npx playwright test` | 9 passed | **9 passed** | 0 |

Playwright requires `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/tmp/chromium` (the sandbox has no
`ms-playwright` cache; `playwright.config.ts:16` already supports the override) and
`LD_LIBRARY_PATH=/tmp/al2023/lib`.

Tests added: **0. Removed: 0. Skipped: 0 new. Weakened: 0.** The 2 pre-existing skips are
unchanged.

### Browser and accessibility

- Chromium, 1280×900 and 390×844: home renders, **horizontal overflow 0 px at both widths**.
- Footer wraps to two clean lines at 390 px with no dangling separator; "Built for ChatGPT Ads,
  2026" stays hidden on mobile by design.
- `e2e/accessibility.e2e.ts` passes its four gates unchanged: every interactive control has an
  accessible name, the journey completes by keyboard alone, the workspace overlay is a `dialog`
  that closes on Escape, and the page reports **no uncaught console errors**.

### Security and privacy regression

Spot-checked against unchanged code paths, since this change touched none of them:

- `PRIVATE_RESEARCH_ENABLED` gate still present in `server/config.mjs` (2 references); the
  pre-auth `404 not_configured` order in `server/app.mjs` is untouched.
- No client-supplied role or permission is trusted: `WorkspacePanel.tsx:266-269` only *renders*
  the server-returned `permissions` object; no authorization decision is made in the browser.
- No secret in client variables: `import.meta.env` usage is limited to `VITE_API_BASE` (a base
  path) and the documented Firebase client config.
- `server/`, `firestore.rules`, `package.json` and `src/lib/api.ts` show **zero diff**.

Findings unchanged: **real provider calls BLOCKED / NOT RUN** (no key), **Firestore
BLOCKED / NOT RUN**, distributed rate limits **NOT RUN**. No integration evidence was fabricated.

---

## 5. Git status — my edits vs pre-existing work

`git status --porcelain` = **51 entries** before and after, so nothing was added or deleted.

Important structural finding: **`src/`, `server/` and `e2e/` are entirely untracked** on this
branch (`git ls-files src/` is empty). The application code has no version history here, which
means my edits cannot be separated from pre-existing work by `git diff` — the list in §3 is the
authoritative record. Pre-existing tracked modifications
(`.env.example`, `.gitignore`, `README.md`, `docs/{DECISIONS,METRICS,PRIVACY,TRACKING_PLAN}.md`)
were not reset, cleaned, stashed or overwritten.

The untracked `src/` tree is the highest-severity process risk in this repository.

---

## 6. Remaining production blockers

| # | Blocker | Severity |
|---|---|---|
| 1 | Application source (`src/`, `server/`, `e2e/`) is untracked — no review history, no rollback point | **High** |
| 2 | No real OpenAI Ads account, HubSpot app or Firestore project has ever been exercised | **High** (known, documented) |
| 3 | `previewUtm` dead client; `#d93025` third error red; ~49 one-off hex values | Low |
| 4 | 4 overlapping phase reports vs 3 status docs (5 395 doc lines) | Low (clarity) |

## 7. Recommended next step

Commit the untracked application tree on a branch first — until it exists in version control,
none of the above verification is reproducible by anyone else. After that, the highest-value
cleanup is the documentation consolidation (item 4), which changes no code.
