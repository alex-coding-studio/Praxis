'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  unverifiedDeliveryRefs,
  latestActionGitHub,
  hasUnsupportedAppArtifact,
  hasReviewableReport,
} from '@/lib/modules/implementation/result-display';
import { CheckDetails } from '@/components/check-details';
import {
  assessRequiredChecks,
  splitChecks,
} from '@/lib/modules/implementation/checklist';
import {
  LoaderCircle,
  Check,
  ChevronRight,
  RefreshCw,
  FolderOpen,
  GitBranch,
  RotateCcw,
  Square,
  Undo2,
} from 'lucide-react';
import {
  AgentComposerAttachments,
  AgentComposerShell,
} from '@/components/agent-composer-shell';
import { AgentGraphComposerCard } from '@/components/agent-graph-composer-card';
import {
  ExecutionHeaderStatus,
  PullRequestChip,
  runDocument,
} from '@/components/execution-sticky-header';
import { useLatestResponse } from '@/hooks/use-latest-response';
import { useSurfacePreference } from '@/hooks/use-surface-preference';
import { AgentRunControls } from '@/components/agent-run-controls';
import {
  ContextAttachmentPicker,
  contextAttachmentTitle,
} from '@/components/context-attachment-picker';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useUiText } from '@/components/ui-language-provider';
import type { PlanningCard } from '@/lib/modules/implementation/planning-service';
import type { ActionContract } from '@/lib/modules/implementation/harness';
import type { AgentProfile } from '@/lib/agents/profile';
import type { ContextBrowserFolder } from '@/lib/modules/product-context/catalog';

const justDoItAgents = ['codex', 'claude', 'deepseek'] as const;

export function JustDoItAction({
  projectId,
  card,
  action,
  coordinatorProfile,
  folders,
  headerActionsTarget,
  headerStatusTarget,
  onChange,
}: {
  projectId: string;
  card: PlanningCard;
  action: ActionContract;
  coordinatorProfile: AgentProfile;
  folders: ContextBrowserFolder[];
  headerActionsTarget: HTMLElement | null;
  headerStatusTarget: HTMLElement | null;
  onChange: (card: PlanningCard) => void;
}) {
  const { t } = useUiText();
  const [instruction, setInstruction] = useState(
    card.execution?.retryInputs?.[action.id] ?? '',
  );
  const [contextRefs, setContextRefs] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [folderPath, setFolderPath] = useState(folders[0]?.path ?? '');
  const [profile, setProfile] = useState<AgentProfile>(
    card.execution?.profile ??
      card.execution?.runs.at(-1)?.profile ??
      card.run?.profile ?? { agent: 'codex', model: '', effort: '' },
  );
  const [pending, setPending] = useState(false);
  const [preparingAcceptance, setPreparingAcceptance] = useState(false);
  const [error, setError] = useState('');
  const [acceptancePreview, setAcceptancePreview] = useState<{
    runId: string;
    revision: number;
  } | null>(null);
  const latestResponse = useLatestResponse(projectId, { card: card.id });
  const actionDocument =
    latestResponse.document?.actionId === action.id
      ? latestResponse.document
      : null;
  const [composerCollapsed, setComposerCollapsed] = useSurfacePreference(
    projectId,
    `card:${card.id}`,
    'composer',
  );
  const [stopPreview, setStopPreview] = useState<{
    runId: string;
    revision: number;
  } | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetPreview, setResetPreview] = useState<{
    token: string;
    path: string;
    branch: string;
    baseCommit: string;
    repositoryUrl: string | null;
  } | null>(null);
  const history =
    card.execution?.runs.filter((run) => run.actionId === action.id) ?? [];
  const latest = history.at(-1);
  const headerGitHub = latestActionGitHub(history, action.id);
  const headerPullRequests = headerGitHub?.pullRequests ?? [];
  const accepted =
    card.execution?.acceptedActionIds.includes(action.id) ?? false;
  const current = card.actions.find(
    (item) => !card.execution?.acceptedActionIds.includes(item.id),
  );
  const lastCardRun = card.execution?.runs.at(-1);
  const running = lastCardRun?.status === 'running';
  const enabled = current?.id === action.id && !pending && !running;
  const canUndo =
    !accepted &&
    current?.id === action.id &&
    Boolean(latest) &&
    latest?.status !== 'running';
  const canReturnToPlanning = Boolean(
    card.execution?.workspace &&
    card.execution.acceptedActionIds.length > 0 &&
    lastCardRun,
  );

  async function send(
    operation:
      | 'start'
      | 'cancel'
      | 'accept'
      | 'refresh-github'
      | 'recheck-output'
      | 'override-check'
      | 'open-workspace'
      | 'undo-action',
    outputId = latest?.id,
    criterionId?: string,
    decisionNote = instruction,
  ) {
    setPending(true);
    setError('');
    try {
      const supplementalInput =
        operation === 'start'
          ? {
              contextRefs,
              files: await Promise.all(
                files.map(async (file) => ({
                  name: file.name,
                  content: await file.text(),
                })),
              ),
            }
          : {};
      const response = await fetch(`/api/projects/${projectId}/execution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: operation,
          cardId: card.id,
          actionId: action.id,
          expectedRevision: card.revision,
          instruction,
          profile,
          coordination: { profile: coordinatorProfile },
          outputId,
          criterionId,
          note: decisionNote,
          ...supplementalInput,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.code ?? data.error);
      onChange(data.card);
      if (operation === 'start') {
        setInstruction('');
        setContextRefs([]);
        setFiles([]);
      }
      if (operation === 'accept') setAcceptancePreview(null);
      if (operation === 'cancel') setStopPreview(null);
      void latestResponse.refresh();
      if (operation === 'undo-action') {
        setUndoOpen(false);
        setInstruction(
          data.card.execution?.retryInputs?.[action.id] ?? latest?.input ?? '',
        );
        setContextRefs([]);
        setFiles([]);
      }
      return data.card as PlanningCard;
    } catch (err) {
      if (operation === 'undo-action') setUndoOpen(false);
      setError(err instanceof Error ? err.message : 'Execution failed.');
    } finally {
      setPending(false);
    }
  }

  async function prepareAcceptance() {
    if (!latest || pending || preparingAcceptance) return;
    setPreparingAcceptance(true);
    try {
      const updated = latest.github
        ? await send('refresh-github', latest.id)
        : card;
      if (updated) {
        setError('');
        setAcceptancePreview({ runId: latest.id, revision: updated.revision });
      }
    } finally {
      setPreparingAcceptance(false);
    }
  }

  async function resetCard(token?: string) {
    setResetOpen(true);
    setPending(true);
    setResetError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/execution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: token ? 'replan' : 'preview-replan',
          cardId: card.id,
          expectedRevision: card.revision,
          token,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.code ?? data.error);
      if (data.preview) setResetPreview(data.preview);
      if (data.card) {
        onChange(data.card);
        setInstruction('');
        setResetPreview(null);
        setResetOpen(false);
      }
    } catch (err) {
      setResetPreview(null);
      setResetError(err instanceof Error ? err.message : 'Reset failed.');
    } finally {
      setPending(false);
    }
  }

  const requiredAssessment = assessRequiredChecks(
    latest?.acceptanceChecklist,
    latest?.result?.checks ?? [],
    card.execution?.acceptanceOverrides?.[action.id],
  );
  const requiredPassed = requiredAssessment.passed;
  const additionalChecks =
    latest?.result && latest.acceptanceChecklist
      ? splitChecks(
          latest.acceptanceChecklist,
          latest.result.checks,
          latest.result.additionalChecks,
        ).additional
      : [];
  const previewChanged =
    acceptancePreview &&
    (acceptancePreview.revision !== card.revision ||
      acceptancePreview.runId !== latest?.id);
  const nextAction =
    card.actions[card.actions.findIndex((item) => item.id === action.id) + 1];
  const stage = accepted
    ? 1
    : hasReviewableReport(latest) && requiredPassed
      ? 1
      : 0;
  const currentStatus = accepted
    ? 'Verified'
    : latest?.status === 'running'
      ? 'Agent running'
      : hasReviewableReport(latest)
        ? requiredPassed
          ? 'Ready to verify'
          : 'Needs your input'
        : latest?.status === 'failed'
          ? 'Execution failed'
          : latest
            ? 'Needs your input'
            : 'Ready to start';
  return (
    <section className="mt-6 space-y-4 border-t border-border pt-5">
      <output className="block text-sm font-medium">
        {t('Current status')}: {t(currentStatus)}
      </output>
      <div className="grid grid-cols-2 gap-2 text-xs">
        {['Execution phase', 'Acceptance phase'].map((label, index) => (
          <div
            key={label}
            aria-current={!accepted && index === stage ? 'step' : undefined}
            className={`flex items-center gap-1.5 border-t-2 px-2 py-2 ${index === stage && !accepted ? 'border-blue-500 bg-blue-500/10 font-semibold text-blue-600 dark:text-blue-400' : index < stage || accepted ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400' : 'border-border text-muted-foreground'}`}
          >
            {index < stage || accepted ? (
              <Check aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              String(index + 1).padStart(2, '0')
            )}{' '}
            · {t(label)}
            {index === stage && !accepted && (
              <span className="ml-auto rounded bg-blue-500/15 px-1 py-0.5 text-[10px]">
                {t('Current stage')}
              </span>
            )}
          </div>
        ))}
      </div>
      {card.execution?.workspace && (
        <div className="space-y-3 rounded-lg border border-border p-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium">{t('Card workspace')}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void send('open-workspace')}
            >
              <FolderOpen className="size-3.5" />
              {t('Open workspace folder')}
            </Button>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
            <dt className="text-muted-foreground">{t('Workspace path')}</dt>
            <dd className="min-w-0 break-all font-mono leading-5">
              {card.execution.workspace.path}
            </dd>
            <dt className="flex items-center gap-1 text-muted-foreground">
              <GitBranch className="size-3.5" />
              {t('Branch')}
            </dt>
            <dd className="min-w-0 break-all font-mono leading-5">
              {card.execution.workspace.branch}
            </dd>
          </dl>
          <p className="text-muted-foreground">
            {t(
              'Shared by this Card’s Actions. Main receives changes through PR merges.',
            )}
          </p>
          {card.execution.workspaceBackups?.at(-1) && (
            <p className="break-all">
              {t('Previous workspace backup')}:{' '}
              {card.execution.workspaceBackups.at(-1)!.path}
            </p>
          )}
        </div>
      )}
      {card.execution?.git && (
        <p className="text-xs text-muted-foreground">
          {t('Local Git baseline')}:{' '}
          <code>{card.execution.git.baseline.slice(0, 8)}</code> ·{' '}
          {t('App-owned history; separate from repository commits and PRs.')}
        </p>
      )}
      {current?.id !== action.id && !accepted && (
        <p className="text-sm text-muted-foreground">
          {t('Accept earlier Actions before starting this step.')}
        </p>
      )}
      {history.length > 0 && (
        <div className="space-y-3">
          {history.map((run, index) => (
            <details
              key={run.id}
              open={run.id === latest?.id}
              className="group/round rounded-xl border border-border p-4"
            >
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-open/round:rotate-90"
                />
                <span className="mr-auto">
                  {t('Round')} {index + 1} ·{' '}
                  {t(
                    accepted && run.id === latest?.id
                      ? 'Verified'
                      : run.status === 'running'
                        ? 'Agent running'
                        : run.status === 'canceled'
                          ? 'Canceled'
                          : hasReviewableReport(run)
                            ? assessRequiredChecks(
                                run.acceptanceChecklist,
                                run.result?.checks ?? [],
                                run.id === latest?.id
                                  ? card.execution?.acceptanceOverrides?.[
                                      action.id
                                    ]
                                  : undefined,
                              ).passed
                              ? 'Ready to verify'
                              : 'Needs your input'
                            : run.status === 'failed'
                              ? 'Execution failed'
                              : 'Needs your input',
                  )}
                </span>
                {run.status !== 'running' && (
                  <span className="flex flex-wrap items-center gap-1.5 text-xs">
                    {run.github?.pullRequests.map((pr) => (
                      <PullRequestChip
                        key={pr.url}
                        pr={pr}
                        stale={Boolean(run.github?.error)}
                      />
                    ))}
                    {!run.github?.pullRequests.length && (
                      <span className="text-muted-foreground">
                        {t('No PR')}
                      </span>
                    )}
                    {run.github && (
                      <button
                        type="button"
                        disabled={pending || running}
                        aria-label={t('Refresh GitHub status')}
                        title={
                          run.github.error
                            ? t(run.github.error)
                            : t('Refresh GitHub status')
                        }
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void send('refresh-github', run.id);
                        }}
                      >
                        <RefreshCw aria-hidden="true" className="size-3.5" />
                      </button>
                    )}
                  </span>
                )}
              </summary>
              <details className="mt-3 rounded-lg bg-muted/40 px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium text-muted-foreground">
                  {t('Run information')}
                </summary>
                <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
                  <dt className="text-muted-foreground">Agent</dt>
                  <dd>
                    {run.profile.agent} ·{' '}
                    {run.profile.model || t('Agent default')} ·{' '}
                    {run.profile.effort || t('Agent default')}
                  </dd>
                  <dt className="text-muted-foreground">
                    {t('Execution permissions')}
                  </dt>
                  <dd>
                    {run.executionAccess
                      ? t(run.executionAccess)
                      : t('Not recorded')}
                  </dd>
                  <dt className="text-muted-foreground">{t('Run started')}</dt>
                  <dd>{run.startedAt}</dd>
                  {run.commit && (
                    <>
                      <dt className="text-muted-foreground">
                        {t('Local version')}
                      </dt>
                      <dd className="flex flex-wrap gap-2">
                        <code>{run.commit.slice(0, 8)}</code>
                        <a
                          className="underline underline-offset-4"
                          href={`/api/projects/${projectId}/execution-history?cardId=${card.id}&runId=${run.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('View version diff')}
                        </a>
                      </dd>
                    </>
                  )}
                </dl>
                {run.input && (
                  <div className="mt-3 border-t border-border pt-3">
                    <p className="mb-1 font-medium">{t('Your input')}</p>
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {run.input}
                    </p>
                  </div>
                )}
              </details>
              {run.error && !run.evidenceErrors && (
                <p className="mt-3 text-sm text-destructive">{run.error}</p>
              )}
              {run.result && (
                <>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7">
                    {run.result.summary}
                  </p>
                  <div className="mt-4 space-y-3">
                    <h4 className="text-sm font-medium">
                      {t(
                        run.coordination?.attempts.at(-1)?.role === 'worker'
                          ? 'Agent self-check'
                          : run.coordination
                            ? 'Coordinator report'
                            : 'Agent-reported checks',
                      )}
                    </h4>
                    <h5 className="text-xs font-semibold">
                      {t('Required checks')}
                    </h5>
                    {!run.acceptanceChecklist && (
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'Historical report without a fixed checklist; rerun against confirmed criteria.',
                        )}
                      </p>
                    )}
                    {assessRequiredChecks(
                      run.acceptanceChecklist,
                      run.result.checks,
                      run.id === latest?.id
                        ? card.execution?.acceptanceOverrides?.[action.id]
                        : undefined,
                    ).items.map((item) => (
                      <CheckDetails
                        key={item.criterion.id}
                        title={item.criterion.criterion}
                        status={item.status}
                      >
                        <p className="text-xs text-muted-foreground">
                          {item.criterion.id}
                        </p>
                        <p>
                          {t('Pass condition')}: {item.criterion.passCondition}
                        </p>
                        <p>
                          {t('Observed result')}:{' '}
                          {t(item.observed?.status ?? 'not-run')} ·{' '}
                          {item.observed?.summary}
                        </p>
                        {item.observed?.evidenceRefs.map((ref, i) => (
                          <p
                            key={i}
                            className="break-all text-xs text-muted-foreground"
                          >
                            {ref}
                          </p>
                        ))}
                        {item.override && (
                          <p>
                            {t('Passed by user decision')}: {item.override.note}{' '}
                            · {item.override.recordedAt}
                          </p>
                        )}
                        {item.status !== 'passed' &&
                          run.id === latest?.id &&
                          !accepted &&
                          run.input.trim() &&
                          run.coordination?.decisions
                            .at(-1)
                            ?.verificationPlan.some(
                              (plan) =>
                                plan.criterionId === item.criterion.id &&
                                plan.mode === 'needs-user-decision',
                            ) && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!enabled}
                              onClick={() =>
                                void send(
                                  'override-check',
                                  run.id,
                                  item.criterion.id,
                                  `User confirmed the coordinator interpretation for ${item.criterion.id}. Source input: ${run.input}. Interpretation: ${item.observed?.summary ?? ''}`,
                                )
                              }
                            >
                              {t('Confirm this user decision')}
                            </Button>
                          )}
                        {item.status !== 'passed' &&
                          run.id === latest?.id &&
                          !accepted &&
                          run.status !== 'running' && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!enabled || !instruction.trim()}
                              onClick={() =>
                                void send(
                                  'override-check',
                                  run.id,
                                  item.criterion.id,
                                )
                              }
                            >
                              {t(
                                'Use feedback as user decision to pass this item',
                              )}
                            </Button>
                          )}
                      </CheckDetails>
                    ))}
                    {(!run.acceptanceChecklist ||
                      splitChecks(
                        run.acceptanceChecklist,
                        run.result.checks,
                        run.result.additionalChecks,
                      ).additional.length > 0) && (
                      <h5 className="text-xs font-semibold">
                        {run.acceptanceChecklist
                          ? `${t('Additional checks')} · non-blocker`
                          : t('Historical checks (not classified)')}
                      </h5>
                    )}
                    {(run.acceptanceChecklist
                      ? splitChecks(
                          run.acceptanceChecklist,
                          run.result.checks,
                          run.result.additionalChecks,
                        ).additional
                      : [
                          ...run.result.checks,
                          ...(run.result.additionalChecks ?? []),
                        ]
                    ).map((check, i) => (
                      <CheckDetails
                        key={i}
                        title={check.summary}
                        status={check.status}
                        nonBlocking={Boolean(run.acceptanceChecklist)}
                      >
                        <p>
                          {t('Observed result')}: {t(check.status)}
                        </p>
                        {run.acceptanceChecklist && (
                          <p className="text-xs text-muted-foreground">
                            non-blocker
                          </p>
                        )}
                        {check.evidenceRefs.map((ref, j) => (
                          <p
                            key={j}
                            className="break-all text-xs text-muted-foreground"
                          >
                            {ref}
                          </p>
                        ))}
                      </CheckDetails>
                    ))}
                  </div>
                </>
              )}
              {run.evidenceErrors?.length ||
              run.unverifiedCheckRefs?.length ||
              run.github?.error ? (
                <details className="mt-4 border-t border-border pt-3 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    {t('System diagnostics')}
                    {run.evidenceErrors?.length
                      ? ` · ${t('Verification note')}`
                      : ''}
                  </summary>
                  <div className="mt-2">
                    {run.github?.error && (
                      <p className="text-amber-700 dark:text-amber-400">
                        {t(run.github.error)}
                      </p>
                    )}
                    {run.evidenceErrors ? (
                      <section className="mt-3 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="font-medium text-amber-600 dark:text-amber-400">
                            {t('System artifact verification note')}
                          </h4>
                          {run.id === card.execution?.runs.at(-1)?.id &&
                            run.status === 'failed' &&
                            !accepted &&
                            !hasUnsupportedAppArtifact(run) && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1.5 border-amber-500/30 bg-transparent px-2 text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                                disabled={pending || running}
                                title={t(
                                  'Recheck saved report without rerunning Agent',
                                )}
                                onClick={() =>
                                  void send('recheck-output', run.id)
                                }
                              >
                                <RefreshCw
                                  aria-hidden="true"
                                  className="size-3"
                                />
                                {t('Retry verification')}
                              </Button>
                            )}
                        </div>
                        <p>
                          {t('Agent-reported required checks')}:{' '}
                          {
                            assessRequiredChecks(
                              run.acceptanceChecklist,
                              run.result?.checks ?? [],
                              card.execution?.acceptanceOverrides?.[action.id],
                            ).items.filter((item) => item.status === 'passed')
                              .length
                          }
                          /{run.acceptanceChecklist?.items.length ?? 0}
                        </p>
                        <p className="text-muted-foreground">
                          {t(
                            'The system has not verified these delivery references:',
                          )}
                        </p>
                        {hasUnsupportedAppArtifact(run) && (
                          <p className="text-xs text-amber-700 dark:text-amber-400">
                            {t('App bundle verification is not supported yet.')}
                          </p>
                        )}
                        <ul className="space-y-1 break-all font-mono text-xs">
                          {unverifiedDeliveryRefs(run).map((ref) => (
                            <li key={ref}>{ref}</li>
                          ))}
                        </ul>
                        <p className="text-xs text-muted-foreground">
                          {t(
                            'Artifact verification notes do not block acceptance when required checks pass.',
                          )}
                        </p>
                      </section>
                    ) : (
                      run.error && (
                        <p className="mt-3 whitespace-pre-wrap text-sm text-destructive">
                          {run.error}
                        </p>
                      )
                    )}
                    {run.evidenceErrors && (
                      <details className="mt-3 text-xs">
                        <summary>{t('Evidence validation details')}</summary>
                        <ul className="mt-2 space-y-1 break-all">
                          {run.evidenceErrors.map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {Boolean(run.unverifiedCheckRefs?.length) && (
                      <details className="mt-3 text-xs text-muted-foreground">
                        <summary>{t('Unverified check references')}</summary>
                        <p className="mt-2">
                          {t(
                            'These references were reported by the Agent; the host has not verified the commands or external results.',
                          )}
                        </p>
                        <ul className="mt-2 space-y-1 break-all">
                          {run.unverifiedCheckRefs!.map((ref) => (
                            <li key={ref}>{ref}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </details>
              ) : null}
              {run.coordination && (
                <details className="mt-4 border-t border-border pt-3 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    {t('Coordination record')} ·{' '}
                    {run.coordination.attempts.length} {t('calls')}
                  </summary>
                  <div className="mt-2 space-y-2">
                    {run.coordination.attempts.map((attempt) => (
                      <div
                        key={attempt.id}
                        className="rounded border border-border p-2"
                      >
                        <p>
                          {t(
                            attempt.role === 'coordinator'
                              ? 'Coordinator'
                              : 'Worker',
                          )}{' '}
                          · {attempt.phase} ·{' '}
                          {attempt.profile.model || t('Agent default')}
                        </p>
                        <p>{attempt.error ?? attempt.summary}</p>
                        <p className="text-muted-foreground">
                          {attempt.usage
                            ? `${attempt.usage.inputTokens} input · ${attempt.usage.cachedInputTokens} cached · ${attempt.usage.outputTokens} output`
                            : t('Usage not available')}
                        </p>
                        {run.coordination?.logRef && (
                          <a
                            className="underline"
                            target="_blank"
                            rel="noreferrer"
                            href={`/api/projects/${projectId}/execution-log?cardId=${card.id}&runId=${run.id}&attempt=${attempt.id}`}
                          >
                            {t('View recorded response')}
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {run.activityRef && (
                <a
                  className="mt-3 block text-xs underline"
                  href={`/api/projects/${projectId}/execution-log?cardId=${card.id}&runId=${run.id}&view=activity`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('View activity log')}
                </a>
              )}
              {run.observedRefs.some(
                (ref) => !ref.startsWith('checkpoint:'),
              ) && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {t('Observed file and Git changes')} ·{' '}
                    {
                      run.observedRefs.filter(
                        (ref) => !ref.startsWith('checkpoint:'),
                      ).length
                    }
                  </summary>
                  <ul className="mt-2 space-y-1 break-all font-mono text-xs">
                    {run.observedRefs
                      .filter((ref) => !ref.startsWith('checkpoint:'))
                      .map((ref) => (
                        <li key={ref}>{ref}</li>
                      ))}
                  </ul>
                </details>
              )}
            </details>
          ))}
        </div>
      )}
      {!accepted && current?.id === action.id ? (
        <AgentGraphComposerCard
          className="fixed z-30 m-0!"
          running={latest?.status === 'running' || running}
          collapsed={composerCollapsed}
          onCollapsedChange={setComposerCollapsed}
          title={t(history.length ? 'Modify or clarify' : 'Start this Action')}
        >
          {error ? (
            <p role="alert" className="mb-3 text-xs text-destructive">
              {error}
            </p>
          ) : null}
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
                  setFiles((current) =>
                    current.filter((_, item) => item !== index),
                  ),
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
                    onAddFiles={(candidates) => {
                      const markdown = candidates.filter((file) =>
                        /\.(md|markdown|txt|html|htm)$/i.test(file.name),
                      );
                      if (markdown.length !== candidates.length)
                        setError(
                          t('Only Markdown Resources can be added right now.'),
                        );
                      setFiles((current) =>
                        [...current, ...markdown].slice(0, 20),
                      );
                    }}
                    onRemoveFile={(index) =>
                      setFiles((current) =>
                        current.filter((_, item) => item !== index),
                      )
                    }
                    label={t('Optional sources')}
                    disabled={pending || running}
                  />
                }
                extraInfoCount={contextRefs.length + files.length}
                extraInfoLabel="Optional sources"
                value={profile}
                onChange={setProfile}
                disabled={
                  !enabled || (history.length > 0 && !instruction.trim())
                }
                running={pending}
                label="Execution profile"
                agents={justDoItAgents}
                actionLabel={
                  history.length ? 'Continue this Action' : 'Start this Action'
                }
                onRun={() => void send('start')}
              />
            }
          >
            <Textarea
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              maxLength={20000}
              disabled={pending || running}
              rows={4}
              className="min-h-24 resize-none text-sm"
              placeholder={t(
                history.length
                  ? 'Tell the Agent what to change or clarify…'
                  : 'Add requirements for this step, or leave empty to follow the confirmed Plan.',
              )}
              aria-label={t(
                history.length
                  ? 'Feedback for this Action'
                  : 'Additional Action instructions',
              )}
            />
          </AgentComposerShell>
        </AgentGraphComposerCard>
      ) : null}
      {headerActionsTarget
        ? createPortal(
            <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
              {canReturnToPlanning ? (
                <Button
                  className="bg-destructive text-white hover:bg-destructive/85"
                  disabled={pending || running}
                  onClick={() => {
                    setResetPreview(null);
                    void resetCard();
                  }}
                >
                  <RotateCcw />
                  {t('Roll back')}
                </Button>
              ) : null}
              {canUndo ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => setUndoOpen(true)}
                >
                  <Undo2 />
                  {t('Undo')}
                </Button>
              ) : null}
              {!accepted &&
              latest?.status !== 'running' &&
              latest?.result &&
              requiredPassed ? (
                <Button
                  disabled={!enabled || preparingAcceptance}
                  onClick={() => void prepareAcceptance()}
                >
                  {preparingAcceptance ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Check />
                  )}
                  {t('Pass')}
                </Button>
              ) : null}
              {latest?.status === 'running' ? (
                <Button
                  variant="outline"
                  disabled={
                    pending || latestResponse.document?.phase === 'stopping'
                  }
                  onClick={() => {
                    setError('');
                    setStopPreview({
                      runId: latest.id,
                      revision: card.revision,
                    });
                  }}
                >
                  <Square />
                  {t(
                    actionDocument?.phase === 'stopping'
                      ? 'Stopping'
                      : 'Cancel',
                  )}
                </Button>
              ) : null}
            </div>,
            headerActionsTarget,
          )
        : null}
      {headerStatusTarget
        ? createPortal(
            <ExecutionHeaderStatus
              document={
                actionDocument ??
                runDocument(
                  projectId,
                  card.id,
                  latest,
                  `Action ${card.actions.findIndex((item) => item.id === action.id) + 1}/${card.actions.length} · ${action.title}`,
                )
              }
              actionIndex={card.actions.findIndex(
                (item) => item.id === action.id,
              )}
              actionTotal={card.actions.length}
              actionTitle={action.title}
              checks={
                latest?.acceptanceChecklist
                  ? {
                      passed: requiredAssessment.items.filter(
                        (item) => item.status === 'passed',
                      ).length,
                      total: requiredAssessment.items.length,
                    }
                  : null
              }
              accepted={accepted}
              pullRequests={headerPullRequests}
              staleGithub={Boolean(
                headerGitHub?.error || latest?.github?.error,
              )}
              openingWorkspace={pending}
              onOpenWorkspace={
                card.execution?.workspace
                  ? () => void send('open-workspace')
                  : undefined
              }
            />,
            headerStatusTarget,
          )
        : null}
      <Dialog
        open={Boolean(stopPreview)}
        onOpenChange={(open) => {
          if (!open && !pending) setStopPreview(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Stop execution?')}</DialogTitle>
            <DialogDescription>
              {t(
                'Stopping keeps the current code and files. It does not restore an earlier version.',
              )}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setStopPreview(null)}
            >
              {t('Keep running')}
            </Button>
            <Button
              disabled={
                pending ||
                !running ||
                stopPreview?.runId !== latest?.id ||
                stopPreview?.revision !== card.revision
              }
              onClick={() => void send('cancel', stopPreview?.runId)}
            >
              {t('Stop execution')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={undoOpen}
        onOpenChange={(open) => {
          if (!pending) setUndoOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Undo this Action?')}</DialogTitle>
            <DialogDescription>
              {t(
                'Return this Action to its clean starting point. Previous passed Actions and the Plan stay unchanged.',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setUndoOpen(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              disabled={pending || !canUndo}
              onClick={() => void send('undo-action')}
            >
              {t('Undo')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(acceptancePreview)}
        onOpenChange={(open) => {
          if (!open && !pending) setAcceptancePreview(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('Confirm Action acceptance')}</DialogTitle>
            <DialogDescription>
              {t(
                'Review this output, required checks and any user overrides before confirming.',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <section className="space-y-1">
              <p className="font-medium">
                {action.title} · {t('Round')} {history.length}
              </p>
              <p className="whitespace-pre-wrap text-muted-foreground">
                {latest?.result?.summary}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('Code revision')}:{' '}
                <code>
                  {latest?.github?.outputHead?.slice(0, 12) ??
                    t('Not recorded')}
                </code>
              </p>
            </section>
            <section className="space-y-2 rounded-lg border border-border p-3">
              <p>
                {t('Required checks')}:{' '}
                {
                  requiredAssessment.items.filter(
                    (item) => item.status === 'passed',
                  ).length
                }
                /{requiredAssessment.items.length} ·{' '}
                {t(requiredPassed ? 'passed' : 'not-run')}
              </p>
              {requiredAssessment.items
                .filter((item) => item.override)
                .map((item) => (
                  <p
                    key={item.criterion.id}
                    className="text-amber-600 dark:text-amber-400"
                  >
                    {t('Passed by user decision')} · {item.criterion.criterion}:{' '}
                    {item.override!.note} ({t('Observed result')}:{' '}
                    {t(item.observed?.status ?? 'not-run')})
                  </p>
                ))}
            </section>
            {additionalChecks.some((check) => check.status !== 'passed') && (
              <section className="space-y-2">
                <h4 className="font-medium">
                  {t('Additional checks')} · non-blocker
                </h4>
                <ul className="list-disc space-y-1 pl-5 text-amber-600 dark:text-amber-400">
                  {additionalChecks
                    .filter((check) => check.status !== 'passed')
                    .map((check, index) => (
                      <li key={index}>{check.summary}</li>
                    ))}
                </ul>
              </section>
            )}
            {latest?.evidenceErrors && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-400">
                {t(
                  'Artifact verification notes do not block acceptance when required checks pass.',
                )}
              </p>
            )}
            <section className="space-y-1">
              <h4 className="font-medium">PR</h4>
              {latest?.github?.pullRequests.length ? (
                latest.github.pullRequests.map((pr) => (
                  <PullRequestChip
                    key={pr.url}
                    pr={pr}
                    stale={Boolean(latest.github?.error)}
                  />
                ))
              ) : (
                <p className="text-muted-foreground">{t('No PR')}</p>
              )}
              {latest?.github?.error && (
                <p className="text-amber-600 dark:text-amber-400">
                  {t('Stale status')}: {t(latest.github.error)}
                </p>
              )}
            </section>
            <p className="rounded-lg bg-muted p-3">
              {nextAction
                ? `${t('Acceptance unlocks the next Action')}: ${nextAction.title}.`
                : t('This is the final Action in this Plan.')}{' '}
              {t(
                'Nothing starts automatically. Acceptance does not merge a PR.',
              )}
            </p>
            {!requiredPassed && (
              <p className="text-amber-700 dark:text-amber-400">
                {t(
                  'Required checks are incomplete. Review them before confirming acceptance.',
                )}
              </p>
            )}
            {previewChanged && (
              <p className="text-destructive">
                {t(
                  'Output changed. Close this dialog and review the latest output before confirming.',
                )}
              </p>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </div>
          <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-background pt-3">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setAcceptancePreview(null)}
            >
              {t('Back to review')}
            </Button>
            <Button
              disabled={
                !enabled ||
                !requiredPassed ||
                !hasReviewableReport(latest) ||
                Boolean(previewChanged)
              }
              onClick={() => void send('accept', acceptancePreview?.runId)}
            >
              {t('Confirm acceptance')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={resetOpen}
        onOpenChange={(open) => {
          if (!pending) setResetOpen(open);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('Return to planning?')}</DialogTitle>
            <DialogDescription>
              {t(
                'Back up the current workspace, restore the Card baseline, clear accepted Actions, and reopen the Plan.',
              )}
            </DialogDescription>
          </DialogHeader>
          {resetPreview && (
            <>
              <p className="break-all text-xs">
                {resetPreview.path}
                <br />
                {resetPreview.branch}
                <br />
                {t('Base commit')}: {resetPreview.baseCommit.slice(0, 8)}
              </p>
              <p className="text-sm">
                {t(
                  'Main, GitHub repositories, PRs and installed apps are not reverted by this operation.',
                )}
              </p>
              {resetPreview.repositoryUrl && (
                <p className="break-all text-xs">
                  {resetPreview.repositoryUrl}
                </p>
              )}
              <Button
                className="bg-destructive text-white hover:bg-destructive/85"
                disabled={pending}
                onClick={() => void resetCard(resetPreview.token)}
              >
                {t('Confirm roll back')}
              </Button>
            </>
          )}
          {pending && <p className="text-sm">{t('Working…')}</p>}
          {resetError && (
            <p role="alert" className="text-sm text-destructive">
              {resetError}
            </p>
          )}
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => setResetOpen(false)}
          >
            {t('Cancel')}
          </Button>
        </DialogContent>
      </Dialog>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
