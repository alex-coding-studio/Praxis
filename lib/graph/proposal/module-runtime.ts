export type ModuleMutationKey =
  | 'whatsNextMutations'
  | 'taskDecompositionMutations';

export type ModuleRunRegistryKey = '__praxisWhatsNextRuns' | '__praxisRuns';

type ActiveModuleRun = {
  record?: { revisionOf?: string | null; status?: string };
};

type MutationRuntime = typeof globalThis & {
  [key in ModuleMutationKey]?: Map<string, Promise<unknown>>;
};

type RunRegistryRuntime = typeof globalThis & {
  [key in ModuleRunRegistryKey]?: Map<string, unknown>;
};

const REVISION_IN_PROGRESS = ['running', 'validating'];

function moduleMutationQueue(key: ModuleMutationKey) {
  const runtime = globalThis as MutationRuntime;
  return (runtime[key] ??= new Map<string, Promise<unknown>>());
}

export async function withModuleMutation<T>(
  key: ModuleMutationKey,
  planningPath: string,
  work: () => Promise<T>,
): Promise<T> {
  const mutations = moduleMutationQueue(key);
  const previous = mutations.get(planningPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  mutations.set(planningPath, next);
  try {
    return (await next) as T;
  } finally {
    if (mutations.get(planningPath) === next) mutations.delete(planningPath);
  }
}

export function moduleRunRegistry<T>(key: ModuleRunRegistryKey) {
  const runtime = globalThis as RunRegistryRuntime;
  return (runtime[key] ??= new Map<string, unknown>()) as Map<string, T>;
}

export function revisionRunInProgress(
  key: ModuleRunRegistryKey,
  candidateId: string,
) {
  return [...moduleRunRegistry<ActiveModuleRun>(key).values()].some(
    (active) =>
      active.record?.revisionOf === candidateId &&
      REVISION_IN_PROGRESS.includes(active.record.status ?? ''),
  );
}
