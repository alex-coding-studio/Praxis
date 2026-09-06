'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type NodeProps,
  type Node,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, ArrowUp, Check, Settings, Square } from 'lucide-react';
import { AgentGraphComposerCard } from '@/components/agent-graph-composer-card';
import { AgentComposerShell } from '@/components/agent-composer-shell';
import { AgentProfileSelector } from '@/components/agent-profile-selector';
import { Button } from '@/components/ui/button';
import { useUiText } from '@/components/ui-language-provider';
import type {
  DeliveryModels,
  ExecutableTarget,
  DeliverySourceKind,
} from '@/lib/modules/delivery/types';
import {
  deliveryCandidateReady,
  type DeliveryRecord,
} from '@/lib/modules/delivery/record';
import { cn } from '@/lib/utils';

type Workspace = {
  models: DeliveryModels | null;
  targets: ExecutableTarget[];
  records: DeliveryRecord[];
  instructions: string;
};
const layers: Array<{ id: DeliverySourceKind; label: string }> = [
  { id: 'mvp', label: 'MVP' },
  { id: 'task', label: 'Scope Decomposition' },
  { id: 'delivery-contract', label: 'Delivery Contracts' },
];
const labels: Record<string, string> = {
  waiting: 'Waiting for prerequisites',
  ready: 'Ready to deliver',
  briefing: 'Preparing delivery brief',
  'ready-to-run': 'Ready to start',
  running: 'Running',
  reviewing: 'In review',
  'waiting-for-user': 'Waiting for feedback',
  warning: 'Warning',
  failed: 'Failed',
  completed: 'Completed',
};

function TargetNode({ data }: NodeProps<Node<{ target: ExecutableTarget }>>) {
  const { t } = useUiText();
  const target = data.target;
  return (
    <div className="h-full rounded-2xl border border-border bg-card p-4 shadow-sm">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="text-[11px] text-muted-foreground">
        {t(layers.find((layer) => layer.id === target.sourceKind)!.label)}
      </div>
      <div className="mt-2 line-clamp-2 text-sm font-medium">
        {target.title}
      </div>
      <div
        className={cn(
          'mt-4 text-xs',
          target.status === 'completed'
            ? 'text-emerald-600'
            : ['running', 'reviewing', 'briefing'].includes(target.status)
              ? 'text-sky-500'
              : target.status === 'failed'
                ? 'text-red-500'
                : 'text-muted-foreground',
        )}
      >
        {t(labels[target.status])}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
const nodeTypes = { target: TargetNode };

export function DeliveryWorkspace({
  projectId,
  initialWorkspace,
}: {
  projectId: string;
  initialWorkspace: Workspace;
}) {
  const { t } = useUiText();
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [layer, setLayer] = useState<DeliverySourceKind>('mvp');
  const [uid, setUid] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [settings, setSettings] = useState(false);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [models, setModels] = useState<DeliveryModels>(
    initialWorkspace.models ?? {
      orchestrator: { agent: 'codex', model: '', effort: '' },
      workers: [],
      reviewers: [],
    },
  );
  const [tick, setTick] = useState<number | null>(null);
  const target = workspace.targets.find((entry) => entry.sourceUid === uid);
  const record = workspace.records.find((entry) => entry.sourceUid === uid);
  const run = record?.runs.at(-1);
  const running = run?.status === 'running';
  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/delivery`, {
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    setWorkspace(result);
  }, [projectId]);
  useEffect(() => {
    const timer = setInterval(
      () => void load().catch((failure) => setError(String(failure))),
      3000,
    );
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!scrollRoot || !sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setStuck(
          Boolean(
            entry?.rootBounds &&
            sentinel.isConnected &&
            entry.boundingClientRect.bottom <= entry.rootBounds.top,
          ),
        );
      },
      { root: scrollRoot, threshold: 1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollRoot, sentinel]);
  async function command(action: string, extra: Record<string, unknown> = {}) {
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/delivery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          uid,
          expectedRevision: record?.revision,
          ...extra,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setWorkspace(result);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setPending(false);
    }
  }
  const graph = useMemo(() => {
    const visible = workspace.targets.filter(
      (entry) => entry.sourceKind === layer,
    );
    const ids = new Set(visible.map((entry) => entry.sourceUid));
    const edges = visible.flatMap((entry) =>
      entry.dependsOn
        .filter((id) => ids.has(id))
        .map((source) => ({
          id: `${source}:${entry.sourceUid}`,
          source,
          target: entry.sourceUid,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: '#c58a36' },
        })),
    );
    const layout = new dagre.graphlib.Graph();
    layout.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 36 });
    layout.setDefaultEdgeLabel(() => ({}));
    for (const entry of visible)
      layout.setNode(entry.sourceUid, { width: 250, height: 145 });
    for (const edge of edges) layout.setEdge(edge.source, edge.target);
    dagre.layout(layout);
    return {
      edges,
      nodes: visible.map((entry) => ({
        id: entry.sourceUid,
        type: 'target',
        position: {
          x: layout.node(entry.sourceUid).x - 125,
          y: layout.node(entry.sourceUid).y - 72.5,
        },
        style: { width: 250, height: 145 },
        data: { target: entry },
      })),
    };
  }, [workspace.targets, layer]);
  const elapsed = run
    ? Math.max(
        0,
        Math.floor(
          ((run.endedAt
            ? Date.parse(run.endedAt)
            : (tick ?? Date.parse(run.startedAt))) -
            Date.parse(run.startedAt)) /
            1000,
        ),
      )
    : 0;
  return (
    <main className="relative flex h-dvh min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border p-5">
        <div className="flex min-w-0 items-center gap-3">
          {uid && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setUid(null)}
              aria-label={t('Back')}
            >
              <ArrowLeft />
            </Button>
          )}
          <h1 className="truncate text-xl font-semibold">
            {target?.title ?? t('Development Delivery')}
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setInstructions(workspace.instructions);
            if (record) setModels(record.models);
            setSettings(!settings);
          }}
        >
          <Settings className="size-4" />
          {t('Settings')}
        </Button>
      </header>
      {!uid ? (
        <>
          <nav className="flex gap-2 border-b border-border px-5 py-3">
            {layers.map((item) => (
              <Button
                key={item.id}
                variant={layer === item.id ? 'secondary' : 'ghost'}
                onClick={() => setLayer(item.id)}
              >
                {t(item.label)}
              </Button>
            ))}
          </nav>
          <div className="relative min-h-0 flex-1">
            <ReactFlow
              key={layer}
              nodes={graph.nodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              onNodeClick={(_, node) => {
                setUid(node.id);
                setInput('');
              }}
              fitView
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
            {!graph.nodes.length && (
              <p className="absolute left-5 top-5 text-sm text-muted-foreground">
                {t('Accepted executable targets appear here automatically.')}
              </p>
            )}
          </div>
        </>
      ) : target ? (
        <div
          ref={setScrollRoot}
          className="relative min-h-0 flex-1 overflow-y-auto p-5 pb-64"
        >
          <div ref={setSentinel} aria-hidden="true" className="h-px" />
          <header
            className={cn(
              'sticky top-0 z-20 flex flex-wrap items-start justify-between gap-4 border border-border bg-background/95 p-4 shadow-sm backdrop-blur',
              stuck ? 'rounded-b-xl border-t-0' : 'rounded-xl',
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium">
                  {t(labels[target.status])}
                </span>
                {run && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {Math.floor(elapsed / 60)}:
                    {String(elapsed % 60).padStart(2, '0')}
                  </span>
                )}
              </div>
              {record?.response && (
                <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
                  {record.response.detail}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {run && (
                  <a
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-6 items-center rounded-md border px-2 text-[11px]"
                    href={`/projects/${projectId}/delivery/${uid}/logs/${run.id}`}
                  >
                    {t('Log')}
                  </a>
                )}
                {record?.workspace && (
                  <span className="text-xs text-muted-foreground">
                    {record.workspace.path}
                  </span>
                )}
                {record?.publication && (
                  <a
                    href={record.publication.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-6 items-center rounded-md border px-2 text-[11px]"
                  >
                    #{record.publication.number} ·{' '}
                    {record.publication.draft
                      ? 'Draft'
                      : record.publication.state}
                  </a>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <AgentProfileSelector
                value={record?.models.orchestrator ?? models.orchestrator}
                onChange={(profile) => {
                  if (record)
                    void command('models', {
                      models: { ...record.models, orchestrator: profile },
                    });
                  else setModels({ ...models, orchestrator: profile });
                }}
                disabled={running}
                showStatus={false}
                triggerClassName="h-8"
              />
              {running ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void command('cancel')}
                >
                  <Square className="size-3" />
                  {t('Cancel')}
                </Button>
              ) : (
                record?.brief &&
                !record.brief.confirmedAt && (
                  <Button
                    disabled={
                      pending || Boolean(record.brief.openDecisions.length)
                    }
                    onClick={() => void command('confirm-brief')}
                  >
                    <Check />
                    {t('Confirm delivery brief')}
                  </Button>
                )
              )}
            </div>
          </header>
          <details className="my-5 text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              {t('Source')}
            </summary>
            <p className="mt-3 whitespace-pre-wrap">{target.summary}</p>
          </details>
          {!running && record?.publication && record.status !== 'completed' && (
            <Button
              disabled={
                pending ||
                !deliveryCandidateReady(record, record.publication.head)
              }
              onClick={() => {
                if (
                  window.confirm(
                    t('Accept this delivery and merge its pull request?'),
                  )
                )
                  void command('accept');
              }}
            >
              {t('Accept and merge')}
            </Button>
          )}
          {record?.brief && (
            <section className="mb-5 rounded-2xl border border-border p-5">
              <h2 className="text-lg font-semibold">{t('Delivery brief')}</h2>
              <p className="mt-3 whitespace-pre-wrap">{record.brief.outcome}</p>
              <ul className="mt-4 list-inside list-disc space-y-2 text-sm">
                {record.brief.criteria.map((criterion) => (
                  <li key={criterion.id}>{criterion.description}</li>
                ))}
              </ul>
              {record.brief.openDecisions.map((decision) => (
                <p className="mt-2 text-amber-600" key={decision}>
                  {decision}
                </p>
              ))}
            </section>
          )}
          {record?.progress.length ? (
            <ol className="mb-5 space-y-2 rounded-2xl border p-5">
              {record.progress.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    'text-sm',
                    item.status === 'running' && 'text-sky-500',
                    item.status === 'completed' && 'text-emerald-600',
                  )}
                >
                  {item.title} · {t(item.status)}
                </li>
              ))}
            </ol>
          ) : null}
          <div className="space-y-4">
            {record?.messages.map((message) => (
              <article
                key={message.id}
                className="rounded-2xl border border-border p-4"
              >
                <span className="text-xs text-muted-foreground">
                  {message.actor}
                </span>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                  {message.content}
                </p>
              </article>
            ))}
          </div>
        </div>
      ) : (
        <p className="p-5">{t('Target is no longer available.')}</p>
      )}
      {error && (
        <div
          role="alert"
          className="absolute left-5 top-20 z-40 max-w-lg rounded-xl border border-red-500 bg-background p-4 text-sm text-red-600"
        >
          {error}
        </div>
      )}
      {settings && (
        <section className="absolute right-5 top-20 z-40 max-h-[75vh] w-[min(440px,90%)] space-y-4 overflow-y-auto rounded-2xl border bg-background p-5 shadow-xl">
          <h2>{t('Delivery settings')}</h2>
          <label className="block text-sm">
            {t('Module instructions')}
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              className="mt-2 min-h-24 w-full rounded-lg border p-2"
            />
          </label>
          <AgentProfileSelector
            value={models.orchestrator}
            onChange={(profile) =>
              setModels({ ...models, orchestrator: profile })
            }
            label="Orchestrator"
          />
          {(['workers', 'reviewers'] as const).map((pool) => (
            <div key={pool} className="space-y-2">
              <h3 className="text-sm">
                {t(pool === 'workers' ? 'Worker models' : 'Reviewer models')}
              </h3>
              {models[pool].map((profile, index) => (
                <div className="flex gap-2" key={index}>
                  <AgentProfileSelector
                    value={profile}
                    onChange={(value) =>
                      setModels({
                        ...models,
                        [pool]: models[pool].map((entry, i) =>
                          i === index ? value : entry,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setModels({
                        ...models,
                        [pool]: models[pool].filter((_, i) => i !== index),
                      })
                    }
                  >
                    ×
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setModels({
                    ...models,
                    [pool]: [
                      ...models[pool],
                      { agent: 'codex', model: '', effort: '' },
                    ],
                  })
                }
              >
                {t('Add model')}
              </Button>
            </div>
          ))}
          <Button
            disabled={pending}
            onClick={async () => {
              if (await command('instructions', { instructions })) {
                await command('models', { models });
                setSettings(false);
              }
            }}
          >
            {t('Save')}
          </Button>
        </section>
      )}
      {target && (
        <AgentGraphComposerCard
          title={t(
            record?.brief?.confirmedAt
              ? 'Delivery feedback'
              : 'Discuss delivery',
          )}
          running={running}
          description={
            !record
              ? t('Prepare this target with your selected models.')
              : undefined
          }
        >
          <AgentComposerShell
            controls={
              <div className="flex justify-end">
                <Button
                  disabled={pending || !input.trim()}
                  size="icon"
                  onClick={async () => {
                    if (!record) {
                      if (await command('prepare', { models, message: input }))
                        setInput('');
                    } else if (await command('send', { message: input }))
                      setInput('');
                  }}
                  aria-label={t('Send')}
                >
                  <ArrowUp className="size-4" />
                </Button>
              </div>
            }
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t('Describe the outcome or your feedback.')}
              className="min-h-28 w-full resize-none p-2 text-sm outline-none"
            />
          </AgentComposerShell>
        </AgentGraphComposerCard>
      )}
    </main>
  );
}
