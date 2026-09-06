# Roadmap

## Delivered — graph result materialization boundary

As of 2026-09-06, validation, identity allocation, reference resolution,
Candidate staging and canonical publication are deterministic services separate
from Agent generation in all four graph-oriented modules. Each owns a versioned
Result Contract, a frozen Basis and a publish service that a producer with a
typed semantic result can call without an Agent, and each records a
Materialization Receipt for what it published or refused. See
[GRAPH_RESULT_MATERIALIZATION.md](GRAPH_RESULT_MATERIALIZATION.md) for the
closure record. MCP exposure and external producers remain a separate design.

## Current implementation update — real Planning connected

The [live Planning slice](JUST_DO_IT_PLANNING.md) now imports real formal Nodes,
persists Card context and runs a read-only local Agent for Plan generation and
feedback. Finalize creates ready Action contracts without execution. The frozen
preview remains separately accessible. Next evaluate Plan quality and recovery
with real users, then define the execution integration; no GitHub writes or
Action execution were enabled in this slice.

## Current focus — Just Do It Harness design; UI baseline frozen

As of 2026-08-30, the user accepted the current UI direction and requested a
freeze. The existing interaction remains available as explicit Preview Mode;
the ordinary implementation route does not display simulated execution data.
See [JUST_DO_IT_DEMO.md](JUST_DO_IT_DEMO.md) for the frozen baseline and limits.
Next, agree on the planning, execution-session, and verification Harness contracts,
then authorize real integration and validate a bounded end-to-end task.
No live execution or Session-reuse implementation is part of this UI freeze.

The subsequent Harness discussion is recorded in [JUST_DO_IT.md](JUST_DO_IT.md):
Agent-generated Plan and user review/sign-off, user-owned acceptance with honest
evidence, Agent-facing handoffs, bounded execution Session reuse, local Skill
integration, and Todo-to-Node follow-up. A Plan may reopen before any output;
after any output it requires a verified full rollback to its clean execution
baseline. These are design rules, not behavior already enforced by the frozen
preview. Next resolve rollback scope, partial acceptance/downstream readiness,
and Skill/runtime integration. Do not redesign the frozen UI in this docs round.

The [offline Harness foundation](JUST_DO_IT_HARNESS.md) now covers four stage
prompts, identity/scope/result validation and a durable Card worklog with a short
main handoff plus on-demand references. Fixed tests and an isolated sample
generator exercise the contracts; no model-quality or real-execution claim is
made. Next wire a bounded real planning run to those contracts and evaluate
handoff across Sessions before authorizing execution/GitHub integrations.

As of the 2026-08-29 discussion, the focus is defining Just Do It's manual
planning, execution, and verification workflow for GitHub-backed software
projects over shared Formal Nodes. The goal dashboard has independent execution
lifecycles, retains work after source deletion, and can report completion back
to surviving source Nodes without adding a new Node state. Clicking that
completion indicator to navigate to Just Do It is a later UI refinement.
See [JUST_DO_IT.md](JUST_DO_IT.md) for settled intent and remaining decisions.
The design-document round is followed by an authorized
[isolated UI demo](JUST_DO_IT_DEMO.md) using sample data. Real execution,
Harness integration, automatic review/merge, and storage migration remain out
of scope until separately agreed.

Local Git versioning and operational analytics remain deferred. They must not
delay completing the workflow discussion. Implementation scope and acceptance
checks will be agreed separately after the unresolved design questions are settled.

The frozen UI demonstrates whole-plan generation and feedback before Action
creation, concrete input/output/validation contracts, per-role demo model
configuration, and Issue-style follow-ups. Actual shared Agent/model settings
and GitHub Issue creation/synchronization require a later integration contract.
GitHub-backed Todos are distinct from the deferred local Git artifact-version
proposal; neither implies the other has been implemented.

The planning interaction now follows Start Plan, Loading, Overview with
step-by-step preview, and whole-plan confirmation. It keeps a current draft only;
planning response history and Git version management are explicitly excluded.

## Earlier Decomposition MVP planning baseline

The following records the earlier planning baseline, not a current runtime
status or acceptance report. It includes historical proposal/storage behavior;
do not use it to override later product contracts or infer that current data may
be deleted. Current conceptual boundaries are in [DECOMPOSITION_MODEL.md](DECOMPOSITION_MODEL.md).

### 1. Agent Run loop

- Replace the local-only Request Preview action with `Send to Agent`.
- Create a minimal Run record with `runId`, status, transport, start and end
  timestamps, and optional raw usage returned by the transport.
- Render a connected running Placeholder Card with honest transport and
  validation states.
- Let the user cancel a Run, interrupt the transport, remove the Placeholder,
  and restore the exact Instruction and Resources in the Composer.
- Ignore every late result from a canceled `runId`.
- Validate the Agent response through the Decomposition Harness before
  rendering Candidate Cards.
- Represent proposal, clarification, insufficient-evidence, failure, and
  cancellation outcomes without manufacturing a successful result.

The first implementation may execute one fresh local Agent per Run, but its
transport and records must preserve the seam required for Session reuse. A Run
therefore carries both its own `runId` and an optional provider-owned
`agentSessionId`, alongside the Praxis Decomposition `sessionId`, request
identity, input fingerprint, and Harness revision.

Later Runs should reuse one Coordinator Agent only inside the same bounded
Decomposition Session. Candidate feedback, clarification answers, Resource
changes, and graph deltas can continue that Agent Session without reinjecting
the complete Harness and unchanged evidence. A different independent root
starts a new Agent Session. An independent Reviewer always starts fresh so it
does not inherit the Coordinator's assumptions.

Session reuse is bounded rather than permanent. Praxis freezes a compact
handoff and creates a new Agent Session when the Context threshold is reached,
the Harness revision changes, the input boundary changes materially, the
transport or model changes, or repeated failures make the current Session
unreliable. Accepting the proposal or ending the Decomposition Session also
ends reuse. Run observability should later compare fresh and resumed Runs so
the cost benefit is measured rather than assumed.

### 2. Candidate delivery loop

- Inspect each Candidate and its proposed lineage and dependency relationships.
- Revise or discard temporary Candidates without mutating the formal graph.
- Accept one exact Candidate revision.
- Promote accepted output into a formal Node folder containing `node.json`, a
  readable Markdown artifact, and any Node-local Resources.
- Move superseded Candidate versions and transient Session history to the
  operating system Trash after successful promotion.
- Resume one bounded Coordinator Session for supplemental parent-level
  decomposition. Existing children remain immutable; the Agent can return only
  new siblings, `no-change`, or clarification.
- Restrict Candidate revision to the same Candidate identifier and next
  revision. Structural sibling or child changes return clarification.

## Deferred: Todo to task promotion

Allow an actionable GitHub Todo to become a task Card under a user-selected
parent Node, preserving its Issue association. Define the appropriate Node
acceptance and routing behavior separately. Current Todo UI stays a lightweight
Issue index and does not implement this conversion.

## Deferred proposal: Shared local Git versioning

Captured during the Just Do It design discussion on 2026-08-29. This is an
exploratory direction, not an approved architecture or migration task. Continue
defining the Just Do It workflow first; this proposal must not block it.

Investigate using an App-managed local Git repository as the shared versioning
foundation for What's Next, Break It Down, and Just Do It, without requiring
GitHub:

- Keep a stable file path for each Node or Action artifact. Each completed
  output round creates a commit instead of another version-specific artifact
  directory. A commit records an output, not successful validation.
- Read earlier versions and diffs from Git. Present rounds and revisions in
  the UI without requiring users to understand Git commands.
- Support selecting an earlier version as the baseline for further work.
- Reuse the same mechanism for Candidate refinement and Action output/review
  cycles rather than implementing separate artifact histories per module.
- Retain request, feedback, provider-session, usage, failure, and validation
  records linked to the relevant output version; Git does not remove the need
  for Run identity or execution evidence.

Questions to resolve before implementation:

- Repository boundaries and isolation from the user's existing code history.
- Node-level, proposal-level, and Action-level restore scope, including graph
  relationships; restoring one item must not reset unrelated work.
- Concurrent writes, commit ownership, and consistent artifact/metadata updates.
- How App artifact commits relate to actual code commits and external effects.
- How restoring content changes the next Agent input without assuming its
  provider session has also been rewound.
- Retention, deletion, sensitive data exclusions, and migration of existing
  per-Run artifact directories. Do not create a permanent duplicate versioning
  system or migrate current user data as part of this discussion.

The current implementation writes artifacts under distinct Run directories;
the proposal is to replace that artifact-version mechanism, not merely add a
Git audit log alongside it. Reset, scoped restore, revert, and branching policy
remain open design choices.

## Deferred: Run observability

Run observability is intentionally outside the first MVP. The initial transport
should preserve raw usage when it is already available, but it should not block
Agent invocation on cost calculation, dashboards, or detailed attribution.

Later observability should record:

- actual provider-reported input, cached input, output, and reasoning tokens
  when available;
- model, transport, elapsed time, retries, context expansions, tool calls, Sub
  Agent usage, outcome, cancellation, and failure information;
- estimated cost only when a reliable model-price snapshot is available;
- Praxis's measured request-payload attribution across the built-in
  Harness, user Instruction, Decomposition Context, Source Resources, graph
  map, expanded Nodes, type template, prior Candidate feedback, and output; and
- an explicit unallocated or platform-overhead category instead of pretending
  that attribution is exact.

Usage totals come from the transport or provider. The Agent must never be asked
to invent or self-report them. Payload attribution is a separate Praxis
measurement and must be labeled as such.

Candidate and formal Node content should reference the generating `runId`
instead of duplicating telemetry. A compact immutable Run summary may remain
after transient Session content is discarded. It must not retain complete
prompts or abandoned Candidate content merely for analytics. Canceled Runs
retain the usage accumulated before interruption.

The future interface can expose a `Run statistics` view with totals, Context
breakdown, duration, expansions, retries, tools, Sub Agents, outcome, and cost
when known.

## Deferred: Decomposition Recompose runtime

The product contract now names proposal-level structural revision
`Recompose`. Unlike the current strict one-Candidate `revise-candidate`
operation, Recompose may return a different partition and Candidate count.

Deliver it as one coherent runtime migration:

- add an explicit proposal-level Recompose operation;
- reconcile retained, replaced, split, merged, added, and removed Candidate
  identities;
- update the output schema, validator, persistence, and Canvas interaction
  together;
- treat accepted Formal Nodes as protected boundaries; and
- cover dependency impact, stale inputs, comparison, rollback, and system-Trash
  cleanup.

Do not rename only the Prompt or UI while the runtime still enforces one-to-one
revision. Restructuring accepted graph branches remains a separate future
operation.

## Deferred: Mobile Markdown feedback

The desktop Markdown review flow supports free text selection and block-level
feedback anchors. On an iPhone browser or embedded WebView, text-selection
handles, hover-only block controls, and the follow-up feedback action are not
reliable enough for practical use. A visible `Add feedback` action may appear
without producing a usable feedback Composer.

Mobile annotation is not required for the first desktop-focused What's Next
V1. A later mobile-specific interaction should avoid depending on desktop text
selection and should be validated on iOS Safari and embedded WebViews. Possible
directions include:

- an explicit annotation mode with always-visible block controls;
- tap-to-select paragraphs or list items, with optional multi-block selection;
- a bottom-sheet feedback Composer that preserves the selected excerpt; and
- clear selected, queued, stale, and removed feedback states without hover.

Do not treat the current mobile interaction as accepted merely because the
underlying line-range data model supports multiple lines.
