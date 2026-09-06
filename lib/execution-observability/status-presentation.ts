import type { LogActor, RunPhase, SurfaceStatus } from './types.ts';

export type StatusPresentation = {
  label: string;
  icon: 'running' | 'success' | 'warning' | 'error';
  dot: string;
  border: string;
  badge: string;
  text: string;
  pulse: boolean;
};

const presentations: Record<SurfaceStatus, StatusPresentation> = {
  running: {
    label: 'Running',
    icon: 'running',
    dot: 'bg-sky-500',
    border: 'border-sky-500/55 bg-sky-500/10',
    badge: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    text: 'text-sky-700 dark:text-sky-300',
    pulse: true,
  },
  completed: {
    label: 'Completed',
    icon: 'success',
    dot: 'bg-emerald-500',
    border: 'border-emerald-500/45 bg-emerald-500/8',
    badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    text: 'text-emerald-700 dark:text-emerald-400',
    pulse: false,
  },
  warning: {
    label: 'Warning',
    icon: 'warning',
    dot: 'bg-amber-500',
    border: 'border-amber-500/55 bg-amber-500/10',
    badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    text: 'text-amber-700 dark:text-amber-300',
    pulse: false,
  },
  fail: {
    label: 'Fail',
    icon: 'error',
    dot: 'bg-destructive',
    border: 'border-destructive/55 bg-destructive/10',
    badge: 'bg-destructive/15 text-destructive',
    text: 'text-destructive',
    pulse: false,
  },
};

export function statusPresentation(status: SurfaceStatus) {
  return presentations[status];
}

const phaseLabels: Record<RunPhase, string> = {
  coordinating: 'Coordinating',
  executing: 'Executing',
  verifying: 'Verifying',
  publishing: 'Publishing',
  finalizing: 'Finalizing',
  stopping: 'Stopping',
};

export function phaseLabel(phase: RunPhase) {
  return phaseLabels[phase];
}

const actorLabels: Record<LogActor, string> = {
  HOST: 'Host',
  AGENT: 'Agent',
  COORDINATOR: 'Coordinator',
  ORCHESTRATOR: 'Orchestrator',
  WORKER: 'Worker',
  REVIEWER: 'Reviewer',
  JOB: 'Job',
};

export function actorLabel(actor: LogActor) {
  return actorLabels[actor];
}

export function formatElapsed(
  fromIso: string,
  toIso: string | null,
  now = Date.now(),
) {
  const from = Date.parse(fromIso);
  const to = toIso ? Date.parse(toIso) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '0:00';
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`;
}
