'use client';

import { FolderOpen, GitPullRequest } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useUiText } from '@/components/ui-language-provider';
import type { LatestResponseDocument } from '@/lib/execution-observability/types';
import {
  actorLabel,
  formatElapsed,
  phaseLabel,
  statusPresentation,
} from '@/lib/execution-observability/status-presentation';
import type { GitHubPullRequest } from '@/lib/github-delivery';
import type { ActionRun } from '@/lib/modules/implementation/execution-types';
import { cn } from '@/lib/utils';

export function ExecutionStickyHeaderFrame({
  stuck,
  children,
}: {
  stuck: boolean;
  children: ReactNode;
}) {
  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border border-border bg-background/95 p-4 shadow-sm backdrop-blur transition-[border-radius] duration-150',
        stuck ? 'rounded-b-xl border-t-0' : 'rounded-xl',
      )}
    >
      {children}
    </header>
  );
}

export function PullRequestChip({
  pr,
  stale,
  className = '',
}: {
  pr: Pick<GitHubPullRequest, 'url' | 'title' | 'number' | 'isDraft' | 'state'>;
  stale: boolean;
  className?: string;
}) {
  const { t } = useUiText();
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      title={pr.title}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${stale ? 'border-amber-500/40 text-amber-500' : pr.state === 'MERGED' ? 'border-purple-500/30 text-purple-500' : pr.isDraft || pr.state === 'CLOSED' ? 'border-border text-muted-foreground' : 'border-blue-500/30 text-blue-500'} ${className}`}
    >
      <GitPullRequest aria-hidden="true" className="size-3.5" />#{pr.number} ·{' '}
      {t(pr.isDraft && pr.state === 'OPEN' ? 'Draft' : pr.state)}
      {stale && ` · ${t('Stale status')}`}
    </a>
  );
}

export function runDocument(
  projectId: string,
  cardId: string,
  run: ActionRun | undefined,
  subjectLabel: string,
): LatestResponseDocument | null {
  if (!run?.response || run.status === 'running') return null;
  return {
    schemaVersion: 1,
    owner: { kind: 'card', cardId },
    projectId,
    runId: run.id,
    revision: 0,
    status: run.response.status,
    title: run.response.title,
    detail: run.response.detail,
    subject: { kind: 'action', label: subjectLabel, id: run.actionId },
    supplementaryWarnings: run.response.supplementaryWarnings,
    recovery: run.response.recovery,
    startedAt: run.startedAt,
    updatedAt: run.endedAt ?? run.startedAt,
    endedAt: run.endedAt,
    logRef: run.logRef ?? `implementation/cards/${cardId}/logs/${run.id}.log`,
    logUrlPath: `/projects/${projectId}/logs/implementation/${cardId}/${run.id}`,
    hostPid: run.hostPid,
    agentProfile: run.profile,
    actionId: run.actionId,
    jobLogs: run.jobs,
    recentActivity: [],
    reconstructed: true,
  };
}

export function ExecutionHeaderStatus({
  document,
  actionIndex,
  actionTotal,
  actionTitle,
  checks,
  pullRequests,
  staleGithub,
  onOpenWorkspace,
  openingWorkspace = false,
  accepted,
}: {
  document: LatestResponseDocument | null;
  actionIndex: number;
  actionTotal: number;
  actionTitle: string;
  checks: { passed: number; total: number } | null;
  pullRequests: GitHubPullRequest[];
  staleGithub: boolean;
  onOpenWorkspace?: () => void;
  openingWorkspace?: boolean;
  accepted: boolean;
}) {
  const { t } = useUiText();
  const running = document?.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  const presentation = document ? statusPresentation(document.status) : null;
  const latestActivity = document?.recentActivity.at(-1) ?? null;
  const warnings = document?.supplementaryWarnings.length ?? 0;
  return (
    <div
      data-execution-header="left"
      data-status={document?.status ?? 'waiting'}
      className="min-w-0 space-y-1.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t('Action {current}/{total}', {
            current: actionIndex + 1,
            total: actionTotal,
          })}
        </span>
        <span className="text-sm font-medium">{actionTitle}</span>
        {presentation && document ? (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium',
              presentation.badge,
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 rounded-full',
                presentation.dot,
                presentation.pulse && 'animate-pulse',
              )}
            />
            {t(
              document.phase === 'stopping'
                ? 'Stopping'
                : accepted && document.status === 'completed'
                  ? 'Accepted'
                  : presentation.label,
            )}
          </span>
        ) : (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {t('Ready to start')}
          </span>
        )}
        {running && document ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            {document.actor ? t(actorLabel(document.actor)) : t('Agent')} ·{' '}
            {document.phase ? t(phaseLabel(document.phase)) : t('Running')} ·{' '}
            {formatElapsed(document.startedAt, null, now)}
          </span>
        ) : document?.endedAt ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatElapsed(document.startedAt, document.endedAt)}
          </span>
        ) : null}
      </div>
      {running && latestActivity ? (
        <p className="truncate text-xs text-muted-foreground">
          <span className="mr-1 font-mono text-[10px] uppercase opacity-70">
            {latestActivity.actor}
          </span>
          {latestActivity.message}
        </p>
      ) : null}
      {!running && document ? (
        <p className="text-xs">
          <span className="font-medium">{document.title}</span>
          <span className="text-muted-foreground"> — {document.detail}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        {checks ? (
          <span>
            {t('Required checks')} · {checks.passed}/{checks.total}
          </span>
        ) : null}
        {!running && warnings ? (
          <span className="text-amber-700 dark:text-amber-300">
            {t('{count} additional findings', { count: warnings })}
          </span>
        ) : null}
        {document ? (
          <a
            href={document.logUrlPath}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[11px] font-medium text-foreground hover:bg-secondary"
          >
            {t('Log')}
          </a>
        ) : null}
        {onOpenWorkspace ? (
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-foreground hover:bg-secondary disabled:opacity-50"
            disabled={openingWorkspace}
            onClick={onOpenWorkspace}
          >
            <FolderOpen className="size-3" />
            {t('Open workspace folder')}
          </button>
        ) : null}
        {pullRequests.map((pr) => (
          <PullRequestChip
            key={pr.url}
            pr={pr}
            stale={staleGithub}
            className="h-6 rounded-md px-2 text-[11px]"
          />
        ))}
      </div>
    </div>
  );
}
