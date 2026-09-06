import type { MaterializationModule } from '../materialization/basis.ts';
import type { ResultContract } from '../materialization/contract.ts';
import type { ResponseModule } from '../execution-observability/types.ts';
import {
  PRODUCT_EXPLORATION_MINIMAL_EXAMPLE,
  PRODUCT_EXPLORATION_RESULT_CONTRACT,
} from '../modules/product-discovery/contract.ts';
import {
  SCOPE_DECOMPOSITION_MINIMAL_EXAMPLE,
  SCOPE_DECOMPOSITION_RESULT_CONTRACT,
} from '../modules/scope-decomposition/contract.ts';
import {
  DOMAIN_MODEL_MINIMAL_EXAMPLE,
  DOMAIN_MODEL_RESULT_CONTRACT,
} from '../modules/domain-modeling/contract.ts';
import {
  DELIVERY_MAP_MINIMAL_EXAMPLE,
  DELIVERY_MAP_RESULT_CONTRACT,
} from '../modules/delivery-planning/contract.ts';

export const MCP_MODULES = [
  'product-exploration',
  'scope-decomposition',
  'domain-modeling',
  'delivery-planning',
] as const;

export type McpModule = (typeof MCP_MODULES)[number];

export type McpModuleDefinition = {
  module: McpModule;
  responseOwner: ResponseModule;
  materializationModule: MaterializationModule;
  implementationPath: string;
  layers: readonly string[];
  contract: ResultContract<unknown>;
  example: unknown;
  preparationOperations: readonly string[];
  submissionTool: string;
};

export const MCP_MODULE_DEFINITIONS: Record<McpModule, McpModuleDefinition> = {
  'product-exploration': {
    module: 'product-exploration',
    responseOwner: 'whats-next',
    materializationModule: 'whats-next',
    implementationPath: 'lib/modules/product-discovery',
    layers: ['discovery', 'product-design'],
    contract:
      PRODUCT_EXPLORATION_RESULT_CONTRACT as unknown as ResultContract<unknown>,
    example: PRODUCT_EXPLORATION_MINIMAL_EXAMPLE,
    preparationOperations: ['explore', 'refine-candidate'],
    submissionTool: 'praxis_submit_product_exploration',
  },
  'scope-decomposition': {
    module: 'scope-decomposition',
    responseOwner: 'task-decomposition',
    materializationModule: 'task-graph',
    implementationPath: 'lib/modules/scope-decomposition',
    layers: [],
    contract:
      SCOPE_DECOMPOSITION_RESULT_CONTRACT as unknown as ResultContract<unknown>,
    example: SCOPE_DECOMPOSITION_MINIMAL_EXAMPLE,
    preparationOperations: [
      'propose',
      'append-candidates',
      'revise-candidate',
      'recompose-candidates',
    ],
    submissionTool: 'praxis_submit_scope_decomposition',
  },
  'domain-modeling': {
    module: 'domain-modeling',
    responseOwner: 'domain-model',
    materializationModule: 'domain-model',
    implementationPath: 'lib/modules/domain-modeling',
    layers: [],
    contract:
      DOMAIN_MODEL_RESULT_CONTRACT as unknown as ResultContract<unknown>,
    example: DOMAIN_MODEL_MINIMAL_EXAMPLE,
    preparationOperations: ['change-model'],
    submissionTool: 'praxis_submit_domain_model',
  },
  'delivery-planning': {
    module: 'delivery-planning',
    responseOwner: 'what-to-do',
    materializationModule: 'what-to-do',
    implementationPath: 'lib/modules/delivery-planning',
    layers: [],
    contract:
      DELIVERY_MAP_RESULT_CONTRACT as unknown as ResultContract<unknown>,
    example: DELIVERY_MAP_MINIMAL_EXAMPLE,
    preparationOperations: ['create-map', 'adjust-map'],
    submissionTool: 'praxis_submit_delivery_map',
  },
};

export function isMcpModule(value: unknown): value is McpModule {
  return (
    typeof value === 'string' &&
    (MCP_MODULES as readonly string[]).includes(value)
  );
}

export function mcpModuleDefinition(module: McpModule) {
  return MCP_MODULE_DEFINITIONS[module];
}

export function mcpModuleForContract(contractId: string) {
  return (
    MCP_MODULES.map((module) => MCP_MODULE_DEFINITIONS[module]).find(
      (definition) => definition.contract.id === contractId,
    ) ?? null
  );
}
