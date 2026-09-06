import { PublicApiError } from '../../api-errors.ts';
import {
  userInputWorkspaceInput,
  type ContextWorkspaceInput,
} from '../../graph/agent/workspace-input.ts';
import { readDomainModel, type DomainModel } from '../domain-modeling/model.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import { readWhatToDoInstructions } from './instructions.ts';
import {
  whatToDoCurrentMapPromptView,
  type WhatToDoDeliveryMap,
} from './map.ts';
import {
  collectWhatToDoRepositoryFacts,
  readWhatToDoRepositoryEvidence,
  readWhatToDoTargetedRepositoryEvidence,
} from './repository-facts.ts';
import { selectWhatToDoFeatureSources } from './sources.ts';
import { readWhatToDoRepositorySummary } from './storage.ts';
import { whatToDoFeatureWorkspaceInputs } from './workspace-inputs.ts';

export type DeliveryPlanningEvidenceRequest = {
  userInputPath: string;
  userInput: string;
  sourceUids: string[];
  currentMap: WhatToDoDeliveryMap | null;
  repositoryEvidencePaths: string[];
  extraInputs?: ContextWorkspaceInput[];
};

export function assertDeliveryPlanningSelection(input: {
  currentMap: WhatToDoDeliveryMap | null;
  sourceUids: readonly string[];
  focusContractIds: readonly string[];
}) {
  if (!input.currentMap && input.sourceUids.length === 0)
    throw new PublicApiError(
      'Select at least one accepted Product Design Feature.',
      400,
    );
  if (
    input.currentMap &&
    input.sourceUids.some((uid) => input.currentMap!.sourceUids.includes(uid))
  )
    throw new PublicApiError(
      'A selected Product Design Feature is already part of the current Delivery Map.',
      409,
    );
  const currentContracts = new Set(
    (input.currentMap?.contracts ?? []).map((contract) => contract.id),
  );
  if (input.focusContractIds.some((id) => !currentContracts.has(id)))
    throw new PublicApiError(
      'A selected Delivery Contract is no longer available.',
      409,
    );
}

export async function collectDeliveryPlanningEvidence(
  project: RegisteredProject,
  request: DeliveryPlanningEvidenceRequest,
) {
  const [
    sources,
    repositoryFacts,
    repositorySummary,
    domainModel,
    instructions,
  ] = await Promise.all([
    request.sourceUids.length
      ? selectWhatToDoFeatureSources(project, request.sourceUids)
      : Promise.resolve([]),
    collectWhatToDoRepositoryFacts(project),
    readWhatToDoRepositorySummary(project),
    readDomainModel(project),
    readWhatToDoInstructions(project),
  ]);
  const featureInputs = await whatToDoFeatureWorkspaceInputs(project, sources);
  const sourceInputs = featureInputs;
  let repositoryEvidence: Array<{ path: string; content: string }>;
  try {
    const [automatic, targeted] = await Promise.all([
      readWhatToDoRepositoryEvidence(project, repositoryFacts),
      readWhatToDoTargetedRepositoryEvidence(
        project,
        repositoryFacts,
        request.repositoryEvidencePaths,
      ),
    ]);
    repositoryEvidence = [
      ...new Map(
        [...automatic, ...targeted].map((entry) => [entry.path, entry]),
      ).values(),
    ];
  } catch (error) {
    if (error instanceof PublicApiError) throw error;
    throw new PublicApiError(
      'Repository evidence changed or is unavailable. Reload before continuing.',
      409,
    );
  }
  const confirmedFacts = await collectWhatToDoRepositoryFacts(project);
  if (confirmedFacts.fingerprint !== repositoryFacts.fingerprint)
    throw new PublicApiError(
      'Repository facts changed. Reload before continuing.',
      409,
    );
  const extraInputs = request.extraInputs ?? [];
  const userInput = userInputWorkspaceInput(
    request.userInputPath,
    request.userInput,
  );
  if (!userInput) throw new Error('What to Do User Input was lost.');
  return {
    sources,
    repositoryFacts,
    domainModel,
    inputs: [
      userInput,
      ...(instructions.trim()
        ? [
            {
              role: 'related' as const,
              kind: 'module-instructions',
              logicalPath: 'what-to-do/instructions.md',
              content: `# Delivery Planning Instructions\n\n${instructions.trim()}\n`,
            },
          ]
        : []),
      ...sourceInputs,
      ...(request.currentMap
        ? [
            {
              role: 'related' as const,
              kind: 'delivery-map',
              logicalPath: 'what-to-do/current-map.json',
              content: `${JSON.stringify(whatToDoCurrentMapPromptView(request.currentMap), null, 2)}\n`,
            },
          ]
        : []),
      {
        role: 'related',
        kind: 'repository-facts',
        logicalPath: 'what-to-do/repository-context/facts.json',
        content: `${JSON.stringify(repositoryFacts, null, 2)}\n`,
      },
      ...repositoryEvidence.map((entry) => ({
        role: 'related' as const,
        kind: 'repository-evidence',
        logicalPath: `repository/${entry.path}`,
        content: entry.content,
      })),
      ...(repositorySummary &&
      repositoryFacts.reusable &&
      repositorySummary.repositoryFingerprint === repositoryFacts.fingerprint
        ? [
            {
              role: 'related' as const,
              kind: 'repository-summary',
              logicalPath: 'what-to-do/repository-context/summary.md',
              content: repositorySummary.markdown,
            },
          ]
        : []),
      {
        role: 'related',
        kind: 'domain-model-summary',
        logicalPath: 'domain-model/domain-model-summary.md',
        content: renderDomainModelSummary(domainModel),
      },
      {
        role: 'related',
        kind: 'domain-model',
        logicalPath: 'domain-model/domain-model.json',
        content: `${JSON.stringify(domainModel, null, 2)}\n`,
      },
      ...extraInputs,
    ] satisfies ContextWorkspaceInput[],
  };
}

export function renderDomainModelSummary(model: DomainModel) {
  const entities = model.entities.length
    ? model.entities
        .map(
          (entity) =>
            `- ${entity.name}: ${entity.meaning} (${entity.fields.length} fields)`,
        )
        .join('\n')
    : '- None';
  const relationships = model.relationships.length
    ? model.relationships
        .map(
          (relationship) => `- ${relationship.label}: ${relationship.meaning}`,
        )
        .join('\n')
    : '- None';
  const constraints = model.constraints.length
    ? model.constraints.map((constraint) => `- ${constraint.text}`).join('\n')
    : '- None';
  return `# Domain Model Summary\n\nState version: ${model.stateVersion}\n\n## Entities\n\n${entities}\n\n## Relationships\n\n${relationships}\n\n## Constraints\n\n${constraints}\n`;
}
