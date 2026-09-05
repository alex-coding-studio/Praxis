'use client';

import { summarizeGitHub } from '@/lib/github-delivery-summary';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  LoaderCircle,
  Pencil,
  Plus,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AgentComposerShell,
  AgentComposerAttachments,
} from '@/components/agent-composer-shell';
import { AgentGraphComposerCard } from '@/components/agent-graph-composer-card';
import { AgentGraphRunningCard } from '@/components/agent-graph-running-card';
import { AgentProfileSelector } from '@/components/agent-profile-selector';
import { AgentRunControls } from '@/components/agent-run-controls';
import { ModuleContextTrigger } from '@/components/module-context-trigger';
import { JustDoItAction } from '@/components/just-do-it-action';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ContextAttachmentPicker } from '@/components/context-attachment-picker';
import { PlanningStepDetails } from '@/components/planning-step-details';
import { GoalSourcePicker } from '@/components/goal-source-picker';
import { ProjectModuleHeader } from '@/components/project-module-header';
import { useUiText } from '@/components/ui-language-provider';
import { cn } from '@/lib/utils';
import type {
  PendingDependencyReview,
  PlanningCard,
  PlanningProfile,
} from '@/lib/modules/implementation/planning-service';
import type { PlanningSource } from '@/lib/modules/implementation/planning-sources';
import type { ContextBrowserFolder } from '@/lib/modules/product-context/catalog';

type View = {
  cards: PlanningCard[];
  sources: PlanningSource[];
  instructions: string;
  folders: ContextBrowserFolder[];
  dependencyReviews: Record<string, PendingDependencyReview[]>;
};
const justDoItAgents = ['codex', 'claude'] as const;
type Draft = {
  requirements: string;
  feedback: string;
  profile: PlanningProfile;
  coordinationProfile: PlanningProfile;
  files: Array<{ name: string; content: string }>;
  retainRefs: string[];
  contextRefs: string[];
  folder: string;
};
function initialDraft(card: PlanningCard): Draft {
  return {
    requirements: card.requirements,
    feedback: '',
    profile: card.run?.profile ?? { agent: 'codex', model: '', effort: '' },
    coordinationProfile: card.execution?.coordinationSettings?.profile ??
      card.run?.profile ?? { agent: 'codex', model: '', effort: '' },
    files: [],
    retainRefs: card.resources.map((item) => item.ref),
    contextRefs: [],
    folder: '',
  };
}

export function JustDoItLiveWorkspace({ projectId }: { projectId: string }) {
  const { t } = useUiText();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialSourceUid = searchParams.get('source') ?? undefined;
  const endpoint = `/api/projects/${projectId}/planning`;
  const [view, setView] = useState<View | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    searchParams.get('card'),
  );
  const [stepId, setStepId] = useState(
    () => searchParams.get('action') ?? 'overview',
  );
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncingMain, setSyncingMain] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  async function syncMain() {
    setSyncingMain(true);
    setSyncMessage('');
    try {
      const response = await fetch(`/api/projects/${projectId}/sync-main`, {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSyncMessage(
        t(data.updated ? 'Main synced.' : 'Main is already up to date.'),
      );
    } catch (cause) {
      setSyncMessage(
        t(cause instanceof Error ? cause.message : 'Could not sync main.'),
      );
    } finally {
      setSyncingMain(false);
    }
  }
  const [instructions, setInstructions] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionHeaderTarget, setActionHeaderTarget] =
    useState<HTMLDivElement | null>(null);
  const [actionHeaderStatusTarget, setActionHeaderStatusTarget] =
    useState<HTMLDivElement | null>(null);
  const [planHeaderStuck, setPlanHeaderStuck] = useState(false);
  const [planHeaderSentinel, setPlanHeaderSentinel] =
    useState<HTMLDivElement | null>(null);
  const attachPlanHeaderSentinel = useCallback(
    (element: HTMLDivElement | null) => {
      setPlanHeaderSentinel(element);
      setPlanHeaderStuck(false);
    },
    [],
  );
  const initialSourceHandled = useRef(false);
  const mounted = useRef(true);
  const refreshBusy = useRef(false);

  const updateSelectionLocation = useCallback(
    (cardId: string | null, actionId = 'overview') => {
      const params = new URLSearchParams(window.location.search);
      params.delete('source');
      if (cardId) params.set('card', cardId);
      else params.delete('card');
      if (cardId && actionId !== 'overview') params.set('action', actionId);
      else params.delete('action');
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router],
  );

  const refresh = useCallback(async () => {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (
        mounted.current &&
        initialSourceUid &&
        !initialSourceHandled.current
      ) {
        initialSourceHandled.current = true;
        const existing = (data.cards as PlanningCard[]).find(
          (item) => item.source.uid === initialSourceUid,
        );
        if (existing) {
          setSelectedId(existing.id);
          setStepId('overview');
          updateSelectionLocation(existing.id);
          setError(null);
        } else if (
          (data.sources as PlanningSource[]).some(
            (source) => source.uid === initialSourceUid,
          )
        ) {
          setImporting(true);
        }
      }
      if (mounted.current)
        setView((old) => {
          const cards = new Map<string, PlanningCard>(
            (old?.cards ?? []).map((item) => [item.id, item]),
          );
          for (const item of data.cards as PlanningCard[])
            if ((cards.get(item.id)?.revision ?? 0) <= item.revision)
              cards.set(item.id, item);
          return { ...data, cards: [...cards.values()] };
        });
    } catch (err) {
      if (mounted.current)
        setError(
          err instanceof Error ? err.message : t('Could not load planning.'),
        );
    } finally {
      refreshBusy.current = false;
    }
  }, [endpoint, initialSourceUid, t, updateSelectionLocation]);
  useEffect(() => {
    mounted.current = true;
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      mounted.current = false;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);
  const card = view?.cards.find((item) => item.id === selectedId);
  useEffect(() => {
    const sentinel = planHeaderSentinel;
    if (!sentinel) return;
    let active = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!active) return;
        setPlanHeaderStuck(
          Boolean(
            entry &&
            sentinel.isConnected &&
            sentinel.getClientRects().length &&
            entry.rootBounds &&
            entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0),
          ),
        );
      },
      { threshold: 1 },
    );
    observer.observe(sentinel);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [planHeaderSentinel]);
  const draft = card ? (drafts[card.id] ?? initialDraft(card)) : null;
  const selectedStep = card?.plan?.steps.find((item) => item.id === stepId);
  const running = card?.run?.status === 'running';
  const busy = pending || reading || Boolean(running);
  const finalized = card?.plan?.status === 'finalized';
  const currentActionId = finalized
    ? card?.actions.find(
        (action) => !card.execution?.acceptedActionIds.includes(action.id),
      )?.id
    : undefined;
  const scopedBusy = running && Boolean(card?.run?.targetId);
  const executionRunning = card?.execution?.runs.at(-1)?.status === 'running';
  const dependencyReview = card
    ? (view?.dependencyReviews?.[card.id] ?? [])
    : [];
  const deletable = Boolean(
    card &&
    !running &&
    card.plan?.status !== 'finalized' &&
    !card.actions.length &&
    !card.execution?.runs.length,
  );
  const requestedSource = view?.sources.find(
    (source) => source.uid === initialSourceUid,
  );

  function patchDraft(id: string, patch: Partial<Draft>) {
    setDrafts((old) => {
      const source = view?.cards.find((item) => item.id === id);
      return source
        ? { ...old, [id]: { ...(old[id] ?? initialDraft(source)), ...patch } }
        : old;
    });
  }
  async function mutate(payload: Record<string, unknown>) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (data.card && mounted.current)
        setView((old) => {
          if (
            !old ||
            (old.cards.find((item) => item.id === data.card.id)?.revision ??
              0) > data.card.revision
          )
            return old;
          return {
            ...old,
            cards: [
              data.card,
              ...old.cards.filter((item) => item.id !== data.card.id),
            ],
          };
        });
      if (data.deleted && mounted.current) {
        setView((old) =>
          old
            ? {
                ...old,
                cards: old.cards.filter((item) => item.id !== data.cardId),
              }
            : old,
        );
        setSelectedId(null);
        setStepId('overview');
        updateSelectionLocation(null);
      }
      return data.card as PlanningCard | undefined;
    } catch (err) {
      if (mounted.current)
        setError(
          err instanceof Error ? err.message : t('Planning request failed.'),
        );
      return undefined;
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  async function generate(targetId: string | null) {
    if (!card || !draft) return;
    const saved = await mutate({
      action: 'start',
      cardId: card.id,
      expectedRevision: card.revision,
      ...draft,
      ...(targetId
        ? {
            requirements: card.requirements,
            files: [],
            contextRefs: [],
            retainRefs: card.resources.map((item) => item.ref),
          }
        : {}),
      targetId,
    });
    if (saved) {
      patchDraft(card.id, {
        feedback: '',
        files: [],
        contextRefs: [],
        retainRefs: saved.resources.map((item) => item.ref),
      });
      setEditing(null);
    }
  }
  function command(action: string) {
    if (card)
      void mutate({ action, cardId: card.id, expectedRevision: card.revision });
  }
  function openCard(id: string) {
    setSelectedId(id);
    setStepId('overview');
    updateSelectionLocation(id);
    setError(null);
  }
  function closeCard() {
    setSelectedId(null);
    setStepId('overview');
    updateSelectionLocation(null);
  }
  function selectStep(id: string) {
    if (!card) return;
    setStepId(id);
    updateSelectionLocation(card.id, id);
  }
  async function addFiles(files: File[]) {
    if (!card || !draft) return;
    const id = card.id;
    setReading(true);
    try {
      if (
        draft.files.length +
          draft.retainRefs.length +
          draft.contextRefs.length +
          files.length >
        5
      )
        throw new Error(t('Attach no more than five resources.'));
      const values = await Promise.all(
        files.map(async (file) => {
          if (
            file.size > 262144 ||
            !/\.(md|markdown|txt|html|htm)$/i.test(file.name)
          )
            throw new Error(t('Use text or Markdown files up to 256 KB.'));
          return { name: file.name, content: await file.text() };
        }),
      );
      if (mounted.current)
        patchDraft(id, { files: [...draft.files, ...values] });
    } catch (err) {
      if (mounted.current)
        setError(String(err instanceof Error ? err.message : err));
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  const attachmentPicker = (embedded = false) =>
    card &&
    draft && (
      <ContextAttachmentPicker
        embedded={embedded}
        folders={view?.folders ?? []}
        folderPath={draft.folder || view?.folders[0]?.path || ''}
        onFolderPath={(folder) => patchDraft(card.id, { folder })}
        refs={draft.contextRefs}
        onToggleRef={(ref) =>
          patchDraft(card.id, {
            contextRefs: draft.contextRefs.includes(ref)
              ? draft.contextRefs.filter((item) => item !== ref)
              : [...draft.contextRefs, ref],
          })
        }
        files={[
          ...card.resources.filter((item) =>
            draft.retainRefs.includes(item.ref),
          ),
          ...draft.files,
        ]}
        onAddFiles={(files) => void addFiles(files)}
        onRemoveFile={(index) => {
          const retained = card.resources.filter((item) =>
            draft.retainRefs.includes(item.ref),
          );
          if (index < retained.length)
            patchDraft(card.id, {
              retainRefs: draft.retainRefs.filter(
                (ref) => ref !== retained[index].ref,
              ),
            });
          else
            patchDraft(card.id, {
              files: draft.files.filter(
                (_, i) => i !== index - retained.length,
              ),
            });
        }}
        label={t('Extra resources')}
        disabled={busy}
        accept=".md,.markdown,.txt"
      />
    );

  const setup = card && draft && (
    <div className="space-y-3">
      <label className="block text-xs font-medium">
        {t('Original input')}
        <Textarea
          className="mt-1 min-h-24 resize-none text-sm"
          value={draft.requirements}
          disabled={busy}
          onChange={(event) =>
            patchDraft(card.id, { requirements: event.target.value })
          }
        />
      </label>
      {attachmentPicker()}
    </div>
  );

  return (
    <div className="relative flex min-h-dvh flex-col">
      <ProjectModuleHeader
        title={t('Implementation')}
        description={t(
          'Plan together, execute one Action, then verify the output.',
        )}
        actions={
          <>
            {syncMessage ? (
              <output className="max-w-64 text-xs text-muted-foreground">
                {syncMessage}
              </output>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={syncingMain}
              onClick={() => void syncMain()}
            >
              <RefreshCw className={cn(syncingMain && 'animate-spin')} />
              {t(syncingMain ? 'Syncing…' : 'Sync Up')}
            </Button>
            <ModuleContextTrigger
              disabled={!view}
              onClick={() => setContextOpen(true)}
            />
          </>
        }
      />
      <div
        className={cn(
          'w-full space-y-5 px-5 py-6 lg:pr-5 lg:pl-8',
          card && 'mx-auto max-w-[1440px]',
        )}
      >
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {!view ? (
          <p className="flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin" />
            {t('Loading')}
          </p>
        ) : !card ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                {t('Add a formal Node, then plan with your Agent.')}
              </p>
              <Button className="ml-auto" onClick={() => setImporting(true)}>
                <Plus />
                {t('Add a goal')}
              </Button>
            </div>
            {!view.cards.length && (
              <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
                {t('No goals yet. Add a formal Node to start planning.')}
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {view.cards.map((item) => (
                <button
                  key={item.id}
                  onClick={() => openCard(item.id)}
                  className="flex h-60 flex-col rounded-2xl border border-border bg-card p-4 text-left hover:border-foreground/40"
                >
                  <div className="grid h-12 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                    <h2 className="line-clamp-2 font-semibold">
                      {item.source.title}
                    </h2>
                    <span
                      className={cn(
                        'rounded-full px-2 py-1 text-[10px]',
                        item.actions.length > 0 &&
                          item.execution?.acceptedActionIds.length ===
                            item.actions.length
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : 'bg-secondary text-muted-foreground',
                      )}
                    >
                      {item.run?.status === 'running' ||
                      item.execution?.runs.at(-1)?.status === 'running' ? (
                        <span
                          aria-hidden="true"
                          data-running-marker="true"
                          className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-sky-500 align-middle"
                        />
                      ) : null}
                      {t(
                        item.run?.status === 'running' ||
                          item.execution?.runs.at(-1)?.status === 'running'
                          ? 'Agent running'
                          : item.actions.length > 0 &&
                              item.execution?.acceptedActionIds.length ===
                                item.actions.length
                            ? 'Verified'
                            : item.execution?.runs.at(-1)?.result
                              ? 'Needs attention'
                              : item.plan?.status === 'finalized'
                                ? 'Plan finalized'
                                : item.run?.status === 'failed'
                                  ? 'Needs attention'
                                  : 'Planning',
                      )}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                    {item.source.summary}
                  </p>
                  <p className="mt-auto text-xs text-muted-foreground">
                    {item.plan
                      ? `${t('Plan')} · ${item.plan.steps.length}`
                      : t('Not planned yet')}
                  </p>
                  {Boolean(item.execution?.runs.some((run) => run.github)) && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      GitHub ·{' '}
                      {summarizeGitHub(item.execution!.runs)
                        .map(
                          ({ pr, stale }) =>
                            `#${pr.number} ${t(pr.state)}${stale ? ` (${t('Stale status')})` : ''}`,
                        )
                        .join(' · ') ||
                        t('No verified PR association for this output.')}
                    </p>
                  )}
                  <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-[10px] text-muted-foreground">
                    <span>
                      {t('Completed Actions')} ·{' '}
                      {item.execution?.acceptedActionIds.length ?? 0} /{' '}
                      {item.actions.length}
                    </span>
                    <span>
                      {view.sources.some(
                        (source) => source.uid === item.source.uid,
                      )
                        ? `Node-${item.source.id.slice(5)}`
                        : t('Source node deleted')}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={closeCard}>
              <ArrowLeft />
              {t('All goals')}
            </Button>
            <header>
              <div className="flex items-center justify-between gap-4">
                <h2 className="min-w-0 text-2xl font-semibold">
                  {card.source.title}
                </h2>
                {card.actions.length > 0 &&
                  card.actions.every((action) =>
                    card.execution?.acceptedActionIds.includes(action.id),
                  ) && (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                      <Check aria-hidden="true" className="size-4" />
                      {t('Completed')}
                    </span>
                  )}
              </div>
              <details className="mt-3 text-sm text-muted-foreground">
                <summary className="cursor-pointer">{t('Source')}</summary>
                <p className="mt-2">{card.source.summary}</p>
                <p className="mt-2 font-mono text-xs">{card.source.id}</p>
                {card.source.dependsOn.length > 0 && (
                  <p className="mt-2">
                    {t('Prerequisites not yet verified')}:{' '}
                    {card.source.dependsOn.join(', ')}
                  </p>
                )}
              </details>
              {deletable && (
                <Button
                  className="mt-3"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDeleteOpen(true)}
                >
                  {t('Delete this Card')}
                </Button>
              )}
            </header>
            {running && !scopedBusy && (
              <>
                <div
                  ref={attachPlanHeaderSentinel}
                  aria-hidden="true"
                  className="h-px"
                />
                <AgentGraphRunningCard
                  className={cn(
                    'sticky top-0 z-30 transition-[border-radius] duration-150',
                    planHeaderStuck ? 'rounded-b-xl border-t-0' : 'rounded-xl',
                  )}
                  agent={card.run?.profile.agent ?? 'codex'}
                  startedAt={card.run?.startedAt ?? new Date().toISOString()}
                  activity={[]}
                  fallback="Preparing your plan…"
                  cancelDisabled={pending}
                  onCancel={() => command('cancel')}
                />
              </>
            )}
            {dependencyReview.length > 0 && (
              <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
                <h2 className="text-sm font-semibold">
                  {t('Dependency review required')}
                </h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t(
                    'This Card derives from unfinished Nodes that were not marked as prerequisites. Classify each one before planning or confirming this Card.',
                  )}
                </p>
                <div className="mt-3 space-y-3">
                  {dependencyReview.map((item) => (
                    <div
                      key={item.uid}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                    >
                      <div>
                        <p className="text-sm font-medium">{item.title}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {item.id}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void mutate({
                              action: 'resolve-dependency',
                              cardId: card.id,
                              expectedRevision: card.revision,
                              sourceUid: item.uid,
                              decision: 'lineage-only',
                            })
                          }
                        >
                          {t('Conceptual source only')}
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void mutate({
                              action: 'resolve-dependency',
                              cardId: card.id,
                              expectedRevision: card.revision,
                              sourceUid: item.uid,
                              decision: 'dependency',
                            })
                          }
                        >
                          {t('Add as prerequisite')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {card.run?.error && (
              <p
                role="alert"
                className="rounded-xl border border-destructive/30 p-3 text-sm text-destructive"
              >
                {card.run.error}
              </p>
            )}
            {running && !scopedBusy ? (
              <AgentGraphComposerCard
                className="fixed z-30 m-0!"
                title=""
                running
              />
            ) : !card.plan ? (
              <AgentGraphComposerCard
                title={
                  <span className="flex items-center gap-2">
                    <Sparkles className="size-4 text-muted-foreground" />
                    {t('Start planning')}
                  </span>
                }
                description={t(
                  'This goal is here. Nothing has been planned or started yet.',
                )}
              >
                <AgentComposerAttachments
                  label={t('Extra info')}
                  className="mb-3"
                  items={[
                    ...draft!.contextRefs.map((ref) => ({
                      id: ref,
                      label: ref.split('/').at(-1) ?? ref,
                      onRemove: () =>
                        patchDraft(card.id, {
                          contextRefs: draft!.contextRefs.filter(
                            (item) => item !== ref,
                          ),
                        }),
                    })),
                    ...card.resources
                      .filter((item) => draft!.retainRefs.includes(item.ref))
                      .map((item) => ({
                        id: item.ref,
                        label: item.name,
                        onRemove: () =>
                          patchDraft(card.id, {
                            retainRefs: draft!.retainRefs.filter(
                              (ref) => ref !== item.ref,
                            ),
                          }),
                      })),
                    ...draft!.files.map((file, index) => ({
                      id: `file-${index}`,
                      label: file.name,
                      onRemove: () =>
                        patchDraft(card.id, {
                          files: draft!.files.filter((_, i) => i !== index),
                        }),
                    })),
                  ]}
                />
                <AgentComposerShell
                  controls={
                    <AgentRunControls
                      key={card.id}
                      value={draft!.profile}
                      onChange={(profile) => patchDraft(card.id, { profile })}
                      disabled={busy || dependencyReview.length > 0}
                      actionLabel="Start planning"
                      agents={justDoItAgents}
                      extraInfo={attachmentPicker(true)}
                      extraInfoCount={
                        draft!.files.length +
                        draft!.retainRefs.length +
                        draft!.contextRefs.length
                      }
                      onRun={() => void generate(null)}
                    />
                  }
                >
                  <Textarea
                    className="min-h-24 resize-none text-sm"
                    aria-label={t('Your requirements')}
                    placeholder={t('Your requirements')}
                    value={draft!.requirements}
                    disabled={busy}
                    onChange={(event) =>
                      patchDraft(card.id, { requirements: event.target.value })
                    }
                  />
                </AgentComposerShell>
              </AgentGraphComposerCard>
            ) : (
              <section className="space-y-4">
                <div
                  ref={attachPlanHeaderSentinel}
                  aria-hidden="true"
                  className="h-px"
                />
                <header
                  className={cn(
                    'sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border border-border bg-background/95 p-4 shadow-sm backdrop-blur transition-[border-radius] duration-150',
                    planHeaderStuck ? 'rounded-b-xl border-t-0' : 'rounded-xl',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    {finalized ? (
                      <div
                        ref={setActionHeaderStatusTarget}
                        className="min-w-0"
                      />
                    ) : (
                      <>
                        <span className="text-sm font-medium">
                          {t('Plan preview')}
                        </span>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {t(
                            'Review each step, then confirm the entire plan to create Actions.',
                          )}
                        </p>
                      </>
                    )}
                  </div>
                  <div
                    className={cn(
                      'flex flex-wrap justify-end gap-3',
                      finalized ? 'items-end' : 'items-center',
                    )}
                  >
                    {finalized ? (
                      <div className="flex min-w-0 flex-col items-end gap-2">
                        <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-secondary/40 pl-2">
                          <span className="text-xs font-medium">
                            {t('Coordinator')}
                          </span>
                          <AgentProfileSelector
                            value={draft!.coordinationProfile}
                            onChange={(coordinationProfile) =>
                              patchDraft(card.id, { coordinationProfile })
                            }
                            disabled={busy || executionRunning}
                            label="Coordination profile"
                            showStatus={false}
                            agents={justDoItAgents}
                            triggerClassName="h-7 focus-visible:ring-inset"
                          />
                        </div>
                        <div className="flex min-h-8 w-full items-center justify-end gap-2">
                          {!card.execution?.runs.length ? (
                            <Button
                              className="w-full"
                              variant="outline"
                              disabled={busy}
                              onClick={() => command('reopen')}
                            >
                              <Pencil />
                              {t('Adjust whole plan')}
                            </Button>
                          ) : (
                            <div
                              ref={setActionHeaderTarget}
                              className="flex items-center gap-2"
                            />
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => setEditing('whole')}
                        >
                          <Pencil />
                          {t('Adjust whole plan')}
                        </Button>
                        <Button
                          disabled={
                            busy ||
                            card.run?.status !== 'succeeded' ||
                            dependencyReview.length > 0
                          }
                          onClick={() => command('finalize')}
                        >
                          <Check />
                          {t('Confirm entire plan')}
                        </Button>
                      </>
                    )}
                  </div>
                </header>
                <div className="grid items-start gap-4 xl:grid-cols-[238px_minmax(0,1fr)]">
                  <aside className="rounded-2xl border border-border bg-card p-3">
                    <h2 className="px-2 py-2 text-xs text-muted-foreground">
                      {t(finalized ? 'Actions' : 'Plan')} ·{' '}
                      {card.plan.steps.length}
                    </h2>
                    <button
                      aria-pressed={!selectedStep}
                      className={cn(
                        'mb-2 w-full rounded-xl px-3 py-3 text-left text-sm',
                        !selectedStep && 'bg-secondary',
                      )}
                      onClick={() => selectStep('overview')}
                    >
                      {t('Overview')}
                    </button>
                    {card.plan.steps.map((step, index) => (
                      <button
                        key={step.id}
                        aria-pressed={step.id === stepId}
                        aria-busy={running && card.run?.targetId === step.id}
                        onClick={() => selectStep(step.id)}
                        className={cn(
                          'flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left',
                          step.id === stepId
                            ? 'bg-secondary'
                            : 'hover:bg-secondary/50',
                        )}
                      >
                        <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="text-sm leading-5">{step.title}</span>
                        {card.execution?.acceptedActionIds.includes(
                          step.id,
                        ) && (
                          <Check className="ml-auto size-4 shrink-0 text-emerald-500" />
                        )}
                        {card.execution?.runs.at(-1)?.actionId === step.id &&
                          card.execution.runs.at(-1)?.status === 'running' && (
                            <LoaderCircle className="ml-auto size-4 shrink-0 animate-spin text-blue-500" />
                          )}
                        {step.id === currentActionId &&
                          card.execution?.runs.some(
                            (run) => run.actionId === step.id,
                          ) &&
                          card.execution.runs.at(-1)?.status !== 'running' && (
                            <span
                              className="ml-auto shrink-0 text-blue-500"
                              title={t('Current Action')}
                            >
                              <span className="sr-only">
                                {t('Current Action')}
                              </span>
                              <ArrowRight
                                aria-hidden="true"
                                className="size-4"
                              />
                            </span>
                          )}
                        {running && card.run?.targetId === step.id && (
                          <LoaderCircle className="ml-auto size-4 shrink-0 animate-spin" />
                        )}
                      </button>
                    ))}
                  </aside>
                  <article
                    aria-busy={Boolean(
                      running && selectedStep?.id === card.run?.targetId,
                    )}
                    className="relative min-w-0 rounded-2xl border border-border bg-card p-5"
                  >
                    <div
                      className={cn(
                        running &&
                          selectedStep?.id === card.run?.targetId &&
                          'invisible',
                      )}
                      inert={
                        (running && selectedStep?.id === card.run?.targetId) ||
                        undefined
                      }
                    >
                      {selectedStep ? (
                        <>
                          <header className="mb-5 flex items-start justify-between gap-3">
                            <h2 className="text-xl font-semibold leading-8">
                              {selectedStep.title}
                            </h2>
                            {!finalized && (
                              <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() => setEditing(selectedStep.id)}
                              >
                                {t('Adjust this step')}
                              </Button>
                            )}
                          </header>
                          <PlanningStepDetails step={selectedStep} />
                          {finalized && (
                            <JustDoItAction
                              key={`${card.id}:${selectedStep.id}`}
                              projectId={projectId}
                              card={card}
                              action={selectedStep}
                              coordinatorProfile={draft!.coordinationProfile}
                              folders={view.folders}
                              headerActionsTarget={actionHeaderTarget}
                              headerStatusTarget={actionHeaderStatusTarget}
                              onChange={(updated) =>
                                setView((old) =>
                                  old
                                    ? {
                                        ...old,
                                        cards: old.cards.map((item) =>
                                          item.id === updated.id &&
                                          item.revision <= updated.revision
                                            ? updated
                                            : item,
                                        ),
                                      }
                                    : old,
                                )
                              }
                            />
                          )}
                        </>
                      ) : (
                        <>
                          <h2 className="text-xl font-semibold">
                            {t('Overview')}
                          </h2>
                          <p className="mt-3 whitespace-pre-wrap text-sm leading-7">
                            {card.plan.overview}
                          </p>
                          <h3 className="mt-5 text-xs text-muted-foreground">
                            {t("This plan's scope")}
                          </h3>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-7">
                            {card.requirements || card.source.summary}
                          </p>
                        </>
                      )}
                    </div>
                    {running && selectedStep?.id === card.run?.targetId && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-5 text-center">
                        <LoaderCircle className="size-7 animate-spin text-blue-500" />
                        <p>{t('Updating this planned step…')}</p>
                        <p className="text-xs text-muted-foreground">
                          {t(
                            'Only this step is updating. You can still browse the plan on the left.',
                          )}
                        </p>
                        <Button
                          variant="outline"
                          disabled={pending}
                          onClick={() => command('cancel')}
                        >
                          {t('Cancel')}
                        </Button>
                      </div>
                    )}
                  </article>
                </div>
                {scopedBusy && selectedStep?.id !== card.run?.targetId && (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => command('cancel')}
                  >
                    {t('Cancel')}
                  </Button>
                )}
              </section>
            )}
          </>
        )}
      </div>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Delete this Card?')}</DialogTitle>
            <DialogDescription>
              {t(
                'The Implementation Card and its unconfirmed draft will move to system Trash. Its upstream source remains unchanged.',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button
              disabled={!card || pending}
              onClick={async () => {
                if (!card) return;
                await mutate({
                  action: 'delete-card',
                  cardId: card.id,
                  expectedRevision: card.revision,
                });
                setDeleteOpen(false);
              }}
            >
              {t('Move Card to Trash')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={contextOpen} onOpenChange={setContextOpen}>
        <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('Working instructions')}</DialogTitle>
            <DialogDescription>
              {t(
                'Applies to every Implementation Card in this project. System workflow rules are built in; only add your own preferences here. Changes apply to new planning runs, not running Agents.',
              )}
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            <span>{t('Custom instructions (optional)')}</span>
            <Textarea
              className="min-h-64"
              maxLength={20000}
              placeholder={t(
                'Add development conventions or local Skill instructions. Leave empty to use the built-in workflow.',
              )}
              value={instructions ?? view?.instructions ?? ''}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            disabled={pending || !view}
            onClick={async () => {
              await mutate({
                action: 'instructions',
                instructions: instructions ?? view?.instructions,
              });
              void refresh();
            }}
          >
            {t('Save')}
          </Button>
        </DialogContent>
      </Dialog>
      <GoalSourcePicker
        key={requestedSource?.module ?? 'default'}
        open={importing}
        onOpenChange={setImporting}
        sources={view?.sources ?? []}
        cards={view?.cards ?? []}
        pending={pending}
        error={error}
        initialModule={requestedSource?.module}
        onChoose={async (source) => {
          const existing = view?.cards.find(
            (item) => item.source.uid === source.uid,
          );
          if (existing) return;
          const imported = await mutate({
            action: 'import',
            module: source.module,
            uid: source.uid,
          });
          if (imported) {
            openCard(imported.id);
            setImporting(false);
          }
        }}
      />
      <Dialog
        open={editing !== null && Boolean(card)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t(
                editing === 'whole' ? 'Adjust whole plan' : 'Adjust this step',
              )}
            </DialogTitle>
          </DialogHeader>
          {editing === 'whole' && setup}
          {card && draft && (
            <>
              <label className="text-sm">
                {t('Requested step change')}
                <Textarea
                  className="mt-2 min-h-32"
                  value={draft.feedback}
                  onChange={(event) =>
                    patchDraft(card.id, { feedback: event.target.value })
                  }
                  disabled={busy}
                />
              </label>
              <Button
                disabled={busy || !draft.feedback.trim()}
                onClick={() =>
                  void generate(editing === 'whole' ? null : editing)
                }
              >
                {t('Send to Agent')}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
