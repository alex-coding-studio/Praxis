import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RegisteredProject } from './project-registry.ts';

export class PlanningPathShapeError extends Error {
  readonly relativePath: string;
  constructor(relativePath: string) {
    super(`Planning path shape is not allowed: ${relativePath}`);
    this.name = 'PlanningPathShapeError';
    this.relativePath = relativePath;
  }
}

export class PlanningPathEscapeError extends Error {
  readonly relativePath: string;
  constructor(relativePath: string) {
    super(`Planning path escapes the planning root: ${relativePath}`);
    this.name = 'PlanningPathEscapeError';
    this.relativePath = relativePath;
  }
}

export class PlanningPathKindError extends Error {
  readonly relativePath: string;
  readonly expected: PlanningTargetKind;
  constructor(relativePath: string, expected: PlanningTargetKind) {
    super(`Planning path is not a ${expected}: ${relativePath}`);
    this.name = 'PlanningPathKindError';
    this.relativePath = relativePath;
    this.expected = expected;
  }
}

export class PlanningPathSizeError extends Error {
  readonly relativePath: string;
  readonly size: number;
  readonly maxBytes: number;
  constructor(relativePath: string, size: number, maxBytes: number) {
    super(`Planning path exceeds ${maxBytes} bytes: ${relativePath}`);
    this.name = 'PlanningPathSizeError';
    this.relativePath = relativePath;
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

export type PlanningTargetKind = 'file' | 'directory';

export type PlanningPathShape = {
  readonly name: string;
  readonly pattern: RegExp;
};

const MARKDOWN_FILE = String.raw`[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:md|markdown)`;
const NODE_ID = String.raw`NODE-[0-9a-f]{8,32}`;
const RUN_ID = String.raw`RUN-[0-9a-f-]{36}`;
const CANDIDATE_ID = String.raw`CANDIDATE-(?:[0-9]{4,}|[0-9a-f]{8,32})`;
const CARD_ID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
const CONTEXT_SEGMENTS = String.raw`(?:\/[a-z0-9][a-z0-9-]*)+`;

export const CONTEXT_LIBRARY_MARKDOWN: PlanningPathShape = {
  name: 'Context Library Markdown',
  pattern: new RegExp(
    String.raw`^context${CONTEXT_SEGMENTS}\/${MARKDOWN_FILE}$`,
    'i',
  ),
};

export const PRODUCT_CONTEXT_DOCUMENT_SHAPES: readonly PlanningPathShape[] = [
  {
    name: 'Delivery target artifacts',
    pattern: new RegExp(
      String.raw`^delivery\/targets\/${CARD_ID}\/(?:brief|output)\.md$`,
      'i',
    ),
  },
  CONTEXT_LIBRARY_MARKDOWN,
  {
    name: 'Accepted Task Graph or Product Design output',
    pattern: new RegExp(
      String.raw`^(?:task-graph|whats-next)\/nodes\/${NODE_ID}\/output\.md$`,
      'i',
    ),
  },
  {
    name: 'Applied Domain Model summary',
    pattern: new RegExp(
      String.raw`^domain-model\/runs\/${RUN_ID}\/summary\.md$`,
      'i',
    ),
  },
  {
    name: 'Current Delivery Contract output',
    pattern: new RegExp(
      String.raw`^what-to-do\/runs\/${RUN_ID}\/contracts\/${NODE_ID}\/output\.md$`,
      'i',
    ),
  },
  {
    name: 'Implementation Plan or accepted Action output',
    pattern: new RegExp(
      String.raw`^implementation\/cards\/${CARD_ID}\/[0-9]{8}\/(?:plan|output)\.md$`,
      'i',
    ),
  },
];

export const TASK_GRAPH_MARKDOWN_SHAPES: readonly PlanningPathShape[] = [
  ...PRODUCT_CONTEXT_DOCUMENT_SHAPES,
  {
    name: 'Task Graph or What’s Next node resource',
    pattern: new RegExp(
      String.raw`^(?:task-graph|whats-next)\/nodes\/${NODE_ID}\/resources\/${MARKDOWN_FILE}$`,
      'i',
    ),
  },
  {
    name: 'Break It Down Candidate output',
    pattern: new RegExp(
      String.raw`^task-decomposition\/runs\/${RUN_ID}\/candidates\/${CANDIDATE_ID}\/output\.md$`,
      'i',
    ),
  },
  {
    name: 'Break It Down Run response or summary',
    pattern: new RegExp(
      String.raw`^task-decomposition\/runs\/${RUN_ID}\/(?:response|summary)\.md$`,
      'i',
    ),
  },
  {
    name: 'What’s Next Candidate output',
    pattern: new RegExp(
      String.raw`^whats-next\/runs\/${RUN_ID}\/candidates\/${CANDIDATE_ID}\/output\.md$`,
      'i',
    ),
  },
  {
    name: 'What’s Next Run reflection',
    pattern: new RegExp(
      String.raw`^whats-next\/runs\/${RUN_ID}\/reflection\.md$`,
      'i',
    ),
  },
  {
    name: 'What’s Next Run response or summary',
    pattern: new RegExp(
      String.raw`^whats-next\/runs\/${RUN_ID}\/(?:response|summary)\.md$`,
      'i',
    ),
  },
  {
    name: 'What’s Next Run resource',
    pattern: new RegExp(
      String.raw`^whats-next\/runs\/${RUN_ID}\/resources\/${MARKDOWN_FILE}$`,
      'i',
    ),
  },
  {
    name: 'What’s Next Run User Input',
    pattern: new RegExp(
      String.raw`^whats-next\/runs\/${RUN_ID}\/context\/input\/user-input\.md$`,
      'i',
    ),
  },
  {
    name: 'What to Do Run response or summary',
    pattern: new RegExp(
      String.raw`^what-to-do\/runs\/${RUN_ID}\/(?:response|summary)\.md$`,
      'i',
    ),
  },
];

export const ANY_PLANNING_RELATIVE_PATH: PlanningPathShape = {
  name: 'planning-store relative path',
  pattern: /^[\s\S]+$/,
};

const WINDOWS_QUALIFIED = /^(?:[A-Za-z]:|\\\\|\\)/;

export function isAcceptedPlanningShape(
  relativePath: string,
  shapes: readonly PlanningPathShape[],
) {
  return shapes.some((shape) => shape.pattern.test(relativePath));
}

export function assertPlanningRelativePath(relativePath: string) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\0')
  )
    throw new PlanningPathShapeError(String(relativePath));
  if (path.isAbsolute(relativePath) || WINDOWS_QUALIFIED.test(relativePath))
    throw new PlanningPathShapeError(relativePath);
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === '..'))
    throw new PlanningPathShapeError(relativePath);
}

export type ResolvePlanningPathOptions = {
  shapes?: readonly PlanningPathShape[];
  within?: string;
  require?: PlanningTargetKind;
  maxBytes?: number;
};

export type ResolvedPlanningPath = {
  relativePath: string;
  absolutePath: string;
  size: number | null;
};

export async function resolvePlanningPath(
  project: RegisteredProject,
  relativePath: string,
  options: ResolvePlanningPathOptions = {},
): Promise<ResolvedPlanningPath> {
  const shapes = options.shapes ?? [ANY_PLANNING_RELATIVE_PATH];
  assertPlanningRelativePath(relativePath);
  if (!isAcceptedPlanningShape(relativePath, shapes))
    throw new PlanningPathShapeError(relativePath);

  const planningRoot = await realpath(project.planningPath);
  const boundary = options.within
    ? path.join(planningRoot, options.within)
    : planningRoot;
  const absolutePath = await realpath(path.resolve(planningRoot, relativePath));
  if (!absolutePath.startsWith(`${boundary}${path.sep}`))
    throw new PlanningPathEscapeError(relativePath);

  if (!options.require && options.maxBytes === undefined)
    return { relativePath, absolutePath, size: null };

  const info = await stat(absolutePath);
  if (options.require === 'file' && !info.isFile())
    throw new PlanningPathKindError(relativePath, 'file');
  if (options.require === 'directory' && !info.isDirectory())
    throw new PlanningPathKindError(relativePath, 'directory');
  if (options.maxBytes !== undefined && info.size > options.maxBytes)
    throw new PlanningPathSizeError(relativePath, info.size, options.maxBytes);
  return { relativePath, absolutePath, size: info.size };
}

export function isPlanningPathRejection(error: unknown) {
  return (
    error instanceof PlanningPathShapeError ||
    error instanceof PlanningPathEscapeError
  );
}
