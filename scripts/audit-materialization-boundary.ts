import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DependencyGraph } from '../lib/graph/runtime-dependencies.ts';
import { runAudit } from './audit-runtime-dependencies.ts';

export type MaterializationBoundaryTier = {
  name: string;
  members: RegExp[];
  forbidden: RegExp[];
};

export type MaterializationBoundaryPolicy = {
  tiers: MaterializationBoundaryTier[];
  requiredFiles: string[];
};

export type MaterializationBoundaryViolation = {
  tier: string;
  from: string;
  to: string;
  chain: string[];
};

const AGENT_TRANSPORT = String.raw`lib/agents/`;
const RUN_SERVICE = String.raw`lib/modules/[^/]+/runs\.tsx?$`;
const HARNESS = String.raw`lib/modules/[^/]+/harness\.tsx?$`;
const PROMPT = String.raw`lib/modules/[^/]+/prompt\.tsx?$`;
const MODULE_CONTEXT = String.raw`lib/modules/[^/]+/context\.tsx?$`;
const AGENT_GRAPH_IO = String.raw`lib/graph/agent/(?:run|input|context-workspace)\.ts$`;

const MATERIALIZER_MEMBERS = [
  String.raw`lib/materialization/`,
  String.raw`lib/graph/proposal/`,
  String.raw`lib/graph/task/nodes\.ts$`,
  String.raw`lib/modules/[^/]+/(?:contract|basis|validation|materializer|publish)\.tsx?$`,
  String.raw`lib/modules/delivery-planning/map\.tsx?$`,
];

const ADAPTER_MEMBERS = [String.raw`lib/modules/[^/]+/producer-adapter\.tsx?$`];

export const MATERIALIZATION_REQUIRED_FILES = [
  'lib/materialization/contract.ts',
  'lib/materialization/hash.ts',
  'lib/materialization/basis.ts',
  'lib/materialization/receipt.ts',
  'lib/materialization/producer.ts',
  'lib/materialization/log.ts',
  'lib/materialization/publication.ts',
  'lib/graph/proposal/reference.ts',
  'lib/graph/proposal/contract.ts',
  'lib/graph/proposal/basis.ts',
  'lib/graph/proposal/validate.ts',
  'lib/graph/proposal/classify.ts',
  'lib/graph/proposal/dependencies.ts',
  'lib/graph/proposal/promote.ts',
  'lib/graph/proposal/resolve.ts',
  'lib/graph/proposal/stage.ts',
  'lib/graph/task/nodes.ts',
  'lib/modules/product-discovery/contract.ts',
  'lib/modules/product-discovery/basis.ts',
  'lib/modules/product-discovery/validation.ts',
  'lib/modules/product-discovery/materializer.ts',
  'lib/modules/product-discovery/publish.ts',
  'lib/modules/scope-decomposition/contract.ts',
  'lib/modules/scope-decomposition/basis.ts',
  'lib/modules/scope-decomposition/validation.ts',
  'lib/modules/scope-decomposition/materializer.ts',
  'lib/modules/scope-decomposition/publish.ts',
  'lib/modules/domain-modeling/contract.ts',
  'lib/modules/domain-modeling/basis.ts',
  'lib/modules/domain-modeling/materializer.ts',
  'lib/modules/domain-modeling/publish.ts',
  'lib/modules/delivery-planning/contract.ts',
  'lib/modules/delivery-planning/basis.ts',
  'lib/modules/delivery-planning/validation.ts',
  'lib/modules/delivery-planning/map.ts',
  'lib/modules/delivery-planning/publish.ts',
  'lib/modules/product-discovery/producer-adapter.ts',
  'lib/modules/scope-decomposition/producer-adapter.ts',
  'lib/modules/domain-modeling/producer-adapter.ts',
  'lib/modules/delivery-planning/producer-adapter.ts',
];

export function materializationBoundaryPolicy(
  prefix = '',
  requiredFiles: string[] = MATERIALIZATION_REQUIRED_FILES,
): MaterializationBoundaryPolicy {
  const anchored = (pattern: string) => new RegExp(`^${prefix}${pattern}`);
  return {
    tiers: [
      {
        name: 'materializer',
        members: MATERIALIZER_MEMBERS.map(anchored),
        forbidden: [
          AGENT_TRANSPORT,
          RUN_SERVICE,
          HARNESS,
          PROMPT,
          MODULE_CONTEXT,
          AGENT_GRAPH_IO,
        ].map(anchored),
      },
      {
        name: 'adapter',
        members: ADAPTER_MEMBERS.map(anchored),
        forbidden: [AGENT_TRANSPORT, RUN_SERVICE].map(anchored),
      },
    ],
    requiredFiles: requiredFiles.map((file) => `${prefix}${file}`),
  };
}

export const MATERIALIZATION_BOUNDARY_POLICY = materializationBoundaryPolicy();

function adjacencyOf(graph: DependencyGraph) {
  const adjacency = new Map<string, string[]>();
  for (const edge of [...graph.runtimeEdges, ...graph.typeOnlyEdges]) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  return adjacency;
}

export function reachableViolations(
  adjacency: Map<string, string[]>,
  start: string,
  forbidden: RegExp[],
) {
  const parents = new Map<string, string>([[start, '']]);
  const queue = [start];
  const found: Array<{ to: string; chain: string[] }> = [];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (parents.has(next)) continue;
      parents.set(next, current);
      if (forbidden.some((pattern) => pattern.test(next))) {
        const chain = [next];
        let cursor = current;
        while (cursor) {
          chain.unshift(cursor);
          cursor = parents.get(cursor) ?? '';
        }
        found.push({ to: next, chain });
        continue;
      }
      queue.push(next);
    }
  }
  return found;
}

export function materializationBoundaryMembers(
  graph: DependencyGraph,
  tier: MaterializationBoundaryTier,
) {
  return graph.modules.filter((file) =>
    tier.members.some((pattern) => pattern.test(file)),
  );
}

export function materializationBoundaryViolations(
  graph: DependencyGraph,
  policy: MaterializationBoundaryPolicy = MATERIALIZATION_BOUNDARY_POLICY,
): MaterializationBoundaryViolation[] {
  const adjacency = adjacencyOf(graph);
  return policy.tiers.flatMap((tier) =>
    materializationBoundaryMembers(graph, tier).flatMap((from) =>
      reachableViolations(adjacency, from, tier.forbidden).map((hit) => ({
        tier: tier.name,
        from,
        to: hit.to,
        chain: hit.chain,
      })),
    ),
  );
}

export function nonLiteralImports(
  graph: DependencyGraph,
  policy: MaterializationBoundaryPolicy = MATERIALIZATION_BOUNDARY_POLICY,
) {
  const guarded = new Set(
    policy.tiers.flatMap((tier) => materializationBoundaryMembers(graph, tier)),
  );
  return graph.unresolvedImports.filter(
    (entry) => guarded.has(entry.from) && entry.reason === 'non-literal',
  );
}

export function missingRequiredFiles(
  graph: DependencyGraph,
  policy: MaterializationBoundaryPolicy = MATERIALIZATION_BOUNDARY_POLICY,
  projectRoot = auditProjectRoot(),
) {
  const entries: Array<{ file: string; reason: 'missing' | 'not-analyzed' }> =
    [];
  for (const file of policy.requiredFiles) {
    if (!existsSync(path.join(projectRoot, file)))
      entries.push({ file, reason: 'missing' });
    else if (!graph.modules.includes(file))
      entries.push({ file, reason: 'not-analyzed' });
  }
  return entries;
}

export function auditProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function runMaterializationBoundaryAudit(
  projectRoot = auditProjectRoot(),
) {
  const graph = runAudit(projectRoot);
  return {
    graph,
    violations: materializationBoundaryViolations(graph),
    nonLiteral: nonLiteralImports(graph),
    missing: missingRequiredFiles(
      graph,
      MATERIALIZATION_BOUNDARY_POLICY,
      projectRoot,
    ),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { graph, violations, nonLiteral, missing } =
    runMaterializationBoundaryAudit();
  const guarded = MATERIALIZATION_BOUNDARY_POLICY.tiers.map((tier) => ({
    tier: tier.name,
    files: materializationBoundaryMembers(graph, tier).length,
  }));
  for (const entry of guarded)
    process.stdout.write(`${entry.tier}: ${entry.files} guarded files\n`);
  for (const violation of violations)
    process.stdout.write(
      `${violation.tier} violation: ${violation.chain.join(' -> ')}\n`,
    );
  for (const entry of nonLiteral)
    process.stdout.write(
      `non-literal import: ${entry.from}:${entry.line}:${entry.column}\n`,
    );
  for (const entry of missing)
    process.stdout.write(`required file ${entry.reason}: ${entry.file}\n`);
  if (guarded.some((entry) => entry.files === 0) || missing.length)
    process.exit(2);
  if (violations.length || nonLiteral.length) process.exit(3);
}
