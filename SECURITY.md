# Security policy

## Supported releases

Security fixes are prepared for the latest immutable release and the current
reviewed release candidate. Older tags are historical artifacts and may remain
public for reproducibility, but they do not receive independent fixes.

## Report a vulnerability privately

If this repository's Security tab offers **Report a vulnerability**, use that
GitHub private reporting flow. If it is unavailable, contact the maintainer
through a previously established private channel and ask for a security-intake
route without including the finding. If no private channel exists, open a
content-free public issue asking only how to report a vulnerability privately.

Do not put exploit steps, private data, credentials, capability links, customer
identifiers, or affected Git objects in a public issue.

Include only what is needed to reproduce the problem with synthetic data:

- the affected release or commit;
- the security boundary that failed;
- minimal reproduction steps;
- expected and observed behavior; and
- whether you believe a credential or person's data was exposed.

Do not send a live token or secret. If a credential may be exposed, identify
its provider and state only whether it is active, rotated, revoked, or unknown.
Coordinate replacement through the provider's own secure interface.

## Response boundary

Maintainers will acknowledge a complete private report, reproduce it with
synthetic fixtures, and document the affected release and remediation decision.
No response-time or bounty promise is made in this policy.

Repository access does not grant access to any owner's Brain, Cloudflare
account, source corpus, support journal, or private evaluation material.
