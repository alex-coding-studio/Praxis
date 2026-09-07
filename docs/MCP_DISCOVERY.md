# MCP discovery and graph-operation coverage

Task 07 builds on main through #253. It exposes existing catalog operations, not a database index or new graph mutation model. Module instruction editing is separate task 06; reconcile its actual callable names after that PR merges. Search and assembled item context are separate Context Provider work.

## Consumer entry points

1. Fetch `tools/list` for current invocation schemas and read `praxis://capabilities` for supported workflows and limits. Schemas, instructions and examples should be sufficient without inspecting Praxis source.
2. Use `praxis_list_projects` and follow a project's module URI for graph state and source-node identities.
3. Use `praxis_list_candidates({projectId, module, limit?, cursor?})` for current pending proposals. Each item includes `runId`, `candidateId`, `revision`, stable UID, meaning, relations, eligibility, `artifactId` and `documentUri`. The two supported modules are Product Exploration and Scope Decomposition. This list excludes accepted, discarded and superseded Candidates according to the existing module services.
4. Use `praxis_list_context({projectId, section?, limit?, cursor?})` for the existing Product Context library. It returns sections represented on the current page plus document summaries, `artifactId`, `uri` and content revision. Summary previews are limited to 1,024 UTF-8 bytes (without splitting encoded characters) and marked with summaryTruncated; read the URI for complete evidence. It is not a recursive repository browser or keyword search. Reuse returned section IDs; do not invent paths.
5. Read the returned URI with `praxis_read_resource`. Pass a context document's `artifactId` to Domain Modeling or Delivery Planning `request.contextIds`. Product Exploration and Scope currently freeze their selected node resources instead; the existence of `contextIds` in a shared schema does not mean every module consumes it.

Both new lists default to 50 entries, maximum 100. Follow `nextCursor` until null. Cursors are bound to the project, collection/filter and current listing revision. Restart after `RESOURCE_CHANGED`; do not combine old and new pages. Context listing reuses the application's current Product Context catalog, including its existing derived-delivery-document materialization. It does not launch an Agent or perform user acceptance. It reads the existing catalog before paging; this is bounded output, not yet index-backed or constant-cost enumeration.

The context catalog selects current accepted/formal graph outputs, applied Domain Model summaries, current Delivery Contracts, eligible implementation/delivery artifacts and manual context documents according to the existing service. Pending Candidate bodies have their separate list. Other historical artifacts may remain exactly readable, but are not advertised as current context. Path shapes and planning-root confinement are still enforced by the existing readers.

## Read pages are not document size limits

Product Exploration output accepts up to 100,000 characters. `praxis_read_resource.limitBytes` is an independent UTF-8 page limit: default 32,768 and maximum 131,072 bytes. Multibyte characters mean these numbers are not interchangeable. Use returned `nextCursor` on the **same URI**, append each page's `text`, and parse JSON only after all pages are collected. The revision-bound cursor refuses to splice a changed document into an earlier read.

The observed consumer used 200,000 bytes, received validation feedback, corrected it to 131,072 and succeeded. That was a caller parameter error, not a failed body update, and does not justify increasing the page limit.

## Discovery after deployment

The HTTP route constructs a server per request and closes it afterward (`app/api/mcp/route.ts`). Therefore an explicit `tools/list` reaches the deployed registrations; the Host does not retain an old per-client tool list. A desktop client may separately cache its model-visible schema inventory. Refresh discovery or reconnect/reload that client when a tool is missing. Do not claim server-pushed tool refresh on this stateless transport.

The recorded MoMERP consumer read source and authentication/route code, then wrote a script calling official `tools/list` and `tools/call`. The script still used MCP. Its log does not establish whether cached native discovery, poor descriptions or a deliberate batching choice caused the detour. This change supplies the missing catalog handles and clearer descriptions. SDK tests prove public discovery and invocation, not automatic schema refresh inside an already-open Codex desktop conversation. No new desktop hot-refresh guarantee is made.

## Existing operation coverage

| Application operation                         | Existing entry point / owner                                | MCP status after this change                                                  | Boundary                                                                      |
| --------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Register project                              | `project-registry.ts`; projects route                       | `praxis_register_project`                                                     | Existing local directory; does not create a remote repository                 |
| Create source                                 | nodes POST; `graph/task/model.ts`                           | `praxis_create_source`                                                        | Store original brief; not automatic decomposition                             |
| Read/update source                            | nodes PATCH; `readStartNodeForUpdate`, `updateStartNode`    | `praxis_read_source`, `praxis_update_source`                                  | Existing revision/attachment semantics                                        |
| Read module graph/current model/map           | module stores; `mcp/catalog.ts`                             | Module resources                                                              | Distinguish nodes, pending proposals and canonical states                     |
| Read current context library                  | `product-context/catalog.ts`, `resource.ts`                 | **Added:** `praxis_list_context` plus exact resource reader                   | No arbitrary filesystem enumeration                                           |
| Read pending Candidates and bodies            | module `acceptance.ts`; `graph/proposal/pending.ts`         | **Added:** `praxis_list_candidates`; existing module projection retained      | Pending list is not history                                                   |
| Prepare/submit PE and refine                  | whats-next-runs; PE basis/materializer                      | `praxis_prepare`, `praxis_submit_product_exploration`                         | Refine uses returned immutable revisionSource; no acceptance                  |
| Propose/append/revise/recompose Scope         | decomposition-runs; Scope basis/materializer                | `praxis_prepare`, `praxis_submit_scope_decomposition`                         | Split/merge/retain already supported; examples below                          |
| Accept/discard Candidate                      | module acceptance/discard services; run PATCH               | `praxis_accept_candidate`, `praxis_discard_candidate`                         | Needs user intent; publishing does not grant it                               |
| Accepted node body revision                   | `mcp/node-document-tools.ts`; neutral node document service | `praxis_update_node_document`                                                 | Body only; no general metadata/edge editor                                    |
| Delete formal node                            | nodes DELETE; deletion service                              | `praxis_inspect_node_deletion`, `praxis_delete_node`                          | Existing blockers, no cascade; deletion differs from Candidate discard        |
| Domain Model changes                          | domain-model-runs; Domain basis/materializer                | `praxis_prepare`, `praxis_submit_domain_model`                                | Typed model changes, not arbitrary graph edges                                |
| Delivery Map changes                          | what-to-do-runs; map publication                            | `praxis_prepare`, `praxis_submit_delivery_map`                                | Preserve current map constraints and completed work                           |
| Read/update module instructions               | four context/instruction route-service pairs                | Separate task 06; not added here                                              | Check deployed schemas before advertising names                               |
| Read resource/operation/log                   | resources route; MCP catalog/operations                     | Existing read tools and resources                                             | Exact bounded reads, not log search                                           |
| Execution/Sync Up/reveal/cancel Host work     | delivery, sync-main, reveal and run routes                  | Not exposed by this checklist                                                 | Existing app capabilities; separate future tasks if requested                 |
| Generic formal title/summary/metadata editing | nodes PATCH is source-only; formal body service is narrower | Not served; no general application operation identified in audited node route | Future node retrieval-metadata contract must be explicit                      |
| Standalone dependency editor                  | Relations inside typed module results                       | No standalone MCP operation                                                   | Do not invent an edge-edit API under discovery work                           |
| Indexed search / context package              | No current application index service                        | Planned separately                                                            | Reuse these identities and read URIs, not a competing catalog/search protocol |

Unsupported operations and invalid input are different. A malformed reference to a served operation is invalid input; a missing generic editor is not a reason to try private routes or write storage files directly.

## Scope recomposition through existing tools

Read the Scope module contract URI for the complete Candidate schema and intention requirements. Discovery now exposes Scope intention/motion descriptions and effect examples in capabilities/module/contract resources. The following workflow is executed by `tests/mcp-discovery.test.ts` through the HTTP SDK, using only returned Candidate identities.

Suppose the pending list contains `Combined`, `Keep` and `Untouched`. Prepare:

```json
{
  "projectId": "<registered-project-id>",
  "module": "scope-decomposition",
  "request": {
    "userInput": "Split Combined into Input and Output, retain Keep and leave Untouched alone.",
    "sourceNodeId": "<source-node-id>",
    "operation": "recompose-candidates",
    "candidateIds": ["<combined-id>", "<keep-id>"]
  }
}
```

Submit to `praxis_submit_scope_decomposition` with the returned `operationId` and exact `contract`. `result.outcome` is `proposal`. Supply complete new Candidate objects for local keys `input` and `output` using the selected intention's contract. A minimal `understanding` Candidate is:

```json
{
  "localKey": "input",
  "type": "module",
  "title": "Input",
  "summary": "The bounded input capability.",
  "derivedFrom": [{ "kind": "node", "id": "<source-node-id>" }],
  "dependsOn": [],
  "resources": [],
  "typeTemplateRef": null,
  "metadata": {},
  "presentation": {},
  "assumptions": []
}
```

Its sibling uses local key `output` and its own title/meaning. `result.recomposition` is:

```json
{
  "effects": [
    {
      "kind": "split",
      "from": [{ "kind": "candidate", "id": "<combined-id>" }],
      "to": [
        { "kind": "proposal", "localKey": "input" },
        { "kind": "proposal", "localKey": "output" }
      ]
    },
    {
      "kind": "retain",
      "from": [{ "kind": "candidate", "id": "<keep-id>" }],
      "to": [{ "kind": "candidate", "id": "<keep-id>" }]
    }
  ]
}
```

Do not emit a duplicate Candidate object for Keep. It retains its identity, revision and original body reference. Untouched is outside the selection and has no effect entry. Re-list after submission; Combined is replaced by Input and Output, and no node has been accepted.

To merge Input and Output, prepare a new recomposition selecting their **newly returned** Candidate IDs, emit one complete Candidate with local key `combined`, and use:

```json
{
  "effects": [
    {
      "kind": "merge",
      "from": [
        { "kind": "candidate", "id": "<input-id>" },
        { "kind": "candidate", "id": "<output-id>" }
      ],
      "to": [{ "kind": "proposal", "localKey": "combined" }]
    }
  ]
}
```

Every selected Candidate is consumed by exactly one effect, and every new proposal is produced once. Dependent pending Candidates may need inclusion so references can be remapped; existing cycle and dependency checks still apply. `derivedFrom` is node lineage, `dependsOn` is a real prerequisite and may use node/candidate/proposal references allowed by the contract. Display grouping is neither. This does not create a standalone formal dependency editor.

## Verification and remaining scope

`tests/mcp-discovery.test.ts` verifies current context discovery, pagination, exact UTF-8 reconstruction, returned handles frozen into a Domain operation, frozen evidence surviving source edits, changed-list cursor rejection and project confinement. It also verifies Scope split/retain/merge and unchanged unselected Candidates through public SDK prepare/submit and discovery.

`tests/mcp-transport.test.ts` checks advertised tool names against real SDK registrations. Catalog/schema tests retain contract validation and module boundaries. Repository checks remain required. Tests use temporary projects and do not mutate MoMERP or Locus.

The new lists still materialize the existing catalog before paging. Full-text search, fast indexing, summary/tag updates and automatic desktop client schema refresh are not delivered by these tests or this PR.
