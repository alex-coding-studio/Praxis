import { readdir } from 'node:fs/promises';
import { listDeliveryRecords } from '../delivery/storage.ts';
import { ensureDeliveryArtifacts } from '../delivery/artifacts.ts';
import path from 'node:path';
import { readDomainModel } from '../domain-modeling/model.ts';
import type { PlanningCard } from '../implementation/planning-service.ts';
import { readPlanningFile } from '../../planning-documents.ts';
import {
  PRODUCT_CONTEXT_DOCUMENT_SHAPES,
  isAcceptedPlanningShape,
} from '../../planning-paths.ts';
import { resolveProductContextResource } from './resource.ts';
import {
  readCardWorkDocument,
  readCardWorklog,
} from '../implementation/worklog.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import { listTaskGraphNodes } from '../../graph/task/nodes.ts';
import { readWhatToDoCurrentMap } from '../delivery-planning/storage.ts';

export type ContextSection = {
  slug: string;
  title: string;
  summary: string;
  markdown: string;
  documents: ContextDocument[];
};

export type ContextDocument = {
  fileName: string;
  path?: string;
  title: string;
  summary: string;
  markdown: string;
};

export type ContextBrowserFolder = {
  path: string;
  name: string;
  title: string;
  entries: ContextBrowserEntry[];
};

export type ContextBrowserEntry =
  | {
      kind: 'folder';
      path: string;
      name: string;
      title: string;
    }
  | {
      kind: 'file';
      path: string;
      name: string;
      title: string;
    };

const systemSectionDefinitions = [
  {
    slug: 'mvp-prototype',
    title: 'MVP Prototype',
    summary: 'Accepted discovery outputs that define an early product slice.',
  },
  {
    slug: 'product-design',
    title: 'Product Design',
    summary: 'Accepted product behavior and experience Features.',
  },
  {
    slug: 'domain-model',
    title: 'Domain Model',
    summary: 'The latest applied entities, fields, relationships, and rules.',
  },
  {
    slug: 'task-breakdown',
    title: 'Task Breakdown',
    summary: 'Accepted decomposition outputs with stable scope boundaries.',
  },
  {
    slug: 'delivery-contract',
    title: 'Delivery Contract',
    summary: 'Current formal delivery boundaries and their dependencies.',
  },
  {
    slug: 'task-execution',
    title: 'Task Execution',
    summary: 'Confirmed implementation plans and accepted Action outputs.',
  },
] as const;

export async function readProductContext(project: RegisteredProject) {
  const [systemSections, manualSections] = await Promise.all([
    readSystemProductContext(project),
    readManualProductContext(project),
  ]);
  const sections = new Map(
    systemSections.map((section) => [section.slug, section]),
  );
  for (const manual of manualSections) {
    const system = sections.get(manual.slug);
    if (!system) {
      sections.set(manual.slug, manual);
      continue;
    }
    const known = new Set(system.documents.map((document) => document.path));
    system.documents.push(
      ...manual.documents.filter((document) => !known.has(document.path)),
    );
    system.documents.sort((left, right) =>
      left.title.localeCompare(right.title),
    );
  }
  return [...sections.values()];
}

export async function readContextBrowser(
  project: RegisteredProject,
  excludeSections: readonly string[] = [],
): Promise<ContextBrowserFolder[]> {
  const sections = await readProductContext(project);
  const excluded = new Set(excludeSections);
  return sections
    .filter((section) => !excluded.has(section.slug))
    .map((section) => ({
      path: `product-context/${section.slug}`,
      name: section.slug,
      title: section.title,
      entries: section.documents.flatMap((document) =>
        document.path
          ? [
              {
                kind: 'file' as const,
                path: document.path,
                name: document.fileName,
                title: document.title,
              },
            ]
          : [],
      ),
    }));
}

async function readManualProductContext(
  project: RegisteredProject,
): Promise<ContextSection[]> {
  const contextRoot = path.join(project.planningPath, 'context');
  const entries = await readdir(contextRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const sections: ContextSection[] = [];
  for (const entry of entries
    .filter(
      (candidate) =>
        candidate.isDirectory() && /^[a-z0-9][a-z0-9-]*$/i.test(candidate.name),
    )
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const documents = await readManualDocuments(project, entry.name);
    if (!documents.length) continue;
    const readme = documents.find(
      (document) => document.fileName.toLowerCase() === 'readme.md',
    );
    sections.push({
      slug: entry.name.toLowerCase(),
      title: readme?.title ?? titleFromFileName(entry.name),
      summary: readme?.summary ?? 'Manually managed project resources.',
      markdown: readme?.markdown ?? '',
      documents,
    });
  }
  return sections;
}

async function readManualDocuments(
  project: RegisteredProject,
  section: string,
) {
  const root = path.join(project.planningPath, 'context', section);
  const documents: ContextDocument[] = [];
  async function visit(directory: string, segments: string[]) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/i.test(entry.name)) {
        await visit(path.join(directory, entry.name), [
          ...segments,
          entry.name,
        ]);
        continue;
      }
      if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) continue;
      const resourcePath = ['context', section, ...segments, entry.name].join(
        '/',
      );
      const resource = await resolveProductContextResource(
        project,
        resourcePath,
      );
      if (!resource) continue;
      documents.push({
        fileName: [...segments, entry.name].join('/'),
        path: resource.path,
        title: titleFromMarkdown(resource.markdown, entry.name),
        summary: readSummary(resource.markdown),
        markdown: resource.markdown,
      });
    }
  }
  await visit(root, []);
  return documents;
}

async function readSystemProductContext(
  project: RegisteredProject,
): Promise<ContextSection[]> {
  const documents = new Map<string, ContextDocument[]>();
  const add = async (
    section: string,
    input: { path: string; fileName: string; title: string; summary?: string },
  ) => {
    if (!isAcceptedPlanningShape(input.path, PRODUCT_CONTEXT_DOCUMENT_SHAPES))
      throw new Error('Invalid Product Context document path.');
    const markdown = await readPlanningFile(project, input.path, 2_097_152);
    const current = documents.get(section) ?? [];
    if (current.some((document) => document.path === input.path)) return;
    current.push({
      path: input.path,
      fileName: input.fileName,
      title: input.title,
      summary: input.summary?.trim() || readSummary(markdown),
      markdown,
    });
    documents.set(section, current);
  };

  const [whatsNextNodes, breakdownNodes, domainModel, deliveryMap, cards] =
    await Promise.all([
      listTaskGraphNodes(project, 'whats-next'),
      listTaskGraphNodes(project, 'task-graph'),
      readDomainModel(project),
      readWhatToDoCurrentMap(project),
      listPlanningCardsForContext(project),
    ]);

  for (const node of whatsNextNodes) {
    if (node.role !== 'node' || !['accepted', 'formal'].includes(node.status))
      continue;
    const outputPath = node.resources.find(
      (resource) => resource.kind === 'output',
    )?.path;
    if (!outputPath) continue;
    await add(
      (node.layer ?? 'discovery') === 'product-design'
        ? 'product-design'
        : 'mvp-prototype',
      {
        path: outputPath,
        fileName: `${node.id}.md`,
        title: node.title,
        summary: node.summary,
      },
    );
  }

  for (const node of breakdownNodes) {
    if (node.role !== 'node' || !['accepted', 'formal'].includes(node.status))
      continue;
    const outputPath = node.resources.find(
      (resource) => resource.kind === 'output',
    )?.path;
    if (!outputPath) continue;
    await add('task-breakdown', {
      path: outputPath,
      fileName: `${node.id}.md`,
      title: node.title,
      summary: node.summary,
    });
  }

  if (domainModel.lastRunId)
    await add('domain-model', {
      path: `domain-model/runs/${domainModel.lastRunId}/summary.md`,
      fileName: 'domain-model.md',
      title: 'Domain Model',
    });

  for (const contract of deliveryMap?.contracts ?? [])
    await add('delivery-contract', {
      path: contract.outputPath,
      fileName: `${contract.id}.md`,
      title: contract.title,
      summary: contract.summary,
    });

  for (const record of await listDeliveryRecords(project)) {
    for (const artifact of await ensureDeliveryArtifacts(project, record)) {
      await add('task-execution', {
        path: artifact.path,
        fileName: `${record.sourceUid}-${artifact.kind}.md`,
        title: `${record.source.title} · ${artifact.kind === 'brief' ? 'Delivery Brief' : 'Delivery'}`,
        summary: record.brief?.outcome,
      });
    }
  }
  for (const card of cards) {
    if (card.plan?.status === 'finalized' && card.planRef)
      await add('task-execution', {
        path: card.planRef,
        fileName: `${card.id}-plan.md`,
        title: `${card.source.title} · Plan`,
        summary: card.plan.overview,
      });
    for (const actionId of card.execution?.acceptedActionIds ?? []) {
      const run = card.execution?.runs.findLast(
        (candidate) =>
          candidate.actionId === actionId &&
          candidate.status === 'succeeded' &&
          candidate.outputRef,
      );
      if (!run?.outputRef) continue;
      const action = card.actions.find(
        (candidate) => candidate.id === actionId,
      );
      await add('task-execution', {
        path: run.outputRef,
        fileName: `${card.id}-${actionId}.md`,
        title: `${card.source.title} · ${action?.title ?? 'Action'}`,
        summary: run.result?.summary,
      });
    }
  }

  return systemSectionDefinitions.flatMap((definition) => {
    const sectionDocuments = documents.get(definition.slug) ?? [];
    if (!sectionDocuments.length) return [];
    sectionDocuments.sort((left, right) =>
      left.title.localeCompare(right.title),
    );
    return [
      {
        slug: definition.slug,
        title: definition.title,
        summary: definition.summary,
        markdown: `# ${definition.title}\n\n${definition.summary}\n`,
        documents: sectionDocuments,
      },
    ];
  });
}

async function listPlanningCardsForContext(project: RegisteredProject) {
  const root = path.join(project.planningPath, 'implementation', 'cards');
  const cardIds = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const cards: PlanningCard[] = [];
  for (const cardId of cardIds) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        cardId,
      )
    )
      continue;
    const log = await readCardWorklog(root, cardId);
    if (!log.revision) continue;
    const card = JSON.parse(
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
      throw new Error('Invalid Planning Card state.');
    cards.push(card);
  }
  return cards;
}

function readSummary(markdown: string) {
  return (
    markdown
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .find((paragraph) => paragraph && !paragraph.startsWith('#')) ??
    'No summary yet.'
  );
}

function titleFromMarkdown(markdown: string, fileName: string) {
  return (
    markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? titleFromFileName(fileName)
  );
}

function titleFromFileName(fileName: string) {
  return path
    .parse(fileName)
    .name.split(/[-_]/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}
