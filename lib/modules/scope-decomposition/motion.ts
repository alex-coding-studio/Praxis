import {
  defineAgentGraphMotionRegistry,
  motionProfile,
} from '../../graph/agent/motion.ts';
import type { ScopeDecompositionResult } from './contract.ts';

export const taskDecompositionMotionRegistry = defineAgentGraphMotionRegistry({
  module: 'task-decomposition',
  defaultId: 'unspecified',
  profiles: [
    {
      id: 'unspecified',
      label: 'Unspecified',
      description: 'Follow the clear boundaries in the current User Input.',
      prompt: `MOTION — Unspecified
Return exactly as many supported boundaries as the current purpose and evidence require. Do not manufacture alternatives or collapse distinct concerns to satisfy a count.`,
    },
    {
      id: 'diverge',
      label: 'Diverge',
      description: 'Expose materially different ways to partition this scope.',
      prompt: `MOTION — Diverge
Return at least two materially different sibling boundaries or partition alternatives. Do not manufacture near-duplicates.`,
    },
    {
      id: 'converge',
      label: 'Converge',
      description: 'Combine the selected meaning into one coherent boundary.',
      prompt: `MOTION — Converge
Return exactly one coherent Candidate. Preserve every material contribution and surface unresolved conflicts rather than silently dropping them.`,
    },
  ] as const,
});

export type TaskDecompositionMotion =
  (typeof taskDecompositionMotionRegistry.profiles)[number]['id'];

export function taskDecompositionMotionProfile(value: unknown) {
  return motionProfile(taskDecompositionMotionRegistry, value);
}

export function validateTaskDecompositionMotionResult(
  motion: TaskDecompositionMotion,
  result: ScopeDecompositionResult,
  outputCount = result.outcome === 'proposal' ? result.candidates.length : 0,
) {
  if (result.outcome !== 'proposal') return;
  if (motion === 'diverge' && outputCount < 2)
    throw new Error('Diverge requires at least two Candidate boundaries.');
  if (motion === 'converge' && outputCount !== 1)
    throw new Error('Converge requires exactly one Candidate boundary.');
}
