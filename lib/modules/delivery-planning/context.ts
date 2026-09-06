import type { AgentProfile } from '../../agents/profile.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  agentGraphContentPacket,
  writeAgentGraphContextWorkspace,
  type AgentGraphContentPacket,
  type ContextWorkspaceInput,
} from '../../graph/agent/context-workspace.ts';
import { PublicApiError } from '../../api-errors.ts';
import {
  resolveProductContextReferences,
  type ResolvedProductContextResource,
} from '../product-context/resource.ts';
import {
  assertDeliveryPlanningSelection,
  collectDeliveryPlanningEvidence,
} from './evidence.ts';
export { renderDomainModelSummary } from './evidence.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import type { WhatToDoDeliveryMap } from './map.ts';
import { stageWhatToDoRunDirectory } from './storage.ts';

export type WhatToDoRunInput = {
  instruction: string;
  clarificationRunId?: string;
  clarificationContent?: AgentGraphContentPacket;
  sourceUids: string[];
  profile: AgentProfile;
  contextRefs?: string[];
  files?: File[];
  repositoryEvidencePaths?: string[];
  focusContractIds?: string[];
  currentMap?: WhatToDoDeliveryMap | null;
};

export async function prepareWhatToDoContext(
  project: RegisteredProject,
  runId: string,
  input: WhatToDoRunInput,
) {
  const instruction = input.instruction.trim();
  if (!instruction)
    throw new PublicApiError('What to Do User Input is required.', 400);
  const contextRefs = [...new Set(input.contextRefs ?? [])];
  const files = input.files ?? [];
  const repositoryEvidencePaths = [
    ...new Set(input.repositoryEvidencePaths ?? []),
  ];
  const focusContractIds = [...new Set(input.focusContractIds ?? [])];
  const currentMap = input.currentMap ?? null;
  assertDeliveryPlanningSelection({
    currentMap,
    sourceUids: input.sourceUids,
    focusContractIds,
  });
  if (contextRefs.length > 50)
    throw new PublicApiError('Select no more than 50 Context documents.', 400);
  if (files.length > 20)
    throw new PublicApiError('Attach no more than 20 Markdown files.', 400);
  if (repositoryEvidencePaths.length > 50)
    throw new PublicApiError(
      'Select no more than 50 repository evidence files.',
      400,
    );
  const contextResources = await resolveProductContextReferences(
    project,
    contextRefs,
    ['delivery-contract'],
  );

  const extraInputs = await contextInputs(contextResources, files, runId);
  const evidence = await collectDeliveryPlanningEvidence(project, {
    userInputPath: `what-to-do/runs/${runId}/context/input/user-input.md`,
    userInput: instruction,
    sourceUids: input.sourceUids,
    currentMap,
    repositoryEvidencePaths,
    extraInputs,
  });
  const { sources, repositoryFacts, domainModel } = evidence;
  const userInput = evidence.inputs[0]!;
  const staging = await stageWhatToDoRunDirectory(project, runId);
  let workspace: Awaited<ReturnType<typeof writeAgentGraphContextWorkspace>>;
  let packet: AgentGraphContentPacket;
  try {
    const staged = await writeAgentGraphContextWorkspace(
      staging.stagingPath,
      evidence.inputs,
    );
    packet = agentGraphContentPacket(staged.manifest);
    if (input.clarificationContent)
      assertClarificationContextPreserved(input.clarificationContent, packet);
    const publishedRoot = await staging.publish();
    workspace = {
      ...staged,
      root: path.join(publishedRoot, 'context'),
      indexPath: path.join(publishedRoot, 'context', 'index.json'),
    };
  } catch (error) {
    await staging.cleanup();
    throw error;
  }
  const inputEntry = workspace.manifest.primary.find(
    (entry) => entry.kind === 'user-input',
  );
  if (!inputEntry) throw new Error('What to Do Packet has no User Input.');
  const manifestEntries = [
    ...workspace.manifest.primary,
    ...workspace.manifest.related,
  ];
  const sourceContents = await Promise.all(
    manifestEntries.map(
      async (entry) =>
        [
          entry.logicalPath,
          {
            sha256: entry.sha256,
            content: await readFile(
              path.join(workspace.root, entry.workspacePath),
              'utf8',
            ),
          },
        ] as const,
    ),
  );
  return {
    workspace,
    packet,
    sources,
    repositoryFacts,
    domainModel,
    userInput: {
      path: inputEntry.logicalPath,
      sha256: inputEntry.sha256,
      content: userInput.content,
    },
    knownSources: Object.fromEntries(sourceContents),
    sourceSnapshots: manifestEntries.map((entry) => ({
      logicalPath: entry.logicalPath,
      sha256: entry.sha256,
      storedPath: `what-to-do/runs/${runId}/context/${entry.workspacePath}`,
    })),
    requiredSourcePaths: [
      ...new Set([
        ...sources.map((source) => source.outputPath),
        ...(currentMap?.sourceClaims.map((claim) => claim.sourcePath) ?? []),
      ]),
    ],
    knownEvidencePaths: knownEvidencePaths(workspace.manifest),
    evidencePathAliases: Object.fromEntries(
      manifestEntries.map((entry) => [entry.workspacePath, entry.logicalPath]),
    ),
  };
}

function assertClarificationContextPreserved(
  previous: AgentGraphContentPacket,
  next: AgentGraphContentPacket,
) {
  for (const entry of previous.references) {
    const current = next.references.find(
      (candidate) =>
        candidate.kind === entry.kind &&
        candidate.logicalPath === entry.logicalPath,
    );
    if (!current || current.sha256 !== entry.sha256)
      throw new PublicApiError(
        'The frozen Clarification Context changed. Start a new Delivery Planning request.',
        409,
      );
  }
  for (const entry of previous.external) {
    const current = next.external.find(
      (candidate) =>
        candidate.sha256 === entry.sha256 &&
        candidate.attachment?.originalName === entry.attachment?.originalName &&
        candidate.attachment?.mediaType === entry.attachment?.mediaType &&
        candidate.attachment?.byteSize === entry.attachment?.byteSize,
    );
    if (!current)
      throw new PublicApiError(
        'The frozen Clarification attachments changed. Start a new Delivery Planning request.',
        409,
      );
  }
}

async function contextInputs(
  contextResources: ResolvedProductContextResource[],
  files: File[],
  runId: string,
): Promise<ContextWorkspaceInput[]> {
  const references = contextResources.map((resource) => ({
    role: 'primary' as const,
    kind: 'context',
    logicalPath: resource.path,
    content: resource.markdown,
  }));
  const external = await Promise.all(
    files.map(async (file, index) => {
      if (!/\.(md|markdown|txt|html|htm)$/i.test(file.name))
        throw new PublicApiError(
          'Only Markdown files can be attached to What to Do.',
          400,
        );
      if (file.size > 2 * 1024 * 1024)
        throw new PublicApiError(
          'Each What to Do attachment must be 2 MB or smaller.',
          400,
        );
      if (file.name.length > 255 || file.name.includes('\0'))
        throw new PublicApiError(
          'A What to Do attachment name is invalid.',
          400,
        );
      const bytes = new Uint8Array(await file.arrayBuffer());
      let content: string;
      try {
        content = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw new PublicApiError(
          'A What to Do attachment must be UTF-8 Markdown text.',
          400,
        );
      }
      const mediaType = file.type || 'text/markdown';
      if (!['text/markdown', 'text/plain'].includes(mediaType.toLowerCase()))
        throw new PublicApiError(
          'A What to Do attachment media type is not supported.',
          400,
        );
      return {
        role: 'primary' as const,
        kind: 'run-attachment',
        logicalPath: `what-to-do/runs/${runId}/attachments/${String(index + 1).padStart(3, '0')}-${safeAttachmentName(file.name)}`,
        content,
        attachment: {
          originalName: file.name,
          mediaType,
          byteSize: bytes.byteLength,
          semanticKind: 'markdown',
        },
      };
    }),
  );
  return [...references, ...external];
}

function safeAttachmentName(value: string) {
  const name = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return name || 'attachment.md';
}

function knownEvidencePaths(
  manifest: Awaited<
    ReturnType<typeof writeAgentGraphContextWorkspace>
  >['manifest'],
) {
  return [
    ...new Set([
      '.',
      ...manifest.primary.map((entry) => entry.logicalPath),
      ...manifest.related.map((entry) => entry.logicalPath),
    ]),
  ];
}
