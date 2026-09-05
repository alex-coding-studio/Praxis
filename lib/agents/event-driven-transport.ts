import path from 'node:path';
import type { AgentProfile } from './profile.ts';
import {
  codexSkillConfig,
  readCodexSkills,
  withSkillCatalog,
  type SkillCatalog,
} from './skills.ts';
import {
  startLocalAgentRun,
  type LocalAgentKind,
  type LocalAgentRun,
  type LocalAgentRunInput,
} from './transport.ts';
import { CodexAppServerDriver } from './codex/app-server-driver.ts';
import { ClaudeSessionDriver } from './claude/session-driver.ts';
import { DeepseekSessionDriver } from './deepseek/session-driver.ts';
import { HostJobBroker } from './host-job-broker.ts';
import { runCandidatePublicationScript } from './candidate-publication.ts';
import type {
  AgentRuntimeThreadInput,
  AgentSessionDriver,
  HostTool,
} from './runtime-driver.ts';

export type CoordinatorSessionInput = {
  profile: AgentProfile;
  workingDirectory: string;
  protectedPath?: string;
  hostTools: HostTool[];
  skillCatalog?: SkillCatalog;
};
export type CoordinatorSession = {
  driver: AgentSessionDriver;
  decoratePrompt: (prompt: string) => string;
};

const candidatePublicationInstructions =
  '\n\nCandidate publication tool: call publish_candidate once with a title and body to deliver the current Action changes. One Host script owns allowed-file inspection, pending commit creation, bot identity selection and restoration, repository initialization, Action-scoped branch push, and PR creation or update. Treat it as a black box. Do not run GitHub account, permission, push, PR creation or PR lookup commands yourself. Set ready=true only after the required gates passed, including explicitly reused valid evidence. A later round in the same Action calls the same tool to update that Action PR.';

export function codexWorkerAppServerArguments(
  catalog: SkillCatalog,
  allowedSkillPaths?: string[],
) {
  return [
    'app-server',
    '-c',
    codexSkillConfig(catalog, allowedSkillPaths),
    '--stdio',
  ];
}

export async function startPushCoordinatorSession(
  input: CoordinatorSessionInput,
): Promise<CoordinatorSession | null> {
  const recordRoot = path.join(
    input.protectedPath ?? input.workingDirectory,
    'runtime/jobs',
  );
  if (input.profile.agent === 'claude')
    return {
      driver: new ClaudeSessionDriver({
        brokerFactory: (thread) =>
          new HostJobBroker(thread.workingDirectory, recordRoot),
        hostTools: input.hostTools,
      }),
      decoratePrompt: (prompt) => prompt,
    };
  if (input.profile.agent !== 'codex') return null;
  const catalog =
    input.skillCatalog ?? (await readCodexSkills(input.workingDirectory));
  if (catalog.executionAccess !== 'full-access') return null;
  return {
    driver: new CodexAppServerDriver({
      brokerFactory: (thread) =>
        new HostJobBroker(thread.workingDirectory, recordRoot),
      hostTools: input.hostTools,
    }),
    decoratePrompt: (prompt) => withSkillCatalog(prompt, catalog),
  };
}

export async function openWorkerThread(
  driver: AgentSessionDriver,
  resumeSessionId: string | undefined,
  threadInput: AgentRuntimeThreadInput,
) {
  if (!resumeSessionId) return driver.startThread(threadInput);
  try {
    return await driver.resumeThread({
      provider: driver.provider,
      threadId: resumeSessionId,
      ...threadInput,
    });
  } catch {
    return driver.startThread(threadInput);
  }
}

export function startEventDrivenWorkerRun(
  agent: LocalAgentKind,
  input: LocalAgentRunInput,
): LocalAgentRun {
  if (input.access !== 'workspace-write')
    return startLocalAgentRun(agent, input);
  if (agent === 'deepseek') return startDeepseekWorkerRun(input);
  if (agent === 'claude') return startClaudeWorkerRun(input);
  let canceled = false;
  let driver: CodexAppServerDriver | undefined;
  let interrupt: (() => void) | undefined;
  let fallback: LocalAgentRun | undefined;
  const completion = (async () => {
    const catalog = await readCodexSkills(input.workingDirectory);
    if (canceled) throw new Error('Execution canceled before Agent startup.');
    if (catalog.executionAccess !== 'full-access') {
      fallback = startLocalAgentRun(agent, {
        ...input,
        resumeSessionId: undefined,
      });
      if (canceled) fallback.cancel();
      return await fallback.completion;
    }
    const recordRoot = path.join(
      input.protectedPath ?? input.workingDirectory,
      'runtime/jobs',
    );
    driver = new CodexAppServerDriver({
      arguments: codexWorkerAppServerArguments(
        catalog,
        input.allowedSkillPaths,
      ),
      brokerFactory: (thread) =>
        new HostJobBroker(
          thread.workingDirectory,
          recordRoot,
          (event) =>
            input.onActivity?.({
              kind: 'tool',
              phase: event.status === 'running' ? 'started' : 'completed',
              summary:
                event.status === 'running'
                  ? `Running job: ${event.label}`
                  : `Finished: ${event.command} (exit ${event.exitCode ?? 'none'})`,
              job: {
                jobId: event.jobId,
                label: event.label,
                command: event.command,
                status: event.status,
                exitCode: event.exitCode,
                logRef: event.logRef,
              },
            }),
          (progress) =>
            input.onActivity?.({
              kind: 'tool',
              phase: 'started',
              summary: `Running job: ${progress.label} — ${progress.outputTail}`,
            }),
        ),
      hostTools: input.candidatePublication
        ? [candidatePublicationTool(input.candidatePublication)]
        : [],
    });
    const profile: AgentProfile = {
      agent: 'codex' as const,
      model: input.model ?? '',
      effort: input.effort ?? '',
    };
    const thread = await openWorkerThread(driver, input.resumeSessionId, {
      profile,
      workingDirectory: input.workingDirectory,
      access: 'full-access',
    });
    const permissionContext =
      '\n\nExecution permissions: Full Access, selected in local Codex settings. There is no OS filesystem sandbox protecting the primary checkout or planning store. You must still work only in the Card worktree, preserve host-owned records, and follow the explicit PR and acceptance boundaries. Full Access is not authorization for unrelated actions.';
    const hostToolContext =
      '\n\nHost job tool: use run_job for builds, tests and other commands that may run longer than a quick inspection. The Host owns waiting, progress, logs and cancellation. Starting a job ends the current physical turn; Praxis will create a continuation turn in this same thread only when the operating-system process exits. Never call wait or write_stdin and never start an overlapping replacement. Short read-only commands and file edits may use normal tools.';
    const candidateToolContext = input.candidatePublication
      ? candidatePublicationInstructions
      : '';
    const turn = driver.startTurn(thread, {
      prompt:
        withSkillCatalog(input.prompt, catalog, input.allowedSkillPaths) +
        permissionContext +
        hostToolContext +
        candidateToolContext,
      onEvent: (event) => {
        if (event.type === 'activity')
          input.onActivity?.({ kind: 'message', summary: event.summary });
      },
    });
    interrupt = turn.interrupt;
    if (canceled) turn.interrupt();
    try {
      const result = await turn.completion;
      return {
        agentSessionId: result.threadId,
        finalOutput: result.finalOutput,
        usage: result.usage,
        executionAccess: catalog.executionAccess,
      };
    } finally {
      await driver.close();
    }
  })();
  return {
    completion,
    cancel: () => {
      canceled = true;
      fallback?.cancel();
      interrupt?.();
      void driver?.close();
    },
  };
}

function stringArgument(value: unknown) {
  if (typeof value !== 'string')
    throw new Error('Candidate publication arguments must be strings.');
  return value;
}

function candidatePublicationTool(
  publication: NonNullable<LocalAgentRunInput['candidatePublication']>,
): HostTool {
  return {
    name: 'publish_candidate',
    description:
      'Deliver the current Card changes through one script. It checks allowed files, commits pending changes, creates a private repository if needed, pushes and creates or updates the PR. Use ready=true only with successful required validation evidence.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'body'],
      properties: {
        baseSha: { type: 'string' },
        headSha: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        ready: { type: 'boolean' },
      },
    },
    call: (arguments_) =>
      runCandidatePublicationScript({
        environment: publication.environment,
        actionId: publication.actionId,
        roundId: publication.roundId,
        baseSha: publication.environment.workspace.baseCommit,
        headSha: publication.environment.workspace.headSha,
        title: stringArgument(arguments_.title),
        body: stringArgument(arguments_.body),
        draft: arguments_.ready !== true,
      }),
  };
}

function startClaudeWorkerRun(input: LocalAgentRunInput): LocalAgentRun {
  let canceled = false;
  let interrupt: (() => void) | undefined;
  const recordRoot = path.join(
    input.protectedPath ?? input.workingDirectory,
    'runtime/jobs',
  );
  const driver = new ClaudeSessionDriver({
    brokerFactory: (thread) =>
      new HostJobBroker(
        thread.workingDirectory,
        recordRoot,
        (event) =>
          input.onActivity?.({
            kind: 'tool',
            phase: event.status === 'running' ? 'started' : 'completed',
            summary:
              event.status === 'running'
                ? `Running job: ${event.label}`
                : `Finished: ${event.command} (exit ${event.exitCode ?? 'none'})`,
            job: {
              jobId: event.jobId,
              label: event.label,
              command: event.command,
              status: event.status,
              exitCode: event.exitCode,
              logRef: event.logRef,
            },
          }),
        (progress) =>
          input.onActivity?.({
            kind: 'tool',
            phase: 'started',
            summary: `Running job: ${progress.label} — ${progress.outputTail}`,
          }),
      ),
    hostTools: input.candidatePublication
      ? [candidatePublicationTool(input.candidatePublication)]
      : [],
  });
  const completion = (async () => {
    if (canceled) throw new Error('Execution canceled before Agent startup.');
    const thread = await openWorkerThread(driver, input.resumeSessionId, {
      profile: {
        agent: 'claude',
        model: input.model ?? '',
        effort: input.effort ?? '',
      },
      workingDirectory: input.workingDirectory,
      access: 'workspace-write',
    });
    const hostToolContext =
      '\n\nHost job tool: use the praxis run_job tool for builds, tests and other commands that may run longer than a quick inspection. The Host owns waiting, progress, logs and cancellation. After starting a job, end this turn immediately with one short line; Praxis resumes this same session with the result when the operating-system process exits. Never poll for it with shell commands and never start an overlapping job. Short read-only commands and file edits may use normal tools.';
    const candidateToolContext = input.candidatePublication
      ? candidatePublicationInstructions
      : '';
    const turn = driver.startTurn(thread, {
      prompt: input.prompt + hostToolContext + candidateToolContext,
      onEvent: (event) => {
        if (event.type === 'activity')
          input.onActivity?.({ kind: 'message', summary: event.summary });
      },
    });
    interrupt = turn.interrupt;
    if (canceled) turn.interrupt();
    try {
      const result = await turn.completion;
      return {
        agentSessionId: result.threadId,
        finalOutput: result.finalOutput,
        usage: result.usage,
        executionAccess: 'workspace-write' as const,
      };
    } finally {
      await driver.close();
    }
  })();
  return {
    completion,
    cancel: () => {
      canceled = true;
      interrupt?.();
      void driver.close();
    },
  };
}

function startDeepseekWorkerRun(input: LocalAgentRunInput): LocalAgentRun {
  let canceled = false;
  let interrupt: (() => void) | undefined;
  const recordRoot = path.join(
    input.protectedPath ?? input.workingDirectory,
    'runtime/jobs',
  );
  const driver = new DeepseekSessionDriver({
    brokerFactory: (thread) =>
      new HostJobBroker(
        thread.workingDirectory,
        recordRoot,
        (event) =>
          input.onActivity?.({
            kind: 'tool',
            phase: event.status === 'running' ? 'started' : 'completed',
            summary:
              event.status === 'running'
                ? `Running job: ${event.label}`
                : `Finished: ${event.command} (exit ${event.exitCode ?? 'none'})`,
            job: {
              jobId: event.jobId,
              label: event.label,
              command: event.command,
              status: event.status,
              exitCode: event.exitCode,
              logRef: event.logRef,
            },
          }),
        (progress) =>
          input.onActivity?.({
            kind: 'tool',
            phase: 'started',
            summary: `Running job: ${progress.label} — ${progress.outputTail}`,
          }),
      ),
    hostTools: input.candidatePublication
      ? [candidatePublicationTool(input.candidatePublication)]
      : [],
  });
  const completion = (async () => {
    if (canceled) throw new Error('Execution canceled before Agent startup.');
    const thread = await openWorkerThread(driver, input.resumeSessionId, {
      profile: {
        agent: 'deepseek',
        model: input.model ?? '',
        effort: input.effort ?? '',
      },
      workingDirectory: input.workingDirectory,
      access: 'workspace-write',
    });
    const hostToolContext =
      '\n\nHost job tool: use the run_job tool for builds, tests and other commands that may run longer than a quick inspection. The Host owns waiting, progress, logs and cancellation. After starting a job, end this turn immediately with one short line; Praxis resumes this same session with the result when the operating-system process exits. Never poll for it with shell commands and never start an overlapping job. Short read-only commands and file edits may use normal tools.';
    const candidateToolContext = input.candidatePublication
      ? candidatePublicationInstructions
      : '';
    const turn = driver.startTurn(thread, {
      prompt: input.prompt + hostToolContext + candidateToolContext,
      onEvent: (event) => {
        if (event.type === 'activity')
          input.onActivity?.({ kind: 'message', summary: event.summary });
      },
    });
    interrupt = turn.interrupt;
    if (canceled) turn.interrupt();
    try {
      const result = await turn.completion;
      return {
        agentSessionId: result.threadId,
        finalOutput: result.finalOutput,
        usage: result.usage,
        executionAccess: 'workspace-write' as const,
      };
    } finally {
      await driver.close();
    }
  })();
  return {
    completion,
    cancel: () => {
      canceled = true;
      interrupt?.();
      void driver.close();
    },
  };
}
