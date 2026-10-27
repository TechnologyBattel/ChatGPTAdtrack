# Plans — Free and Pro

_2026-10-26. Product name: **AI AdTracker**. This file is the source of truth for what
each plan includes and, importantly, for how much of it is actually enforced._

Two plans exist. There is no billing system, no quota counter and no paywall in this
phase: the plan is a field on an organization that the UI displays. Read the **Status**
column before quoting any row to a customer.

## What "policy" and "enforced" mean here

| Mark | Meaning |
|---|---|
| **enforced** | The server refuses the action beyond the limit. Verified by a test. |
| **policy** | The stated intent. Nothing in the code blocks exceeding it yet. Do not describe it as a limit. |
| **Coming soon** | Not built. Shown in the product as forthcoming, never as included. |

As of this document **no row is enforced**. Every Pro-only capability is currently
available to every organization, and both Free limits (500 seeds a month, one workspace)
can be exceeded. That is a deliberate scope decision for this phase, recorded in
`DECISIONS.md`, not an oversight.

## The matrix

| Capability | Free — "Free Buff AI Tool" | Pro | In the product | Status |
|---|:--:|:--:|---|---|
| Demo data mode | ✓ | ✓ | Yes | available |
| Live ChatGPT Ads connection | — | ✓ | Yes — keys live on the server only | **policy** |
| Research: clustering + validators | ✓ | ✓ | Yes | available |
| Seed researches per month | 500 | Unlimited | Clustering yes; no counter | **policy** |
| CSV export | ✓ | ✓ | Yes — answers and hint sets | available |
| Workspaces | 1 | Multiple | Yes | **policy** |
| Push / Undo + audit log | — | ✓ | Yes | **policy** |
| First-party attribution | — | ✓ | Yes — signed server-to-server events | **policy** |
| Hint-set experiments | — | ✓ | **Not built** | **Coming soon** |
| Private Research Mode (BYO API keys) | — | ✓ | **Cluster naming only** — slice 1, behind `PRIVATE_RESEARCH_ENABLED` | **Limited beta · server flag · not plan-gated** |

Notes on individual rows:

- **Live connection.** The switch is already honest: without keys on the server the app
  runs in demo mode and says so. Gating it by plan would be a one-line check once the
  plan is authoritative.
- **500 seeds a month.** "Seed" is a research input, not a saved record. Research runs are
  stored per organization with a timestamp, so counting a calendar month is a natural
  query — but nothing counts today.
- **One workspace.** Workspace creation does not consult the plan. A Free organization can
  create as many as it likes.
- **Push / Undo + audit log** and **first-party attribution** are per-organization features
  that any member with the right role can use, regardless of plan.
- **Hint-set experiments** and **Private Research Mode** are listed because they are part of
  the Pro promise. Both are marked *Coming soon* wherever the product mentions them; the
  README says "coming soon" in the same sentence for the same reason.

## What is exposed in the API

The organization record carries `plan: 'free' | 'pro'`.

| Endpoint | Field |
|---|---|
| `POST /api/orgs` | `plan` on the created organization (always `free` at creation) |
| `GET /api/orgs` | `plan` on every organization, defaulted to `free` when a record predates the field |

The UI shows it as a read-only pill beside the organization selector in the Workspace
panel. It is per-organization on purpose: a global badge would misreport a user who
belongs to two organizations.

## If you need enforcement

In rough order of cost, all small and all separate from this phase:

1. **Workspace cap** — one check in workspace creation, `402` with an `upgrade_required`
   code, plus a UI message. Roughly 6 lines.
2. **Seed quota** — count the organization's research runs in the current month before a
   run starts, same error shape. Roughly 10 lines.
3. **Pro gating** — a `planAtLeast()` helper consulted by the handlers that serve
   live-connection, push and attribution routes.

Each needs a test asserting the *refusal*, not just the happy path.

## Private Research Mode — where it actually stands

Slice 1 exists in the code: it names clusters that the deterministic pipeline already
computed, using the caller's own provider key. Read the following before describing it to
anyone:

- **It is behind a server flag** (`PRIVATE_RESEARCH_ENABLED`), off by default, and it is
  **not gated by plan** — a Free organization can use it while the flag is on. There is still
  no way to set `plan: 'pro'`.
- **It does not replace the deterministic pipeline.** Clustering, scoring, validators and
  hints are unchanged and remain the source of truth. The model may only name a cluster it
  was given, and a rejected response changes nothing.
- **Nothing is stored** — not the key, the seeds, the prompt, the response or the names. One
  metadata-only audit line is written per attempt.
- **The honest limit:** the key and seeds pass through our server process in memory, and the
  request is sent to the provider, which may retain it under its own policy.

## Not in this phase

No billing or Stripe, no invoices, no trials, no proration. No SEO, social-media or
competitor modules. The product is a performance and context-hint research tool for
ChatGPT Ads; the plan matrix above is the whole of the commercial surface.
