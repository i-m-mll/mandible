# Authority lifetime through shutdown

## Evidence

[issue:0a733bd] identified a source-derived ordering hazard: a clearance signer could remain borrowed after queue disposal while its retirement still needed the shared database. [issue:4231051] identified an executor timeout that signaled a child before proving the command and its descendants had stopped. Neither issue records an observed production incident.

## Changes

- Queue, clearance manager, signing resource, and daemon shutdown now share a close barrier. New authority work is refused when closing; existing borrows and retirement finish before the database closes. Eligible unused clearances remain available for successor attachment.
- A consumed clearance has one owner through admission and execution. A failed stop or retirement remains visible and retryable; terminal retirement follows proven exact-process cleanup. Delayed cleanup rechecks process and socket identity before signaling.
- Executor timeout and output failures wait for owned process-group termination. If termination cannot be proved, the request stays nonterminal, its signer remains borrowed, same-repository execution stays fenced, and clean shutdown fails visibly.
- Failed self-restart retains a draining state and can retry the same close barrier. Approval cancellation and request-version checks retain their owner before asynchronous repository admission checks.

## Validation and limit

The integrated candidate passed build, typecheck, static checks, and the default suite (423 files, 2,960 tests). Behavioral tests use the real clearance manager, signing resource, queue, private migrated database, and held executor; process tests exercise a TERM-resistant descendant. Exact candidate acceptance is recorded on the review request.

Unproven process termination has no automatic proof-retry handle. It remains explicitly fenced pending recovery. An abrupt daemon kill or OS crash is outside this orderly-shutdown contract; durable borrower identity for surviving executors would require a separate design.

Co-Authored-By: Codex (GPT) <codex@openai.com>
