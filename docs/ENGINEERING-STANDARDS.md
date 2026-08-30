# Engineering and documentation standard

The goal is not more comments. The goal is for a new engineer to find the
contract, understand why it exists, change it safely, and prove the change.

## Code should carry its contract

- Prefer clear names and small functions over narration of obvious syntax.
- Document every exported module or function with its purpose, inputs, output,
  side effects, failure behavior, and privacy or credential boundary.
- Use inline comments for reasoning the code cannot express: security
  invariants, concurrency assumptions, retry semantics, data-loss boundaries,
  compatibility constraints, and why an apparently simpler option is unsafe.
- Put the comment directly beside the invariant it protects. Update or remove
  it in the same change as the code.
- A complicated block that needs a line-by-line paraphrase should be simplified
  before adding more prose.
- Never place a client name, source identity, path, query, document content,
  credential locator from a real install, raw response, or secret in shipped
  comments, fixtures, examples, logs, or test snapshots.

This follows Google's engineering guidance that comments should usually explain
why while module documentation explains purpose, use, and behavior:
[code-review comments](https://google.github.io/eng-practices/review/reviewer/comments.html)
and [what to review](https://google.github.io/eng-practices/review/reviewer/looking-for.html).

## Tests are executable documentation

Every behavior change needs the smallest useful combination of:

1. A deterministic unit test for the contract and its edge cases.
2. An integration test at each trust boundary, such as Keychain, HTTP, D1,
   Vectorize, launchd, filesystem, or OAuth.
3. A lifecycle test for create, retry, update, delete, restore, and rollback
   when the feature owns persistent state.
4. A negative test proving secrets and private instance material cannot enter
   output, packages, support notes, or telemetry.
5. A real field gate when mocks cannot prove the account, scheduler, scale, or
   provider behavior.

A test must fail when the protected behavior is deliberately broken. Green
tests that never exercise the failure mode are not evidence.

## Track decisions separately from code comments

Architecturally significant choices live in `docs/decisions/` as short,
append-only architecture decision records. Each record states the problem,
options, decision, confidence, consequences, verification, and replacement
conditions. A changed decision gets a new record that supersedes the old one.
The old rationale stays visible.

This is consistent with Microsoft's guidance to retain architecture decisions,
their alternatives, tradeoffs, confidence, and status:
[architecture decision records](https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-record).

Implementation TODOs must name an executable completion condition or an issue.
Do not use comments as an unowned backlog. Runtime failures belong in the local,
sanitized support journal, not in an architecture record or source comment.

## Keep documentation types distinct

- `financialbrain.ai/install` is a beginner tutorial with one safe path.
- `financialbrain.ai/update` is a task-focused how-to guide with rollback and
  verification.
- CLI and manifest documentation are reference material.
- Architecture, evaluation, security, and decision records explain why the
  system works this way.

Mixing all four into one page makes every audience search through material they
do not need. The separation follows the
[Diataxis documentation model](https://diataxis.fr/start-here/).

## Definition of done

A change is not complete until all applicable rows are true:

| Area | Required evidence |
|---|---|
| Behavior | The intended outcome and explicit non-goals are written down. |
| Code | Names are clear; comments preserve only non-obvious contracts and rationale. |
| Tests | Normal, failure, retry, privacy, and lifecycle paths pass at the right layers. |
| Operations | Health, logs, support evidence, rollback, and recovery are defined. |
| Documentation | Install, update, reference, explanation, and ADR surfaces are updated where applicable. |
| Privacy | Package and output scans contain no private instance material or credentials. |
| Release | The immutable artifact, source commit, CI result, and field gate are recorded. |
| Claim boundary | The handoff says what was directly verified and what remains inferred or unimplemented. |

