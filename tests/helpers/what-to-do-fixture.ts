import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LocalAgentRunInput } from '../../lib/agents/transport.ts';
import type { RegisteredProject } from '../../lib/project-registry.ts';
import type { TaskGraphNode } from '../../lib/graph/task/model.ts';
import {
  readWhatToDoRun,
  startWhatToDoRun,
} from '../../lib/modules/delivery-planning/runs.ts';
import { readWhatToDoCurrentMap } from '../../lib/modules/delivery-planning/storage.ts';
export const featureUid = '00000000-0000-4000-8000-000000000002';

export async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'what-to-do-run-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const planningPath = path.join(rootPath, '.praxis');
  const nodeId = 'NODE-00000001';
  const nodePath = path.join(planningPath, 'whats-next/nodes', nodeId);
  await mkdir(nodePath, { recursive: true });
  await writeFile(path.join(rootPath, 'README.md'), '# Fixture\n');
  const node: TaskGraphNode = {
    schemaVersion: 1,
    id: nodeId,
    uid: featureUid,
    relations: { derivedFrom: [], dependsOn: [] },
    role: 'node',
    type: 'feature',
    title: 'Accepted Feature',
    summary: 'Accepted behavior.',
    status: 'accepted',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    resources: [
      { kind: 'output', path: `whats-next/nodes/${nodeId}/output.md` },
    ],
    derivedFrom: [],
    dependsOn: [],
    typeTemplateRef: nodeId,
    metadata: {},
    layer: 'product-design',
    artifactKind: 'feature',
  };
  await writeFile(
    path.join(nodePath, 'node.json'),
    `${JSON.stringify(node, null, 2)}\n`,
  );
  await writeFile(
    path.join(nodePath, 'output.md'),
    '# Accepted Feature\n\n## Behavior\n\nDeliver this behavior.\n',
  );
  const project: RegisteredProject = {
    id: '00000000-0000-4000-8000-000000000003',
    kind: 'repository',
    name: 'Fixture',
    description: '',
    rootPath,
    codePath: rootPath,
    planningPath,
    createdAt: '2026-09-02T00:00:00.000Z',
  };
  return { project, planningPath };
}

export function controlled() {
  const calls: Array<{
    agent: string;
    input: LocalAgentRunInput;
    resolve: (value: {
      agentSessionId: string | null;
      finalOutput: string;
      usage: null;
    }) => void;
    reject: (error: Error) => void;
    canceled: boolean;
    lateOutput: string | null;
  }> = [];
  const transport = (
    agent: 'codex' | 'claude' | 'deepseek',
    input: LocalAgentRunInput,
  ) => {
    let resolve!: (value: {
      agentSessionId: string | null;
      finalOutput: string;
      usage: null;
    }) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<{
      agentSessionId: string | null;
      finalOutput: string;
      usage: null;
    }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const call = {
      agent,
      input,
      resolve,
      reject,
      canceled: false,
      lateOutput: null as string | null,
    };
    calls.push(call);
    return {
      completion,
      cancel() {
        call.canceled = true;
        if (call.lateOutput)
          resolve({
            agentSessionId: null,
            finalOutput: call.lateOutput,
            usage: null,
          });
        else reject(new Error('canceled'));
      },
    };
  };
  return { calls, transport };
}

export function input() {
  return {
    instruction: 'Turn this accepted design into delivery boundaries.',
    sourceUids: [featureUid],
    profile: {
      agent: 'codex' as const,
      model: 'gpt-5.6-luna',
      effort: 'high' as const,
    },
  };
}

export function result(run: Awaited<ReturnType<typeof startWhatToDoRun>>) {
  const candidateId = 'CANDIDATE-0001';
  const source = run.request.sourceFeatures[0]!;
  const factsPath = 'what-to-do/repository-context/facts.json';
  return {
    schemaVersion: 1,
    harness: run.request.harness,
    request: run.request.request,
    responseMarkdown: '# Delivery Map\n\nOne Contract is ready for review.',
    repositorySummary: {
      markdown: '# Repository Summary\n\nA small fixture repository.',
      evidencePaths: [factsPath],
    },
    reviewedEvidence: [
      { path: factsPath, reason: 'Read the frozen repository facts.' },
    ],
    outcome: 'map-proposal',
    candidates: [
      {
        candidateId,
        revision: 1,
        title: 'Deliver accepted behavior',
        summary: 'One independently deliverable behavior.',
        outcome: 'The behavior is available.',
        includedScope: ['Accepted behavior'],
        excludedScope: [],
        productRules: ['Preserve the accepted behavior.'],
        domainImpact: {
          kind: 'none',
          reason: 'No Domain change is needed.',
          evidencePaths: [factsPath],
        },
        requiredExperienceStates: ['Ready', 'Error'],
        repositoryConstraints: ['Use project-owned checks.'],
        dependsOn: [],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            condition: 'The user reaches the behavior.',
            passCondition: 'The behavior works.',
            evidence: 'Focused behavior evidence.',
          },
        ],
        validationExpectations: ['Run project checks.'],
        sourceClaimIds: ['CLAIM-1'],
        openDecisions: [],
        deliveryStrategy: {
          kind: 'vertical-slice',
          reason: 'The outcome is independently usable.',
        },
      },
    ],
    sourceClaims: [
      {
        claimId: 'CLAIM-1',
        sourcePath: source.outputPath,
        sourceSha256: source.outputSha256,
        anchor: '## Behavior',
        summary: 'The accepted behavior must be delivered.',
        disposition: 'in-scope',
        contractCandidateIds: [candidateId],
        exclusionReason: null,
        exclusionAuthority: null,
      },
    ],
  };
}

export function clarificationResult(
  run: Awaited<ReturnType<typeof startWhatToDoRun>>,
) {
  const factsPath = 'what-to-do/repository-context/facts.json';
  return {
    schemaVersion: 1,
    harness: run.request.harness,
    request: run.request.request,
    responseMarkdown: 'One delivery decision needs clarification.',
    repositorySummary: {
      markdown: '# Repository Summary\n\nA small fixture repository.',
      evidencePaths: [factsPath],
    },
    reviewedEvidence: [
      { path: factsPath, reason: 'Read the frozen repository facts.' },
    ],
    outcome: 'clarification',
    clarification: {
      question: 'Which deployment target should govern delivery?',
      options: [
        {
          id: 'ios-26',
          label: 'Use iOS 26',
          effect: 'Use the current platform APIs.',
          recommended: true,
        },
        {
          id: 'ios-16',
          label: 'Use iOS 16',
          effect: 'Plan a compatibility path.',
          recommended: false,
        },
      ],
    },
  } as const;
}

export function retainedResult(
  run: Awaited<ReturnType<typeof startWhatToDoRun>>,
  map: NonNullable<Awaited<ReturnType<typeof readWhatToDoCurrentMap>>>,
) {
  const contract = map.contracts[0]!;
  const candidateId = `CANDIDATE-${contract.id.slice(5)}`;
  const claim = map.sourceClaims[0]!;
  const { contractIds: _contractIds, ...claimContent } = claim;
  const factsPath = 'what-to-do/repository-context/facts.json';
  return {
    schemaVersion: 1,
    harness: run.request.harness,
    request: run.request.request,
    responseMarkdown: '# Delivery Map\n\nThe focused Contract is retained.',
    repositorySummary: {
      markdown: '# Repository Summary\n\nA small fixture repository.',
      evidencePaths: [factsPath],
    },
    reviewedEvidence: [
      { path: factsPath, reason: 'Read the frozen repository facts.' },
    ],
    outcome: 'map-proposal',
    candidates: [],
    sourceClaims: [{ ...claimContent, contractCandidateIds: [candidateId] }],
    recomposition: {
      effects: [{ kind: 'retain', from: [candidateId], to: [candidateId] }],
    },
  };
}

export function replacementResult(
  run: Awaited<ReturnType<typeof startWhatToDoRun>>,
  map: NonNullable<Awaited<ReturnType<typeof readWhatToDoCurrentMap>>>,
  original: ReturnType<typeof result>,
) {
  const priorContract = map.contracts[0]!;
  const priorCandidateId = `CANDIDATE-${priorContract.id.slice(5)}`;
  const candidateId = 'CANDIDATE-0002';
  const { contractIds: _contractIds, ...claim } = map.sourceClaims[0]!;
  return {
    ...original,
    harness: run.request.harness,
    request: run.request.request,
    responseMarkdown: '# Delivery Map\n\nThe Contract was replaced.',
    candidates: [
      {
        ...original.candidates[0]!,
        candidateId,
        title: 'Replacement delivery boundary',
        summary: 'A newly coordinated delivery boundary.',
      },
    ],
    sourceClaims: [{ ...claim, contractCandidateIds: [candidateId] }],
    recomposition: {
      effects: [
        { kind: 'replace', from: [priorCandidateId], to: [candidateId] },
      ],
    },
  };
}

export async function settled(project: RegisteredProject, runId: string) {
  for (let index = 0; index < 100; index += 1) {
    const run = await readWhatToDoRun(project, runId);
    if (run.status !== 'running') {
      const { getActiveRun } =
        await import('../../lib/execution-observability/active-runs.ts');
      const active = getActiveRun({
        kind: 'module',
        projectId: project.id,
        planningPath: project.planningPath,
        module: 'what-to-do',
      });
      if (active?.runId === runId) await active.released;
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('What to Do Run did not settle.');
}
