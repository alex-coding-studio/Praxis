# Graph Result Materialization

Status: Implemented. The completion audit below is closed; see the closure record for the evidence behind each item. MCP exposure remains deferred to its own design.

## Audit closure — 2026-09-06

The 2026-09-05 completion audit is closed against `be2cda2`. Its four sections were delivered by the pull requests named below, each merged after independent review with repository gates green.

| Audit section                                    | Delivered by           | Evidence                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Producer-neutral stage and publish boundary   | #224, #225, #227, #229 | Each module owns `publish.ts`. `tests/{product-exploration,scope-decomposition,domain-model,delivery-map}-submission.test.ts` prepare a Basis, submit a typed semantic result and read back the published outcome without a provider, an Agent response, or a Harness/Session record.         |
| B. Delivery Planning result-contract integration | #228, #229, #235       | `runs.ts` settles through `toDeliveryMapSemanticResult`; `materializeWhatToDoDeliveryMap` takes `DeliveryMapResult` and the frozen Basis; computation, staging and canonical publication sit behind `publish.ts` with the Planning service and Delivery target guard injected.                |
| C. Semantic results, receipts and Host events    | #232, #234             | Every module writes `semantic-result.json`, binds its hash to a `MaterializationReceipt` on the Run record (Domain Modeling and Delivery Planning also to `materialization.json`), and emits `materialization.*` as `HOST`. Rejections carry their failing boundary with `publication: null`. |
| D. Acceptance gap and gate coverage              | #230, #232, #234       | `audit:materialization-boundary` fails on a missing or unanalyzed required file, and a test fails when a guarded module file is absent from that list. Staging and publication failures are covered per module and leave canonical state unchanged.                                           |

Two defects the audit did not name were found and fixed while closing it: a proposal local key shaped like a Candidate label could capture a retained Contract's identity (#228), and a newly created Delivery Contract was published with no Source Claims because the Claim filter compared a materialized identifier against a proposal reference (#235).

Against the Definition of done below: all four modules carry a versioned Result Contract; all four can validate and materialize a typed result without an Agent; all four Agent flows settle through their producer adapter and the same Materializer; the dependency-direction gate guards 36 Materializer-tier files and 4 adapter files across runtime and type-only edges; identities, hashes, paths, lifecycle state, layout, observability and receipts are Praxis-owned; stale and invalid results are refused before any visible change; no artifact migration was required and the parity goldens carry the proof; no MCP server, tool schema, Card change or UI is included.

## Completion audit — 2026-09-05

Audited against `0d40c7e`, including the graph materialization work through PR #221 and the independently merged delivery-runtime refactor in PR #214. This was a document-to-code boundary audit, not a new full test run. Existing passing suites and checkpoint reviews establish their covered behavior; they do not establish the unfinished boundaries below.

The delivered work is useful and should be retained. It establishes versioned Result Contracts, producer adapters, shared graph references and identity allocation, shared Candidate document/promotion primitives, extracted module validation, frozen bases, stale-publication guards and parity goldens. It has not yet established a complete producer-neutral submission-to-publication service for every module.

MCP transport and tools remain explicitly deferred. Their absence is not a finding against this document. The remaining work is inside Praxis so that a later MCP caller can use the same deterministic path as an internal Agent Run.

### Current coverage

| Area                           | Implemented                                                                                                                          | Still required                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared foundation              | Contract identities, versions, hashes, schemas/examples, explicit reference kinds, basis/receipt types and dependency-direction gate | Wire the receipt and materialization log definitions into real operations; persist the independent semantic result                                            |
| Product Exploration and Design | Agent adapter, neutral validation and Candidate identity resolution; shared document staging and Node promotion                      | Module-owned stage/publish orchestration that accepts a basis and semantic result without a `WhatsNextRunRecord` or producer envelope                         |
| Scope Decomposition            | Adapter, neutral validation/materialization, recomposition reference resolution and shared graph primitives                          | The same independent stage/publish boundary, retaining append/revise/recompose behavior                                                                       |
| Domain Modeling                | Frozen basis, adapter, pure model composition and existing canonical model application/commit receipt                                | A service connecting the neutral result and basis to validation/application and a materialization receipt, without reconstructing a Harness-shaped result     |
| Delivery Planning              | Frozen current-map basis, stale-map protection, extracted proposal validation, normalized proposal computation and parity goldens    | Wire the neutral `DeliveryMapResult` adapter into the real flow; make map computation, staging and publication consume that result through one module service |

### A. Complete the producer-neutral stage and publish boundary

The graph Materializers currently return resolved Candidate records and aliases. Their Run services still combine those records back into producer results, organize artifact writes and publish Run state. Shared helpers are present, but a future caller still has to reproduce part of that Run settlement protocol.

Evidence:

- `lib/modules/product-discovery/materializer.ts`: `materializeProductExplorationResult` validates and allocates/resolves Candidate records; `runs.ts` still owns `ensureCandidateArtifacts` and the surrounding Run publication.
- `lib/modules/scope-decomposition/materializer.ts`: `materializeScopeDecompositionResult` returns Candidates/aliases/effects; `runs.ts` still bridges them into its result and settlement lifecycle.
- `lib/graph/proposal/stage.ts`: `stageCandidateDocuments` accepts a caller-supplied `runPath`; this is a lower-level helper, not the registry-confined public submission boundary described here.
- `lib/modules/domain-modeling/runs.ts`: `settledDomainModelResult` composes the neutral result into a Harness-shaped result before `settle` invokes `applyProposedDomainModel`. Existing model application and its commit receipt must be reused, not replaced with another writer.

Required work:

1. Expose explicit module services for preparing, validating, staging and publishing a typed semantic result against a frozen basis. Services own their artifact locations and return structured outcomes and references.
2. Keep producer parsing, raw response, reflection, usage and Session evidence in the Run/adapter layer. Do not require fake values for those fields to call deterministic services.
3. Route existing Agent settlement through these services. The Run service may still orchestrate an Agent and record its evidence; it must not retain an alternative entity-publication implementation.
4. Keep shared staging/promotion helpers where their invariants are identical. Do not introduce a generic repository that erases module lifecycle rules.
5. Preserve the existing Candidate acceptance boundary. Completing this service does not authorize automatically accepting graph proposals.

Acceptance: a test can prepare a basis, submit a valid typed result, obtain the published Candidate or canonical outcome and its references, and inspect that outcome without launching a provider, parsing an Agent response, or constructing a Harness/Session record. Equivalent internal Agent results still produce the existing golden outputs through that same path.

### B. Finish Delivery Planning's result-contract integration

The neutral Contract and adapter exist, but are not yet the input used by the production map materialization path.

Evidence:

- `lib/modules/delivery-planning/producer-adapter.ts` exports `toDeliveryMapSemanticResult`; production Run settlement does not call it.
- `lib/modules/delivery-planning/runs.ts` parses the Harness result and passes that result to `materializeWhatToDoDeliveryMap`.
- `lib/modules/delivery-planning/map.ts` still accepts `WhatToDoMapProposal`, together with caller-provided `runId`, `updatedAt` and source snapshot/storage metadata, rather than `DeliveryMapResult` and the complete frozen basis.
- Contract artifact writes and `publishDeliveryMap` remain in `runs.ts`; the latter still defaults to the old Planning Card service. It is not a producer-neutral publication entry point merely because it is exported.

Required work:

1. Use the existing adapter in the Agent path and feed `DeliveryMapResult` into neutral validation/materialization. Existing formal Contract references must remain explicit; do not require a direct producer to recreate Candidate aliases, revisions or Harness fields.
2. Put map computation, artifact staging and canonical publication behind the module service from A. The Host supplies publication identity and timestamps internally.
3. Preserve the captured `currentMap`, its fingerprint and the stale-basis check inside the existing serialized publication boundary. Do not revert the fixes delivered in PRs #218–#221.
4. Keep completed/unrelated Contract protection and atomic dependency replacement. Reconcile the old Planning Card synchronization consumer with the new DeliveryTarget protection introduced by PR #214; do not revive removed execution APIs or add a second synchronization path.

Acceptance: the minimal neutral map example can reach a published map using only valid project/basis/context inputs, without translating back into `WhatToDoHarnessResult`. Cover a retained Contract and a redundant uncompleted Contract removed with its dependencies reconnected. Existing create/adjust goldens and stale-map conflict tests remain applicable.

### C. Persist semantic results, receipts and Host materialization events

`MaterializationReceipt` and `materializationLogEntry` are defined, but a repository-wide caller search at the audited revision finds no production use that emits those records/events. `semanticResultHash` is used for basis/source fingerprints; it is not persisted as a semantic-result receipt by the scoped Run services. A parsed or materialized result inside a producer-specific Run record does not satisfy independent semantic-result persistence.

This does not mean the product has no logs or receipts. Existing Run logs, Latest Responses and the Domain Model commit receipt are real and must remain. The missing part is the additional producer-boundary evidence explicitly required by this document.

Required work:

- Persist the normalized, producer-neutral semantic result independently of the raw envelope, and bind its hash to the operation receipt.
- Emit the Contract id/version/hash, basis fingerprint, actual producer provenance, outcome, affected identities and publication reference. Reuse the existing Domain commit receipt as publication evidence where appropriate.
- Emit materialization validation, identity allocation, staging and publication events as `HOST`, using the shared event helper. Preserve Agent reasoning/tool events as `AGENT`.
- Persist a rejected operation with its precise failure boundary without claiming publication. Do not require a caller to scan output directories to discover what happened.
- Keep `agent-run` provenance truthful for current Run callers. Do not invent a provider Session for a direct deterministic call. Any future external-producer variant belongs to the later MCP design; this step must leave the deterministic service independent of Agent-specific evidence.

Acceptance: successful and rejected operations expose independently readable semantic-result/receipt artifacts, their hashes agree, their affected IDs match the visible result, and their logs identify Host work. Neither a no-change result nor a validation rejection creates graph entities.

### D. Close the remaining acceptance gap and update completion status

Retain the current parity goldens, reference validation, identity preservation, stale-basis guards and dependency-direction tests. Add only the missing service-level checks from A–C, rather than repeating all gates or testing implementation constants.

For the newly extracted publication boundary, verify a concrete staging/publication failure leaves existing visible state unchanged and cannot produce a successful receipt. This is completion evidence for the new boundary, not an assertion that every current writer is broken. Existing monotonic unused identity reservations remain permitted under the original rules below.

Extend the dependency-direction gate's required-file coverage to the completed module services, including Delivery Planning's computation/publication ownership. Keep both runtime and type-only transitive checks. Do not call the work complete merely because the current gate passes while the remaining publication code lives outside its guarded service layer.

Recommended remaining delivery sequence:

1. Finish the graph-module service/publication seam and its receipt/artifact mechanism using Product Exploration, then reuse it for Scope Decomposition.
2. Connect Domain Modeling's neutral result/basis to its existing state writer through the service boundary.
3. Finish Delivery Planning's adapter-to-neutral-service wiring and publication split.
4. Verify the cross-module Definition of done, update this status with actual completed evidence, and only then start the separate MCP exposure design.

No one-time data migration, source graph rewrite, new UI, provider permission framework or execution refactor is required to close this checklist. Coordinate with the separate delivery-runtime cleanup only where the existing Delivery Map publication consumer crosses that boundary.

## Task summary

Decouple Agent result generation from deterministic validation, identity allocation, relationship resolution, candidate staging, canonical publication, and filesystem persistence across Praxis's graph-oriented modules.

The immediate implementation scope is Product Exploration and Design (`whats-next`), Scope Decomposition (`task-decomposition` / `task-graph`), Domain Modeling, and Delivery Planning (`what-to-do`). Existing in-product Agent Runs must keep working and must be migrated to the same materialization services. MCP exposure, external clients, implementation Cards, execution coordination, and new UI are explicitly deferred.

The resulting boundary must allow a future caller that already owns a complete semantic result to submit that result without invoking a Praxis generation Agent or imitating Praxis's filesystem format. Praxis remains the sole owner of validation, identifiers, hashes, versions, directories, candidate lifecycle, canonical state, derived layout, logs, and atomic publication.

## Why this work is needed

Praxis currently treats the following work as one end-to-end operation in several modules:

1. assemble Context and a Harness request;
2. invoke an Agent;
3. parse and validate the Agent envelope;
4. interpret its semantic result;
5. allocate Candidate or formal identities;
6. resolve dependency and lineage references;
7. write Run evidence and Candidate artifacts;
8. promote or publish canonical state.

That coupling makes the Agent invocation the only practical entrance to capabilities that are otherwise deterministic. A caller that already knows the intended nodes, relationships, Domain Model, or Delivery Map has to ask another Agent to infer the same result before Praxis can persist it.

The target architecture treats Agent generation as one producer of a semantic result, not as the owner of materialization:

```text
Current Praxis Agent + Harness ──> producer adapter ─┐
                                                    ├─> Result Contract
Future external producer ─────────> producer adapter ┘        │
                                                              v
                                                    Validator + Materializer
                                                              │
                                                              v
                                              Candidate / canonical module state
```

There must be one validation and materialization path per module. An external entry point must never introduce a second, simplified persistence path.

## Terminology

### Generation Harness

Agent-facing instructions that explain how to reason from User Input and Context and how to return an Agent result envelope. A Harness may require reflection, impact review, clarification, exploration notes, or response prose. Those fields can be important Run evidence, but they are not automatically part of the canonical semantic result.

### Producer envelope

Transport and producer-specific fields such as Harness identity, request identity, input fingerprint, Agent reflection, impact review, usage, session identity, and raw response. Existing Agent flows retain these records. They must not be required by the Materializer.

### Semantic result

The module-specific, producer-neutral description of the desired result. Examples include proposed graph nodes and relationships, Domain Model operations, or a complete Delivery Map proposal.

### Result Contract

A versioned, machine-readable schema plus semantic validation rules for a module's semantic result. It is narrower than an Agent Harness output schema and contains no transport identity or storage implementation fields.

### Materialization basis

A frozen description of the current module state against which a semantic result is prepared. It identifies the project, module, operation, canonical revision or fingerprint, existing formal identities, current Candidates when applicable, protected accepted artifacts, and allowable source references.

### Materializer

Deterministic application code that validates a semantic result against its basis, allocates system-owned identities, resolves references, stages artifacts, and returns a materialized Candidate or canonical state. It does not invoke an Agent and does not make product decisions.

### Publisher

The lifecycle-specific code that atomically makes staged materialized output visible as a Run Candidate or current canonical module state. User acceptance remains a separate operation where the current product already requires it.

## Required architectural boundary

Each graph-oriented module must expose an internal application service with the following conceptual operations. Exact TypeScript names may follow repository conventions, but the responsibilities must remain distinct.

```ts
prepareMaterializationBasis(project, request): Promise<MaterializationBasis>

validateSemanticResult(basis, value): SemanticResult

materializeSemanticResult(project, basis, result): Promise<StagedMaterialization>

publishMaterialization(project, basis, staged): Promise<PublishedResult>
```

The public orchestration function may compose these operations, but the lower layers must remain independently testable without an Agent transport, prompt, raw JSON response, or provider Session.

The existing Agent route becomes:

```text
prepare Run Context
→ invoke Agent
→ parse producer envelope
→ adapt envelope to semantic result
→ prepare/reconfirm materialization basis
→ validate semantic result
→ materialize
→ publish
→ persist producer evidence and Latest Response
```

A future direct producer route can start at the same Result Contract:

```text
prepare materialization basis
→ submit semantic result
→ validate
→ materialize
→ publish
```

This document does not implement that future route.

## Result template requirements

The Result Contract is the future template that a producer reads before generating data. It must describe semantic input, not persisted `node.json` or Run storage.

Every contract must provide:

- a stable contract identifier and integer version;
- JSON Schema or an equivalently machine-readable structural definition;
- concise field semantics where shape alone is insufficient;
- supported operations and operation-specific constraints;
- accepted reference forms for formal Nodes, current Candidates, proposal-local entities, Sources, and Resources;
- lifecycle expectations: Candidate output, canonical replacement, or no-change;
- a content hash so a caller can prove which contract it used;
- a minimal valid example that contains no project-specific facts.

The contract must not require a producer to supply system-owned storage fields.

## Ownership of fields

### Producer-owned semantic fields

Depending on the module, a producer may supply:

- local proposal keys for newly proposed entities;
- title and human-readable summary or description;
- semantic type, Layer, or artifact kind where the module owns those concepts;
- direct prerequisites (`dependsOn`);
- lineage or derivation sources (`derivedFrom`);
- module-approved Resources and source references;
- module-specific structured content such as assumptions, acceptance criteria, Domain impact, source claims, or relationship meaning;
- human-readable artifact content such as Candidate Markdown when it is canonical product meaning;
- a recomposition plan expressed through supported retain, replace, split, merge, add, and remove effects.

### Praxis-owned fields

Only Praxis may produce or change:

- formal Node IDs and Candidate IDs;
- stable UIDs and identity aliases;
- content hashes and input fingerprints;
- revision numbers and timestamps;
- Run, Session, and request identities;
- filesystem paths, directory names, temporary paths, and filenames;
- accepted, captured, proposed, superseded, or other lifecycle status;
- provenance records that attest to the actual Run or submission;
- type-template fallback selection when it is derived from current project state;
- canonical relationship IDs after reference resolution;
- graph coordinates and layout;
- work records, Latest Response, Log entries, and publication receipts.

A producer must not be allowed to choose a formal ID by embedding `NODE-*`, a UUID, a hash, a timestamp, or a storage path for a new entity. Existing formal entities are referenced by exact current IDs; new entities use proposal-local keys that are meaningful only inside one submission.

## Shared graph proposal model

Product Exploration and Scope Decomposition share the same canonical `TaskGraphNode` storage shape and should share a producer-neutral graph proposal core. Module-specific contracts may extend it.

A conceptual new-node entry is:

```json
{
  "localKey": "find-item",
  "type": "feature",
  "title": "Find an item",
  "summary": "Locate an item through its space and container relationships.",
  "derivedFrom": [{ "kind": "node", "id": "NODE-existing" }],
  "dependsOn": [{ "kind": "proposal", "localKey": "capture-location" }],
  "resources": [],
  "metadata": {},
  "presentation": {},
  "assumptions": []
}
```

This is illustrative, not the schema to copy verbatim. The implementation must derive the final shape from current module requirements and preserve supported fields.

Reference kinds must be explicit. Title matching, array-position matching, or guessing identity from similar content is prohibited. At minimum, validation must distinguish:

- an existing formal Node ID;
- an existing current Candidate ID during Candidate revision or recomposition;
- a proposal-local key for a new entity in the same semantic result.

The Materializer resolves proposal-local references only after every new entity passes validation. It then verifies unknown references, duplicate keys, self-dependencies, cycles, unavailable Candidate revisions, and dependencies on removed or replaced entities before writing any artifact.

Canonical graph Nodes continue to store only formal `NODE-*` dependency and lineage identifiers. Proposal-local and `CANDIDATE-*` references must not leak into accepted `node.json` files.

## Identity and lifecycle requirements

1. Existing accepted Nodes retain their `id`, `uid`, `createdAt`, Resources, provenance, and other protected fields unless the current module explicitly supports a formal edit operation for that field.
2. Refining an unaccepted Candidate retains its Candidate identity and advances its revision exactly once.
3. New Candidates receive identities from Praxis after structural and semantic validation succeeds.
4. Candidate-to-Candidate dependencies resolve through provenance when prerequisites are accepted. Acceptance remains dependency-ordered.
5. Recomposition must account for every selected Candidate exactly once and every output exactly once, preserving the current retain/replace/split/merge/add/remove rules.
6. Removing a Candidate or Delivery Contract must fail when an unmodified remaining entity still depends on it. A semantic result may explicitly replace those dependencies in the same atomic operation.
7. No-change, clarification, insufficient-evidence, and failure are Run responses. They do not materialize graph entities.
8. Product Exploration and Scope Decomposition continue to produce reviewable Candidates. They do not automatically promote formal Nodes.
9. Domain Model and Delivery Map publication retain their current user-visible lifecycle during this refactor. Lifecycle changes require a separate product decision.
10. Layout remains a deterministic projection. Result Contracts contain no `x`, `y`, viewport, rank offset, or React Flow state.

## Concurrency and atomicity

Materialization must be based on a frozen basis and must fail safely when current state changes.

The basis must include enough information to detect stale writes:

- project identity and planning root;
- module and operation;
- canonical state version, graph identity version, or deterministic state fingerprint;
- selected formal and Candidate identities with their current revisions;
- protected accepted identities;
- permitted Source and Resource references;
- Result Contract identifier, version, and hash.

Immediately before canonical publication, Praxis must confirm that the basis still matches current state. A stale basis produces a conflict and no partial update.

Where a module has no revision counter, the basis fingerprint is computed from the current canonical file content. The Delivery Map basis fingerprints the bytes of `current-map.json`, and the graph modules fingerprint `identities.json`. Any change to that file between basis preparation and publication, including a manual edit, is a stale basis.

All affected output must be validated before any canonical write. New files must be staged in Praxis-owned temporary paths and exposed only through the module's existing mutation serialization or state lock. On failure:

- temporary files are removed;
- current Candidates and canonical state remain unchanged;
- no identity reservation may make a partial entity visible;
- no Latest Response may claim a proposal was published;
- the failure Log must identify validation, staging, stale basis, or publication as the failed boundary.

Where identity reservation necessarily precedes filesystem publication, an unused reservation may remain only if the existing identity store explicitly treats reservations as durable monotonic allocation. It must never resolve to a visible partial Node.

## Module requirements

### Product Exploration and Design (`whats-next`)

Current coupling is concentrated in `lib/modules/product-discovery/harness.ts` and `runs.ts`: the Harness schema combines producer-envelope fields with Candidate content, Run settlement writes Candidate evidence, and Candidate acceptance allocates a formal identity and writes the formal Node directory.

Required outcome:

- extract a producer-neutral Product Exploration Result Contract from `WHATS_NEXT_HARNESS_OUTPUT_SCHEMA`;
- keep Reflection, continuation advice, exploration notes, request identity, and Harness identity in an Agent producer envelope unless a field is explicitly required as canonical Candidate meaning;
- keep Layer, artifact kind, Candidate Markdown, assumptions, Resources, metadata, presentation, dependencies, and lineage in the semantic contract;
- move Candidate staging and formal promotion behind module services that do not import Agent transport or prompt code;
- use shared graph reference validation and shared Node promotion primitives;
- preserve explore, refine Candidate, redo, clarification, and no-change behavior;
- preserve accepted Product Exploration and Product Design Nodes exactly for equivalent existing Agent results.

### Scope Decomposition (`task-decomposition` / `task-graph`)

Current coupling is concentrated in `lib/modules/scope-decomposition/harness.ts` and `runs.ts`. It duplicates Candidate staging and formal promotion behavior while adding append, revise, and recompose operations.

Required outcome:

- extract a producer-neutral Scope Decomposition Result Contract;
- keep Agent impact review and request identity in the producer envelope;
- reuse the shared graph proposal, reference resolution, identity allocation, Candidate staging, and formal promotion primitives;
- retain module-specific intention and motion validation;
- retain propose, append Candidates, revise Candidate, recompose, clarification, insufficient-evidence, and no-change behavior;
- retain all current recomposition invariants and dependency blockers;
- preserve node-local Resources and Candidate Markdown conventions;
- eliminate duplicated formal Node construction where Product Exploration and Scope Decomposition have identical rules.

Shared code is justified only for identical invariants. Product meaning, valid operation boundaries, Harness prompts, response copy, and module-specific fields remain in their modules.

### Domain Modeling

Domain Modeling is structured and graph-like but does not use `TaskGraphNode` folders. It must not be forced into the shared Task Graph Candidate type.

Current `parseDomainModelResult` and `applyProposedDomainModel` should be separated so that the latter consumes a producer-neutral Domain Model semantic result rather than `DomainModelAgentResult`.

Required outcome:

- extract a versioned Domain Model Result Contract containing only supported semantic operations and content;
- keep Harness, request, response prose, and Agent Session data outside it;
- expose pure validation for entity and relationship references, selection boundaries, operation legality, and base `stateVersion`;
- make Domain Model application callable with a frozen basis and no Agent transport;
- keep commit receipt creation and canonical state publication in Praxis;
- preserve the existing state version, summary generation, no-change behavior, and current user-visible publication lifecycle;
- do not convert Domain entities into Task Graph Nodes as part of this work.

### Delivery Planning (`what-to-do`)

`materializeWhatToDoDeliveryMap` is already close to the desired deterministic boundary, but its input is an extracted `WhatToDoHarnessResult` and Run settlement owns parsing, materialization, artifact writing, current-map publication, and Planning Card synchronization.

Required outcome:

- move producer-neutral Delivery Map proposal types out of the Harness module;
- make `materializeWhatToDoDeliveryMap` consume the Delivery Map Result Contract, not the Agent result envelope;
- preserve Candidate-to-formal Contract identity remapping, source claims, source snapshots, retained identities, dependency updates, and recomposition effects;
- separate pure map materialization from contract Markdown staging, current-map publication, and Planning Card synchronization;
- keep the whole Delivery Map update under `withDeliveryState` and reject stale current-map revisions;
- preserve completed Contracts and their implementation/acceptance state unless an explicit, separately authorized lifecycle operation supports changing them;
- allow one atomic adjustment to remove a redundant uncompleted Contract and reconnect remaining dependencies without rewriting unrelated Contracts;
- ensure a failed publication cannot leave `current-map.json`, Contract artifacts, and implementation Cards describing different maps;
- preserve current repository summary and source-evidence behavior; binary repository-evidence filtering is a separate defect and must not be folded into this refactor.

## Run records, provenance, and observability

Agent Runs continue to record the full producer envelope, raw response, usage, Session identity, Context manifest, activity, and validation failure evidence.

Materialization records must additionally make the producer boundary visible:

- Result Contract identifier, version, and hash;
- basis revision or fingerprint;
- producer kind, initially `agent-run`;
- semantic result hash;
- materialization outcome and affected Candidate or formal IDs;
- publication receipt or precise failure boundary.

Do not label deterministic Materializer work as Agent work in the Run Log. Validation, identity allocation, staging, and publication are `HOST` events. Existing Agent reasoning and tool use remain `AGENT` events.

The semantic result must be durably inspectable independently of the raw Agent envelope. A future external producer must be able to create the same record shape without inventing an Agent Session.

## Internal API constraints

- Materializers must accept typed values, never raw JSON strings.
- Raw JSON parsing belongs to a producer adapter.
- Materializers must not import Agent transports, prompts, model profiles, Harness prose, or provider Session types.
- Harness validators may import Result Contract validators, but Result Contract and Materializer modules must not import Harness modules.
- Filesystem writers must not accept caller-selected absolute paths.
- Callers must not supply timestamps, UUID factories, or hash functions outside tests.
- Production callers must use the project registry identity and existing planning-path confinement.
- Module services return structured receipts. They must not require callers to rediscover generated files by scanning directories.
- A generic graph repository must not erase module lifecycle semantics. Prefer a small shared graph core plus explicit module services.

## Compatibility requirements

This is an internal refactor before it is an extensibility feature.

For equivalent existing Agent output, the migrated flow must preserve:

- visible Candidate content and ordering;
- stable accepted Node identities;
- formal dependency and lineage direction;
- Candidate revision behavior;
- type template resolution;
- node-local Resource paths;
- canonical Domain Model content and state-version progression;
- Delivery Contract content, source coverage, identities, dependency relationships, and current-map behavior;
- Latest Response status and existing user acceptance boundaries;
- deterministic graph layout;
- cancellation and stale-write protection.

No migration may rewrite existing project data merely to adopt the new code boundary. Existing Runs and Nodes remain readable.

## Testing requirements

Tests must exercise meaningful boundaries without manufacturing mutations in otherwise correct project data.

Required coverage:

1. a valid producer-neutral result can be materialized without an Agent transport or Harness prompt;
2. the existing Agent adapter produces the same semantic result for a representative valid Harness result;
3. unknown formal references, unknown Candidate references, duplicate proposal keys, self-dependencies, and cycles fail before publication;
4. new proposal-local dependencies are resolved deterministically;
5. accepted Candidate dependencies resolve to formal Node IDs during dependency-ordered promotion;
6. existing accepted identities and protected fields remain stable;
7. Candidate revision and recomposition preserve current identity rules;
8. removal with an unrepaired dependent fails; removal plus dependency replacement in the same result succeeds;
9. a stale basis fails without changing visible state;
10. a forced staging or publication failure leaves canonical state unchanged and cleans temporary artifacts;
11. Domain Model materialization rejects an old `stateVersion` and preserves current canonical state;
12. Delivery Map materialization preserves retained Contract identities and source claims and publishes map, artifacts, and Planning Card synchronization consistently;
13. no-change, clarification, insufficient-evidence, and failed producer results create no graph entities;
14. existing module integration tests remain green through the new services.

Do not test by deleting a correct validation rule, altering a valid identifier, or corrupting production fixtures merely to prove a test can fail. Invalid result fixtures are appropriate when the invalidity is the behavior under test.

## Delivery sequence

Deliver the implementation as an ordered series of pull requests, each of which leaves the product self-consistent after merge:

1. This document.
2. Part 1, delivered as four pull requests: the materialization core and graph reference model; the per-module Result Contracts with the Harness schemas composed from their fragments; the producer adapters, shared graph proposal validator and Domain Model parse split; and the dependency-direction gate with its self-test fixtures.
3. Part 2a: shared graph proposal primitives and the Product Exploration migration, with parity goldens captured from the existing path before the refactor.
4. Part 2b: the Scope Decomposition migration and removal of the duplicated identity and Node-construction path.
5. Part 3: Domain Modeling.
6. Part 4: Delivery Planning.

Part 1 is split because each pull request establishes one reviewable boundary that the next builds on, and a single change would have been too large to review against the ownership rules above.

Part 2 is split because the two module run services are each close to two thousand lines and duplicate one another; the shared primitives and the first migration are one review unit, and the second migration is then a mirror whose diff is dominated by deletions.

### Part 1: Establish contracts and boundaries without behavior change

- introduce shared terminology and core types for basis, producer kind, semantic result identity, and materialization receipt;
- move producer-neutral schema fragments out of Harness modules;
- add producer adapters from existing Agent results;
- add dependency-direction tests preventing Materializers from importing Harness or transport code;
- keep existing orchestration and storage behavior unchanged.

The dependency-direction gate guards two tiers. Materializer and Contract modules may reach neither Agent transport nor a Harness, a prompt, a Context assembler or a Run service. Producer adapters may read their Harness, because translating its result is their purpose, but may reach neither Agent transport nor a Run service. Both tiers follow runtime and type-only imports transitively, reject a computed import specifier that would hide its target, and assert that every guarded path exists and was analyzed so a rename cannot empty the guarded set. Synthetic fixtures prove the gate reports a direct Harness import, transport reached through a helper, a provider Session reached through a type-only import, and a computed specifier.

### Part 2a: Shared graph primitives and Product Exploration

- extract shared graph validation, local-reference resolution, Candidate staging, and formal promotion primitives;
- route the Product Exploration Agent flow through its module Materializer;
- retain the module's current operations and Candidate lifecycle;
- capture parity goldens from the existing path before the refactor and keep them as the regression suite.

### Part 2b: Scope Decomposition

- route the Scope Decomposition Agent flow through its module Materializer using the Part 2a primitives;
- retain propose, append, revise, recompose, and all recomposition invariants;
- remove duplicated identity allocation and Node-construction logic only after parity tests pass.

### Part 3: Domain Modeling

- extract the Domain Model Result Contract and frozen basis;
- adapt current Agent output to it;
- route `applyProposedDomainModel` through the producer-neutral service;
- preserve current model files and lifecycle.

### Part 4: Delivery Planning

- detach Delivery Map types and `materializeWhatToDoDeliveryMap` from the Harness result;
- separate map computation, artifact staging, canonical publication, and Planning Card synchronization;
- route existing Agent-driven create and adjust operations through the service;
- verify preservation of completed and unrelated Contracts.

Each Part should be independently reviewable and must leave the current UI and internal Agent flow usable. Do not begin MCP exposure in these Parts.

## Definition of done

The graph-result materialization boundary is complete when:

- every scoped module has a versioned producer-neutral Result Contract;
- every scoped module can validate and materialize a typed semantic result without launching an Agent;
- all current Agent flows use producer adapters and those same Materializers;
- no Materializer imports an Agent Harness, prompt, transport, or provider Session;
- Praxis exclusively owns formal identities, hashes, versions, storage paths, lifecycle state, layout, observability, and publication receipts;
- stale or invalid results cannot partially change visible state;
- existing accepted artifacts require no migration and remain behaviorally unchanged;
- tests demonstrate parity, identity preservation, relationship correctness, concurrency protection, and atomic failure handling;
- no MCP server, external tool schema, execution Card change, or new UI is included.

## Deferred follow-up

After this boundary is complete and proven through the existing internal Agent flows, a separate design can expose:

- versioned Result Contract templates as MCP Resources;
- preparation tools that return a bounded materialization basis;
- submission tools that accept producer-neutral semantic results;
- read-only project, module, Candidate, Latest Response, and Log resources;
- explicit acceptance tools that require clear user authorization.

That follow-up must call the services defined here. It must not write node folders, hashes, graph edges, Domain Model files, Delivery Map files, or Planning Cards itself.
