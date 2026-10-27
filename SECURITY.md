# Security policy

## Supported versions

This project is **pre-release**. No version has been published, tagged or deployed, and there
is no long-term-support line to patch.

| Version | Supported |
|---|---|
| `main` (current development) | Security fixes are applied here |
| Any tagged or published release | **None exist yet** |
| Forks, older branches, deployed instances run by third parties | Not supported by this project |

`0.1.0` in `package.json` is a development version number, not a release.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** A public report exposes users
before a fix exists.

Use GitHub's private vulnerability reporting on this repository if it is enabled — the
**Security** tab → **Report a vulnerability**. That channel keeps the report private between
you and the maintainers and creates a tracked advisory.

If private reporting is not available, open an issue that contains **no technical detail** —
only the sentence "I have a security report and need a private channel" — and a maintainer
will respond with a way to send it. Do not include reproduction steps, payloads, credentials
or affected-user details in that issue.

> The project has not yet published a dedicated security contact address. This section will be
> updated when the owner nominates one; no address is invented here deliberately.

### What to include

- The affected endpoint, screen or file, and the version or commit you tested.
- The impact you believe it has, and who could exploit it.
- Reproduction steps, with secrets and personal data removed or replaced by placeholders.
- Whether you have already disclosed it anywhere else.

### What to expect

This is a small, pre-release project without a staffed security team, so these are targets
rather than contractual commitments:

- Acknowledgement of your report within a few days.
- An assessment of severity and affected scope, and a decision on whether a fix or a
  documented limitation is appropriate.
- Credit in the fix's release notes if you would like it.

Please give a reasonable window for a fix before public disclosure. If a report affects people
using a deployed instance, say so in the first message so it can be prioritised.

## Scope

**In scope:** this repository's code — authentication, authorization and tenant isolation,
the consent handshake, secret handling, the event-ingest signature check, the audit trail,
webhook verification, CSP and other response headers, and dependency vulnerabilities reachable
from this code.

**Out of scope:** findings that require a compromised developer machine or browser extension;
denial of service by raw traffic volume; reports produced solely by an automated scanner with
no demonstrated impact; the security posture of OpenAI Ads, HubSpot, Firebase or Google Cloud
themselves (report those to the respective vendor); and any instance deployed by someone else.

## Security model, in one paragraph

Keys live only in server environment variables and never reach the browser; `VITE_*` variables
are public by definition and are treated as such. Every request that touches tenant data
resolves the organization and workspace from the caller's membership, and a foreign or
nonexistent id returns an identical `404`. Roles come from the server's own response, never
from client input. Production refuses to start without Firebase auth, and the development auth
mode refuses to start at all when a real ad-account key is present on the same process.
Nothing is pushed to an ad account without a diff, an explicit confirm and an audit record.

The full model, including which parts are verified and which are assumptions, is in
[docs/SECURITY.md](docs/SECURITY.md). Data handling is in [docs/PRIVACY.md](docs/PRIVACY.md).

## Known and accepted limitations

These are documented rather than fixed, so they are not vulnerabilities in themselves:

- Nothing in this repository has been exercised against a real OpenAI Ads account, a real
  HubSpot portal or a real Firestore project.
- Consent recording and retention choices are implemented, but their legal sufficiency under
  GDPR, DPDP or any other regime has not been assessed.
- No load, capacity or recovery testing has been performed, and no such numbers are claimed.
- The HubSpot connector is read-only by design and covers a narrow scope.
- Private Research Mode is disabled by default and, when enabled, deliberately reveals whether
  the feature is on for the deployment — a documented trade-off, not an oversight.
