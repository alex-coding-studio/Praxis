export const LOG_LEVELS = ['INFO', 'WARN', 'ERROR'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_ACTORS = [
  'HOST',
  'AGENT',
  'COORDINATOR',
  'ORCHESTRATOR',
  'WORKER',
  'REVIEWER',
  'JOB',
] as const;
export type LogActor = (typeof LOG_ACTORS)[number];

export const LOG_PHASES = [
  'RUN',
  'PREPARE',
  'EXECUTE',
  'VERIFY',
  'PUBLISH',
  'FINALIZE',
  'STOP',
  'RECOVERY',
] as const;
export type LogPhase = (typeof LOG_PHASES)[number];

export type RunLogEntry = {
  sequence: number;
  at: string;
  level: LogLevel;
  actor: LogActor;
  phase: LogPhase;
  event: string;
  message: string;
};

export type RunLogInput = Omit<RunLogEntry, 'sequence' | 'at'> & {
  at?: string;
};
