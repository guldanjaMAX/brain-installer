# Architecture decision records

Use an ADR for a choice that changes system structure, a key quality attribute,
an ownership boundary, or something expensive to reverse. Accepted records are
append-only. When a decision changes, add a new record with `Supersedes` and
update the old record's status to `Superseded` without rewriting its rationale.

Start from `000-template.md`. Keep each record short enough to review with the
code it governs.

- [001: Standardize new Brain installs on Cloudflare](001-cloudflare-native-standard.md)
- [002: Accelerate exact legacy projection bootstrap only behind the paused barrier](002-paused-bootstrap-acceleration.md)
- [003: Use native, read-only temporary support sessions](003-temporary-support-sessions.md)
