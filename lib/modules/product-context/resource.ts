import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PublicApiError } from '../../api-errors.ts';
import { readDomainModel } from '../domain-modeling/model.ts';
import type { PlanningCard } from '../implementation/planning-service.ts';
import { readDeliveryRecord } from '../delivery/storage.ts';
import { readPlanningFile } from '../../planning-documents.ts';
import {
  readCardWorkDocument,
  readCardWorklog,
} from '../implementation/worklog.ts';
import {
  CONTEXT_LIBRARY_MARKDOWN,
  PRODUCT_CONTEXT_DOCUMENT_SHAPES,
  isAcceptedPlanningShape,
  resolvePlanningPath,
  type PlanningPathShape,
} from '../../planning-paths.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import type { TaskGraphNode } from '../../graph/task/nodes.ts';
import { readWhatToDoCurrentMap } from '../delivery-planning/storage.ts';

export type ProductContextSectionSlug = string;

export type ResolvedProductContextResource = {
  section: ProductContextSectionSlug;
  path: string;
  fileName: string;
  markdown: string;
};

const NODE_JSON: PlanningPathShape = {
  name: 'formal graph node record',
  pattern:
    /^(?:task-graph|whats-next)\/nodes\/NODE-[0-9a-f]{8,32}\/node\.json$/i,
};

export async function resolveProductContextResource(
  project: RegisteredProject,
  resourcePath: string,
  excludeSections: readonly string[] = [],
): Promise<ResolvedProductContextResource | null> {
  const section = await currentProductContextSection(project, resourcePath);
  if (!section || excludeSections.includes(section)) return null;
  return {
    section,
    path: resourcePath,
    fileName: path.basename(resourcePath),
    markdown: await readPlanningFile(project, resourcePath, 2_097_152),
  };
}

export async function validateProductContextReferences(
  project: RegisteredProject,
  refs: string[],
  excludeSections: readonly string[] = [],
) {
  return (
    await resolveProductContextReferences(project, refs, excludeSections)
  ).map((resource) => resource.path);
}

export async function resolveProductContextReferences(
  project: RegisteredProject,
  refs: string[],
  excludeSections: readonly string[] = [],
) {
  const uniqueRefs = [...new Set(refs)];
  const resources: ResolvedProductContextResource[] = [];
  for (const ref of uniqueRefs) {
    const resource =
      typeof ref !== 'string' || !ref
        ? null
        : await resolveProductContextResource(project, ref, excludeSections);
    if (!resource)
      throw new PublicApiError(
        'A selected Product Context document is no longer available.',
        409,
      );
    resources.push(resource);
  }
  return resources;
}

async function currentProductContextSection(
  project: RegisteredProject,
  resourcePath: string,
): Promise<ProductContextSectionSlug | null> {
  if (CONTEXT_LIBRARY_MARKDOWN.pattern.test(resourcePath)) {
    try {
      await resolvePlanningPath(project, resourcePath, {
        shapes: [CONTEXT_LIBRARY_MARKDOWN],
        within: 'context',
        require: 'file',
        maxBytes: 2_097_152,
      });
    } catch {
      return null;
    }
    return resourcePath.split('/')[1]?.toLowerCase() ?? null;
  }

  if (!isAcceptedPlanningShape(resourcePath, PRODUCT_CONTEXT_DOCUMENT_SHAPES))
    return null;
  const delivery = resourcePath.match(
    /^delivery\/targets\/([0-9a-f-]{36})\/(brief|output)\.md$/i,
  );
  if (delivery) {
    const record = await readDeliveryRecord(project, delivery[1]);
    return record &&
      (delivery[2] === 'brief'
        ? record.brief?.confirmedAt
        : record.status === 'completed')
      ? 'task-execution'
      : null;
  }

  const node = resourcePath.match(
    /^(whats-next|task-graph)\/nodes\/(NODE-[0-9a-f]{8,32})\/output\.md$/i,
  );
  if (node)
    return currentNodeSection(project, resourcePath, node[1]!, node[2]!);

  const domain = resourcePath.match(
    /^domain-model\/runs\/(RUN-[0-9a-f-]{36})\/summary\.md$/i,
  );
  if (domain) {
    const model = await readDomainModel(project);
    return model.lastRunId === domain[1] ? 'domain-model' : null;
  }

  if (
    /^what-to-do\/runs\/RUN-[0-9a-f-]{36}\/contracts\/NODE-[0-9a-f]{8,32}\/output\.md$/i.test(
      resourcePath,
    )
  ) {
    const map = await readWhatToDoCurrentMap(project);
    return map?.contracts.some(
      (contract) => contract.outputPath === resourcePath,
    )
      ? 'delivery-contract'
      : null;
  }

  const implementation = resourcePath.match(
    /^implementation\/cards\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9]{8})\/(plan|output)\.md$/i,
  );
  if (implementation)
    return currentImplementationSection(
      project,
      resourcePath,
      implementation[1]!,
      implementation[3]!,
    );

  return null;
}

async function currentNodeSection(
  project: RegisteredProject,
  outputPath: string,
  graphRoot: string,
  nodeId: string,
) {
  let record;
  try {
    const resolved = await resolvePlanningPath(
      project,
      `${graphRoot}/nodes/${nodeId}/node.json`,
      { shapes: [NODE_JSON], require: 'file', maxBytes: 2_097_152 },
    );
    record = JSON.parse(
      await readFile(resolved.absolutePath, 'utf8'),
    ) as TaskGraphNode;
  } catch {
    return null;
  }
  if (
    record.schemaVersion !== 1 ||
    record.id !== nodeId ||
    record.role !== 'node' ||
    !['accepted', 'formal'].includes(record.status) ||
    !record.resources.some(
      (resource) => resource.kind === 'output' && resource.path === outputPath,
    )
  )
    return null;
  if (graphRoot === 'task-graph') return 'task-breakdown';
  return (record.layer ?? 'discovery') === 'product-design'
    ? 'product-design'
    : 'mvp-prototype';
}

async function currentImplementationSection(
  project: RegisteredProject,
  resourcePath: string,
  cardId: string,
  documentKind: string,
) {
  const root = path.join(project.planningPath, 'implementation', 'cards');
  let card: PlanningCard;
  try {
    const log = await readCardWorklog(root, cardId);
    if (!log.revision) return null;
    card = JSON.parse(
      await readCardWorkDocument(
        root,
        cardId,
        log.revision,
        'planning-state.json',
      ),
    ) as PlanningCard;
    if (
      card.schemaVersion !== 1 ||
      card.id !== cardId ||
      card.revision !== log.revision
    )
      return null;
  } catch {
    return null;
  }

  if (documentKind === 'plan')
    return card.plan?.status === 'finalized' && card.planRef === resourcePath
      ? 'task-execution'
      : null;

  const accepted = new Set(card.execution?.acceptedActionIds ?? []);
  const matching = card.execution?.runs.find(
    (run) => run.outputRef === resourcePath,
  );
  if (!matching || !accepted.has(matching.actionId)) return null;
  const current = card.execution?.runs.findLast(
    (run) =>
      run.actionId === matching.actionId &&
      run.status === 'succeeded' &&
      run.outputRef,
  );
  return current?.outputRef === resourcePath ? 'task-execution' : null;
}
