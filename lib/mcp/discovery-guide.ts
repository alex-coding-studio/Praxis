import { taskDecompositionIntentionRegistry } from '../modules/scope-decomposition/intention.ts';
import { taskDecompositionMotionRegistry } from '../modules/scope-decomposition/motion.ts';

export const MCP_DISCOVERY_GUIDANCE = {
  candidates: {
    tool: 'praxis_list_candidates',
    modules: ['product-exploration', 'scope-decomposition'],
    selection:
      'Use returned candidateId, runId and revision; do not derive identifiers or file paths.',
  },
  context: {
    tool: 'praxis_list_context',
    input:
      'Use returned artifactId in request.contextIds for domain-modeling or delivery-planning. For Product Exploration and Scope, preparation freezes selected node resources instead.',
    output:
      'Use returned uri with praxis_read_resource; follow nextCursor on that same URI until null. Concatenate all text pages before parsing JSON.',
  },
  clientDiscovery: {
    schema:
      'Call tools/list to obtain current tool schemas. capabilities lists names, not a replacement invocation schema.',
    refresh:
      'The HTTP Host creates a fresh MCP server for each request. An explicit tools/list fetch sees deployed registrations; persistent client UI caches may need reconnect/reload. Server-pushed hot refresh is not guaranteed.',
    diagnosis:
      'A missing tool in an already-open client does not prove a missing Host capability. Refresh discovery before inspecting implementation or creating a custom request script.',
  },
  boundaries: [
    {
      operation: 'accepted-node-body-update',
      status: 'served',
      tool: 'praxis_update_node_document',
      scope: 'Body only; not title, summary, metadata or relationship editing.',
    },
    {
      operation: 'pending-candidate-split-merge-retain',
      status: 'served',
      tool: 'praxis_prepare',
      scope:
        'Scope recompose-candidates plus praxis_submit_scope_decomposition; proposals remain unaccepted.',
    },
    {
      operation: 'standalone-dependency-editor',
      status: 'not-served',
      scope:
        'Use supported module result relations. No generic edge-edit tool is exposed.',
    },
    {
      operation: 'accepted-node-title-summary-metadata-editor',
      status: 'not-served',
      scope: 'No general formal-node mutation API is exposed.',
    },
    {
      operation: 'indexed-search-and-context-package',
      status: 'planned',
      scope: 'Separate Context Provider work; catalog listing is not search.',
    },
  ],
};

export const SCOPE_DISCOVERY_GUIDANCE = {
  intentions: taskDecompositionIntentionRegistry.profiles.map((profile) => ({
    id: profile.id,
    description: profile.description,
    instructions: profile.prompt,
  })),
  motions: taskDecompositionMotionRegistry.profiles,
  relations: {
    derivedFrom:
      'Node references only: {kind: "node", id}. Lineage is not an execution dependency.',
    dependsOn:
      'Existing node/candidate references or {kind: "proposal", localKey} for another output in this submission. Only real prerequisites; respect cycle and known-identity checks.',
    resources:
      'Reuse allowed paths from prepared context. Resource paths are not graph references.',
  },
  recomposition: {
    prepare:
      'Read pending Candidates, then prepare operation recompose-candidates with sourceNodeId and selected candidateIds. Submit with that operationId and returned contract.',
    effects:
      'Every selected Candidate has exactly one effect. Every new proposal output is produced once. Unselected Candidates remain unchanged. Retain references the same Candidate in from/to and does not emit a duplicate proposal. Select dependent pending Candidates too when their references need remapping.',
    examples: [
      {
        kind: 'split',
        from: [{ kind: 'candidate', id: 'CANDIDATE-00000001' }],
        to: [
          { kind: 'proposal', localKey: 'input' },
          { kind: 'proposal', localKey: 'output' },
        ],
      },
      {
        kind: 'retain',
        from: [{ kind: 'candidate', id: 'CANDIDATE-00000002' }],
        to: [{ kind: 'candidate', id: 'CANDIDATE-00000002' }],
      },
      {
        kind: 'merge',
        from: [
          { kind: 'candidate', id: 'CANDIDATE-00000001' },
          { kind: 'candidate', id: 'CANDIDATE-00000002' },
        ],
        to: [{ kind: 'proposal', localKey: 'combined' }],
      },
    ],
    exampleUsage:
      'Examples are separate effect shapes with placeholders, not a combined plan. Substitute discovered Candidate ids and supply full candidate records for every proposal localKey, using the Result Contract example and selected intention requirements.',
    authorization:
      'Recomposition needs user intent to reorganize proposals. It does not accept or delete formal nodes. Accept/discard remain separate user-authorized transitions.',
  },
};
