import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { UiLanguageProvider } from '../components/ui-language-provider.tsx';
import {
  CANVAS_NODE_CARD_MIN_HEIGHT,
  canvasNodeCardMinHeight,
} from '../lib/graph/canvas-node-card-metrics.ts';
import { TASK_GRAPH_NODE_MIN_HEIGHT } from '../lib/graph/card-metrics.ts';

const { CanvasNodeCardFrame } =
  await import('../components/canvas-node-card-frame.tsx');

type FrameProps = Parameters<typeof CanvasNodeCardFrame>[0];

function render(props: FrameProps) {
  return renderToStaticMarkup(createElement(CanvasNodeCardFrame, props));
}

function control(
  label: string,
  extra: Record<string, unknown> = {},
): ReactNode {
  return createElement('button', {
    type: 'button',
    'aria-label': label,
    ...extra,
  });
}

void test('standard density keeps the Task Graph layout height', () => {
  assert.equal(
    canvasNodeCardMinHeight('standard'),
    TASK_GRAPH_NODE_MIN_HEIGHT,
    'the layout adapter and the Frame must agree on standard height',
  );
});

void test('compact density is shorter than standard and stays in the agreed range', () => {
  const compact = canvasNodeCardMinHeight('compact');
  assert.ok(compact < CANVAS_NODE_CARD_MIN_HEIGHT.standard);
  assert.ok(compact >= 96 && compact <= 112, `compact height was ${compact}`);
});

void test('only standard and compact densities exist', () => {
  assert.deepEqual(Object.keys(CANVAS_NODE_CARD_MIN_HEIGHT).sort(), [
    'compact',
    'standard',
  ]);
});

void test('both densities render one card of the shared width', () => {
  for (const density of ['standard', 'compact'] as const) {
    const html = render({ title: 'Item', density });
    assert.match(html, /data-canvas-node-card/);
    assert.match(html, new RegExp(`data-density="${density}"`));
    assert.match(html, /class="[^"]*\bw-72\b/);
    assert.match(
      html,
      new RegExp(`min-height:${canvasNodeCardMinHeight(density)}px`),
    );
  }
});

void test('a compact card with short content reserves no standard height', () => {
  const compact = render({
    title: 'Item',
    summary: 'A physical thing the user records.',
    density: 'compact',
  });
  assert.match(compact, /min-height:104px/);
  assert.doesNotMatch(compact, /min-height:160px/);
});

void test('selection, focus, details, status and footer are independent', () => {
  const base: FrameProps = { title: 'Item' };
  const selectionOnly = render({
    ...base,
    selected: true,
    selectionControl: control('Select Item'),
  });
  assert.match(selectionOnly, /Select Item/);
  assert.match(selectionOnly, /ring-2 ring-foreground\/35/);
  assert.doesNotMatch(selectionOnly, /ring-3 ring-ring\/20/);
  assert.doesNotMatch(selectionOnly, /Open details/);

  const focusOnly = render({ ...base, focused: true });
  assert.match(focusOnly, /ring-3 ring-ring\/20/);
  assert.doesNotMatch(focusOnly, /ring-2 ring-foreground\/35/);

  const detailsOnly = render({
    ...base,
    detailsControl: control('Open details for Item'),
  });
  assert.match(detailsOnly, /Open details for Item/);
  assert.doesNotMatch(detailsOnly, /aria-pressed/);

  const statusOnly = render({ ...base, status: 'Waiting' });
  assert.match(statusOnly, /Waiting/);

  const footerOnly = render({ ...base, footer: 'In 1 · Out 1' });
  assert.match(footerOnly, /In 1 · Out 1/);

  const bare = render(base);
  for (const absent of ['Select Item', 'Open details', 'Waiting', 'In 1'])
    assert.ok(!bare.includes(absent), `${absent} should not render`);
});

void test('a selected card keeps its selection ring while also focused', () => {
  const html = render({ title: 'Item', focused: true, selected: true });
  const classes = /class="([^"]*)"/.exec(html)?.[1] ?? '';
  const rings = classes.split(' ').filter((name) => name.startsWith('ring'));
  assert.deepEqual(rings, ['ring-2', 'ring-foreground/35']);
});

void test('a card without a title area still renders every provided slot once', () => {
  const html = render({
    title: 'Item',
    selectionControl: control('Select Item'),
    kindLabel: 'Entity',
    headerActions: control('Show direct dependencies for Item'),
    detailsControl: control('Open details for Item'),
    summary: 'One line of meaning.',
    footer: 'Rev 2',
    edgeAction: control('Decompose from Item'),
  });
  for (const fragment of [
    'aria-label="Select Item"',
    'Entity',
    'aria-label="Show direct dependencies for Item"',
    'aria-label="Open details for Item"',
    'One line of meaning.',
    'Rev 2',
    'aria-label="Decompose from Item"',
  ])
    assert.equal(
      html.split(fragment).length - 1,
      1,
      `${fragment} should appear exactly once`,
    );
});

void test('accessible names come from the slotted controls, not the Frame', () => {
  const html = render({
    title: 'Item',
    selectionControl: control('Select Item', { 'aria-pressed': 'false' }),
    detailsControl: control('Open details for Item'),
  });
  assert.match(html, /aria-label="Select Item"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /aria-label="Open details for Item"/);
  assert.doesNotMatch(html, /<div[^>]*aria-label/);
});

void test('a busy card is announced and uses the accent border', () => {
  const busy = render({ title: 'Item', busy: true, accentColor: '#ff0000' });
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /border-color:#ff0000/);
  assert.match(busy, /border-width:2px/);

  const idle = render({ title: 'Item', accentColor: '#ff0000' });
  assert.doesNotMatch(idle, /aria-busy="true"/);
  assert.match(idle, /border-top-color:var\(--foreground\)/);
});

void test('a provisional card is visually distinct and keeps its accent', () => {
  const html = render({
    title: 'Item',
    appearance: 'provisional',
    accentColor: '#00aa00',
  });
  assert.match(html, /border-dashed/);
  assert.match(html, /bg-secondary\/35/);
  assert.match(html, /border-top-color:#00aa00/);
});

void test('a dimmed card reads as de-emphasised without losing its content', () => {
  const html = render({ title: 'Item', dimmed: true, summary: 'Still here.' });
  assert.match(html, /opacity-40/);
  assert.match(html, /Still here./);
});

void test('an explicitly empty summary keeps its slot so height does not jump', () => {
  const empty = render({ title: 'Item', summary: '' });
  const absent = render({ title: 'Item' });
  assert.match(empty, /class="mt-1"/);
  assert.doesNotMatch(absent, /class="mt-1"/);
});

void test('the shared Frame requires no Task Graph data', async () => {
  const source = await readFile(
    new URL('../components/canvas-node-card-frame.tsx', import.meta.url),
    'utf8',
  );
  for (const forbidden of [
    'task-graph',
    'TaskGraph',
    'graph-identity',
    'graph-card-metrics',
    'inputCount',
    'outputCount',
    'relationshipCount',
    'revision',
    'candidate',
    'formal',
  ])
    assert.ok(
      !source.includes(forbidden),
      `the Frame must not reference ${forbidden}`,
    );

  const props = render({ title: 'Item', density: 'compact' });
  assert.match(props, /Item/);
});

void test('GraphNodeCard adapts the shared Frame instead of duplicating the shell', async () => {
  const source = await readFile(
    new URL('../components/graph-node-card.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /import \{ CanvasNodeCardFrame \}/);
  assert.match(source, /<CanvasNodeCardFrame/);
  assert.match(source, /CircleEllipsis/);
  assert.doesNotMatch(source, /\bInfo\b/);
  for (const shellFragment of [
    'rounded-2xl border border-t-[3px]',
    'shadow-[0_10px_30px_rgb(15_23_42/6%)]',
    'flex w-72 flex-col',
  ])
    assert.ok(
      !source.includes(shellFragment),
      `the adapter must not re-declare ${shellFragment}`,
    );
});

const CARD_SCENARIOS: Array<[string, Record<string, unknown>, boolean]> = [
  ['formal selectable unselected', { selectionEnabled: true }, false],
  [
    'formal selectable selected',
    { selectionEnabled: true, selectedForRun: true },
    false,
  ],
  ['formal focused', {}, true],
  [
    'formal with dependencies',
    { relationshipCount: 3, dependenciesFocused: true },
    false,
  ],
  ['formal with revision footer', { revision: 4 }, false],
  ['formal read-only', { readOnly: true }, false],
  ['preview candidate', { kind: 'preview', transientKind: 'candidate' }, false],
  [
    'preview run',
    {
      kind: 'preview',
      transientKind: 'run',
      runId: 'RUN-1',
      agentLabel: 'Codex',
    },
    false,
  ],
  [
    'preview run without a summary',
    {
      kind: 'preview',
      transientKind: 'run',
      description: undefined,
    },
    false,
  ],
  ['preview plain', { kind: 'preview' }, false],
];

const CARD_BASE = {
  displayId: 'NODE-abcdef12',
  kind: 'formal' as const,
  title: 'A representative product direction',
  type: 'direction',
  inputCount: 2,
  outputCount: 1,
  color: '#4f46e5',
  description: 'A bounded summary of what this card means.',
  relationshipCount: 0,
  onFocusDependencies: () => {},
  onDecompose: () => {},
  onToggleSelection: () => {},
  onInspect: () => {},
  onCancelRun: () => {},
};

void test('every Task Graph card scenario still renders its full shell through the Frame', async () => {
  const { GraphNodeCard } = await import('../components/graph-node-card.tsx');
  for (const [label, overrides, focused] of CARD_SCENARIOS) {
    const data = { ...CARD_BASE, ...overrides };
    const html = renderToStaticMarkup(
      createElement(
        UiLanguageProvider as never,
        { initialLanguage: 'en' } as never,
        createElement(
          GraphNodeCard as never,
          {
            data,
            selected: focused,
          } as never,
        ),
      ),
    );
    assert.match(html, /data-canvas-node-card/, label);
    assert.match(html, /data-density="standard"/, label);
    assert.match(html, /min-height:160px/, label);
    assert.match(html, /A representative product direction/, label);
    assert.match(
      html,
      overrides.kind === 'preview' && overrides.transientKind === 'run'
        ? /Updated 0:00 ago/
        : /In 2 · Out 1|Rev 4 · In 2 · Out 1/,
      label,
    );
  }
});

void test('a running card without a summary keeps the summary slot so height is stable', async () => {
  const { GraphNodeCard } = await import('../components/graph-node-card.tsx');
  const render = (description?: string) =>
    renderToStaticMarkup(
      createElement(
        UiLanguageProvider as never,
        { initialLanguage: 'en' } as never,
        createElement(
          GraphNodeCard as never,
          {
            data: {
              ...CARD_BASE,
              description,
              kind: 'preview',
              transientKind: 'run',
            },
          } as never,
        ),
      ),
    );
  assert.match(render(undefined), /class="mt-1"><p class="line-clamp-3/);
  assert.match(render('Present.'), /class="mt-1"><p class="line-clamp-3/);
});

void test('the shared proposal workspace renders counts and named metadata sections', async () => {
  const { CandidateMetadataSections, ProposalWorkspaceStatus } =
    await import('../components/agent-graph-proposal-workspace.tsx');
  const html = renderToStaticMarkup(
    createElement(
      UiLanguageProvider as never,
      { language: 'zh-CN' } as never,
      createElement(
        'div',
        null,
        createElement(ProposalWorkspaceStatus, {
          formalCount: 1,
          candidateCount: 9,
          activeProposalCount: 9,
          onFocusProposal: () => {},
        }),
        createElement(CandidateMetadataSections, {
          metadata: {
            keyRules: ['Keep one boundary.', 'Preserve accepted meaning.'],
          },
        }),
      ),
    ),
  );
  assert.match(html, /1.*正式节点/);
  assert.match(html, /9.*当前候选/);
  assert.match(html, /aria-label="聚焦当前提案"/);
  assert.match(html, /关键规则/);
  assert.doesNotMatch(html, /<pre/);
});

void test('Latest Response exposes the standard Response, Summary and Log actions', async () => {
  const { LatestResponse, LatestResponseActions } =
    await import('../components/latest-response.tsx');
  const html = renderToStaticMarkup(
    createElement(
      LatestResponse,
      {
        title: 'Latest Response',
        statusLabel: 'No change',
        summary: 'The current proposal already covers this boundary.',
        tone: 'completed',
        attention: 'none',
        icon: 'success',
      },
      createElement(LatestResponseActions, {
        responseLabel: 'Response',
        summaryLabel: 'Summary',
        logLabel: 'Log',
        onOpenResponse: () => {},
        onOpenSummary: () => {},
        onOpenLog: () => {},
      }),
    ),
  );
  assert.match(html, />Response</);
  assert.match(html, />Summary</);
  assert.match(html, />Log</);
  assert.doesNotMatch(html, /aria-expanded="/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);

  for (const file of [
    'whats-next-workspace.tsx',
    'task-decomposition-workspace.tsx',
    'domain-model-workspace.tsx',
    'what-to-do-workspace.tsx',
  ]) {
    const source = await readFile(
      new URL(`../components/${file}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /LatestResponseActions/, file);
  }
});

void test('Latest Response renders clarification options with their effects', async () => {
  const { LatestResponse, LatestResponseOptions } =
    await import('../components/latest-response.tsx');
  const html = renderToStaticMarkup(
    createElement(
      LatestResponse,
      {
        title: 'Latest Response',
        statusLabel: 'Answer needed',
        summary: 'Choose one persistence strategy.',
        tone: 'warning',
        attention: 'action-required',
        icon: 'warning',
      },
      createElement(LatestResponseOptions, {
        options: [
          {
            id: 'keep-ios-16',
            label: 'Keep iOS 16',
            effect: 'Use one compatible persistence path.',
            recommended: true,
          },
          {
            id: 'raise-ios-17',
            label: 'Raise to iOS 17',
            effect: 'Use SwiftData as the persistence foundation.',
            recommended: false,
          },
        ],
        recommendedLabel: 'Recommended',
        selectedId: 'keep-ios-16',
        onSelect: () => {},
      }),
    ),
  );
  assert.match(html, /Keep iOS 16/);
  assert.match(html, /Use one compatible persistence path/);
  assert.match(html, /Recommended/);
  assert.match(html, /Raise to iOS 17/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-pressed="false"/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
});

void test('Delivery Planning restores clarification Context independently of option selection', async () => {
  const source = await readFile(
    new URL('../components/what-to-do-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /initialTerminal\?\.result\?\.outcome === 'clarification'/,
  );
  assert.match(source, /initialClarification\?\.sourceUids/);
  assert.match(source, /setSourceUids\(nextTerminal\.sourceUids\)/);
  assert.match(source, /setProfile\(nextTerminal\.profile\)/);
  assert.match(source, /body\.set\('clarificationRunId', latestTerminal\.id\)/);
  assert.match(
    source,
    /Choose an option or write your own answer in the Composer/,
  );
  const selectOptionStart = source.indexOf(
    'function selectClarificationOption',
  );
  const selectOption = source.slice(
    selectOptionStart,
    source.indexOf('\n  }\n', selectOptionStart),
  );
  assert.doesNotMatch(selectOption, /setSourceUids|setProfile|startRun/);
});

void test('Delivery Planning always renders its hard dependency DAG', async () => {
  const workspace = await readFile(
    new URL('../components/what-to-do-workspace.tsx', import.meta.url),
    'utf8',
  );
  const canvas = await readFile(
    new URL('../components/task-graph-canvas.tsx', import.meta.url),
    'utf8',
  );
  assert.match(workspace, /showAllDependencies/);
  assert.match(workspace, /showLineageLegend=\{false\}/);
  assert.match(
    canvas,
    /edge\.relation !== 'dependency' \|\|\s*showAllDependencies/,
  );
  assert.match(canvas, /showAllDependencies \? 'Hard dependencies'/);
});

void test('Domain Modeling separates the current answer, compact summary and change log', async () => {
  const source = await readFile(
    new URL('../components/domain-model-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /renderDomainModelResponse\(run, model, t\)/);
  assert.match(source, /renderDomainModelSummary\(run, model, t\)/);
  assert.match(source, /<LatestResponseCard/);
  assert.doesNotMatch(source, /renderDomainModelLog/);
  const relationshipInspector = source.slice(
    source.indexOf(') : relationship ? ('),
    source.indexOf(
      '</InspectorSection>',
      source.indexOf(') : relationship ? ('),
    ),
  );
  assert.match(
    relationshipInspector,
    /relationshipCardinalityLabel\(relationship\)/,
  );
  assert.doesNotMatch(relationshipInspector, /sourceCardinality\} →/);
  assert.doesNotMatch(relationshipInspector, /semanticRole/);
  assert.doesNotMatch(relationshipInspector, /provenance/);
});

void test('Product Design picker Cards keep rendered content inside their layout height', async () => {
  const source = await readFile(
    new URL('../components/product-design-feature-picker.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /const height = 112/);
  assert.match(source, /flex min-h-0 flex-1 items-start gap-2 overflow-hidden/);
  assert.match(source, /max-h-8 overflow-hidden/);
  assert.match(source, /flex h-full w-full flex-col overflow-hidden/);
});

void test('Delivery Planning replaces the full Composer while its Agent is running', async () => {
  const source = await readFile(
    new URL('../components/what-to-do-workspace.tsx', import.meta.url),
    'utf8',
  );
  const transition = source.slice(
    source.indexOf('<LatestResponseCard'),
    source.indexOf('<ProductDesignFeaturePicker'),
  );
  assert.doesNotMatch(source, /<AgentGraphRunningCard/);
  assert.match(transition, /onCancel=\{\(\) => void cancelRun\(\)\}/);
  assert.match(
    transition,
    /<AgentGraphComposerCard\s+running=\{moduleResponse\.running \|\| Boolean\(running\)\}/,
  );
  assert.match(transition, /<Textarea/);
  assert.doesNotMatch(source, /function buildPreviews/);
  assert.match(source, /previews=\{\[\]\}/);
});

void test('Graph and Flow modules run inside Latest Response while Just Do It still shares the running card', async () => {
  const { latestReadableAgentActivity } =
    await import('../components/agent-graph-running-card.tsx');
  assert.equal(
    latestReadableAgentActivity(
      [
        { summary: 'Preparing the request.' },
        { summary: 'The accepted context is ready.' },
        { summary: 'Running: sed -n 1,240p input.md' },
        { summary: 'Finished: sed -n 1,240p input.md (exit 0)' },
      ],
      'Fallback',
    ),
    'The accepted context is ready.',
  );
  const planningRunningCard = await readFile(
    new URL('../components/agent-graph-running-card.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(planningRunningCard, /AgentGraphComposerCard/);
  assert.match(planningRunningCard, /data-planning-run-header="true"/);
  assert.match(planningRunningCard, /\{agent\} is running/);
  assert.match(planningRunningCard, /latestReadableAgentActivity/);
  assert.match(planningRunningCard, /line-clamp-4 overflow-hidden/);
  assert.doesNotMatch(planningRunningCard, /overflow-y-auto/);
  assert.match(planningRunningCard, /<Square/);
  for (const file of [
    'whats-next-workspace.tsx',
    'task-decomposition-workspace.tsx',
    'domain-model-workspace.tsx',
    'what-to-do-workspace.tsx',
  ]) {
    const source = await readFile(
      new URL(`../components/${file}`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /<AgentGraphRunningCard/, file);
    assert.match(source, /<LatestResponseCard/, file);
    assert.match(source, /running=\{moduleResponse\.running/, file);
    assert.match(source, /useSurfacePreference\(/, file);
  }
  for (const file of [
    'whats-next-workspace.tsx',
    'task-decomposition-workspace.tsx',
  ]) {
    const source = await readFile(
      new URL(`../components/${file}`, import.meta.url),
      'utf8',
    );
    assert.match(
      source,
      /<\/AgentGraphComposerCard>\s*\) : moduleResponse\.running \? \(\s*<AgentGraphComposerCard title="" running \/>\s*\) : null\}/,
      file,
    );
    assert.equal(
      (source.match(/moduleResponse\.running \? \(/g) ?? []).length,
      1,
      file,
    );
  }
  const justDoIt = await readFile(
    new URL('../components/just-do-it-live-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.match(justDoIt, /<AgentGraphRunningCard/);
  assert.match(justDoIt, /<AgentGraphRunningCard[\s\S]*?'sticky top-0 z-30/);
  assert.match(
    justDoIt,
    /<AgentGraphComposerCard\s+className="fixed z-30 m-0!"\s+title=""\s+running/,
  );
});

void test('terminal What’s Next outcomes leave the Canvas and stay in Latest Response', async () => {
  const { whatsNextRunToPreviews } =
    await import('../lib/modules/product-discovery/previews.ts');
  for (const status of ['no-change', 'clarification', 'failed'] as const) {
    assert.deepEqual(
      whatsNextRunToPreviews({
        runId: 'RUN-11111111-1111-4111-8111-111111111111',
        requestId: 'REQUEST-11111111-1111-4111-8111-111111111111',
        sessionId: 'SESSION-11111111-1111-4111-8111-111111111111',
        schemaVersion: 1,
        status,
        operation: 'explore',
        intention: 'product-design-completion',
        motion: 'converge',
        sourceNodeIds: ['NODE-11111111'],
        startedAt: '2026-09-03T00:00:00.000Z',
        updatedAt: '2026-09-03T00:00:01.000Z',
        endedAt: '2026-09-03T00:00:01.000Z',
        transport: 'codex-cli',
        agentSessionMode: 'persistent',
        agentSessionId: null,
        profile: { agent: 'codex', model: '', effort: '' },
        harness: { id: 'praxis.whats-next', revision: 8 },
        inputFingerprint: '0'.repeat(64),
        input: {
          userInputPath: 'input/user-input.md',
          moduleInstructionsState: 'cleared',
          resourcePaths: [],
          feedbackAnchors: [],
          requestArtifact: 'request.json',
          intention: 'product-design-completion',
          motion: 'converge',
        },
        activity: [],
        usage: null,
        result: null,
        error: status === 'failed' ? 'Failed.' : null,
      }),
      [],
    );
  }
});

void test('every primary module uses one compact Project Header structure', async () => {
  const { ProjectModuleHeader } =
    await import('../components/project-module-header.tsx');
  const html = renderToStaticMarkup(
    createElement(ProjectModuleHeader, {
      title: 'What’s Next',
      description: 'Explore the next supported product direction.',
      actions: createElement('button', { type: 'button' }, 'Context'),
    }),
  );
  assert.match(html, /min-h-16/);
  assert.match(html, /What’s Next/);
  assert.match(html, /Explore the next supported product direction/);
  assert.match(html, /Context/);

  for (const file of [
    'whats-next-context-toolbar.tsx',
    'task-decomposition-workspace.tsx',
    'domain-model-workspace.tsx',
    'just-do-it-live-workspace.tsx',
  ]) {
    const source = await readFile(
      new URL(`../components/${file}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /ProjectModuleHeader/, file);
  }
  const justDoIt = await readFile(
    new URL('../components/just-do-it-live-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(justDoIt, /Open preview/);
  assert.match(justDoIt, /<ModuleContextTrigger/);
  const contextTrigger = await readFile(
    new URL('../components/module-context-trigger.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    contextTrigger,
    /buttonVariants\(\{ variant: 'outline', size: 'sm' \}\)/,
  );
  assert.match(contextTrigger, /<span>\{t\('Context'\)\}<\/span>/);
  const instructionsDialog = await readFile(
    new URL('../components/module-instructions-dialog.tsx', import.meta.url),
    'utf8',
  );
  assert.match(instructionsDialog, /<ModuleContextTrigger/);
  const decomposition = await readFile(
    new URL('../components/task-decomposition-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.match(decomposition, /<ModuleContextTrigger/);
  const delivery = await readFile(
    new URL('../components/what-to-do-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.match(delivery, /what-to-do-context/);
});

void test('Product Context is a system-managed read-only catalog', async () => {
  const workspace = await readFile(
    new URL('../components/product-context-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.match(workspace, /Product Context is empty/);
  assert.doesNotMatch(workspace, /context\/initialize/);
  assert.doesNotMatch(workspace, /Create context structure/);
  assert.doesNotMatch(workspace, /context\/documents/);
  assert.doesNotMatch(workspace, /context\/sections/);
  assert.doesNotMatch(workspace, /Import Markdown/);
});

void test('every Agent Graph module adopts the standard Composer and attachment input', async () => {
  for (const file of [
    'whats-next-workspace.tsx',
    'task-decomposition-workspace.tsx',
    'domain-model-workspace.tsx',
  ]) {
    const source = await readFile(
      new URL(`../components/${file}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /AgentGraphComposerCard/, file);
    assert.match(source, /ContextAttachmentPicker/, file);
    assert.doesNotMatch(source, /maxLength=\{(?:1_000|4_000)\}/, file);
    assert.doesNotMatch(source, /\/4,000 characters/, file);
  }
  const decomposition = await readFile(
    new URL('../components/task-decomposition-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    decomposition,
    /avoidBottomRightPanel=\{[\s\S]*decomposeSource !== null[\s\S]*recomposeCandidateIds\.length > 0/,
  );
  assert.match(decomposition, /selectableKinds=\{\['candidate'\]\}/);
  const whatsNext = await readFile(
    new URL('../components/whats-next-workspace.tsx', import.meta.url),
    'utf8',
  );
  const emptyStateSubmission = whatsNext.slice(
    whatsNext.indexOf('async function beginFromIdea()'),
    whatsNext.indexOf('async function submitGrow()'),
  );
  assert.match(
    emptyStateSubmission,
    /setActiveLayer\(intentionDestination\(intention\)\.layer\)/,
  );
  const selectedCardSubmission = whatsNext.slice(
    whatsNext.indexOf('async function submitCombine()'),
    whatsNext.indexOf('function toggleSelection'),
  );
  assert.match(selectedCardSubmission, /contextRefs: combineRefs/);
  assert.match(selectedCardSubmission, /files: combineFiles/);
  assert.match(whatsNext, /contextRefs: input\.contextRefs \?\? \[\]/);
  assert.match(whatsNext, /files: input\.files \?\? \[\]/);
  assert.match(whatsNext, /setCombineRefs\(snapshot\.contextRefs\)/);
  assert.match(whatsNext, /setCombineFiles\(snapshot\.files\)/);
  assert.match(
    whatsNext,
    /!hasCombineDraft\(combineDraftRef\.current\)[\s\S]*restoreRunSnapshot\(snapshot\)/,
  );
  const selectedCardComposer = whatsNext.slice(
    whatsNext.indexOf('{combineIds.length >= 1 ? ('),
    whatsNext.indexOf(
      '<Dialog',
      whatsNext.indexOf('{combineIds.length >= 1 ? ('),
    ),
  );
  assert.match(selectedCardComposer, /extraInfo=\{/);
  assert.match(selectedCardComposer, /refs=\{combineRefs\}/);
  assert.match(selectedCardComposer, /files=\{combineFiles\}/);
  assert.doesNotMatch(selectedCardComposer, /Clear the selection/);
});

void test('the standard Agent Composer owns one collapsible panel control', async () => {
  const { AgentGraphComposerCard } =
    await import('../components/agent-graph-composer-card.tsx');
  const html = renderToStaticMarkup(
    createElement(
      AgentGraphComposerCard,
      { title: 'Prepare a Delivery Map', description: 'Describe the update.' },
      createElement('textarea', { defaultValue: 'Keep this input.' }),
    ),
  );
  assert.match(html, /aria-label="Collapse input panel"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Keep this input/);
  const source = await readFile(
    new URL('../components/agent-graph-composer-card.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /aria-label=\{collapsedLabel \?\? t\('Expand input panel'\)\}/,
  );
  assert.match(source, /<Sparkles/);
  assert.match(source, /setCollapsed\(false\)/);
});

void test('the shared Agent profile is one caption button beside the action', async () => {
  const { AgentProfileSelector, preferredEffort } =
    await import('../components/agent-profile-selector.tsx');
  assert.equal(
    preferredEffort({
      id: 'reasoning-model',
      name: 'Reasoning model',
      description: '',
      efforts: ['medium', 'high'],
    }),
    'medium',
  );
  assert.equal(
    preferredEffort({
      id: 'plain-model',
      name: 'Plain model',
      description: '',
      efforts: [],
    }),
    '',
  );
  const html = renderToStaticMarkup(
    createElement(
      UiLanguageProvider as never,
      { language: 'en' },
      createElement(AgentProfileSelector, {
        value: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
        onChange: () => {},
        mode: 'demo',
      }),
    ),
  );
  assert.match(html, /Codex/);
  assert.match(html, /gpt-5\.6-sol/);
  assert.match(html, /high/);
  assert.match(html, /aria-haspopup="dialog"/);
  const selector = await readFile(
    new URL('../components/agent-profile-selector.tsx', import.meta.url),
    'utf8',
  );
  assert.match(selector, /grid-cols-\[108px_minmax\(0,1fr\)\]/);
  assert.match(selector, /type="range"/);
  assert.match(selector, /effortOptions\.map/);
  assert.match(selector, /h-4 .*rounded-full bg-secondary/);
  assert.match(selector, /rounded-l-full/);
  assert.match(selector, /className="absolute right-0"/);
  assert.match(selector, /catalogPromises/);
  assert.match(selector, /!value\.model && !manual/);
  assert.match(selector, /effortOptions\.length > 0/);
  assert.match(selector, /manual[\s\S]*Custom model…/);
  assert.doesNotMatch(selector, /\{t\('Default'\)\}/);
  const controls = await readFile(
    new URL('../components/agent-run-controls.tsx', import.meta.url),
    'utf8',
  );
  assert.match(controls, /flex items-stretch justify-between gap-2/);
  assert.match(controls, /ml-auto flex items-stretch gap-2/);
  assert.match(controls, /size-8 shrink-0/);
  assert.match(controls, /<SendHorizontal/);
  assert.match(controls, /<Plus/);
  assert.match(controls, /<PopoverContent[\s\S]*align="start"/);
  assert.match(controls, /aria-label=\{t\(extraInfoLabel\)\}/);
  assert.match(controls, /disabled=\{disabled \|\| !value\.model\}/);
  const runningCard = await readFile(
    new URL('../components/agent-graph-running-card.tsx', import.meta.url),
    'utf8',
  );
  assert.match(runningCard, /disabled=\{cancelDisabled\}/);
  const justDoIt = await readFile(
    new URL('../components/just-do-it-live-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.match(justDoIt, /cancelDisabled=\{pending\}/);
});

void test('the standard Composer Shell keeps input above its toolbar', async () => {
  const { contextAttachmentTitle } =
    await import('../components/context-attachment-picker.tsx');
  assert.equal(
    contextAttachmentTitle(
      [
        {
          path: 'product-design',
          name: 'product-design',
          title: 'Product Design',
          entries: [
            {
              kind: 'file',
              path: 'product-design/002-output.md',
              name: '002-output.md',
              title: 'Layered location records',
            },
          ],
        },
      ],
      'product-design/002-output.md',
    ),
    'Layered location records',
  );
  const shell = await readFile(
    new URL('../components/agent-composer-shell.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(shell.indexOf('{children}') < shell.indexOf('{controls}'));
  for (const file of [
    'whats-next-workspace.tsx',
    'task-decomposition-workspace.tsx',
    'what-to-do-workspace.tsx',
    'domain-model-workspace.tsx',
  ]) {
    const source = await readFile(
      new URL(`../components/${file}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /<AgentComposerShell/, file);
    assert.match(source, /<ContextAttachmentPicker\s+embedded/, file);
    assert.match(source, /<AgentComposerAttachments/, file);
  }
});

void test('Just Do It separates the Task coordinator from the Action Composer', async () => {
  const workspace = await readFile(
    new URL('../components/just-do-it-live-workspace.tsx', import.meta.url),
    'utf8',
  );
  assert.match(workspace, /coordinationProfile: PlanningProfile/);
  assert.match(workspace, /value=\{draft!\.coordinationProfile\}/);
  assert.match(workspace, /label="Coordination profile"/);
  assert.match(workspace, /coordinatorProfile=\{draft!\.coordinationProfile\}/);
  assert.match(workspace, /lg:pr-5 lg:pl-8/);
  assert.match(workspace, /searchParams\.get\('card'\)/);
  assert.match(workspace, /searchParams\.get\('action'\)/);
  assert.match(workspace, /params\.set\('card', cardId\)/);
  assert.match(workspace, /params\.set\('action', actionId\)/);
  assert.match(workspace, /router\.replace/);
  assert.match(workspace, /sticky top-0 z-30/);
  assert.match(workspace, /planHeaderStuck/);
  assert.match(workspace, /rounded-b-xl border-t-0/);
  assert.match(workspace, /rounded-xl/);
  assert.match(workspace, /ref=\{setActionHeaderTarget\}/);
  assert.match(workspace, /ref=\{setActionHeaderStatusTarget\}/);
  assert.match(workspace, /headerActionsTarget=\{actionHeaderTarget\}/);
  assert.match(workspace, /headerStatusTarget=\{actionHeaderStatusTarget\}/);
  assert.match(workspace, /onClick=\{\(\) => command\('reopen'\)\}/);
  assert.doesNotMatch(
    workspace,
    /Plan and acceptance criteria are locked after confirmation/,
  );
  assert.match(workspace, /folders=\{view\.folders\}/);
  assert.doesNotMatch(workspace, /Last run usage/);

  const action = await readFile(
    new URL('../components/just-do-it-action.tsx', import.meta.url),
    'utf8',
  );
  assert.match(action, /<AgentGraphComposerCard/);
  assert.match(action, /<AgentComposerShell/);
  assert.match(action, /<AgentRunControls/);
  assert.match(action, /<ContextAttachmentPicker/);
  assert.match(action, /<AgentComposerAttachments/);
  assert.match(action, /contextRefs/);
  assert.match(action, /files: await Promise\.all/);
  assert.match(action, /label="Execution profile"/);
  assert.doesNotMatch(action, /<AgentGraphRunningCard/);
  assert.match(action, /<ExecutionHeaderStatus/);
  assert.match(action, /coordination: \{ profile: coordinatorProfile \}/);
  assert.match(action, /createPortal/);
  assert.match(action, /\{t\('Roll back'\)\}/);
  assert.match(action, /\{t\('Undo'\)\}/);
  assert.match(action, /\{t\('Pass'\)\}/);
  const rollbackVisibility = action.slice(
    action.indexOf('const canReturnToPlanning'),
    action.indexOf('async function send'),
  );
  assert.doesNotMatch(rollbackVisibility, /status/);
  assert.match(action, /disabled=\{pending \|\| running\}/);
  assert.ok(action.indexOf("{t('Roll back')}") < action.indexOf("{t('Pass')}"));
  assert.ok(action.indexOf("{t('Undo')}") < action.indexOf("{t('Pass')}"));
  assert.match(action, /headerStatusTarget/);
  assert.match(action, /\{t\(currentStatus\)\}/);
  const floatingComposer = action.slice(
    action.indexOf('title={t(currentStatus)}'),
    action.indexOf(
      '</AgentGraphComposerCard>',
      action.indexOf('title={t(currentStatus)}'),
    ),
  );
  assert.doesNotMatch(floatingComposer, /Accept this output/);
  assert.doesNotMatch(floatingComposer, /Required checks/);
  assert.doesNotMatch(action, /data-action-controls/);
  assert.doesNotMatch(action, /setCoordinatorProfile/);
});

void test('Latest Response Markdown uses one standard reader shell and close control', async () => {
  const dialog = await readFile(
    new URL('../components/markdown-reader-dialog.tsx', import.meta.url),
    'utf8',
  );
  assert.match(dialog, /showCloseButton=\{false\}/);
  assert.match(dialog, /bg-transparent p-0 ring-0/);
  assert.match(dialog, /<MarkdownReader/);
  assert.match(dialog, /onClose=\{onClose\}/);
  for (const file of [
    'whats-next-workspace.tsx',
    'task-decomposition-workspace.tsx',
    'domain-model-workspace.tsx',
    'what-to-do-workspace.tsx',
  ]) {
    const source = await readFile(
      new URL(`../components/${file}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /<MarkdownReaderDialog/, file);
  }
});
