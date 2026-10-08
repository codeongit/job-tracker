---
name: implement
description: 'Implement a piece of work based on a spec or set of tickets.'
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Follow [change workflow](../../../docs/agents/change-workflow.md) before editing: verify the affected current mechanism and intended behavior separately, capture the task baseline, and resolve consequential assumptions. Reuse this record for verification and independent review; scale the work to the actual impact. Do not treat an implementer-authored spec or ADR as evidence of user confirmation.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.
