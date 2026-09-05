import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { latestActionGitHub } from '../lib/modules/implementation/result-display.ts';
import type { ActionRun } from '../lib/modules/implementation/execution-types.ts';
import type { LatestResponseDocument } from '../lib/execution-observability/types.ts';

const { ExecutionHeaderStatus } =
  await import('../components/execution-sticky-header.tsx');
const { UiLanguageProvider } =
  await import('../components/ui-language-provider.tsx');

void test('a new modification round keeps only its own Action PR until a newer publication exists', () => {
  const previous = { pullRequests: [{ number: 3 }] };
  const newer = { pullRequests: [{ number: 3, headRefOid: 'new-head' }] };
  const runs = [
    { actionId: 'one', github: { pullRequests: [{ number: 2 }] } },
    { actionId: 'two', github: previous },
    { actionId: 'two', status: 'running', github: null },
  ] as unknown as ActionRun[];
  assert.equal(latestActionGitHub(runs, 'two'), previous);
  assert.equal(latestActionGitHub(runs, 'three'), undefined);
  runs.push({
    actionId: 'two',
    status: 'failed',
    github: { pullRequests: [] },
  } as unknown as ActionRun);
  assert.equal(latestActionGitHub(runs, 'two'), previous);
  runs.push({ actionId: 'two', github: newer } as unknown as ActionRun);
  assert.equal(latestActionGitHub(runs, 'two'), newer);
});

function document(
  overrides: Partial<LatestResponseDocument> = {},
): LatestResponseDocument {
  return {
    schemaVersion: 1,
    owner: { kind: 'card', cardId: 'card-1' },
    projectId: 'project-1',
    runId: 'run-1',
    revision: 1,
    status: 'running',
    phase: 'verifying',
    actor: 'WORKER',
    title: 'Running',
    detail: 'Running LocusKit unit tests',
    subject: { kind: 'action', label: 'Action 1/2 · Add the token store' },
    supplementaryWarnings: [],
    recovery: ['log'],
    startedAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:30.000Z',
    endedAt: null,
    logRef: 'implementation/cards/card-1/logs/run-1.log',
    logUrlPath: '/projects/project-1/logs/implementation/card-1/run-1',
    hostPid: 1,
    recentActivity: [
      {
        sequence: 4,
        at: '2026-09-04T00:00:20.000Z',
        level: 'INFO',
        actor: 'JOB',
        phase: 'VERIFY',
        event: 'job.started',
        message: 'LocusKit unit tests — swift test',
      },
    ],
    ...overrides,
  };
}

const pullRequest = {
  url: 'https://github.com/org/repo/pull/2',
  number: 2,
  title: 'Token store',
  state: 'OPEN' as const,
  isDraft: false,
  headRefOid: 'abc',
  headRefName: 'praxis/card',
  mergedAt: null,
};

function render(props: Parameters<typeof ExecutionHeaderStatus>[0]) {
  return renderToStaticMarkup(
    createElement(
      UiLanguageProvider,
      { language: 'en' } as never,
      createElement(ExecutionHeaderStatus, props),
    ),
  );
}

void test('the running header shows Action, status, actor, phase, elapsed time, one activity line, checks, PR and Log on the left', () => {
  const html = render({
    document: document(),
    actionIndex: 0,
    actionTotal: 2,
    actionTitle: 'Add the token store',
    checks: { passed: 1, total: 3 },
    pullRequests: [pullRequest as never],
    staleGithub: false,
    accepted: false,
  });
  assert.match(html, /data-execution-header="left"[^>]*data-status="running"/);
  assert.match(html, /Action 1\/2/);
  assert.match(html, /Add the token store/);
  assert.match(html, />Running</);
  assert.match(html, /Worker · Verifying · \d+:\d{2}/);
  assert.match(html, /LocusKit unit tests — swift test/);
  assert.match(html, /Required checks · 1\/3/);
  assert.match(html, /href="https:\/\/github\.com\/org\/repo\/pull\/2"/);
  assert.match(
    html,
    /href="\/projects\/project-1\/logs\/implementation\/card-1\/run-1"[^>]*>Log<\/a>/,
  );
  assert.doesNotMatch(html, /Plan finalized/);
});

void test('terminal headers show the dynamic title, detail, non-blocking count and Accepted', () => {
  const warning = render({
    document: document({
      status: 'warning',
      phase: undefined,
      actor: undefined,
      title: 'Deployment target needs confirmation',
      detail:
        'project.yml declares iOS 26.0 while the configuration declares iOS 26.1.',
      endedAt: '2026-09-04T00:03:40.000Z',
    }),
    actionIndex: 1,
    actionTotal: 2,
    actionTitle: 'Publish',
    checks: null,
    pullRequests: [],
    staleGithub: false,
    accepted: false,
  });
  assert.match(warning, /data-status="warning"/);
  assert.match(warning, /Deployment target needs confirmation/);
  assert.match(warning, /iOS 26\.1/);
  assert.match(warning, /3:40/);
  const accepted = render({
    document: document({
      status: 'completed',
      title: 'Delivered',
      detail: 'PR #2 is ready.',
      endedAt: '2026-09-04T00:01:00.000Z',
      supplementaryWarnings: ['Unused import'],
    }),
    actionIndex: 0,
    actionTotal: 1,
    actionTitle: 'Add the token store',
    checks: { passed: 2, total: 2 },
    pullRequests: [],
    staleGithub: false,
    accepted: true,
  });
  assert.match(accepted, />Accepted</);
  assert.match(accepted, /1 additional findings/);
  const waiting = render({
    document: null,
    actionIndex: 0,
    actionTotal: 1,
    actionTitle: 'Add the token store',
    checks: null,
    pullRequests: [],
    staleGithub: false,
    accepted: false,
  });
  assert.match(waiting, /Ready to start/);
  assert.doesNotMatch(waiting, />Log</);
});

void test('the workspace header no longer says Plan finalized and keeps Cancel with the right-side controls', async () => {
  const workspace = await readFile(
    new URL('../components/just-do-it-live-workspace.tsx', import.meta.url),
    'utf8',
  );
  const sentinel = workspace.indexOf('ref={attachPlanHeaderSentinel}');
  const header = workspace.slice(
    sentinel,
    workspace.indexOf('</header>', sentinel),
  );
  assert.doesNotMatch(header, /'Plan finalized'/);
  assert.match(
    header,
    /planHeaderStuck \? 'rounded-b-xl border-t-0' : 'rounded-xl'/,
  );
  assert.match(header, /ref=\{setActionHeaderStatusTarget\}/);
  assert.match(header, /ref=\{setActionHeaderTarget\}/);
  assert.match(workspace, /data-running-marker="true"/);
  const action = await readFile(
    new URL('../components/just-do-it-action.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(action, /<AgentGraphRunningCard/);
  const rightPortal = action.slice(
    action.indexOf('{headerActionsTarget'),
    action.indexOf('{headerStatusTarget'),
  );
  assert.match(rightPortal, /setStopPreview\(/);
  assert.doesNotMatch(rightPortal, /PullRequestChip/);
  const leftPortal = action.slice(action.indexOf('{headerStatusTarget'));
  assert.match(leftPortal, /<ExecutionHeaderStatus/);
  assert.match(leftPortal, /pullRequests=\{headerPullRequests\}/);
  assert.match(
    action,
    /const actionDocument =\s*latestResponse\.document\?\.actionId === action\.id\s*\? latestResponse\.document\s*: null;/,
  );
  assert.match(leftPortal, /actionDocument \?\?\s*runDocument\(/);
  assert.match(rightPortal, /latest\?\.result &&\s*requiredPassed \? \(/);
  assert.match(
    action,
    /<AgentGraphComposerCard\s+className="fixed z-30[^"]*"\s+running=\{latest\?\.status === 'running' \|\| running\}/,
  );
});
