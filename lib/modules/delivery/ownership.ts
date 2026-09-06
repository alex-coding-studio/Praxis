import path from 'node:path';
import { PublicApiError } from '../../api-errors.ts';
import type { RegisteredProject } from '../../project-registry.ts';

const runtime = globalThis as typeof globalThis & {
  deliveryTargetOwners?: Set<string>;
};
const owners = (runtime.deliveryTargetOwners ??= new Set());

export function claimDeliveryTarget(project: RegisteredProject, uid: string) {
  const key = `${path.resolve(project.planningPath)}:${uid}`;
  if (owners.has(key))
    throw new PublicApiError('This delivery is already running.', 409);
  owners.add(key);
  return () => {
    owners.delete(key);
  };
}

export function deliveryTargetBusy(project: RegisteredProject, uid: string) {
  return owners.has(`${path.resolve(project.planningPath)}:${uid}`);
}
