# Praxis MCP Interface

Praxis serves a local MCP interface at `/api/mcp` so an external coding assistant can
read registered project state, module state and versioned Result Contracts without
Praxis launching a model. The assistant reasons in its own session; Praxis owns
deterministic publication and evidence.

This document records the settled interface. It is delivered in Parts. **This release
implements Part 1: the endpoint, its connection boundary, and the read surface.** No
preparation, submission, acceptance, Agent dispatch or GitHub capability is served
here, and none is advertised.

## Served in this release

| Capability                                                                 | Status                     |
| -------------------------------------------------------------------------- | -------------------------- |
| Streamable HTTP endpoint at `/api/mcp`                                     | served                     |
| Loopback-only host and origin boundary, bearer credential                  | served                     |
| `praxis://capabilities`, `praxis://projects`                               | served                     |
| `praxis://projects/{projectId}/modules/{module}` and its `latest-response` | served                     |
| `praxis://projects/{projectId}/artifacts/{artifactId}`                     | served                     |
| `praxis://contracts/{contractId}/{version}`                                | served                     |
| `praxis_list_projects`, `praxis_read_resource`                             | served                     |
| `praxis_prepare`, the four `praxis_submit_*` tools, operations and logs    | not served, not advertised |

`praxis://capabilities` reports `preparationOperations: []` and `submissionTool: null`
for every module. A client must not infer a write path from the planned fields beside
them.

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

### Connecting### Connecting

The endpoint is `http://127.0.0.1:<actual-port>/api/mcp`. The port is whatever the
running Host uses; no port is hardcoded in tracked code.

```bash
praxis mcp enable
```

```bash
praxis mcp info
```

`praxis mcp info` prints the endpoint for each managed background instance and the path
of the credential file. It never prints the credential, and it does not start, restart
or modify a running project. Start the Host with the existing lifecycle command:

```bash
praxis start -d --port 3101
```

An offline Host produces an ordinary connection failure; start it rather than spawning
a competing writer.

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

Both tools are annotated read-only, reject unknown structural fields, and export JSON
Schema rather than prose. They are thin access to the same catalog the resources use;
there is no second reader implementation.

### `praxis_list_projects`

Input `{ cursor?, limit? }`. Output: project summaries and `nextCursor`. No model call,
no Git fetch, no project creation.

### `praxis_read_resource`

Input `{ uri, cursor?, limitBytes? }`. Output: MIME type, bounded content, revision and
next cursor. `limitBytes` controls pagination, not which documents are reachable.

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

`STALE_BASIS`, `ACTIVE_RUN_CONFLICT`, `SUBMISSION_CONFLICT` and `PUBLICATION_FAILED`
belong to the write path and arrive with it.

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
- [tests/mcp-transport.test.ts](../tests/mcp-transport.test.ts) — a real SDK client over
  HTTP completing initialization, discovery and reads, with bounded 20-second timeouts,
  including both sides of the argument-failure split.

## Not in this interface

Project registration or deletion, arbitrary filesystem access, repository search, shell
execution, provider or model selection, Agent dispatch or resume, worktree management,
Git operations, PR publication, execution Card transitions, Candidate acceptance or
rejection, human delivery acceptance, background subscriptions, remote or LAN access,
OAuth, multi-user access, and any tool named `run_agent`.

Users accept published Candidates through the existing UI. A successful tool call is
not human acceptance. Future execution tools, acceptance tools, subscriptions and LAN
access require their own explicit scope, not a silent extension of this API.

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
