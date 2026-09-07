import { PublicApiError } from '../api-errors.ts';
import {
  InstructionsRevisionError,
  instructionsRevision,
} from '../modules/module-instructions.ts';
import {
  readWhatsNextInstructions,
  saveWhatsNextInstructions,
} from '../modules/product-discovery/context.ts';
import {
  readTaskDecompositionContext,
  saveTaskDecompositionInstructions,
} from '../modules/scope-decomposition/context.ts';
import {
  readDomainModelInstructions,
  saveDomainModelInstructions,
} from '../modules/domain-modeling/context.ts';
import {
  readWhatToDoInstructions,
  saveWhatToDoInstructions,
} from '../modules/delivery-planning/instructions.ts';
import { requireProject } from './catalog.ts';
import { invalidArgument, resourceChanged } from './errors.ts';
import { MCP_MODULES, type McpModule } from './modules.ts';
import { instructionsUri, moduleUri } from './uri.ts';
import type { RegisteredProject } from '../project-registry.ts';

const INSTRUCTIONS = {
  'product-exploration': {
    maxLength: 20_000,
    storagePath: 'whats-next/instructions.md',
    read: readWhatsNextInstructions,
    save: saveWhatsNextInstructions,
  },
  'scope-decomposition': {
    maxLength: 100_000,
    storagePath: 'context/task-decomposition/instructions.md',
    read: async (project: RegisteredProject) =>
      (await readTaskDecompositionContext(project)).instructions,
    save: saveTaskDecompositionInstructions,
  },
  'domain-modeling': {
    maxLength: 20_000,
    storagePath: 'domain-model/instructions.md',
    read: readDomainModelInstructions,
    save: saveDomainModelInstructions,
  },
  'delivery-planning': {
    maxLength: 20_000,
    storagePath: 'what-to-do/instructions.md',
    read: readWhatToDoInstructions,
    save: saveWhatToDoInstructions,
  },
} as const satisfies Record<
  McpModule,
  {
    maxLength: number;
    storagePath: string;
    read: (project: RegisteredProject) => Promise<string>;
    save: (
      project: RegisteredProject,
      instructions: string,
      options?: { expectedRevision?: string },
    ) => Promise<unknown>;
  }
>;

export const INSTRUCTIONS_MODULES = MCP_MODULES;

export function moduleInstructionLimits(module: McpModule) {
  return {
    maxLength: INSTRUCTIONS[module].maxLength,
    storagePath: INSTRUCTIONS[module].storagePath,
  };
}

export async function readInstructions(
  project: RegisteredProject,
  module: McpModule,
) {
  const instructions = await INSTRUCTIONS[module].read(project);
  return { instructions, revision: instructionsRevision(instructions) };
}

export async function moduleInstructionsSummary(
  project: RegisteredProject,
  module: McpModule,
) {
  const { instructions, revision } = await readInstructions(project, module);
  return {
    revision,
    length: instructions.length,
    ...moduleInstructionLimits(module),
    uri: instructionsUri(project.id, module),
    updateTool: 'praxis_update_instructions' as const,
  };
}

export async function updateInstructions(input: {
  projectId: string;
  module: McpModule;
  instructions: string;
  expectedRevision: string;
}) {
  const project = await requireProject(input.projectId);
  const definition = INSTRUCTIONS[input.module];
  if (input.instructions.length > definition.maxLength)
    throw invalidArgument(
      `${input.module} Instructions are at most ${definition.maxLength} characters; received ${input.instructions.length}.`,
    );
  try {
    await definition.save(project, input.instructions, {
      expectedRevision: input.expectedRevision,
    });
  } catch (error) {
    if (error instanceof InstructionsRevisionError)
      throw resourceChanged(
        `${error.message} The Instructions were not changed.`,
      );
    if (error instanceof PublicApiError) throw invalidArgument(error.message);
    throw error;
  }
  const current = await readInstructions(project, input.module);
  return {
    projectId: project.id,
    module: input.module,
    revision: current.revision,
    length: current.instructions.length,
    cleared: current.instructions.length === 0,
    ...moduleInstructionLimits(input.module),
    instructionsUri: instructionsUri(project.id, input.module),
    moduleUri: moduleUri(project.id, input.module),
  };
}
