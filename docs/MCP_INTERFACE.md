# Praxis MCP Interface

Praxis serves a local MCP interface at `/api/mcp` so an external coding assistant can
read registered project state, module state and versioned Result Contracts without
Praxis launching a model. The assistant reasons in its own session; Praxis owns
deterministic publication and evidence.

This document records the settled interface. It is delivered in Parts. **This release
implements Part 1 (the endpoint, its connection boundary and the read surface), Part 2
(prepared operations and the Product Exploration submission slice), Part 3 (Scope
Decomposition), Part 4 (Domain Modeling and Delivery Planning), Part 5 (client
acceptance and these instructions), Part 6 (Candidate acceptance for Product
Exploration and Scope Decomposition) and Part 7 (Candidate discard for the same two
modules).** All four modules can now be prepared against and
submitted to. Agent dispatch and GitHub capability are not served here, and neither is
advertised.

## Served in this release

| Capability                                                                 | Status                     |
| -------------------------------------------------------------------------- | -------------------------- |
| Streamable HTTP endpoint at `/api/mcp`                                     | served                     |
| Loopback-only host and origin boundary, bearer credential                  | served                     |
| `praxis://capabilities`, `praxis://projects`                               | served                     |
| `praxis://projects/{projectId}/modules/{module}` and its `latest-response` | served                     |
| `praxis://projects/{projectId}/modules/{module}/instructions`              | served                     |
| `praxis://projects/{projectId}/artifacts/{artifactId}`                     | served                     |
| `praxis://contracts/{contractId}/{version}`                                | served                     |
| `praxis_list_projects`, `praxis_read_resource`                             | served                     |
| `praxis_prepare`, the four `praxis_submit_*` tools, operations and logs    | served                     |
| `praxis_accept_candidate` for Product Exploration and Scope Decomposition  | served                     |
| `praxis_discard_candidate` for the same two modules                        | served                     |
| `praxis_update_instructions` for all four modules                          | served                     |
| Formal Node deletion, Agent dispatch, GitHub delivery                      | not served, not advertised |

## Host and transport

The endpoint runs inside the existing local Praxis Node Host as an App Router route
handler ([app/api/mcp/route.ts](../app/api/mcp/route.ts)). It is not a separate
process and not a second writer. `lib/agents/claude/host-bridge.ts` is the outbound
Worker tool bridge and is unrelated to this inbound API.

Transport is MCP Streamable HTTP through the official TypeScript SDK, pinned at
`@modelcontextprotocol/sdk` 1.30.0, whose `LATEST_PROTOCOL_VERSION` is `2025-11-25` —
the interoperability baseline this interface targets. The route uses the SDK's
`WebStandardStreamableHTTPServerTransport`, which speaks Web `Request`/`Response`
directly, in stateless mode with JSON responses.

[lib/mcp/server.ts](../lib/mcp/server.ts) registers resources and tools through the
SDK's `McpServer`. `McpServer` accepts only a Zod schema, while Praxis authors tool
inputs and Result Contracts as JSON Schema, so
[lib/mcp/schema-adapter.ts](../lib/mcp/schema-adapter.ts) converts them once at
registration with Zod 4's `z.fromJSONSchema`. The four business contracts are not
rewritten in Zod, and the contract resources and hashes still come from
[lib/materialization/contract.ts](../lib/materialization/contract.ts).

## Schema adapter

`z.fromJSONSchema` is marked experimental upstream, so the pinned release matters and
its behaviour is measured rather than assumed. Zod is a direct dependency pinned at
exactly `4.5.4`; a test fails if that changes without the measurements being redone.

The adapter classifies every keyword before converting and **throws at registration**
for anything it has not classified, so a future contract keyword can never be widened
silently.

| Class      | Keywords                                                                                                                                                                       | Meaning                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Enforced   | `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `oneOf`, `pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems` | Converted and still enforced by the tool-level schema                                                 |
| Advisory   | `uniqueItems`                                                                                                                                                                  | Converted but **not** enforced at the tool layer; the Result Contract validator remains authoritative |
| Annotation | `$schema`, `title`, `description`                                                                                                                                              | Carry no constraint                                                                                   |

`uniqueItems` is the one measured gap, and the four contracts use it in 13 places. A
duplicated array entry passes the tool-level schema and is then refused by the contract's
own AJV validator with a precise pointer. `tests/mcp-schema-adapter.test.ts` pins both
halves of that boundary against the real Delivery Planning contract, so the gap cannot
widen unnoticed and cannot be mistaken for enforcement.

Genuinely unsupported constructs — `not`, `if`/`then`/`else`, `dependentRequired` —
make the conversion throw, which fails registration rather than serving a weaker tool.

The SDK advertises draft-07 and drops several constraints from the advertised schema
even where it still enforces them, and it rewrites `oneOf` as `anyOf`. Contract
resources therefore keep serving the original schema and hash; the advertised tool
schema is never presented as the contract.

## Installing in a client

The endpoint is `http://127.0.0.1:<actual-port>/api/mcp`. The port is whatever the
running Host uses; no port is hardcoded in tracked code.

### 1. Enable the endpoint and find it

```bash
praxis mcp enable
```

```bash
praxis mcp info
```

`praxis mcp info` prints the endpoint for every running managed instance and the path of
the credential file. It never prints the credential, and it does not start, restart or
modify a running project. Start the Host with the existing lifecycle command:

```bash
praxis start -d --port 3101
```

An offline Host produces an ordinary connection failure; start it rather than spawning a
competing writer. `enable`, `disable` and `rotate` are read on the next request, so a
Host that is already running picks them up without a restart.

### 2. Put the credential in the environment, not in a config file

Both clients below read the credential from `PRAXIS_MCP_TOKEN`, so it is never written
into client configuration. Read it from the `0600` file rather than pasting it, which
also keeps it out of shell history:

```bash
export PRAXIS_MCP_TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.praxis/mcp/credentials.json")))["token"])')"
```

Put that line in the shell profile the client inherits. A client started without the
variable fails with the endpoint's own `401` text, which names the credential file.

### 3. Codex

```bash
codex mcp add praxis --url http://127.0.0.1:3101/api/mcp --bearer-token-env-var PRAXIS_MCP_TOKEN
```

This writes an `[mcp_servers.praxis]` table to `~/.codex/config.toml` holding the URL and
the **name** of the environment variable. Adding a server rewrites that file through
Codex's own serializer, so unrelated entries may come back reordered. Check with
`codex mcp get praxis`, and remove it with `codex mcp remove praxis`.

### 4. Claude Code

```bash
claude mcp add --transport http praxis http://127.0.0.1:3101/api/mcp --header 'Authorization: Bearer ${PRAXIS_MCP_TOKEN}'
```

Keep the single quotes: `${PRAXIS_MCP_TOKEN}` is stored literally and expanded by Claude
Code when it connects, so `~/.claude.json` holds no credential. Add `-s user` for every
project on this machine rather than the current one. Check with `claude mcp list`, and
remove it with `claude mcp remove praxis`.

### 5. Disable and rotate

```bash
praxis mcp disable
```

```bash
praxis mcp rotate
```

`disable` denies new work immediately while an operation that is already publishing runs
to completion, and retains the credential so `praxis mcp enable` restores the same one.
`rotate` issues a new credential and the previous one stops working on the next request;
every configured client needs the new value. Both take effect without restarting the
Host.

### A first conversation

Ask the assistant to read before it writes. Preparation is what turns a request into an
operation; nothing is published until a submission tool is called.

> Read `praxis://projects` and tell me which projects are registered.

> Read the Delivery Planning module resource for that project, then prepare a
> `delivery-planning` operation that plans the accepted Feature it lists.

> Here is the Delivery Map I want. Submit it against the contract that operation returned.

The prepare result carries the Result Contract identity, the frozen Basis and the name of
the submission tool to call, so the assistant does not have to guess any of them. If the
project state moved while it was reasoning, the submission is refused as `STALE_BASIS`
and the operation stays preparable — read the module resource again and prepare a new one.

## Security boundary

Security here is a local connection boundary, not a per-operation approval workflow.

- **Disabled by default.** `praxis mcp enable` issues an installation-local 32-byte
  credential and writes `PRAXIS_HOME/mcp/credentials.json` with mode `0600`. Until
  then the endpoint answers `404` with the command that enables it. The credential is
  never in project Git, a URL, a receipt, a model-readable resource or a log. It is
  consumed by client configuration, read from that file by the person configuring the
  client — never passed to a model as a tool argument.
- **Loopback only.** Every request must carry a loopback `Host`
  (`localhost`, `127.0.0.1`, `[::1]`). `PRAXIS_ALLOWED_HOSTS` and
  `PRAXIS_ALLOWED_DEV_ORIGINS`, which widen the general UI boundary in
  [docs/REQUEST_BOUNDARY.md](REQUEST_BOUNDARY.md) for LAN and Tailscale access, do not
  widen this one. A LAN peer reaching a `--lan` Host is refused with `421`.
- **Origin.** A request carrying an `Origin` outside loopback is refused with `403`, so
  a page on another origin cannot drive the endpoint through the user's browser. The
  handler also runs the shared `guardRequest` from
  [lib/request-boundary.ts](../lib/request-boundary.ts) first, as every unsafe route
  does, so an `Origin` on a different local port is refused too: only a same-origin
  browser request is accepted.
- **Bearer on every request.** A missing, malformed or wrong credential is refused with
  `401` and `WWW-Authenticate: Bearer`, before any catalog read. Comparison is
  constant-time.

Checks run in that order — host, origin, enabled, credential — so a non-loopback peer
learns nothing about whether the endpoint is enabled.

```bash
praxis mcp rotate
```

Rotation issues a new credential and invalidates the previous one; update every
configured client and restart the Host.

```bash
praxis mcp disable
```

Disabling retains the credential and denies new work. It does not abort an operation
that is already publishing.

The Host that owns the endpoint is the Praxis Node process for that port, the one
`praxis status` reports. There is no second process and no stdio proxy in this release.

## Resource catalog

Resource URIs identify registered objects. They are not filesystem paths. No
`file://` URI, absolute path or `..` segment is accepted, and a URI carrying a query
string or fragment is refused.

| Resource URI                                                     | Content                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `praxis://capabilities`                                          | API version, protocol baseline, served modules and operations, tool names, limits, Result Contract identities, and the Host's owner-registry identity |
| `praxis://projects`                                              | Registered project summaries: id, name, kind, description, module links. No root path, code path, planning path or recursive source content           |
| `praxis://projects/{projectId}/modules/{module}`                 | Module revision, entity summaries with artifact links, layers where applicable, active operation summary, Latest Response reference                   |
| `praxis://projects/{projectId}/modules/{module}/latest-response` | The existing Latest Response projection, or `null` for a module that has produced no result                                                           |
| `praxis://projects/{projectId}/artifacts/{artifactId}`           | A registered planning document with its kind, content revision and MIME type                                                                          |
| `praxis://contracts/{contractId}/{version}`                      | The actual Result Contract schema, hash, compatible operations and one valid example                                                                  |

Public module names are `product-exploration`, `scope-decomposition`,
`domain-modeling` and `delivery-planning`. Discovery and Product Design are layers of
`product-exploration`, not independent modules: both share the `whats-next` Response
owner, so a UI Run and an MCP read see one owner. Existing internal names — the
`task-graph` module in Basis fingerprints, for one — stay internal and are not renamed
to match the public API.

| Public module         | Existing implementation                                               | Response owner       |
| --------------------- | --------------------------------------------------------------------- | -------------------- |
| `product-exploration` | [lib/modules/product-discovery](../lib/modules/product-discovery)     | `whats-next`         |
| `scope-decomposition` | [lib/modules/scope-decomposition](../lib/modules/scope-decomposition) | `task-decomposition` |
| `domain-modeling`     | [lib/modules/domain-modeling](../lib/modules/domain-modeling)         | `domain-model`       |
| `delivery-planning`   | [lib/modules/delivery-planning](../lib/modules/delivery-planning)     | `what-to-do`         |

Reads go through the existing project registry and document readers rather than a
second implementation: `listTaskGraphNodes`, `readDomainModelView`,
`readWhatToDoCurrentMapWithFingerprint` and `readLatestResponse`. One consequence is
inherited rather than introduced: `listTaskGraphNodes` repairs missing What's Next layer
and artifact-kind defaults while listing, exactly as it does for the UI. No MCP read
creates a graph entity, reserves an owner or writes a Latest Response.

### Artifacts

An artifact id is a handle issued by Praxis inside a project's published catalog. Its
security comes from resolution, not from secrecy: every read goes through
`resolvePlanningPath` in [lib/planning-paths.ts](../lib/planning-paths.ts) with the
`TASK_GRAPH_MARKDOWN_SHAPES` allowlist, so a handle can only ever reach a document that
allowlist already publishes, inside that project's planning root. A file that exists but
matches no shape is refused with `RESOURCE_NOT_FOUND`, as is any handle decoding to an
absolute path or a `..` segment. Reference code outside the project is the client's own
concern in this release; Praxis does not serve an unrestricted read capability.

### Bounds

Lists page at 50 items by default and 100 at most. Content reads page at 32 KiB by
default and 128 KiB at most. Every truncation returns a continuation cursor, so no
evidence is silently dropped. A content cursor is bound to the revision it was issued
for: if the document changed, continuing returns `RESOURCE_CHANGED` rather than
splicing a new revision into an old page. Page boundaries land on UTF-8 character
boundaries, so a multi-byte character is never split across pages.

## Tools

Every tool rejects unknown structural fields and exports JSON Schema rather than prose.
The two read tools are annotated read-only and are thin access to the same catalog the
resources use; there is no second reader implementation.

### `praxis_list_projects`

Input `{ cursor?, limit? }`. Output: project summaries and `nextCursor`. No model call,
no Git fetch, no project creation.

### `praxis_read_resource`

Input `{ uri, cursor?, limitBytes? }`. Output: MIME type, bounded content, revision and
next cursor. `limitBytes` controls pagination, not which documents are reachable.

### `praxis_prepare`

Input `{ projectId, module, request }`. `request` is a discriminated per-module shape,
not a bag of options. Beyond the required `userInput`, each module reads:

| Module                | Request fields                                                                                 | Operations                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `product-exploration` | required `layer`; optional `intention`, `motion`, `sourceNodeIds`, `operation`, `candidateIds` | `explore`, `refine-candidate`                                              |
| `scope-decomposition` | required `sourceNodeId`; optional `operation`, `candidateIds`                                  | `propose`, `append-candidates`, `revise-candidate`, `recompose-candidates` |
| `domain-modeling`     | optional `selectionIds`, `contextIds`                                                          | `change-model`                                                             |
| `delivery-planning`   | optional `sourceUids`, `selectionIds`, `contextIds`                                            | `create-map`, `adjust-map`                                                 |

Preparation freezes the module Basis, the User Input and the source documents the result
may cite, then returns the operation identity, the Result Contract to write against and
the submission tool to call. It starts no Agent Run and calls no model.

Product Exploration defaults to `explore`. `refine-candidate` names exactly one open
Candidate in `candidateIds` and revises it in place instead of appending a near-duplicate.
Preparation resolves that Candidate's current revision, stable identity and revision
source **server-side** from the module's own pending state; no client-supplied Basis or
prior-Candidate body is trusted, and nothing outside `pendingCandidates` has to be read to
name a target. An accepted Candidate is refused — it is a formal Node, and editing a
Node's body is `praxis_update_node_document`, a different operation.

The prepared operation carries a `refine` block with `candidateId`, the current
`revision`, the `requiredRevision` to return, and a `nextStep` saying that republishing a
Candidate is not accepting it. It also carries the frozen Candidate the refinement is
validated against: `revisionSource` holds every field the result must echo back —
`type`, `derivedFrom`, `dependsOn`, `layer`, `artifactKind`, `resources`,
`typeTemplateRef`, `metadata`, `presentation` and `assumptions` — and `documentUri` points
at the current body as a bounded, paged artifact read rather than inlining up to 100,000
characters. A client that has never seen the original submission can therefore build a
valid refinement from `praxis_prepare` and `praxis_read_resource` alone, with no memory of
its own earlier call and no private Run file. The same frozen Candidate is readable again
from the operation resource. Submission runs the
module's existing refine rules unchanged: exactly the requested `localKey`, and type,
origins, dependencies, layer, artifact kind, Resources, type template, metadata and
presentation returned unchanged — a widened Candidate is refused as `INVALID_RESULT`.
Because the Candidate's revision is part of the frozen Basis, a refine prepared against a
revision that has since advanced is refused as `STALE_BASIS` rather than overwriting the
newer body, and unrelated Candidates keep their revisions and documents.

Delivery Planning chooses `create-map` when no Delivery Map exists and `adjust-map`
otherwise. `sourceUids` name accepted Product Design Features to plan from; at least one
is required for a first Map, and preparation names the available uids when the field is
missing rather than guessing. `selectionIds` name Contracts in the current Map to focus
on — focus, not permission to discard the rest. A Feature already carried by the current
Map is refused rather than planned twice.

### The four `praxis_submit_*` tools

Input `{ operationId, contract, result }`, where `contract` restates the Result Contract
identity the result was written against. Each publishes through its module's existing
canonical publication; none accepts a Candidate, merges a pull request or marks a
Contract delivered.

A submission is admitted once. An exact retry of an admitted operation replays its
settled outcome without republishing; a different result for the same operation is
refused as `SUBMISSION_CONFLICT`. Freshness is checked at submission, not by a timer: if
the module state or a frozen source document changed after preparation, the submission is
refused as `STALE_BASIS` and the operation stays preparable.

`praxis_submit_delivery_map` publishes through `submitDeliveryMapResult` with the
existing `deliveryPublicationHost`, so a new Map still cannot replace a Contract whose
delivery work has started.

### `praxis_accept_candidate`

Input `{ projectId, module, runId, candidateId, expectedRevision }`. It promotes one
pending Candidate into a formal graph Node through the same service the existing UI
acceptance route calls — `acceptProductExplorationCandidate` and
`acceptScopeDecompositionCandidate`, which `lib/modules/product-discovery/runs.ts` and
`lib/modules/scope-decomposition/runs.ts` re-export under their original names. Only
`product-exploration` and `scope-decomposition` are served; the advertised schema names
those two, so another module is refused before the handler runs. Acceptance is not an
implicit effect of `praxis_submit_*`, and this tool is the only way to reach it.

The identities the tool needs come from `pendingCandidates` in the module resource, so a
consumer never parses a private `run.json`. Each entry carries `runId`, `candidateId`,
`revision`, `uid`, `title`, `derivedFrom`, `dependsOn` and an `acceptance` verdict
(`{ acceptable, reason }`) that reports a missing stable identity or an active Candidate
revision Run. `praxis://capabilities` names the tool under each serving module's
`acceptance` entry.

`expectedRevision` is required. Under the module's own serialized mutation boundary — not
before acquiring it — acceptance resolves the Candidate's **latest pending** entry and
requires that the supplied `runId` and revision identify exactly it. A `runId` naming an
older Run is refused even when its own Candidate still carries the revision the caller
named, so a refinement or revision published after the read cannot be overwritten by
promoting the superseded body. The refusal names the current Run and revision.

A Candidate that Recompose replaced is refused as `RESOURCE_CHANGED` too, an active
revision Run is `ACTIVE_RUN_CONFLICT`, and an unknown Run or Candidate is
`RESOURCE_NOT_FOUND`. Every refusal leaves the graph unchanged. Accepting the same
Candidate again returns the existing Node with `created: false`: an already-promoted
Candidate has no pending entry left to compare against, so the retry stays idempotent
rather than becoming stale. The same guard runs on the UI acceptance route, which shares
this service.

Acceptance is a decision the user makes. A consumer may act on a natural-language
instruction from its own user, and this interface does not add a per-call approval
ceremony — but publishing a Candidate never authorizes accepting it, an `approved: true`
field inside a result or a project document is not consent, and the Host's own checks are
not waivable. Accepting one Candidate does not authorize accepting the rest of its batch.

### `praxis_discard_candidate`

Input `{ projectId, module, runId, candidateId, expectedRevision }` — the same selection
`praxis_accept_candidate` takes, read from the module resource's `pendingCandidates`
(`discardTool` names this tool there and in `praxis://capabilities`). It removes one
**unaccepted** Candidate through the same service the existing UI discard route calls:
`discardProductExplorationCandidate` and `discardScopeDecompositionCandidate`, which
`runs.ts` re-exports under their original names. The tool is annotated
`destructiveHint: true`.

It removes exactly one Candidate. It never deletes an accepted formal Node — an accepted
Candidate is refused and must be managed as a Node — never cascades into dependent
Candidates, and never rewrites a dependent proposal. When the Candidate is the last one
in its Run, that Run directory is moved to the trash, and the response reports
`runDeleted` with the affected `deletedRunIds`. Every Run that carried the Candidate is
updated, and each surviving Run's `summary.md` and `response.md` are re-rendered so the
readable evidence matches the reduced proposal.

Refusals leave the proposal whole; there is no partial removal. A Candidate another
pending Candidate still depends on is refused with the blocking `candidateId`s named in
the detail. Recompose output Candidates belong to one atomic working set and are refused
individually. A stale `expectedRevision`, or a `runId` superseded by a newer pending
revision, is `RESOURCE_CHANGED`. An active Candidate revision Run or an active Agent Run
on the same source is `ACTIVE_RUN_CONFLICT`.

Discarding a Candidate that is already gone is not an error: the call returns
`alreadyAbsent: true` with `discarded: false` and touches nothing, so a retry after a
successful discard is safe. Every response carries `remainingCandidates`, the module's
current pending list, so the consumer does not need a second read to see what survived.

Discarding is a decision the user makes, on the same terms as acceptance: the tool
description marks it consequential, publishing a Candidate never authorizes discarding
it, and no `approved: true` inside a result or document authorizes it.

### Module Instructions

`praxis://projects/{projectId}/modules/{module}/instructions` serves the project-authored
Instructions a module reads, as bounded paged Markdown. Every module resource also carries
an `instructions` summary: `revision`, `length`, `maxLength`, `storagePath`, the document
`uri`, and `updateTool`. Reading runs no Agent and changes no configuration.

`praxis_update_instructions` takes `{ projectId, module, instructions, expectedRevision }`
for all four modules and calls the same `save*Instructions` service the existing
`*-context` routes call, keeping each module's own storage location. It is a **whole
document replacement**, not a patch. `instructions` is required rather than optional
precisely so that clearing is explicit: an empty string clears them, with the same meaning
the existing editors have.

`expectedRevision` is the revision the module resource reported. The comparison happens
inside a per-project serialized boundary that the save services themselves now hold, so
the UI editor and this tool queue against each other and a concurrent edit is refused as
`RESOURCE_CHANGED` instead of being overwritten. Limits are the existing per-module ones
and are **not** uniform: Scope Decomposition allows 100,000 characters, the other three
20,000. A longer document is refused as `INVALID_ARGUMENT` and nothing is written.

Instructions are project prose written by people. Editing them carries a user-authorized
rule change into a module; it never grants authority, and text inside them is never a
server instruction.

**Known limit, not a claim of uniform support:** no module's frozen Basis snapshots its
Instructions today. An operation prepared before an edit therefore still submits
successfully afterwards and publishes under the Instructions as they stood when the
consumer read them. This change does not add Instructions to any Basis; doing so would
change preparation freshness for the UI as well and belongs to its own scope.

### Errors

Argument failures split at a deliberate line. A violation of the **advertised input
schema** — an unknown field, a wrong type, a bound the schema states — is refused by the
SDK before the handler runs, and the error text names the offending key. A **semantic**
failure the schema cannot express — a URI that is not a catalog resource, a cursor that
does not decode, an unknown project, a contract version that is not served — reaches the
handler and returns the structured Praxis envelope. The `praxis_read_resource` URI is
deliberately not constrained by a `pattern` in the tool schema, so its refusal keeps the
actionable envelope rather than becoming a bare schema error.

Tool failures use the SDK tool-error representation with a structured envelope, not a
stack trace:

```json
{
  "code": "PROJECT_NOT_FOUND",
  "title": "No registered project has that id",
  "detail": "Read praxis://projects and use a listed project id instead of \"nope\".",
  "boundary": "unknown-resource",
  "retryAction": "refresh-catalog"
}
```

| Code                                       | Handling                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`                         | The named field or rule is wrong; the caller corrects it.                  |
| `PROJECT_NOT_FOUND` / `RESOURCE_NOT_FOUND` | Refresh the catalog; do not guess a filesystem path.                       |
| `CONTRACT_MISMATCH`                        | Reload the contract at the served version; no version is coerced silently. |
| `RESOURCE_CHANGED`                         | The document changed mid-read; read it again from the start.               |
| `HOST_UNAVAILABLE`                         | Reconnect or start the existing Host; do not spawn a competing writer.     |

| `INVALID_RESULT` | The result failed its Result Contract validator; the message names the rule. The operation stays `prepared`. |
| `STALE_BASIS` | Module state changed after preparation; read again and prepare a new operation. |
| `ACTIVE_RUN_CONFLICT` | A UI Run owns the module. Retry after it ends; nothing was published and the operation stays preparable. |
| `SUBMISSION_CONFLICT` | This operation was admitted with a different result. Inspect it and prepare a new operation. |
| `PUBLICATION_FAILED` | The publication failed; the operation records the boundary and known effects. |

## One Host, one owner registry

Module ownership lives in `globalThis.__praxisActiveRuns`
([lib/execution-observability/active-runs.ts](../lib/execution-observability/active-runs.ts)).
A second Praxis process, or a second bundled copy of that module, would split the
`WeakMap`-backed handle and release state that `beginRun` and `releaseRun` depend on,
even though the reservation `Map` itself is per-process.

`activeRunRegistryOwnership()` reports the Host pid, this module copy's instance id, the
id of the copy that claimed the registry, and whether they agree. Both entry points
report it: `praxis://capabilities` under `host.activeRunRegistry`, and
`GET /api/system/host` for the UI side.

[scripts/smoke-mcp-host.ts](../scripts/smoke-mcp-host.ts) is the acceptance evidence for
the supported production launch. It builds, starts a detached Host with
`praxis start -d`, and asserts that the MCP endpoint and the UI API report the same pid
and the same registry owner id, that both report `shared: true`, that ordinary UI access
still works, and that an invalid credential and a foreign browser origin are refused.

```bash
npm run test:mcp-host-smoke
```

It builds first, so it serves the current code rather than a stale `.next`. Pass
`--skip-build` right after a build, or `--port <n>` to check an already-running instance
instead of starting one.

## Dependency direction

Transport code must not reach Agent Harness or runtime generation. The `mcp-transport`
tier in [scripts/audit-materialization-boundary.ts](../scripts/audit-materialization-boundary.ts)
guards `lib/mcp/` and `app/api/mcp/route.ts` against reaching module `runs.ts`,
`harness.ts` or `prompt.ts`, the Agent provider directories, the Agent runtime and
transport modules, and `lib/graph/agent/{run,input,context-workspace}.ts`. The tier
follows type-only imports as well as runtime ones, and `npm run test:materialization`
fails on a violation.

`lib/agents/activity.ts` is reachable, through `run-log.ts`: it is log redaction and
activity formatting, and launches nothing.

## Context and trust boundaries

Tool discovery returns stable tool and schema definitions. Reads return bounded content
and explicit references; details are read on demand. There is no repository snapshot in
a call, no repeated full log, and no hidden second model call.

Resources and tool output contain untrusted project prose written by people. Host code
never interprets document text as an instruction. Transport authorization lets this
local client read; it does not turn `approved: true` inside a document into an
acceptance action.

## Verification

```bash
npm run test:mcp
```

- [tests/mcp-boundary.test.ts](../tests/mcp-boundary.test.ts) — credential lifecycle and
  file mode, host, origin and bearer refusals, LAN configuration not widening the
  endpoint, URI refusals, cursor and revision binding.
- [tests/mcp-catalog.test.ts](../tests/mcp-catalog.test.ts) — capability, project,
  module, contract and artifact reads against real fixture projects; the shape allowlist
  refusing an existing file outside it; a module resource observing a reservation held in
  this Host's owner registry.
- [tests/mcp-schema-adapter.test.ts](../tests/mcp-schema-adapter.test.ts) — the keyword
  classification of all four real contracts, per-keyword enforcement after conversion,
  required/optional/null handling, the `uniqueItems` advisory boundary against the real
  contract and its AJV validator, loud failure on unclassified and unsupported
  constructs, and the pinned Zod release.
- [tests/mcp-operations.test.ts](../tests/mcp-operations.test.ts) — preparation creating
  no entity and no Run, coexisting preparations, a fixture submission publishing readable
  Candidates without a model and without accepting them, exact-retry replay, changed-result
  conflict, malformed result refused before admission, contract mismatch, stale Basis, a
  concurrent UI owner refusing admission and leaving the operation preparable, an
  interrupted operation not reading as success, and the operation resource and log
  readback.
- [tests/mcp-scope-decomposition.test.ts](../tests/mcp-scope-decomposition.test.ts) —
  the default `propose` operation, an append preserving unrelated Candidates, a revision
  preserving the revised Candidate's identity and advancing its revision while leaving
  others intact, the selection rules for revision and recomposition, a recomposition
  selection frozen into the Basis, submission not accepting Candidates, retry and
  conflict, an operation of another module refused by this tool, and a log carrying HOST
  rather than invented Agent activity.
- [tests/mcp-canonical-modules.test.ts](../tests/mcp-canonical-modules.test.ts) — Domain
  Modeling preparing against the current state version, publishing through the canonical
  service, a conflict surfacing as `STALE_BASIS` rather than a publication failure, a
  vanished selection refused at preparation, an exact retry replaying without advancing
  the state version, a changed result conflicting, and another module's tool refusing the
  operation.
- [tests/mcp-delivery-planning.test.ts](../tests/mcp-delivery-planning.test.ts) —
  Delivery Planning preparing as `create-map` or `adjust-map` from the current Map,
  naming the Features a first Map could use when none is given, refusing a Feature the
  Map already carries and a focus Contract it no longer has, freezing the Feature
  document and the User Input it was written against, publishing through the canonical
  service, an exact retry replaying without a second publication, a changed result
  conflicting, a Feature edited after preparation refused as `STALE_BASIS` with the
  operation left preparable, evidence removed after preparation refused the same way,
  an adjustment retaining its published Contract, recovery
  from the committed receipt and from the committed Map when the receipt is gone, and an
  uncommitted operation staying unsettled.
- [tests/mcp-candidate-acceptance.test.ts](../tests/mcp-candidate-acceptance.test.ts) —
  a real SDK client over HTTP reading a pending Candidate from the module resource,
  accepting it, discovering the formal Node and its artifacts through public resources,
  a stale `expectedRevision` refused with every Node unchanged, a repeated acceptance
  returning the same Node rather than a duplicate, an unknown Candidate and an unserved
  module refused, Scope Decomposition accepted through the same tool, the existing UI
  PATCH route promoting through the same exported service, and — for both modules — a
  Candidate published as revision 1 then revised to revision 2 in a second Run, where
  accepting the original Run with its own revision 1 is refused, no formal Node is
  promoted, and the current Run promotes the revised body.
- [tests/mcp-candidate-discard.test.ts](../tests/mcp-candidate-discard.test.ts) — a real
  SDK client over HTTP discarding one Candidate while its sibling and the sibling's
  document survive on disk, a repeat reporting `alreadyAbsent` without touching anything,
  a referenced Candidate refused with the dependent named and every Candidate still in
  place, a stale `expectedRevision` refused, an accepted Candidate refused with its
  formal Node intact, the last Candidate in a Run taking its Run with it, and the
  existing UI PATCH discard route using the same exported service.
- [tests/mcp-product-refinement.test.ts](../tests/mcp-product-refinement.test.ts) — a
  real SDK client exploring two Candidates then refining one through
  `operation: refine-candidate`, building the result **only** from the prepared
  `revisionSource` and a `praxis_read_resource` of `documentUri` rather than from its own
  fixture, against a Candidate carrying non-empty Resources, type template, metadata,
  presentation and assumptions; keeping its uid while advancing its revision and leaving
  the sibling byte-identical; a widened Candidate refused with the module's own refine
  rule and the published revision intact; unknown, accepted, missing and ambiguous
  targets refused at preparation; a refine prepared against a superseded revision refused
  as `STALE_BASIS` without advancing the revision twice; and `praxis://capabilities`
  advertising `refine-candidate` as served.
- [tests/mcp-module-instructions.test.ts](../tests/mcp-module-instructions.test.ts) — a
  real SDK client reading, replacing and clearing Instructions for all four modules and
  confirming each value through that module's own existing application reader; a stale
  `expectedRevision` refused as `RESOURCE_CHANGED` without overwriting the concurrent
  edit, with the other three modules untouched; an unserved module and an over-long
  document refused with nothing written; the advertised per-module limits differing where
  the services differ; and a prepared operation still submitting after an edit, which is
  the documented Basis limit rather than a uniform-support claim.
- [tests/mcp-transport.test.ts](../tests/mcp-transport.test.ts) — a real SDK client over
  HTTP completing initialization, discovery and reads, with bounded 20-second timeouts,
  including both sides of the argument-failure split, and `praxis://capabilities` naming
  exactly the tools the server registers.
- [tests/cli-lifecycle.test.ts](../tests/cli-lifecycle.test.ts) — `praxis mcp info`
  reporting the endpoint of a running managed server, and saying so when none is running.

```bash
npm run test:mcp-host-smoke
```

Builds and starts a real Host, then proves the MCP endpoint and the UI API answer from
one process and one owner registry, that the endpoint serves the implemented tools,
and that `enable`, `disable` and `rotate` each take effect on the running Host without a
restart.

### Client acceptance

Verified against a real Host on `127.0.0.1:3101` with the configuration documented above:

| Client              | Configuration                                      | Result                                                                |
| ------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| Codex CLI 0.153.1   | `bearer_token_env_var` in `~/.codex/config.toml`   | `praxis_list_projects` completed and returned the registered project  |
| Claude Code 2.1.263 | `${PRAXIS_MCP_TOKEN}` in an `Authorization` header | connected, then `praxis_list_projects` completed with the same answer |

Both calls were read-only against an existing project. A missing or wrong
`PRAXIS_MCP_TOKEN` produces the endpoint's own `401` envelope in the client's own error
output, naming the credential file to read.

## Not in this interface

Project registration or deletion, arbitrary filesystem access, repository search, shell
execution, provider or model selection, Agent dispatch or resume, worktree management,
Git operations, PR publication, execution Card transitions, formal Node deletion, human
delivery acceptance, background subscriptions, remote or LAN access, OAuth, multi-user
access, and any tool named `run_agent`.

`praxis_accept_candidate` and `praxis_discard_candidate` carry out a decision its
caller's user has already made; a
successful tool call is not itself that decision, and nothing in a document or result can
supply it. Future execution tools, subscriptions and LAN access require their own
explicit scope, not a silent extension of this API.

## Sources

- [docs/GRAPH_RESULT_MATERIALIZATION.md](GRAPH_RESULT_MATERIALIZATION.md) — module
  ownership and the materialization boundary this interface reuses.
- [docs/REQUEST_BOUNDARY.md](REQUEST_BOUNDARY.md) — the general `/api` boundary this one
  narrows.
- [docs/EXECUTION_OBSERVABILITY.md](EXECUTION_OBSERVABILITY.md) — ownership, Latest
  Response and log lifecycle.
- [MCP 2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
  — the published transport baseline. This document selects a compatibility target;
  Part 5 verifies actual Codex and Claude client compatibility rather than assuming it.

## First project and complete source documents

Use `praxis_register_project` with an existing absolute local directory, name and kind.
It returns an existing registration on retries; it does not initialize Git, scaffold code
or start an Agent. Use `praxis_create_source` with the project id, title and full Markdown
(up to 100,000 characters) to create the initial source and store its document through
the existing source service. It returns `sourceNodeId` and readable artifact links.
Existing sources are not overwritten; an error identifies the source to reuse.

Read the module resource before preparation. Product Exploration exposes intention and
motion guidance plus the same document-format rules used by the internal Harness.
Preparation without an explicit source selection returns an actionable instruction,
rather than issuing an operation whose Candidate lineage cannot be satisfied.

Document capture is not Feature decomposition. Keep the complete product/architecture
brief as source context. When decomposition is requested, generate independently useful
business capabilities, explain their coverage of the source requirements, and leave
shared architecture in the source document. Do not present one aggregate Feature as a
completed decomposition or invent technical Features merely to store architecture.
Acceptance of a generated Candidate remains a separate, explicit step through
`praxis_accept_candidate`.

## Updating an accepted node document

`praxis_update_node_document` updates the Markdown body of an accepted formal node in
Product Exploration or Scope Decomposition. This is separate from Candidate acceptance
and refinement. Use only for a user-requested content edit; it does not accept anything,
change relationships or mark delivery work complete.

Read the node's output artifact using `praxis_read_resource`, then submit `projectId`,
`module`, `nodeId`, `expectedRevision` (the returned document hash), and the complete new
`markdown`. Keep the existing title as the first heading. The body allows 100,000
characters. Title, card summary, metadata and graph structure are intentionally outside
this operation, so the node JSON and original acceptance provenance remain unchanged.

The update checks the current body under the existing canvas lock and atomically replaces
only output.md. A stale edit returns RESOURCE_CHANGED without overwriting another edit;
resending the already-current body returns changed:false. Prior content is preserved in
the node's document-history/<previous-hash>.md before replacing the live body. A failed
history write cannot publish the new body. No node is deleted or recreated.

The response returns the new content revision, resource URI and Host log URL. Frozen
operation snapshots and original Candidate documents remain immutable. Existing delivery
source fingerprints include document contents and therefore change naturally; this tool
does not rewrite historical delivery records or claim their previous checks apply to the
new content. Review or refresh downstream work through its existing flow when needed.

This is not a source/attachment editor, arbitrary path writer, bulk replacement operation,
or a tool to update all related nodes implicitly. The caller must choose each node and
read its current document before editing. A secondary log-finalization failure after the
atomic document commit is reported as a warning with the committed revision, not as a
claim that the content was rolled back.

## Updating an existing source (task 03)

`praxis_read_source` takes projectId, module (`product-exploration` or
`scope-decomposition`) and nodeId. It returns the source title, revision and its current
resource paths/URIs. The revision binds source metadata and resource contents.

`praxis_update_source` takes those identities plus expectedRevision. Optional title and
idea update those fields; omission preserves them. An idea must be nonempty; clearing
ideas is not exposed by this operation. Existing Context Library links are retained.

`attachments` adds Markdown documents with fileName and markdown. To replace an existing
attachment, set its `replaces` to the existing path returned by read_source. Only paths
explicitly named in `removeAttachmentRefs` or `replaces` leave the current attachment
list. Other attachments remain untouched. No arbitrary filesystem read or write path is
accepted. Documents may contain up to 100,000 characters each.

The adapter delegates to updateStartNode and checks expectedRevision inside its canvas
lock. Source IDs and graph relations stay intact; a stale request fails without applying.
After a timeout or conflict, read the source again rather than blindly retrying uploads.
No new root or Candidate is created, and this tool does not edit accepted-node bodies.

Replaced/removed files remain as historical source evidence so prior node references
remain readable; they are detached from the current source list, not overwritten.
Previously prepared operation snapshots stay immutable. A new preparation sees the new
source set, while an operation prepared before the edit follows existing stale-Basis
checks. Ordinary UI callers retain their existing cleanup behavior unless they opt into
preserving prior documents.

Validation includes SDK read/update/readback, exact node identity, attachment retention,
explicit removal, source-only target selection, stale/concurrent edits and frozen evidence.

## Deleting a formal graph node (task 04)

Call `praxis_inspect_node_deletion` with projectId, module and nodeId to obtain the
current deletion revision, canDelete and blockerNodeIds. This is a read, not consent or
a reserved operation. Only accepted formal nodes in Product Exploration and Scope
Decomposition are eligible; source nodes and unaccepted Candidates remain separate.

For a user-requested deletion, call `praxis_delete_node` with those identities and
expectedRevision. The existing deletion service rechecks the node content/metadata
version and incoming dependency/lineage references under the module mutation queue and
canvas lock. A stale version or new dependent refuses deletion; no edges are rewired and
no related nodes are removed. The normal UI route shares the same deletion service.

Deletion uses the existing OS Trash mechanism. The response identifies whether the node
was deleted or was already absent, with a module readback link and Host log URL. A missing
target is not claimed to have been deleted. No project, worktree, execution record or
frozen operation snapshot is removed. The original Candidate is not discarded and may
become pending again; use the separately authorized Candidate discard operation if that
is also intended. This tool does not silently combine the two decisions.

The inspect revision binds the node metadata and resource contents. Publication does not
perform a fallible graph reread after Trash succeeds; it returns the already-locked
remaining set. A subsequent logging failure is reported with the completed result rather
than claiming the deletion rolled back.

## Discovery and graph coverage

Use `praxis_list_context` for paged current Product Context documents and `praxis_list_candidates` for paged pending Candidate identities/body URIs. These are existing-state catalogs, not keyword search. See [MCP discovery and graph-operation coverage](MCP_DISCOVERY.md) for the route/service matrix, Scope split/retain/merge examples, contextIds module boundaries, UTF-8 pagination and client refresh limitations.
