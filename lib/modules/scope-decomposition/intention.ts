import {
  defineAgentGraphIntentionRegistry,
  intentionProfile,
} from '../../graph/agent/intention.ts';
import type { ScopeDecompositionResult } from './contract.ts';

export const taskDecompositionIntentionRegistry =
  defineAgentGraphIntentionRegistry({
    module: 'task-decomposition',
    defaultId: 'understanding',
    profiles: [
      {
        id: 'understanding',
        label: 'Understand the structure',
        description:
          'Form coherent sibling boundaries at a human-manageable resolution.',
        prompt: `INTENTION PROFILE — Understand the structure
Partition the current scope into coherent, sibling-distinguishable boundaries that make the whole easier to understand. Stop at a human-manageable resolution. Do not turn the result into implementation tasks or delivery steps merely because they could be executed separately.`,
      },
      {
        id: 'product-modules',
        label: 'Product modules',
        description:
          'Identify product capabilities with clear included and excluded behavior.',
        prompt: `INTENTION PROFILE — Product modules
Partition the current product scope into capability-owning modules. Every Candidate must use type module and metadata with a non-empty capability string, includes string array and excludes string array. Keep user value, behavior and product rules together; do not create implementation components or delivery tasks.`,
      },
      {
        id: 'implementation-approach',
        label: 'Implementation approach',
        description:
          'Partition technical responsibility, data flow and integration boundaries.',
        prompt: `INTENTION PROFILE — Implementation approach
Partition the current scope into technical responsibility boundaries without prescribing commits or pull requests. Every Candidate metadata must contain a non-empty responsibility string plus inputs, outputs and integrationPoints string arrays. Use dependsOn only for a real execution prerequisite.`,
      },
      {
        id: 'delivery',
        label: 'Delivery breakdown',
        description:
          'Create implementation-ready deliverables with acceptance and validation evidence.',
        prompt: `INTENTION PROFILE — Delivery breakdown
Partition the current scope into implementation-ready deliverables. Every Candidate metadata must contain a non-empty deliverable string plus non-empty acceptance and validation string arrays. Make dependencies explicit and preserve product meaning; do not split work only to increase item count.`,
      },
    ] as const,
  });

export type TaskDecompositionIntention =
  (typeof taskDecompositionIntentionRegistry.profiles)[number]['id'];

export function taskDecompositionIntentionProfile(value: unknown) {
  return intentionProfile(taskDecompositionIntentionRegistry, value);
}

export function validateTaskDecompositionIntentionResult(
  intention: TaskDecompositionIntention,
  result: ScopeDecompositionResult,
) {
  if (result.outcome !== 'proposal' || intention === 'understanding') return;
  for (const candidate of result.candidates) {
    if (intention === 'product-modules') {
      if (
        candidate.type !== 'module' ||
        !nonEmptyString(candidate.metadata.capability) ||
        !stringArray(candidate.metadata.includes) ||
        !stringArray(candidate.metadata.excludes)
      )
        throw new Error(
          'A Product modules result requires capability, includes and excludes metadata.',
        );
    }
    if (intention === 'implementation-approach') {
      if (
        !nonEmptyString(candidate.metadata.responsibility) ||
        !stringArray(candidate.metadata.inputs) ||
        !stringArray(candidate.metadata.outputs) ||
        !stringArray(candidate.metadata.integrationPoints)
      )
        throw new Error(
          'An Implementation approach result requires responsibility and integration metadata.',
        );
    }
    if (intention === 'delivery') {
      if (
        !nonEmptyString(candidate.metadata.deliverable) ||
        !nonEmptyStringArray(candidate.metadata.acceptance) ||
        !nonEmptyStringArray(candidate.metadata.validation)
      )
        throw new Error(
          'A Delivery breakdown result requires deliverable, acceptance and validation metadata.',
        );
    }
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return stringArray(value) && value.length > 0 && value.every(Boolean);
}
