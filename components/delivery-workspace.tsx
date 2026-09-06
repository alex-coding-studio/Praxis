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
import { ArrowLeft, Check, Settings, Square, FolderOpen } from 'lucide-react';
import { AgentGraphComposerCard } from '@/components/agent-graph-composer-card';
import {
  AgentComposerShell,
  AgentComposerAttachments,
} from '@/components/agent-composer-shell';
import { AgentProfileSelector } from '@/components/agent-profile-selector';
import { AgentRunControls } from '@/components/agent-run-controls';
import {
  ContextAttachmentPicker,
  contextAttachmentTitle,
} from '@/components/context-attachment-picker';
import { Textarea } from '@/components/ui/textarea';
import type { ContextBrowserFolder } from '@/lib/modules/product-context/catalog';
import { CanvasNodeCardFrame } from '@/components/canvas-node-card-frame';
import {
  ExecutionStickyHeaderFrame,
  PullRequestChip,
} from '@/components/execution-sticky-header';
import {
  CANVAS_NODE_CARD_WIDTH,
  canvasNodeCardMinHeight,
} from '@/lib/graph/canvas-node-card-metrics';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { MarkdownReader } from '@/components/markdown-reader';
import {
  MarkdownReaderDialog,
  type MarkdownReaderDialogPreview,
} from '@/components/markdown-reader-dialog';
import { renderDeliveryBrief } from '@/lib/modules/delivery/documents';
import { ProjectModuleHeader } from '@/components/project-module-header';
import { ModuleInstructionsDialog } from '@/components/module-instructions-dialog';
import { LatestResponseCard } from '@/components/latest-response-card';
import { deliveryResponse } from '@/lib/modules/delivery/response';
import { statusPresentation } from '@/lib/execution-observability/status-presentation';
import { useSurfacePreference } from '@/hooks/use-surface-preference';
import { useUiText } from '@/components/ui-language-provider';
import type {
  DeliveryModels,
  ExecutableTarget,
  DeliverySourceKind,
} from '@/lib/modules/delivery/types';
import {
  deliveryCandidateReady,
  deliveryEvidenceReady,
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

function TargetNode({
  data,
  selected,
}: NodeProps<Node<{ target: ExecutableTarget }>>) {
  const { t } = useUiText();
  const target = data.target;
  const busy = ['running', 'reviewing', 'briefing'].includes(target.status);
  const inProgress =
    busy || ['ready-to-run', 'waiting-for-user'].includes(target.status);
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <CanvasNodeCardFrame
        density="standard"
        focused={selected}
        busy={busy}
        accentColor={inProgress ? 'var(--graph-running)' : undefined}
        kindLabel={
          <span className="rounded-lg bg-foreground px-1.5 py-0.5 text-[9px] font-medium text-background">
            {t(layers.find((layer) => layer.id === target.sourceKind)!.label)}
          </span>
        }
        title={target.title}
        summary={target.summary}
        status={
          <span
            className={cn(
              'text-[11px]',
              target.status === 'completed'
                ? 'text-emerald-600'
                : inProgress
                  ? 'text-sky-500'
                  : target.status === 'failed'
                    ? 'text-red-500'
                    : 'text-muted-foreground',
            )}
          >
            {t(inProgress ? 'In progress' : labels[target.status])}
          </span>
        }
        footer={
          <span className="font-mono text-[9px] text-muted-foreground">
            {target.sourceId}
          </span>
        }
      />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}
const nodeTypes = { target: TargetNode };

export function DeliveryWorkspace({
  projectId,
  initialWorkspace,
  folders,
  initialTarget,
}: {
  projectId: string;
  initialWorkspace: Workspace;
  folders: ContextBrowserFolder[];
  initialTarget?: string;
}) {
  const { t } = useUiText();
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [layer, setLayer] = useState<DeliverySourceKind>(
    initialWorkspace.targets.find((entry) => entry.sourceUid === initialTarget)
      ?.sourceKind ?? 'mvp',
  );
  const [uid, setUid] = useState<string | null>(initialTarget ?? null);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<Array<{ name: string; base64: string }>>(
    [],
  );
  const [contextRefs, setContextRefs] = useState<string[]>([]);
  const [folderPath, setFolderPath] = useState('');
  const [error, setError] = useState('');
  const [taskDocument, setTaskDocument] =
    useState<MarkdownReaderDialogPreview | null>(null);
  const [readingTask, setReadingTask] = useState(false);
  const [pending, setPending] = useState(false);
  const [settings, setSettings] = useState(false);
  const [modelNotice, setModelNotice] = useState(false);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);
  const [responseCollapsed, setResponseCollapsed] = useSurfacePreference(
    projectId,
    `delivery:${layer}`,
    'latest-response',
  );
  const [composerCollapsed, setComposerCollapsed] = useSurfacePreference(
    projectId,
    `delivery:${uid ?? layer}`,
    'composer',
  );
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
  const run = record?.lastWithdrawal ? undefined : record?.runs.at(-1);
  const running = run?.status === 'running';
  async function openTaskDocument() {
    if (!target || readingTask) return;
    setReadingTask(true);
    try {
      const documents = await Promise.all(
        target.outputPaths.map(async (filePath) => {
          const response = await fetch(
            `/api/projects/${projectId}/resources?path=${encodeURIComponent(filePath)}`,
            { cache: 'no-store' },
          );
          const result = await response.json();
          if (!response.ok) throw new Error(result.error);
          return { path: filePath, markdown: result.markdown as string };
        }),
      );
      setTaskDocument({
        title: target.title,
        path: target.outputPaths.join(', '),
        markdown: documents
          .map((document) => document.markdown)
          .join('\n\n---\n\n'),
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setReadingTask(false);
    }
  }
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
    if (action === 'start' && !(record?.models ?? models).workers.length) {
      setError('');
      if (record) setModels(record.models);
      setModelNotice(true);
      setSettings(true);
      return false;
    }
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
  async function attach(selected: FileList | File[] | null) {
    if (!selected) return;
    try {
      const next = await Promise.all(
        Array.from(selected).map(
          (file) =>
            new Promise<{ name: string; base64: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result !== 'string') {
                  reject(new Error('Could not read attachment.'));
                  return;
                }
                resolve({
                  name: file.name,
                  base64: reader.result.split(',')[1],
                });
              };
              reader.onerror = () =>
                reject(new Error('Could not read attachment.'));
              reader.readAsDataURL(file);
            }),
        ),
      );
      setFiles((current) => [...current, ...next]);
    } catch (failure) {
      setError(String(failure));
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
      layout.setNode(entry.sourceUid, {
        width: CANVAS_NODE_CARD_WIDTH,
        height: canvasNodeCardMinHeight('standard'),
      });
    for (const edge of edges) layout.setEdge(edge.source, edge.target);
    dagre.layout(layout);
    return {
      edges,
      nodes: visible.map((entry) => ({
        id: entry.sourceUid,
        type: 'target',
        position: {
          x: layout.node(entry.sourceUid).x - CANVAS_NODE_CARD_WIDTH / 2,
          y:
            layout.node(entry.sourceUid).y -
            canvasNodeCardMinHeight('standard') / 2,
        },
        style: { width: CANVAS_NODE_CARD_WIDTH },
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
  const canvasRecord = workspace.records
    .filter(
      (entry) =>
        entry.source.sourceKind === layer &&
        (entry.runs.length || entry.lastWithdrawal),
    )
    .sort((a, b) =>
      (b.lastWithdrawal?.at ?? b.runs.at(-1)!.startedAt).localeCompare(
        a.lastWithdrawal?.at ?? a.runs.at(-1)!.startedAt,
      ),
    )[0];
  const canvasResponse = deliveryResponse(projectId, canvasRecord);
  const targetPresentation = target
    ? running
      ? statusPresentation('running')
      : target.status === 'completed'
        ? statusPresentation('completed')
        : target.status === 'failed'
          ? statusPresentation('fail')
          : target.status === 'warning'
            ? statusPresentation('warning')
            : null
    : null;
  return (
    <main className="relative flex h-dvh min-w-0 flex-col overflow-hidden">
      <ProjectModuleHeader
        title={
          <span className="flex items-center gap-3">
            {uid && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setUid(null)}
                aria-label={t('Back')}
              >
                <ArrowLeft />
              </Button>
            )}
            {target?.title ?? t('Development Delivery')}
          </span>
        }
        actions={
          <>
            {target && (
              <Button
                variant="outline"
                size="sm"
                disabled={readingTask || !target.outputPaths.length}
                onClick={() => void openTaskDocument()}
              >
                {t('View task document')}
              </Button>
            )}
            <ModuleInstructionsDialog
              endpoint={`/api/projects/${projectId}/delivery-context`}
              title="Development Delivery instructions"
              description="Applies to the next request, including continued sessions. Running requests keep their original instructions. Leave blank to use only the Harness defaults."
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (record) setModels(record.models);
                setSettings(true);
              }}
            >
              <Settings className="size-4" />
              {t('Models')}
            </Button>
          </>
        }
      />
      {!uid ? (
        <>
          <nav className="flex gap-2 border-b border-border px-5 py-3">
            {layers.map((item) => {
              const remaining = workspace.targets.filter(
                (target) =>
                  target.sourceKind === item.id &&
                  target.status !== 'completed',
              ).length;
              return (
                <Button
                  key={item.id}
                  variant={layer === item.id ? 'secondary' : 'ghost'}
                  onClick={() => setLayer(item.id)}
                >
                  {t(item.label)}
                  <span
                    className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground"
                    title={t('Undelivered targets: {count}', {
                      count: remaining,
                    })}
                    aria-label={t('Undelivered targets: {count}', {
                      count: remaining,
                    })}
                  >
                    {remaining}
                  </span>
                </Button>
              );
            })}
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
            {canvasResponse && (
              <LatestResponseCard
                document={canvasResponse}
                collapsed={responseCollapsed}
                onCollapsedChange={setResponseCollapsed}
                onCancel={() =>
                  void command('cancel', { uid: canvasRecord.sourceUid })
                }
                cancelDisabled={pending}
                className="w-[min(360px,calc(100%-2rem))]"
              />
            )}
          </div>
        </>
      ) : target ? (
        <div
          ref={setScrollRoot}
          className="relative min-h-0 flex-1 overflow-y-auto p-5 pb-64"
        >
          <div ref={setSentinel} aria-hidden="true" className="h-px" />
          <ExecutionStickyHeaderFrame stuck={stuck}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                    targetPresentation?.badge ??
                      'bg-secondary text-muted-foreground',
                  )}
                >
                  {targetPresentation && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-1.5 rounded-full',
                        targetPresentation.dot,
                        targetPresentation.pulse && 'animate-pulse',
                      )}
                    />
                  )}
                  {t(labels[target.status])}
                </span>
                {run && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {running && record?.actor ? `${record.actor} · ` : ''}
                    {Math.floor(elapsed / 60)}:
                    {String(elapsed % 60).padStart(2, '0')}
                  </span>
                )}
              </div>
              {record?.response?.status === 'completed' && (
                <p className="mt-2 text-sm font-medium text-foreground">
                  {t(record.response.title)}
                </p>
              )}
              {record?.response && record.response.status !== 'completed' && (
                <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
                  <span className="font-medium">
                    {t(record.response.title)} —{' '}
                  </span>
                  {t(record.response.detail)}
                </p>
              )}
              {running &&
                record?.progress.find((item) => item.status === 'running') && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {
                      record.progress.find((item) => item.status === 'running')!
                        .title
                    }
                  </p>
                )}
              <div className="mt-3 flex flex-wrap gap-2">
                {(run || record?.lastWithdrawal) && (
                  <a
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-6 items-center rounded-md border px-2 text-[11px]"
                    href={
                      record?.lastWithdrawal &&
                      (!run || record.lastWithdrawal.at > run.startedAt)
                        ? record.lastWithdrawal.logUrlPath
                        : `/projects/${projectId}/delivery/${uid}/logs/${run!.id}`
                    }
                  >
                    {t('Log')}
                  </a>
                )}
                {record?.workspace && (
                  <Button
                    variant="outline"
                    disabled={pending}
                    className="h-6 gap-1 rounded-md px-2 text-[11px]"
                    onClick={() => void command('open-workspace')}
                  >
                    <FolderOpen className="size-3" />
                    {t('Open workspace folder')}
                  </Button>
                )}
                {record?.publication && (
                  <PullRequestChip
                    pr={{
                      ...record.publication,
                      title: record.source.title,
                      isDraft: record.publication.draft,
                    }}
                    stale={false}
                    className="h-6 rounded-md px-2 text-[11px]"
                  />
                )}
              </div>
            </div>
            <div className="flex max-w-full flex-col items-end gap-2">
              {record &&
                !record.lastWithdrawal &&
                !record.acceptedHead &&
                record.status !== 'completed' && (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      if (
                        window.confirm(
                          t(
                            'Withdraw this unaccepted delivery? Running work will stop, unaccepted workspace changes will be discarded, and any open delivery PR will be closed. Other targets and merged code are unchanged.',
                          ),
                        )
                      )
                        void command('withdraw');
                    }}
                  >
                    {t('Withdraw delivery')}
                  </Button>
                )}
              {record?.status === 'ready-to-run' && !running && (
                <Button
                  disabled={
                    pending ||
                    target.sourceChanged ||
                    target.unmetDependencies.length > 0
                  }
                  onClick={() => void command('start')}
                >
                  {t('Start delivery')}
                </Button>
              )}
              {record?.status === 'ready-to-run' && !running && (
                <p className="max-w-full text-right text-[11px] leading-4 text-muted-foreground">
                  {t(
                    'Brief confirmed. Click Start delivery to begin implementation.',
                  )}
                </p>
              )}
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
                    variant={
                      record.brief.openDecisions.length
                        ? 'secondary'
                        : 'default'
                    }
                    disabled={
                      pending || Boolean(record.brief.openDecisions.length)
                    }
                    aria-describedby={
                      record.brief.openDecisions.length
                        ? 'brief-confirmation-help'
                        : undefined
                    }
                    onClick={() => void command('confirm-brief')}
                  >
                    {!record.brief.openDecisions.length && <Check />}
                    {t('Confirm delivery brief')}
                  </Button>
                )
              )}
              {!running &&
                record?.brief &&
                !record.brief.confirmedAt &&
                record.brief.openDecisions.length > 0 && (
                  <p
                    id="brief-confirmation-help"
                    className="max-w-64 text-right text-xs text-amber-700 dark:text-amber-300"
                  >
                    {t(
                      'Resolve {count} open decisions in the composer before confirming.',
                      { count: record.brief.openDecisions.length },
                    )}
                  </p>
                )}
              {!running &&
                record?.publication &&
                record.status !== 'completed' && (
                  <Button
                    disabled={
                      pending ||
                      target.sourceChanged ||
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
              {!running &&
                record?.existingDelivery &&
                record.status !== 'completed' && (
                  <Button
                    disabled={
                      pending ||
                      target.sourceChanged ||
                      !deliveryEvidenceReady(
                        record,
                        record.existingDelivery.head,
                      )
                    }
                    onClick={() => void command('accept-existing')}
                  >
                    {t('Confirm existing delivery')}
                  </Button>
                )}
            </div>
          </ExecutionStickyHeaderFrame>
          {record?.brief && (
            <section className="my-5">
              <MarkdownReader
                title={t('Delivery brief')}
                filePath={`delivery/targets/${record.sourceUid}/record.json`}
                markdown={renderDeliveryBrief(record)}
                initialAnnotationsEnabled={false}
                compact
                onAddFeedback={
                  running
                    ? undefined
                    : (selection) => {
                        setInput(
                          (current) =>
                            `${current}\n\nDelivery Brief revision ${record.brief!.revision}, lines ${selection.startLine}-${selection.endLine}:\n> ${selection.excerpt}\n\n`,
                        );
                        setComposerCollapsed(false);
                      }
                }
              />
              {record.brief.openDecisions.map((decision) => (
                <p className="mt-2 text-amber-600" key={decision}>
                  {decision}
                </p>
              ))}
            </section>
          )}
          {target.unmetDependencies.length > 0 && (
            <section className="mb-5 space-y-2">
              <h2 className="text-sm font-medium">
                {t('Waiting for prerequisites')}
              </h2>
              {target.unmetDependencies.map((dependency) => {
                const prerequisite = workspace.targets.find(
                  (entry) => entry.sourceUid === dependency,
                );
                return prerequisite ? (
                  <Button
                    key={dependency}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setUid(prerequisite.sourceUid);
                      setLayer(prerequisite.sourceKind);
                    }}
                  >
                    {prerequisite.title}
                  </Button>
                ) : (
                  <p key={dependency} className="text-xs text-muted-foreground">
                    {dependency}
                  </p>
                );
              })}
            </section>
          )}
          {record?.review && (
            <details className="mb-5 text-sm">
              <summary>
                {t(
                  record.review.disposition === 'not-required'
                    ? 'Independent review not needed'
                    : record.review.approved
                      ? 'Review approved'
                      : 'Review pending',
                )}
              </summary>
              <p className="mt-2 text-xs text-muted-foreground">
                {record.review.reason}
              </p>
            </details>
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
              <MarkdownReader
                key={message.id}
                title={message.actor === 'USER' ? t('You') : message.actor}
                filePath={`delivery/targets/${record.sourceUid}/record.json`}
                markdown={message.content}
                compact
                showFocusButton={false}
              />
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
      <Dialog
        open={settings}
        onOpenChange={(open) => {
          setSettings(open);
          if (!open) setModelNotice(false);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('Delivery settings')}</DialogTitle>
          </DialogHeader>
          {modelNotice && (
            <p className="text-sm text-muted-foreground">
              {t(
                'Add a Worker model before starting delivery. Save your settings, then click Start delivery again.',
              )}
            </p>
          )}
          <section className="space-y-2 border-b border-border pb-4">
            <h3 className="text-sm font-medium">{t('Orchestrator model')}</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                'Understands the target, delegates tasks and brings the delivery together.',
              )}
            </p>
            <AgentProfileSelector
              value={models.orchestrator}
              onChange={(profile) =>
                setModels({ ...models, orchestrator: profile })
              }
              label="Orchestrator"
              triggerClassName="w-full sm:max-w-sm"
            />
          </section>
          <div className="grid min-w-0 gap-6 sm:grid-cols-2">
            {(['workers', 'reviewers'] as const).map((pool) => (
              <section key={pool} className="min-w-0 space-y-2">
                <h3 className="text-sm font-medium">
                  {t(pool === 'workers' ? 'Worker models' : 'Reviewer models')}
                </h3>
                {models[pool].map((profile, index) => (
                  <div className="flex min-w-0 items-center gap-2" key={index}>
                    <AgentProfileSelector
                      triggerClassName="min-w-0 flex-1"
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
                      size="icon-sm"
                      className="shrink-0"
                      aria-label={t('Remove model')}
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
              </section>
            ))}
          </div>
          <Button
            disabled={pending}
            onClick={async () => {
              if (await command('models', { models })) {
                setSettings(false);
                setModelNotice(false);
              }
            }}
          >
            {t('Save')}
          </Button>
        </DialogContent>
      </Dialog>
      <MarkdownReaderDialog
        preview={taskDocument}
        onClose={() => setTaskDocument(null)}
      />
      {target && (
        <AgentGraphComposerCard
          title={t(
            record?.brief?.confirmedAt
              ? 'Delivery feedback'
              : 'Discuss delivery',
          )}
          running={running}
          collapsed={composerCollapsed}
          onCollapsedChange={setComposerCollapsed}
        >
          <AgentComposerAttachments
            className="mb-3"
            label={t('Optional sources')}
            items={[
              ...contextRefs.map((ref) => ({
                id: ref,
                label: contextAttachmentTitle(folders, ref),
                onRemove: () =>
                  setContextRefs((current) =>
                    current.filter((item) => item !== ref),
                  ),
              })),
              ...files.map((file, index) => ({
                id: `${file.name}:${index}`,
                label: file.name,
                onRemove: () =>
                  setFiles((current) => current.filter((_, i) => i !== index)),
              })),
            ]}
          />
          <AgentComposerShell
            controls={
              <AgentRunControls
                extraInfo={
                  <ContextAttachmentPicker
                    embedded
                    folders={folders}
                    folderPath={folderPath}
                    onFolderPath={setFolderPath}
                    refs={contextRefs}
                    onToggleRef={(ref) =>
                      setContextRefs((current) =>
                        current.includes(ref)
                          ? current.filter((item) => item !== ref)
                          : [...current, ref],
                      )
                    }
                    files={files}
                    onAddFiles={(added) => void attach(added)}
                    onRemoveFile={(index) =>
                      setFiles((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                    label={t('Optional sources')}
                    accept=".md,.markdown,.txt,.html,.htm,.pdf,.png,.jpg,.jpeg,.webp,.gif"
                    disabled={pending || running}
                  />
                }
                extraInfoCount={contextRefs.length + files.length}
                extraInfoLabel="Optional sources"
                value={record?.models.orchestrator ?? models.orchestrator}
                onChange={(profile) => {
                  if (record)
                    void command('models', {
                      models: { ...record.models, orchestrator: profile },
                    });
                  else setModels({ ...models, orchestrator: profile });
                }}
                disabled={pending || !input.trim()}
                running={pending}
                label="Orchestrator"
                actionLabel={
                  record?.brief?.confirmedAt
                    ? 'Continue delivery'
                    : 'Prepare delivery brief'
                }
                onRun={() =>
                  void (async () => {
                    const sent = !record
                      ? await command('prepare', {
                          models,
                          message: input,
                          files,
                          contextRefs,
                        })
                      : await command('send', {
                          message: input,
                          files,
                          contextRefs,
                        });
                    if (sent) {
                      setInput('');
                      setFiles([]);
                      setContextRefs([]);
                    }
                  })()
                }
              />
            }
          >
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              maxLength={20000}
              disabled={pending || running}
              rows={4}
              className="min-h-24 resize-none text-sm"
              placeholder={t('Describe the outcome or your feedback.')}
              aria-label={t('Delivery feedback')}
            />
          </AgentComposerShell>
        </AgentGraphComposerCard>
      )}
    </main>
  );
}
