import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  userInputWorkspaceInput,
  type ContextWorkspaceAttachment,
  type ContextWorkspaceInput,
} from './workspace-input.ts';
export { userInputWorkspaceInput };
export type { ContextWorkspaceAttachment, ContextWorkspaceInput };

export type ContextWorkspaceEntry = {
  role: 'primary' | 'related';
  kind: string;
  logicalPath: string;
  workspacePath: string;
  sha256: string;
  nodeId?: string;
  attachment?: ContextWorkspaceAttachment;
};

export type ContextWorkspaceManifest = {
  schemaVersion: 1;
  primary: ContextWorkspaceEntry[];
  related: ContextWorkspaceEntry[];
};

export type AgentGraphContentPacket = {
  input: ContextWorkspaceEntry | null;
  references: ContextWorkspaceEntry[];
  external: ContextWorkspaceEntry[];
};

export function agentGraphContentPacket(
  manifest: ContextWorkspaceManifest,
): AgentGraphContentPacket {
  const entries = [...manifest.primary, ...manifest.related];
  const inputs = entries.filter((entry) => entry.kind === 'user-input');
  if (inputs.length > 1)
    throw new Error('An Agent Graph Packet can contain only one User Input.');
  return {
    input: inputs[0] ?? null,
    references: entries.filter(
      (entry) => entry.kind !== 'user-input' && entry.kind !== 'run-attachment',
    ),
    external: entries.filter((entry) => entry.kind === 'run-attachment'),
  };
}

export function assembleAgentGraphWorkspaceInputs(
  userInput: ContextWorkspaceInput | null,
  references: ContextWorkspaceInput[],
) {
  if (userInput) return [userInput, ...references];
  let promoted = false;
  return references.map((entry) => {
    if (!promoted && entry.kind === 'source-input') {
      promoted = true;
      return { ...entry, role: 'primary' as const, kind: 'user-input' };
    }
    return entry;
  });
}

export function primarySourceResourcePaths(
  role: 'start' | 'node',
  resources: Array<{ kind: string; path: string }>,
) {
  return new Set(
    resources
      .filter((resource) => role === 'start' || resource.kind === 'output')
      .map((resource) => resource.path),
  );
}

export function relatedContextNodeIds(
  sourceNode: {
    id: string;
    derivedFrom?: string[];
    dependsOn: string[];
    resources: Array<{ path: string }>;
  },
  nodes: Array<{
    id: string;
    derivedFrom?: string[];
    dependsOn: string[];
    resources: Array<{ path: string }>;
  }>,
) {
  const sourceOrigins = new Set(sourceNode.derivedFrom ?? []);
  const sourceResources = new Set(
    sourceNode.resources.map((resource) => resource.path),
  );
  const directlyNamed = new Set([
    ...(sourceNode.derivedFrom ?? []),
    ...sourceNode.dependsOn,
  ]);
  return new Set(
    nodes
      .filter((node) => node.id !== sourceNode.id)
      .filter(
        (node) =>
          directlyNamed.has(node.id) ||
          node.derivedFrom?.includes(sourceNode.id) ||
          node.dependsOn.includes(sourceNode.id) ||
          node.derivedFrom?.some((origin) => sourceOrigins.has(origin)) ||
          node.resources.some((resource) => sourceResources.has(resource.path)),
      )
      .map((node) => node.id),
  );
}

export async function writeAgentGraphContextWorkspace(
  runPath: string,
  inputs: ContextWorkspaceInput[],
) {
  const contextPath = path.join(runPath, 'context');
  await mkdir(contextPath, { recursive: true });
  const selected = deduplicateInputs(inputs);
  const entries: ContextWorkspaceEntry[] = [];

  for (const [index, input] of selected.entries()) {
    const workspacePath = chooseWorkspacePath(input, index);
    const absolutePath = path.join(contextPath, workspacePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.content, { flag: 'wx' });
    entries.push({
      role: input.role,
      kind: input.kind,
      logicalPath: input.logicalPath,
      workspacePath,
      sha256: createHash('sha256').update(input.content).digest('hex'),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.attachment ? { attachment: input.attachment } : {}),
    });
  }

  const manifest: ContextWorkspaceManifest = {
    schemaVersion: 1,
    primary: entries.filter((entry) => entry.role === 'primary'),
    related: entries.filter((entry) => entry.role === 'related'),
  };
  await writeFile(
    path.join(contextPath, 'index.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx' },
  );
  return {
    root: contextPath,
    indexPath: path.join(contextPath, 'index.json'),
    manifest,
  };
}

function deduplicateInputs(inputs: ContextWorkspaceInput[]) {
  const selected = new Map<string, ContextWorkspaceInput>();
  for (const input of inputs) {
    const current = selected.get(input.logicalPath);
    if (!current || (current.role === 'related' && input.role === 'primary')) {
      selected.set(input.logicalPath, input);
    }
  }
  return [...selected.values()].sort(
    (left, right) =>
      Number(left.role === 'related') - Number(right.role === 'related') ||
      left.logicalPath.localeCompare(right.logicalPath),
  );
}

function chooseWorkspacePath(input: ContextWorkspaceInput, index: number) {
  if (input.kind === 'user-input') return 'input/user-input.md';
  if (input.kind === 'run-attachment')
    return path.posix.join(
      'external',
      `${String(index + 1).padStart(3, '0')}-${safeFileName(input.logicalPath)}`,
    );
  if (input.role === 'primary') {
    return path.posix.join(
      'primary',
      `${String(index + 1).padStart(3, '0')}-${safeFileName(input.logicalPath)}`,
    );
  }
  if (input.nodeId) {
    const ownOutput = input.logicalPath.endsWith(
      `/nodes/${input.nodeId}/output.md`,
    );
    return path.posix.join(
      'related',
      'nodes',
      ownOutput
        ? `${input.nodeId}.md`
        : `${input.nodeId}-${logicalPathFingerprint(input.logicalPath)}-${safeFileName(input.logicalPath)}`,
    );
  }
  return path.posix.join(
    'related',
    'resources',
    `${logicalPathFingerprint(input.logicalPath)}-${safeFileName(input.logicalPath)}`,
  );
}

function logicalPathFingerprint(logicalPath: string) {
  return createHash('sha256').update(logicalPath).digest('hex').slice(0, 10);
}

function safeFileName(logicalPath: string) {
  const parsed = path.parse(path.basename(logicalPath));
  const baseName =
    parsed.name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'context';
  return `${baseName}${parsed.ext || '.md'}`;
}
