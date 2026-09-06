'use client';
import { useDeliveryStates } from '@/hooks/use-delivery-states';
import { useUiText } from '@/components/ui-language-provider';
import { useRouter } from 'next/navigation';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  FileText,
  ArrowRight,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { AgentProfileSelector } from '@/components/agent-profile-selector';
import {
  AgentComposerAttachments,
  AgentComposerShell,
} from '@/components/agent-composer-shell';
import { AgentRunControls } from '@/components/agent-run-controls';
import { AgentGraphComposerCard } from '@/components/agent-graph-composer-card';
import { LatestResponseCard } from '@/components/latest-response-card';
import { useLatestResponse } from '@/hooks/use-latest-response';
import { useSurfacePreference } from '@/hooks/use-surface-preference';
import type { LatestResponseDocument } from '@/lib/execution-observability/types';
import { AgentGraphIntentionSelect } from '@/components/agent-graph-intention-select';
import { AgentGraphMotionSelect } from '@/components/agent-graph-motion-select';
import { sameModelSelection, type AgentProfile } from '@/lib/agents/profile';
import {
  ContextAttachmentPicker,
  contextAttachmentTitle,
} from '@/components/context-attachment-picker';
import { WhatsNextContextToolbar } from '@/components/whats-next-context-toolbar';
import { createBrowserUuid } from '@/lib/browser-uuid';
import {
  MarkdownReader,
  type MarkdownFeedbackSelection,
} from '@/components/markdown-reader';
import { MarkdownReaderDialog } from '@/components/markdown-reader-dialog';
import {
  NodeProvenanceFacts,
  NodeResourceSections,
} from '@/components/node-property-sections';
import { TaskGraphCanvas } from '@/components/task-graph-canvas';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ContextBrowserFolder } from '@/lib/modules/product-context/catalog';
import type { TaskGraphNode } from '@/lib/graph/task/nodes';
import type { TaskGraphPreview } from '@/lib/graph/task/layout';
import { replaceRunWithPreviewsInPlace } from '@/lib/graph/task/preview-state';
import { getTaskGraphRelationships } from '@/lib/graph/task/rules';
import type { LocalAgentKind } from '@/lib/agents/transport';
import { WHATS_NEXT_HARNESS_REVISION } from '@/lib/modules/product-discovery/harness';
import { renderWhatsNextResponseMarkdown } from '@/lib/modules/product-discovery/response';
import type {
  WhatsNextFeedbackAnchor,
  WhatsNextRunRecord,
} from '@/lib/modules/product-discovery/runs';
import { cn } from '@/lib/utils';
import {
  redoProposalPlan,
  redoProposalContext,
  redoProposalInputRun,
} from '@/lib/modules/product-discovery/redo';
import type {
  WhatsNextIntention,
  WhatsNextLayer,
  WhatsNextMotion,
} from '@/lib/modules/product-discovery/intention';
import {
  intentionDestination,
  whatsNextIntentionRegistry,
  whatsNextMotionRegistry,
} from '@/lib/modules/product-discovery/intention';
import { toggleWhatsNextSelection } from '@/lib/modules/product-discovery/selection';
import { LatestResponseActions } from '@/components/latest-response';
import { latestWhatsNextResponse } from '@/lib/latest-response';
import {
  proposalFocusNodeIds,
  reconcileProposalRuns,
} from '@/lib/graph/agent/proposal';
import { titleFromAgentGraphIdea } from '@/lib/graph/agent/source';
import { whatsNextRunToPreviews } from '@/lib/modules/product-discovery/previews';
import {
  CandidateMetadataSections,
  CandidateResourceList,
  ProposalWorkspaceStatus,
} from '@/components/agent-graph-proposal-workspace';

const AGENT_LABELS: Record<LocalAgentKind, string> = {
  codex: 'Codex',
  claude: 'Claude',
  deepseek: 'DeepSeek',
};

type RunSnapshot = {
  sourceNodeIds: string[];
  instruction: string;
  contextRefs: string[];
  files: File[];
  revisionTarget?: { runId: string; candidateId: string };
  redoProposal?: boolean;
  intention: WhatsNextIntention;
  motion: WhatsNextMotion;
};

type CombineDraft = Pick<
  RunSnapshot,
  'sourceNodeIds' | 'instruction' | 'contextRefs' | 'files'
>;

export function WhatsNextWorkspace(
  props: Parameters<typeof WhatsNextCanvas>[0],
) {
  return (
    <div className="flex h-dvh min-h-[480px] flex-col">
      <WhatsNextContextToolbar
        projectId={props.projectId}
        disabled={props.developmentPreview}
      />
      <div className="min-h-0 flex-1">
        <WhatsNextCanvas {...props} />
      </div>
    </div>
  );
}

function WhatsNextCanvas({
  projectId,
  folders,
  initialNodes,
  initialRuns = [],
  initialResponse = null,
  developmentPreview = false,
  developmentTransitionRun,
  developmentCompletionRun,
}: {
  projectId: string;
  initialResponse?: LatestResponseDocument | null;
  folders: ContextBrowserFolder[];
  initialNodes: TaskGraphNode[];
  initialRuns?: WhatsNextRunRecord[];
  developmentPreview?: boolean;
  developmentTransitionRun?: WhatsNextRunRecord;
  developmentCompletionRun?: WhatsNextRunRecord;
}) {
  const { t } = useUiText();
  const deliveryStates = useDeliveryStates(projectId);
  const router = useRouter();
  const [nodes, setNodes] = useState(initialNodes);
  const [previews, setPreviews] = useState<TaskGraphPreview[]>(
    mergePreviews([], initialRuns.flatMap(whatsNextRunToPreviews)),
  );
  const [runs, setRuns] = useState<WhatsNextRunRecord[]>(initialRuns);
  const [agentProfile, setAgentProfile] = useState<AgentProfile>(
    initialRuns.at(-1)?.profile ?? {
      agent: agentForRun(initialRuns.at(-1)),
      model: '',
      effort: '',
    },
  );
  const selectedAgent = agentProfile.agent;
  const [error, setError] = useState('');

  const [idea, setIdea] = useState('');
  const [starting, setStarting] = useState(false);
  const [startRefs, setStartRefs] = useState<string[]>([]);
  const [startFiles, setStartFiles] = useState<File[]>([]);
  const [startFolderPath, setStartFolderPath] = useState(
    folders[0]?.path ?? '',
  );

  const [growSourceId, setGrowSourceId] = useState('');
  const [growInstruction, setGrowInstruction] = useState('');
  const [redoProposal, setRedoProposal] = useState(false);
  const [redoUserInput, setRedoUserInput] = useState<{
    key: string;
    markdown: string;
  } | null>(null);
  const [loadingRedoUserInput, setLoadingRedoUserInput] = useState(false);
  const [submittingGrow, setSubmittingGrow] = useState(false);
  const [growRefs, setGrowRefs] = useState<string[]>([]);
  const [growFiles, setGrowFiles] = useState<File[]>([]);
  const [growFolderPath, setGrowFolderPath] = useState(folders[0]?.path ?? '');

  const [combineIds, setCombineIds] = useState<string[]>([]);
  const [combineInstruction, setCombineInstruction] = useState('');
  const [combineRefs, setCombineRefs] = useState<string[]>([]);
  const [combineFiles, setCombineFiles] = useState<File[]>([]);
  const [combineFolderPath, setCombineFolderPath] = useState(
    folders[0]?.path ?? '',
  );
  const combineDraftRef = useRef<CombineDraft>({
    sourceNodeIds: [],
    instruction: '',
    contextRefs: [],
    files: [],
  });
  useEffect(() => {
    combineDraftRef.current = {
      sourceNodeIds: combineIds,
      instruction: combineInstruction,
      contextRefs: combineRefs,
      files: combineFiles,
    };
  }, [combineFiles, combineIds, combineInstruction, combineRefs]);
  const [intention, setIntention] =
    useState<WhatsNextIntention>('mvp-exploration');
  const [motion, setMotion] = useState<WhatsNextMotion>('unspecified');
  const [activeLayer, setActiveLayer] = useState<WhatsNextLayer>('discovery');

  const [focusedNodeId, setFocusedNodeId] = useState('');
  const [inspectorId, setInspectorId] = useState('');
  const [locateRequest, setLocateRequest] = useState<{
    nodeId: string;
    sequence: number;
  } | null>(null);
  const [proposalFocusSequence, setProposalFocusSequence] = useState(0);
  const [revisionTarget, setRevisionTarget] = useState<{
    runId: string;
    candidateId: string;
  } | null>(null);
  const [reviseNote, setReviseNote] = useState('');
  const [feedbackDraft, setFeedbackDraft] = useState<{
    selection: MarkdownFeedbackSelection;
    instruction: string;
    feedbackId?: string;
  } | null>(null);
  const [pendingFeedback, setPendingFeedback] = useState<
    WhatsNextFeedbackAnchor[]
  >([]);
  const [preview, setPreview] = useState<{
    title: string;
    path: string;
    markdown: string;
  } | null>(null);
  const [comparison, setComparison] = useState<{
    title: string;
    previous: string;
    current: string;
  } | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [editStartId, setEditStartId] = useState('');
  const [editText, setEditText] = useState('');
  const [savingStart, setSavingStart] = useState(false);
  const [deletingNodeId, setDeletingNodeId] = useState('');
  const runSnapshots = useRef(new Map<string, RunSnapshot>());
  const restoredRuns = useRef(false);
  const locateSequence = useRef(0);

  const growSource = nodes.find((node) => node.id === growSourceId) ?? null;
  const redoBoundary = (() => {
    if (!growSource)
      return {
        count: 0,
        reason: '',
        context: null,
        inputRun: null,
        inputKey: '',
      };
    try {
      const plan = redoProposalPlan(nodes, runs, [growSource.id]);
      const inputRun = redoProposalInputRun(plan) ?? null;
      const inputKey = inputRun?.input?.userInputPath
        ? `${inputRun.runId}:${inputRun.input.userInputPath}`
        : '';
      return {
        count: plan.candidateIds.length,
        context: redoProposalContext(
          plan,
          inputKey && redoUserInput?.key === inputKey
            ? redoUserInput.markdown
            : undefined,
        ),
        reason: '',
        inputRun,
        inputKey,
      };
    } catch (error) {
      return {
        count: 0,
        context: null,
        inputRun: null,
        inputKey: '',
        reason:
          error instanceof Error ? error.message : 'Cannot redo this proposal.',
      };
    }
  })();
  const editStart = nodes.find((node) => node.id === editStartId) ?? null;
  const combineNodes = combineIds.flatMap((nodeId) => {
    const node = nodes.find((value) => value.id === nodeId);
    return node ? [node] : [];
  });
  const selectedProductFeatures = combineNodes.filter(
    (node) =>
      node.role === 'node' &&
      node.status === 'accepted' &&
      node.layer === 'product-design' &&
      node.artifactKind === 'feature' &&
      node.uid,
  );
  const canOpenInWhatToDo =
    activeLayer === 'product-design' &&
    selectedProductFeatures.length > 0 &&
    selectedProductFeatures.length === combineNodes.length;
  const visibleNodes = nodes.filter(
    (node) =>
      node.role === 'start' || (node.layer ?? 'discovery') === activeLayer,
  );
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const sharedSourceId = nodes.find((node) => node.role === 'start')?.id ?? '';
  const selectedNode = nodes.find((node) => node.id === inspectorId) ?? null;
  const deletionBlockers = selectedNode
    ? (() => {
        const related = getTaskGraphRelationships(nodes, selectedNode.id);
        return [
          ...new Map(
            [...related.derivedNodes, ...related.dependents].map((node) => [
              node.id,
              node,
            ]),
          ).values(),
        ];
      })()
    : [];
  const selectedCandidatePreview =
    previews.find(
      (item) => item.id === inspectorId && item.kind === 'candidate',
    ) ?? null;
  const selectedCandidate = selectedCandidatePreview?.candidate ?? null;
  const candidateRelationshipSections = selectedCandidate
    ? buildRelationshipSections(selectedCandidate, nodes, sharedSourceId)
    : [];
  const acceptedCandidateIds = new Set(
    nodes.flatMap((node) =>
      node.provenance?.candidateId ? [node.provenance.candidateId] : [],
    ),
  );
  const visiblePreviews = previews
    .filter(
      (item) =>
        (item.layer ?? 'discovery') === activeLayer &&
        (item.kind !== 'candidate' ||
          !acceptedCandidateIds.has(item.candidate?.candidateId ?? '')),
    )
    .map((item) =>
      item.kind === 'run' &&
      sharedSourceId &&
      !(item.derivedFrom ?? []).some((nodeId) => visibleNodeIds.has(nodeId))
        ? {
            ...item,
            sourceNodeId: sharedSourceId,
            derivedFrom: [sharedSourceId],
          }
        : item,
    );
  const hasGraph = nodes.length > 0;
  const moduleResponse = useLatestResponse(
    projectId,
    'whats-next',
    initialResponse,
  );
  const [responseCollapsed, setResponseCollapsed] = useSurfacePreference(
    projectId,
    'whats-next',
    'latest-response',
  );
  const [composerCollapsed, setComposerCollapsed] = useSurfacePreference(
    projectId,
    'whats-next',
    'composer',
  );
  const latestResponse = [...runs]
    .reverse()
    .find(
      (run) =>
        intentionDestination(run.intention).layer === activeLayer &&
        !['running', 'validating'].includes(run.status),
    );
  const latestResponsePresentation = latestResponse
    ? latestWhatsNextResponse(latestResponse)
    : null;
  const visibleCandidatePreviews = visiblePreviews.filter(
    (preview) => preview.kind === 'candidate',
  );
  const visibleCandidateIds = new Set(
    visibleCandidatePreviews.map((preview) => preview.id),
  );
  const activeProposalNodeIds = proposalFocusNodeIds(visibleCandidatePreviews, {
    visibleNodeIds,
    projectedRootId: sharedSourceId,
  });
  const activeProposalKey = activeProposalNodeIds.join('|');
  const fitRequest = activeProposalKey
    ? {
        nodeIds: activeProposalNodeIds,
        sequence: `${activeLayer}:${activeProposalKey}:${proposalFocusSequence}`,
      }
    : null;
  const continuingGrow = growSource
    ? runs.some(
        (run) =>
          run.agentSessionId &&
          run.harness.revision === WHATS_NEXT_HARNESS_REVISION &&
          sameModelSelection(run.profile, agentProfile) &&
          run.transport ===
            (selectedAgent === 'codex'
              ? 'codex-cli'
              : selectedAgent === 'deepseek'
                ? 'deepseek-cli'
                : 'claude-cli') &&
          run.sourceNodeIds.length === 1 &&
          run.sourceNodeIds[0] === growSource.id,
      )
    : false;

  async function loadRunsFromServer() {
    const response = await fetch(
      `/api/projects/${projectId}/whats-next-runs`,
    ).catch(() => null);
    if (!response?.ok) return;
    const payload = (await response.json()) as { runs: WhatsNextRunRecord[] };
    setRuns(payload.runs);
    setAgentProfile((current) =>
      current.agent === agentForRun(initialRuns.at(-1)) &&
      !current.model &&
      !current.effort
        ? (payload.runs.at(-1)?.profile ?? {
            agent: agentForRun(payload.runs.at(-1)),
            model: '',
            effort: '',
          })
        : current,
    );
    setPreviews(
      mergePreviews([], payload.runs.flatMap(whatsNextRunToPreviews)),
    );
  }

  const restoreRuns = useEffectEvent(loadRunsFromServer);

  useEffect(() => {
    if (developmentPreview) return;
    if (restoredRuns.current) return;
    restoredRuns.current = true;
    void restoreRuns();
  }, [developmentPreview]);

  useEffect(() => {
    if (!developmentTransitionRun) return;
    const transitionTimeout = window.setTimeout(() => {
      const discardedRuns = new Set(
        developmentTransitionRun.replacement?.runIds ?? [],
      );
      setRuns((current) =>
        upsertRun(
          current.filter((run) => !discardedRuns.has(run.runId)),
          developmentTransitionRun,
        ),
      );
      setPreviews((current) =>
        mergePreviews(
          current.filter((preview) => !discardedRuns.has(preview.runId ?? '')),
          whatsNextRunToPreviews(developmentTransitionRun),
        ),
      );
      setFocusedNodeId('');
    }, 800);
    const completionTimeout = developmentCompletionRun
      ? window.setTimeout(() => {
          setRuns((current) => upsertRun(current, developmentCompletionRun));
          setPreviews((current) =>
            mergeTerminalRunPreviews(current, developmentCompletionRun),
          );
        }, 1_800)
      : null;
    return () => {
      window.clearTimeout(transitionTimeout);
      if (completionTimeout !== null) {
        window.clearTimeout(completionTimeout);
      }
    };
  }, [developmentCompletionRun, developmentTransitionRun]);

  async function pollRun(runId: string) {
    for (let attempt = 0; attempt < 3_600; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const response = await fetch(
        `/api/projects/${projectId}/whats-next-runs?runId=${runId}`,
      ).catch(() => null);
      if (!response?.ok) continue;
      const { run } = (await response.json()) as { run: WhatsNextRunRecord };
      if (['running', 'validating'].includes(run.status)) {
        setRuns((current) => upsertRun(current, run));
        setPreviews((current) =>
          mergePreviews(current, whatsNextRunToPreviews(run)),
        );
        continue;
      }
      if (run.revisionOf && run.result?.outcome !== 'proposal') {
        setFocusedNodeId('');
        await loadRunsFromServer();
        return;
      }
      setRuns((current) => upsertRun(current, run));
      setPreviews((current) => mergeTerminalRunPreviews(current, run));
      if (['failed', 'canceled'].includes(run.status)) {
        const snapshot = runSnapshots.current.get(runId);
        if (
          snapshot &&
          !snapshot.revisionTarget &&
          !hasCombineDraft(combineDraftRef.current)
        )
          restoreRunSnapshot(snapshot);
      }
      if (run.revisionOf) setFocusedNodeId('');
      return;
    }
  }

  async function startRun(input: {
    sourceNodeIds: string[];
    instruction: string;
    contextRefs?: string[];
    files?: File[];
    feedback?: WhatsNextFeedbackAnchor[];
    revisionTarget?: { runId: string; candidateId: string };
    redoProposal?: boolean;
    intention?: WhatsNextIntention;
    motion?: WhatsNextMotion;
  }) {
    if (developmentPreview) return;
    const body = new FormData();
    for (const nodeId of input.sourceNodeIds) {
      body.append('sourceNodeIds', nodeId);
    }
    body.append('instruction', input.instruction);
    body.append('agent', selectedAgent);
    body.append('model', agentProfile.model);
    body.append('effort', agentProfile.effort);
    body.append('intention', input.intention ?? 'mvp-exploration');
    body.append('motion', input.motion ?? 'unspecified');
    if (input.redoProposal) body.append('redoProposal', 'true');
    for (const ref of input.contextRefs ?? []) body.append('contextRefs', ref);
    for (const file of input.files ?? []) body.append('files', file);
    if (input.feedback?.length) {
      body.append('feedback', JSON.stringify(input.feedback));
    }
    if (input.revisionTarget) {
      body.append('revisionRunId', input.revisionTarget.runId);
      body.append('revisionCandidateId', input.revisionTarget.candidateId);
    }
    const response = await fetch(`/api/projects/${projectId}/whats-next-runs`, {
      method: 'POST',
      body,
    });
    const payload = (await response.json()) as {
      run?: WhatsNextRunRecord;
      error?: string;
    };
    if (!response.ok || !payload.run) {
      throw new Error(payload.error ?? 'Could not start the Agent Run.');
    }
    runSnapshots.current.set(payload.run.runId, {
      sourceNodeIds: input.sourceNodeIds,
      instruction: input.instruction,
      contextRefs: input.contextRefs ?? [],
      files: input.files ?? [],
      revisionTarget: input.revisionTarget,
      redoProposal: input.redoProposal,
      intention: input.intention ?? 'mvp-exploration',
      motion: input.motion ?? 'unspecified',
    });
    const discardedRuns = new Set(payload.run.replacement?.runIds ?? []);
    setRuns((current) =>
      upsertRun(
        current.filter((run) => !discardedRuns.has(run.runId)),
        payload.run!,
      ),
    );
    setPreviews((current) =>
      mergePreviews(
        current.filter((preview) => !discardedRuns.has(preview.runId ?? '')),
        whatsNextRunToPreviews(payload.run!),
      ),
    );
    if (input.revisionTarget || input.redoProposal) setFocusedNodeId('');
    if (input.redoProposal) setInspectorId('');
    if (['running', 'validating'].includes(payload.run.status))
      void pollRun(payload.run.runId);
  }

  async function beginFromIdea() {
    const sentence = idea.trim();
    if (!sentence || starting || developmentPreview) return;
    setStarting(true);
    setError('');
    try {
      const body = new FormData();
      body.append('title', titleFromAgentGraphIdea(sentence));
      body.append('idea', sentence);
      body.append('graph', 'whats-next');
      for (const ref of startRefs) body.append('contextRefs', ref);
      for (const file of startFiles) body.append('files', file);
      const response = await fetch(`/api/projects/${projectId}/nodes`, {
        method: 'POST',
        body,
      });
      const payload = (await response.json()) as {
        nodes?: TaskGraphNode[];
        node?: TaskGraphNode;
        error?: string;
      };
      if (!response.ok || !payload.nodes || !payload.node) {
        throw new Error(payload.error ?? 'Could not create the Start.');
      }
      setNodes(payload.nodes);
      setIdea('');
      setStartRefs([]);
      setStartFiles([]);
      await startRun({
        sourceNodeIds: [payload.node.id],
        instruction: '',
        intention,
        motion: 'unspecified',
      });
      setActiveLayer(intentionDestination(intention).layer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something failed.');
    } finally {
      setStarting(false);
    }
  }

  async function submitGrow() {
    if (
      !growSource ||
      submittingGrow ||
      (redoProposal && (redoBoundary.reason || !growInstruction.trim()))
    )
      return;
    setSubmittingGrow(true);
    setError('');
    try {
      await startRun({
        sourceNodeIds: [growSource.id],
        instruction: growInstruction,
        contextRefs: growRefs,
        files: growFiles,
        redoProposal,
      });
      closeGrow();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something failed.');
    } finally {
      setSubmittingGrow(false);
    }
  }

  async function enableRedoProposal() {
    if (redoBoundary.reason || loadingRedoUserInput) return;
    const run = redoBoundary.inputRun;
    const workspacePath = run?.input?.userInputPath;
    if (run && workspacePath && redoBoundary.inputKey) {
      setLoadingRedoUserInput(true);
      setError('');
      try {
        const resourcePath = `whats-next/runs/${run.runId}/context/${workspacePath}`;
        const response = await fetch(
          `/api/projects/${projectId}/resources?path=${encodeURIComponent(resourcePath)}`,
        );
        const result = (await response.json()) as {
          markdown?: string;
          error?: string;
        };
        if (!response.ok || result.markdown === undefined)
          throw new Error(
            result.error ?? 'Could not read the previous User Input.',
          );
        setRedoUserInput({
          key: redoBoundary.inputKey,
          markdown: result.markdown,
        });
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : 'Could not read the previous User Input.',
        );
        return;
      } finally {
        setLoadingRedoUserInput(false);
      }
    }
    setRedoProposal(true);
  }

  async function submitCombine() {
    if (combineIds.length < 1 || !combineInstruction.trim()) return;
    setError('');
    try {
      await startRun({
        sourceNodeIds: combineIds,
        instruction: combineInstruction,
        contextRefs: combineRefs,
        files: combineFiles,
        intention,
        motion,
      });
      setActiveLayer(intentionDestination(intention).layer);
      setCombineIds([]);
      setCombineInstruction('');
      setCombineRefs([]);
      setCombineFiles([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something failed.');
    }
  }

  function toggleSelection(nodeId: string) {
    setCombineIds((current) => {
      const next = toggleWhatsNextSelection(nodes, current, nodeId);
      if (next.length === 0) {
        setCombineInstruction('');
        setCombineRefs([]);
        setCombineFiles([]);
      }
      return next;
    });
  }

  function changeIntention(next: WhatsNextIntention) {
    setIntention(next);
    if (next === 'product-design-completion') {
      setMotion('unspecified');
      if (sharedSourceId) setCombineIds([sharedSourceId]);
    }
  }

  function closeGrow() {
    setGrowSourceId('');
    setGrowInstruction('');
    setGrowRefs([]);
    setGrowFiles([]);
    setRedoProposal(false);
  }

  async function cancelRun(runId: string) {
    const snapshot = runSnapshots.current.get(runId);
    setPreviews((current) => current.filter((item) => item.runId !== runId));
    await fetch(`/api/projects/${projectId}/whats-next-runs`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId }),
    }).catch(() => null);
    if (snapshot?.revisionTarget) {
      setFocusedNodeId('');
      await loadRunsFromServer();
      return;
    }
    if (!snapshot || snapshot.revisionTarget) return;
    if (hasCombineDraft(combineDraftRef.current)) return;
    restoreRunSnapshot(snapshot);
  }

  function restoreRunSnapshot(snapshot: RunSnapshot) {
    setCombineIds(snapshot.sourceNodeIds);
    setCombineInstruction(snapshot.instruction);
    setCombineRefs(snapshot.contextRefs);
    setCombineFiles(snapshot.files);
    setIntention(snapshot.intention);
    setMotion(snapshot.motion);
  }

  async function updateCandidate(action: 'accept' | 'discard') {
    if (!selectedCandidatePreview?.runId || !selectedCandidate) return;
    const setBusy = action === 'accept' ? setAccepting : setDiscarding;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/projects/${projectId}/whats-next-runs`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            runId: selectedCandidatePreview.runId,
            candidateId: selectedCandidate.candidateId,
          }),
        },
      );
      const payload = (await response.json()) as {
        nodes?: TaskGraphNode[];
        runDeleted?: boolean;
        deletedRunIds?: string[];
        runs?: WhatsNextRunRecord[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? 'Could not update the direction.');
      }
      if (payload.nodes) setNodes(payload.nodes);
      setPreviews((current) =>
        current.filter((item) => item.id !== selectedCandidatePreview.id),
      );
      if (action === 'discard') {
        setRuns((current) =>
          reconcileProposalRuns(current, {
            requestedRunId: selectedCandidatePreview.runId!,
            runDeleted: payload.runDeleted,
            deletedRunIds: payload.deletedRunIds,
            runs: payload.runs,
          }),
        );
      }
      setInspectorId('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something failed.');
    } finally {
      setBusy(false);
    }
  }

  async function reviseCandidate() {
    if (!revisionTarget || (!reviseNote.trim() && pendingFeedback.length === 0))
      return;
    const origins = selectedCandidate?.derivedFrom ?? [];
    setError('');
    try {
      await startRun({
        sourceNodeIds: origins,
        instruction:
          reviseNote.trim() ||
          'Refine the current Markdown using the attached inline feedback.',
        feedback: pendingFeedback,
        revisionTarget,
        intention:
          runs.find((run) => run.runId === selectedCandidatePreview?.runId)
            ?.intention ??
          (selectedCandidate &&
          'layer' in selectedCandidate &&
          selectedCandidate.layer === 'product-design'
            ? 'feature-synthesis'
            : 'mvp-exploration'),
        motion: 'converge',
      });
      setRevisionTarget(null);
      setReviseNote('');
      setFeedbackDraft(null);
      setPendingFeedback([]);
      setInspectorId('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something failed.');
    }
  }

  async function savePendingFeedback() {
    if (
      !feedbackDraft?.instruction.trim() ||
      !selectedCandidatePreview?.outputPath ||
      !selectedCandidate
    )
      return;
    const excerptHash = await sha256(feedbackDraft.selection.excerpt);
    const feedbackId =
      feedbackDraft.feedbackId ?? `FEEDBACK-${createBrowserUuid()}`;
    const feedback = {
      feedbackId,
      path: selectedCandidatePreview.outputPath!,
      baseRevision: selectedCandidate.revision,
      startLine: feedbackDraft.selection.startLine,
      endLine: feedbackDraft.selection.endLine,
      excerpt: feedbackDraft.selection.excerpt,
      excerptHash,
      instruction: feedbackDraft.instruction.trim(),
    };
    setPendingFeedback((current) =>
      feedbackDraft.feedbackId
        ? current.map((item) =>
            item.feedbackId === feedbackId ? feedback : item,
          )
        : [...current, feedback],
    );
    setRevisionTarget({
      runId: selectedCandidatePreview.runId!,
      candidateId: selectedCandidate.candidateId,
    });
    setFeedbackDraft(null);
  }

  function editPendingFeedback(feedbackId: string) {
    const feedback = pendingFeedback.find(
      (item) => item.feedbackId === feedbackId,
    );
    if (!feedback) return;
    setFeedbackDraft({
      feedbackId,
      selection: {
        startLine: feedback.startLine,
        endLine: feedback.endLine,
        excerpt: feedback.excerpt,
      },
      instruction: feedback.instruction,
    });
  }

  function removePendingFeedback(feedbackId: string) {
    setPendingFeedback((current) =>
      current.filter((item) => item.feedbackId !== feedbackId),
    );
    setFeedbackDraft((current) =>
      current?.feedbackId === feedbackId ? null : current,
    );
  }

  async function saveStart() {
    if (!editStart || !editText.trim() || savingStart) return;
    setSavingStart(true);
    setError('');
    try {
      const body = new FormData();
      body.append('id', editStart.id);
      body.append('title', titleFromAgentGraphIdea(editText));
      body.append('idea', editText.trim());
      body.append('graph', 'whats-next');
      for (const resource of editStart.resources) {
        if (resource.kind === 'context') {
          body.append('contextRefs', resource.path);
        }
        if (resource.kind === 'attachment') {
          body.append('retainedAttachmentRefs', resource.path);
        }
      }
      const response = await fetch(`/api/projects/${projectId}/nodes`, {
        method: 'PATCH',
        body,
      });
      const payload = (await response.json()) as {
        nodes?: TaskGraphNode[];
        error?: string;
      };
      if (!response.ok || !payload.nodes) {
        throw new Error(payload.error ?? 'Could not update the Start.');
      }
      setNodes(payload.nodes);
      setEditStartId('');
      setEditText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something failed.');
    } finally {
      setSavingStart(false);
    }
  }

  async function beginEditSource(node: TaskGraphNode) {
    const source = node.resources.find(
      (resource) => resource.kind === 'user-input' || resource.kind === 'idea',
    );
    if (!source) return;
    const response = await fetch(
      `/api/projects/${projectId}/resources?path=${encodeURIComponent(source.path)}`,
    ).catch(() => null);
    if (!response?.ok) return;
    const payload = (await response.json()) as { markdown: string };
    setEditStartId(node.id);
    setEditText(withoutFirstHeading(payload.markdown));
    setInspectorId('');
  }

  async function deleteNode(nodeId: string) {
    setDeletingNodeId(nodeId);
    setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/nodes`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: nodeId, graph: 'whats-next' }),
      });
      const payload = (await response.json()) as {
        nodes?: TaskGraphNode[];
        error?: string;
        blockerNodeIds?: string[];
      };
      if (!response.ok || !payload.nodes) {
        throw new Error(
          payload.blockerNodeIds?.length
            ? `${nodeId} is still used by ${payload.blockerNodeIds.join(', ')}.`
            : (payload.error ?? 'Could not delete the card.'),
        );
      }
      setNodes(payload.nodes);
      setCombineIds((current) => current.filter((value) => value !== nodeId));
      setInspectorId('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something failed.');
    } finally {
      setDeletingNodeId('');
    }
  }

  async function openComparison(
    title: string,
    previousPath: string,
    currentPath: string,
    previousMarkdown?: string,
    currentMarkdown?: string,
  ) {
    if (previousMarkdown !== undefined && currentMarkdown !== undefined) {
      setComparison({
        title,
        previous: previousMarkdown,
        current: currentMarkdown,
      });
      return;
    }
    const [previousResponse, currentResponse] = await Promise.all([
      fetch(
        `/api/projects/${projectId}/resources?path=${encodeURIComponent(previousPath)}`,
      ),
      fetch(
        `/api/projects/${projectId}/resources?path=${encodeURIComponent(currentPath)}`,
      ),
    ]);
    if (!previousResponse.ok || !currentResponse.ok) return;
    const previous = (await previousResponse.json()) as { markdown: string };
    const current = (await currentResponse.json()) as { markdown: string };
    setComparison({
      title,
      previous: previous.markdown,
      current: current.markdown,
    });
  }

  async function openMarkdown(path: string, title: string) {
    const response = await fetch(
      `/api/projects/${projectId}/resources?path=${encodeURIComponent(path)}`,
    ).catch(() => null);
    if (!response?.ok) return;
    const payload = (await response.json()) as { markdown: string };
    setPreview({ title, path, markdown: payload.markdown });
  }

  function locateGraphNode(nodeId: string) {
    const targetLayer =
      nodes.find((node) => node.id === nodeId)?.layer ??
      previews.find((item) => item.id === nodeId)?.layer;
    if (targetLayer) setActiveLayer(targetLayer);
    setInspectorId('');
    setFocusedNodeId(nodeId);
    window.setTimeout(() => {
      locateSequence.current += 1;
      setLocateRequest({ nodeId, sequence: locateSequence.current });
    }, 0);
  }

  if (!hasGraph) {
    return (
      <div className="relative h-full overflow-hidden bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] bg-[size:22px_22px]">
        <AgentGraphComposerCard
          title={
            <span className="flex items-center gap-2">
              <Sparkles className="size-4 text-muted-foreground" />
              {t('What do you want to build?')}
            </span>
          }
          description={
            <>
              {t(
                'Write the idea in your own words. It becomes the Start of this Canvas, and',
              )}
              {AGENT_LABELS[selectedAgent]} {t('answers it straight away.')}
            </>
          }
        >
          <div className="mt-4">
            <AgentGraphIntentionSelect
              profiles={whatsNextIntentionRegistry.profiles}
              value={intention}
              onChange={changeIntention}
              label="Exploration purpose"
              showDescription={false}
            />
          </div>
          {startRefs.length + startFiles.length > 0 ? (
            <AgentComposerAttachments
              className="mt-4"
              label={t('Optional sources')}
              items={[
                ...startRefs.map((ref) => ({
                  id: ref,
                  label: contextAttachmentTitle(folders, ref),
                  onRemove: () =>
                    setStartRefs((current) =>
                      current.filter((item) => item !== ref),
                    ),
                })),
                ...startFiles.map((file, index) => ({
                  id: `${file.name}:${index}`,
                  label: file.name,
                  onRemove: () =>
                    setStartFiles((current) =>
                      current.filter((_, item) => item !== index),
                    ),
                })),
              ]}
            />
          ) : null}
          <AgentComposerShell
            className="mt-4"
            controls={
              <AgentRunControls
                extraInfo={
                  <ContextAttachmentPicker
                    embedded
                    folders={folders}
                    folderPath={startFolderPath}
                    onFolderPath={setStartFolderPath}
                    refs={startRefs}
                    onToggleRef={(refPath) =>
                      setStartRefs((current) => toggle(current, refPath))
                    }
                    files={startFiles}
                    onAddFiles={(added) =>
                      setStartFiles((current) => [...current, ...added])
                    }
                    onRemoveFile={(index) =>
                      setStartFiles((current) =>
                        current.filter((_, value) => value !== index),
                      )
                    }
                    label={t('Optional sources')}
                  />
                }
                extraInfoCount={startRefs.length + startFiles.length}
                extraInfoLabel="Optional sources"
                value={agentProfile}
                onChange={setAgentProfile}
                mode={developmentPreview ? 'demo' : 'live'}
                disabled={!idea.trim() || starting || developmentPreview}
                running={starting}
                actionLabel="Start and ask"
                onRun={() => void beginFromIdea()}
              />
            }
          >
            <Textarea
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              rows={4}
              placeholder={t(
                'A manager that helps one developer grow and decompose product intent…',
              )}
              className="resize-none text-sm"
              aria-label={t('Your idea')}
            />
          </AgentComposerShell>
          {error ? (
            <p className="mt-4 text-xs text-destructive">{error}</p>
          ) : null}
        </AgentGraphComposerCard>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="flex shrink-0 gap-2 border-b border-border px-5 py-3">
        {(['discovery', 'product-design'] as const).map((layer) => (
          <Button
            key={layer}
            variant={activeLayer === layer ? 'secondary' : 'ghost'}
            aria-pressed={activeLayer === layer}
            onClick={() => {
              setActiveLayer(layer);
              setFocusedNodeId('');
            }}
          >
            {layer === 'discovery' ? t('Discovery') : t('Product Design')}
          </Button>
        ))}
      </nav>
      <div className="relative min-h-0 flex-1">
        <TaskGraphCanvas
          nodes={visibleNodes.map((node) => ({
            ...node,
            metadata: {
              ...node.metadata,
              deliveryState: deliveryStates[node.uid ?? ''],
            },
          }))}
          previews={visiblePreviews}
          focusedNodeId={focusedNodeId}
          locateRequest={locateRequest}
          fitRequest={fitRequest}
          selectedNodeIds={combineIds}
          edgeAlignedOverlays
          avoidBottomRightPanel={combineIds.length >= 1}
          projectedRootId={
            activeLayer === 'product-design' ? sharedSourceId : undefined
          }
          selectionEnabled
          onToggleSelection={toggleSelection}
          onFocusNode={setFocusedNodeId}
          onInspectNode={setInspectorId}
          onSelectPreview={setInspectorId}
          onDecompose={() => {}}
          onCancelRun={(runId) => void cancelRun(runId)}
        />

        <ProposalWorkspaceStatus
          className="absolute top-4 right-4 z-10"
          formalCount={visibleNodes.length}
          candidateCount={visibleCandidateIds.size}
          activeProposalCount={activeProposalNodeIds.length}
          onFocusProposal={() =>
            setProposalFocusSequence((current) => current + 1)
          }
        />

        {moduleResponse.document ? (
          <LatestResponseCard
            document={moduleResponse.document}
            collapsed={responseCollapsed}
            onCollapsedChange={setResponseCollapsed}
            onCancel={() => void cancelRun(moduleResponse.document!.runId)}
            className="w-[min(320px,calc(100%-2rem))]"
          >
            {latestResponse &&
            latestResponsePresentation &&
            latestResponse.runId === moduleResponse.document.runId ? (
              <LatestResponseActions
                responseLabel={t('Response')}
                summaryLabel={t('Summary')}
                onOpenResponse={() =>
                  setPreview({
                    title: t('Latest Response'),
                    path: `whats-next/runs/${latestResponse.runId}/response.md`,
                    markdown: latestResponse.result
                      ? renderWhatsNextResponseMarkdown(latestResponse.result)
                      : `# ${t('Response')}\n\n${t(latestResponsePresentation.summary)}\n`,
                  })
                }
                onOpenSummary={() =>
                  void openMarkdown(
                    `whats-next/runs/${latestResponse.runId}/summary.md`,
                    t('Summary'),
                  )
                }
              />
            ) : null}
          </LatestResponseCard>
        ) : null}

        <div className="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2">
          {error ? (
            <p className="pointer-events-auto rounded-full bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        {combineIds.length >= 1 ? (
          <AgentGraphComposerCard
            title={`${combineIds.length} ${combineIds.length === 1 ? t('card') : t('cards')} ${t('selected')}`}
            running={moduleResponse.running}
            collapsed={composerCollapsed}
            onCollapsedChange={setComposerCollapsed}
          >
            <div className="grid grid-cols-2 gap-2">
              <AgentGraphIntentionSelect
                profiles={whatsNextIntentionRegistry.profiles}
                value={intention}
                onChange={changeIntention}
                label="Exploration purpose"
                showDescription={false}
              />
              <AgentGraphMotionSelect
                profiles={whatsNextMotionRegistry.profiles}
                value={motion}
                onChange={setMotion}
              />
            </div>

            {intention === 'product-design-completion' ? (
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                {t(
                  'The Product Source and all current Product Design Features are included automatically.',
                )}
              </p>
            ) : null}

            <div className="mt-3 flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {combineNodes.map((node) => (
                <span
                  key={node.id}
                  className="flex shrink-0 items-center gap-2 rounded-lg bg-secondary px-2.5 py-2 text-xs"
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{node.title}</span>
                  <button
                    type="button"
                    className="text-muted-foreground transition hover:text-foreground"
                    aria-label={`Remove ${node.title}`}
                    onClick={() =>
                      setCombineIds((current) => {
                        const next = toggle(current, node.id);
                        if (next.length === 0) {
                          setCombineInstruction('');
                          setCombineRefs([]);
                          setCombineFiles([]);
                        }
                        return next;
                      })
                    }
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>

            {canOpenInWhatToDo ? (
              <Button
                className="mt-3 w-full"
                variant="outline"
                onClick={() => {
                  const query = new URLSearchParams();
                  for (const node of selectedProductFeatures)
                    query.append('feature', node.uid!);
                  router.push(
                    `/projects/${projectId}/what-to-do?${query.toString()}`,
                  );
                }}
              >
                {t('Open in Delivery Planning')}
                <ArrowRight className="size-3.5" />
              </Button>
            ) : null}

            <AgentComposerAttachments
              className="mt-3"
              label={t('Optional sources')}
              items={[
                ...combineRefs.map((ref) => ({
                  id: ref,
                  label: contextAttachmentTitle(folders, ref),
                  onRemove: () =>
                    setCombineRefs((current) =>
                      current.filter((item) => item !== ref),
                    ),
                })),
                ...combineFiles.map((file, index) => ({
                  id: `${file.name}:${index}`,
                  label: file.name,
                  onRemove: () =>
                    setCombineFiles((current) =>
                      current.filter((_, item) => item !== index),
                    ),
                })),
              ]}
            />

            <AgentComposerShell
              className="mt-3"
              controls={
                <AgentRunControls
                  extraInfo={
                    <ContextAttachmentPicker
                      embedded
                      folders={folders}
                      folderPath={combineFolderPath}
                      onFolderPath={setCombineFolderPath}
                      refs={combineRefs}
                      onToggleRef={(ref) =>
                        setCombineRefs((current) => toggle(current, ref))
                      }
                      files={combineFiles}
                      onAddFiles={(added) =>
                        setCombineFiles((current) => [...current, ...added])
                      }
                      onRemoveFile={(index) =>
                        setCombineFiles((current) =>
                          current.filter((_, item) => item !== index),
                        )
                      }
                      label={t('Optional sources')}
                    />
                  }
                  extraInfoCount={combineRefs.length + combineFiles.length}
                  extraInfoLabel="Optional sources"
                  value={agentProfile}
                  onChange={setAgentProfile}
                  mode={developmentPreview ? 'demo' : 'live'}
                  disabled={!combineInstruction.trim() || developmentPreview}
                  onRun={() => void submitCombine()}
                />
              }
            >
              <Textarea
                value={combineInstruction}
                onChange={(event) => setCombineInstruction(event.target.value)}
                rows={3}
                required
                placeholder={t(
                  'Describe the result you want from these cards.',
                )}
                className="resize-none text-sm"
                aria-label={t('What to do with the selected cards')}
              />
            </AgentComposerShell>
          </AgentGraphComposerCard>
        ) : moduleResponse.running ? (
          <AgentGraphComposerCard title="" running />
        ) : null}

        <Dialog
          open={growSource !== null}
          onOpenChange={(open) => {
            if (!open) closeGrow();
          }}
        >
          <DialogContent className="max-h-[88vh] overflow-y-auto pb-0 sm:max-w-2xl">
            {growSource ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitGrow();
                }}
                className="space-y-6"
              >
                <div>
                  <h2 className="text-sm font-semibold">
                    {redoProposal
                      ? t('Redo proposal from')
                      : continuingGrow
                        ? t('Continue from')
                        : t('Explore from')}{' '}
                    {growSource.id}
                  </h2>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {redoProposal
                      ? t(
                          'Re-propose discards the current directions to system Trash and immediately generates a new proposal. Cancellation or failure does not restore discarded directions.',
                        )
                      : continuingGrow
                        ? t(
                            '{agent} continues the same line of inquiry with only this round’s changes.',
                            { agent: AGENT_LABELS[selectedAgent] },
                          )
                        : t(
                            '{agent} responds with a Reflection and supported next directions.',
                            { agent: AGENT_LABELS[selectedAgent] },
                          )}{' '}
                    {t(
                      'Inherited Resources stay on the source Node; additions apply only to this request.',
                    )}
                  </p>
                </div>

                <div className="rounded-xl border border-border p-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={!redoProposal ? 'default' : 'outline'}
                      onClick={() => setRedoProposal(false)}
                    >
                      {t('Explore more')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={redoProposal ? 'default' : 'outline'}
                      onClick={() => void enableRedoProposal()}
                      disabled={
                        Boolean(redoBoundary.reason) || loadingRedoUserInput
                      }
                      title={
                        redoBoundary.reason ||
                        t('Redo all unaccepted directions from this parent')
                      }
                    >
                      <RotateCcw className="size-3.5" />
                      {t('Redo proposal')}
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {redoBoundary.reason ||
                      (redoProposal
                        ? t(
                            '{count} directions will be reconsidered together. No Formal Nodes will be changed.',
                            { count: redoBoundary.count },
                          )
                        : t(
                            'Explore more adds directions without replacing the current proposal.',
                          ))}
                  </p>
                </div>

                <AgentProfileSelector
                  value={agentProfile}
                  onChange={setAgentProfile}
                  mode={developmentPreview ? 'demo' : 'live'}
                  disabled={submittingGrow}
                />

                {redoProposal && redoBoundary.context ? (
                  <section
                    aria-label={t('Previous proposal context')}
                    className="space-y-3 rounded-xl border border-border p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-medium">
                        {t('Previous proposal')}
                      </h3>
                      <span className="text-[10px] text-muted-foreground">
                        {t('Included automatically')}
                      </span>
                    </div>
                    <div>
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {t('Previous User Input')}
                      </p>
                      <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5">
                        {redoBoundary.context.userInput ||
                          t('No User Input was recorded for this proposal.')}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {t('Previous outputs ·')}
                        {redoBoundary.context.outputs.length}
                      </p>
                      {redoBoundary.context.outputs.map((output) => (
                        <button
                          key={output.path}
                          type="button"
                          onClick={() => setPreview(output)}
                          className="flex w-full items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-left text-xs hover:bg-secondary/70"
                          aria-label={t('Read previous output: {title}', {
                            title: output.title,
                          })}
                        >
                          <FileText className="size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">
                            {output.title}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {t('Revision')}
                            {output.revision}
                          </span>
                        </button>
                      ))}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setPreview({
                          title: 'Last response',
                          path: 'previous-proposal.md',
                          markdown: redoBoundary.context!.responseMarkdown,
                        })
                      }
                    >
                      {t('Read full last response')}
                    </Button>
                  </section>
                ) : null}

                <div className="space-y-2">
                  <label
                    htmlFor="whats-next-instruction"
                    className="text-xs font-medium"
                  >
                    {redoProposal ? t('Correction') : t('User Input')}{' '}
                    <span className="font-normal text-muted-foreground">
                      {redoProposal ? t('required') : t('optional')}
                    </span>
                  </label>
                  <Textarea
                    id="whats-next-instruction"
                    value={growInstruction}
                    placeholder={
                      redoProposal
                        ? t(
                            'What did this proposal misunderstand, and what do you want instead?',
                          )
                        : t(
                            'Steer this round, or let the Agent respond from the current Node.',
                          )
                    }
                    className="min-h-28"
                    onChange={(event) => setGrowInstruction(event.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-medium">
                      {t('Input from')}
                      {growSource.id}
                    </p>
                    <span className="text-[10px] text-muted-foreground">
                      {t('always included')}
                    </span>
                  </div>
                  <div className="max-h-40 divide-y divide-border overflow-y-auto rounded-xl border border-border bg-muted/30">
                    {growSource.resources.map((resource) => (
                      <div
                        key={`${resource.kind}:${resource.path}`}
                        className="flex items-center gap-2.5 px-3 py-2.5"
                      >
                        <Checkbox
                          checked
                          disabled
                          aria-label={t('{name} is always included', {
                            name: resourceName(resource.path),
                          })}
                        />
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-[11px]">
                          {resourceName(resource.path)}
                        </span>
                        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                          {resource.kind}
                        </span>
                      </div>
                    ))}
                    {growSource.resources.length === 0 ? (
                      <p className="px-3 py-2.5 text-[11px] text-muted-foreground">
                        {t('This Node carries no Resources yet.')}
                      </p>
                    ) : null}
                  </div>
                </div>

                <SourcePicker
                  folders={folders}
                  folderPath={growFolderPath}
                  onFolderPath={setGrowFolderPath}
                  refs={growRefs}
                  onToggleRef={(refPath) =>
                    setGrowRefs((current) => toggle(current, refPath))
                  }
                  files={growFiles}
                  onAddFiles={(added) =>
                    setGrowFiles((current) => [...current, ...added])
                  }
                  onRemoveFile={(index) =>
                    setGrowFiles((current) =>
                      current.filter((_, value) => value !== index),
                    )
                  }
                  label={t('Run-only context')}
                />

                <div className="sticky bottom-0 -mx-4 border-t border-border bg-popover px-4 py-4">
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={
                      developmentPreview ||
                      submittingGrow ||
                      (redoProposal &&
                        (!growInstruction.trim() ||
                          Boolean(redoBoundary.reason)))
                    }
                  >
                    <Sparkles className="size-4" />
                    {submittingGrow
                      ? t('Starting…')
                      : redoProposal
                        ? t('Re-propose')
                        : continuingGrow
                          ? t('Continue exploration')
                          : t('Start exploration')}
                  </Button>
                  {error ? (
                    <p className="mt-2 text-xs text-destructive">{error}</p>
                  ) : null}
                </div>
              </form>
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog
          open={editStart !== null}
          onOpenChange={(open) => {
            if (!open) {
              setEditStartId('');
              setEditText('');
            }
          }}
        >
          <DialogContent className="sm:max-w-lg">
            {editStart ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveStart();
                }}
                className="space-y-5"
              >
                <div>
                  <h2 className="text-sm font-semibold">{t('Edit source')}</h2>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {t('This rewrites the Markdown carried by')}
                    {editStart.id}
                    {t(
                      '. Existing directions and dependencies remain unchanged.',
                    )}
                  </p>
                </div>
                <Textarea
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  rows={10}
                  className="text-sm"
                  aria-label={t('Source Markdown')}
                />
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={!editText.trim() || savingStart}
                  >
                    {savingStart ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : null}
                    {t('Save')}
                  </Button>
                </div>
                {error ? (
                  <p className="text-xs text-destructive">{error}</p>
                ) : null}
              </form>
            ) : null}
          </DialogContent>
        </Dialog>

        <Sheet
          open={Boolean(inspectorId)}
          onOpenChange={(open) => {
            if (!open) {
              setInspectorId('');
              setRevisionTarget(null);
              setReviseNote('');
              setFeedbackDraft(null);
              setPendingFeedback([]);
            }
          }}
        >
          <SheetContent className="w-full sm:max-w-2xl">
            {selectedCandidate ? (
              <>
                <SheetHeader>
                  <SheetTitle>{selectedCandidate.title}</SheetTitle>
                  <SheetDescription>
                    {selectedCandidate.candidateId} {t('· revision')}{' '}
                    {selectedCandidate.revision} {t('· unaccepted direction')}
                  </SheetDescription>
                </SheetHeader>
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4 text-sm">
                  <MarkdownReader
                    title={selectedCandidate.title}
                    filePath={
                      selectedCandidatePreview?.outputPath ?? 'output.md'
                    }
                    markdown={
                      'outputMarkdown' in selectedCandidate &&
                      typeof selectedCandidate.outputMarkdown === 'string'
                        ? selectedCandidate.outputMarkdown
                        : `# ${selectedCandidate.title}\n\n${selectedCandidate.summary}`
                    }
                    compact
                    feedbackMarkers={pendingFeedback}
                    onAddFeedback={(selection) =>
                      setFeedbackDraft({ selection, instruction: '' })
                    }
                    onEditFeedback={editPendingFeedback}
                  />

                  {selectedCandidatePreview?.previousOutputPath &&
                  selectedCandidatePreview.outputPath ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void openComparison(
                          selectedCandidate.title,
                          selectedCandidatePreview.previousOutputPath!,
                          selectedCandidatePreview.outputPath!,
                          selectedCandidatePreview.previousMarkdown,
                          'outputMarkdown' in selectedCandidate &&
                            typeof selectedCandidate.outputMarkdown === 'string'
                            ? selectedCandidate.outputMarkdown
                            : undefined,
                        )
                      }
                    >
                      {t('Compare with previous revision')}
                    </Button>
                  ) : null}

                  <details className="rounded-xl border border-border p-3">
                    <summary className="cursor-pointer text-xs font-medium">
                      {t('Graph details')}
                    </summary>
                    <div className="mt-3 space-y-3">
                      {candidateRelationshipSections.map((section) => (
                        <RelationshipColumns
                          key={section.layer}
                          title={t(layerLabel(section.layer))}
                          leftLabel={t('Grew from')}
                          leftIds={section.derivedFrom}
                          rightLabel={t('Depends on')}
                          rightIds={section.dependsOn}
                          onSelect={locateGraphNode}
                        />
                      ))}
                    </div>
                  </details>

                  <CandidateResourceList
                    resources={selectedCandidate.resources}
                    onOpen={(path) =>
                      void openMarkdown(path, path.split('/').at(-1) ?? path)
                    }
                  />

                  <CandidateMetadataSections
                    metadata={selectedCandidate.metadata}
                  />

                  <Dialog
                    open={feedbackDraft !== null}
                    onOpenChange={(open) => {
                      if (!open) setFeedbackDraft(null);
                    }}
                  >
                    <DialogContent className="sm:max-w-lg">
                      {feedbackDraft ? (
                        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-3">
                          <p className="text-[11px] font-medium">
                            {t('Lines')}
                            {feedbackDraft.selection.startLine}–
                            {feedbackDraft.selection.endLine}
                          </p>
                          <p className="mt-1 line-clamp-3 text-[11px] leading-5 text-muted-foreground">
                            “{feedbackDraft.selection.excerpt}”
                          </p>
                          <Textarea
                            value={feedbackDraft.instruction}
                            onChange={(event) =>
                              setFeedbackDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      instruction: event.target.value,
                                    }
                                  : null,
                              )
                            }
                            rows={3}
                            placeholder={t(
                              'What should the Agent reconsider here?',
                            )}
                            className="mt-3 resize-none text-sm"
                            aria-label={t('Inline feedback')}
                          />
                          <div className="mt-2 flex justify-end gap-2">
                            {feedbackDraft.feedbackId ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="mr-auto text-destructive hover:text-destructive"
                                onClick={() =>
                                  removePendingFeedback(
                                    feedbackDraft.feedbackId!,
                                  )
                                }
                              >
                                {t('Delete feedback')}
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setFeedbackDraft(null)}
                            >
                              {t('Cancel')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={!feedbackDraft.instruction.trim()}
                              onClick={() => void savePendingFeedback()}
                            >
                              {feedbackDraft.feedbackId
                                ? t('Save feedback')
                                : t('Add feedback')}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </DialogContent>
                  </Dialog>

                  {pendingFeedback.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {t('Feedback for this Refine')}
                      </p>
                      {pendingFeedback.map((feedback) => (
                        <div
                          key={feedback.feedbackId}
                          className="flex items-start gap-3 rounded-xl bg-secondary px-3 py-2.5"
                        >
                          <button
                            type="button"
                            className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                            aria-label={t('Edit feedback')}
                            onClick={() =>
                              editPendingFeedback(feedback.feedbackId)
                            }
                          >
                            <p className="text-[10px] text-muted-foreground">
                              {t('Lines')}
                              {feedback.startLine}–{feedback.endLine}
                            </p>
                            <p className="mt-1 text-xs leading-5">
                              {feedback.instruction}
                            </p>
                          </button>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={t('Edit feedback')}
                            onClick={() =>
                              editPendingFeedback(feedback.feedbackId)
                            }
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={t('Remove inline feedback')}
                            onClick={() =>
                              removePendingFeedback(feedback.feedbackId)
                            }
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <SheetFooter className="shrink-0 border-t border-border px-6 py-4">
                  {revisionTarget ? (
                    <div className="w-full">
                      <p className="text-[11px] font-medium">
                        {t('Refine this Markdown')}
                      </p>
                      <Textarea
                        value={reviseNote}
                        onChange={(event) => setReviseNote(event.target.value)}
                        rows={3}
                        placeholder={t('Describe what should change…')}
                        className="mt-2 resize-none text-sm"
                        aria-label={t('Revision note')}
                      />
                      <div className="mt-3">
                        <AgentProfileSelector
                          value={agentProfile}
                          onChange={setAgentProfile}
                          mode={developmentPreview ? 'demo' : 'live'}
                        />
                      </div>
                      <div className="mt-2 flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setRevisionTarget(null);
                            setReviseNote('');
                          }}
                        >
                          {t('Cancel')}
                        </Button>
                        <Button
                          size="sm"
                          disabled={
                            developmentPreview ||
                            (!reviseNote.trim() && pendingFeedback.length === 0)
                          }
                          onClick={() => void reviseCandidate()}
                        >
                          {developmentPreview
                            ? t('Preview only')
                            : t('Send Refine')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex w-full gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        disabled={accepting || discarding || developmentPreview}
                        aria-label={t('Discard this direction')}
                        title={t('Discard this direction')}
                        onClick={() => void updateCandidate('discard')}
                      >
                        {discarding ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Trash2 />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="flex-1"
                        disabled={
                          accepting || discarding || Boolean(revisionTarget)
                        }
                        onClick={() =>
                          setRevisionTarget({
                            runId: selectedCandidatePreview!.runId!,
                            candidateId: selectedCandidate.candidateId,
                          })
                        }
                      >
                        <Pencil /> {t('Refine')}
                      </Button>
                      <Button
                        type="button"
                        className="flex-1"
                        disabled={accepting || discarding || developmentPreview}
                        onClick={() => void updateCandidate('accept')}
                      >
                        {accepting ? t('Accepting…') : t('Accept')}
                      </Button>
                    </div>
                  )}
                </SheetFooter>
              </>
            ) : selectedNode ? (
              <>
                <SheetHeader>
                  <SheetTitle>{selectedNode.title}</SheetTitle>
                  <SheetDescription>
                    {selectedNode.id} · {selectedNode.role} ·{' '}
                    {selectedNode.type}
                  </SheetDescription>
                </SheetHeader>
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 text-sm">
                  {selectedNode.summary ? (
                    <p className="leading-6 text-muted-foreground">
                      {selectedNode.summary}
                    </p>
                  ) : null}
                  <Fact
                    label={t('Grew from')}
                    value={selectedNode.derivedFrom?.join(', ') || 'Nothing'}
                  />
                  <NodeResourceSections
                    node={selectedNode}
                    onOpen={(path) =>
                      void openMarkdown(path, resourceName(path))
                    }
                  />
                  <NodeProvenanceFacts node={selectedNode} />
                </div>
                <SheetFooter className="shrink-0 border-t border-border px-6 py-4">
                  <div className="flex w-full gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon"
                      disabled={
                        deletionBlockers.length > 0 ||
                        deletingNodeId === selectedNode.id
                      }
                      aria-label={t('Delete this card')}
                      title={
                        deletionBlockers.length > 0
                          ? t('Delete the referencing cards first')
                          : t('Move this card to Trash')
                      }
                      onClick={() => void deleteNode(selectedNode.id)}
                    >
                      {deletingNodeId === selectedNode.id ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => {
                        setInspectorId('');
                        toggleSelection(selectedNode.id);
                        locateSequence.current += 1;
                        setLocateRequest({
                          nodeId: selectedNode.id,
                          sequence: locateSequence.current,
                        });
                      }}
                    >
                      {combineIds.includes(selectedNode.id)
                        ? t('Unselect')
                        : t('Add to selection')}
                    </Button>
                    {selectedNode.role === 'start' ? (
                      <Button
                        type="button"
                        className="flex-1"
                        onClick={() => {
                          void beginEditSource(selectedNode);
                        }}
                      >
                        <Pencil /> {t('Edit source')}
                      </Button>
                    ) : null}
                  </div>
                  {deletionBlockers.length > 0 ? (
                    <p className="text-[10px] leading-4 text-muted-foreground">
                      {t('Referenced by')}
                      {deletionBlockers.length}{' '}
                      {deletionBlockers.length === 1 ? 'card' : t('cards')}
                      {t('. Delete those first.')}
                    </p>
                  ) : null}
                </SheetFooter>
              </>
            ) : null}
          </SheetContent>
        </Sheet>

        <MarkdownReaderDialog
          preview={preview}
          onClose={() => setPreview(null)}
        />

        <Dialog
          open={comparison !== null}
          onOpenChange={(open) => {
            if (!open) setComparison(null);
          }}
        >
          <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-4xl">
            {comparison ? (
              <>
                <div>
                  <h2 className="text-sm font-semibold">
                    {t('Review')}
                    {comparison.title}
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(
                      'Every changed line is shown before this revision is accepted.',
                    )}
                  </p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border font-mono text-[11px] leading-5">
                  {lineDiff(comparison.previous, comparison.current).map(
                    (line, index) => (
                      <div
                        key={`${index}:${line.text}`}
                        className={cn(
                          'grid grid-cols-[24px_1fr] px-3 py-0.5',
                          line.kind === 'added' && 'bg-emerald-500/10',
                          line.kind === 'removed' && 'bg-red-500/10',
                        )}
                      >
                        <span className="select-none text-muted-foreground">
                          {line.kind === 'added'
                            ? '+'
                            : line.kind === 'removed'
                              ? '−'
                              : ' '}
                        </span>
                        <span className="whitespace-pre-wrap break-words">
                          {line.text || ' '}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function hasCombineDraft(draft: CombineDraft) {
  return Boolean(
    draft.sourceNodeIds.length ||
    draft.instruction.trim() ||
    draft.contextRefs.length ||
    draft.files.length,
  );
}

function SourcePicker({
  folders,
  folderPath,
  onFolderPath,
  refs,
  onToggleRef,
  files,
  onAddFiles,
  onRemoveFile,
  label,
}: {
  folders: ContextBrowserFolder[];
  folderPath: string;
  onFolderPath: (path: string) => void;
  refs: string[];
  onToggleRef: (path: string) => void;
  files: File[];
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  label: string;
}) {
  return (
    <ContextAttachmentPicker
      folders={folders}
      folderPath={folderPath}
      onFolderPath={onFolderPath}
      refs={refs}
      onToggleRef={onToggleRef}
      files={files}
      onAddFiles={onAddFiles}
      onRemoveFile={onRemoveFile}
      label={label}
    />
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-xs leading-5">{value}</p>
    </div>
  );
}

function buildRelationshipSections(
  candidate: {
    layer?: 'discovery' | 'product-design';
    derivedFrom: string[];
    dependsOn: string[];
  },
  nodes: TaskGraphNode[],
  sharedSourceId: string,
) {
  type Layer = 'discovery' | 'product-design';
  const currentLayer = candidate.layer ?? 'discovery';
  const sections = new Map<
    Layer,
    { layer: Layer; derivedFrom: string[]; dependsOn: string[] }
  >();
  const section = (layer: Layer) => {
    const existing = sections.get(layer);
    if (existing) return existing;
    const created = { layer, derivedFrom: [], dependsOn: [] };
    sections.set(layer, created);
    return created;
  };
  const layerFor = (nodeId: string): Layer =>
    nodes.find((node) => node.id === nodeId)?.layer ?? 'discovery';

  section(currentLayer);
  if (currentLayer === 'product-design' && sharedSourceId) {
    section(currentLayer).derivedFrom.push(sharedSourceId);
  }
  for (const nodeId of candidate.derivedFrom) {
    section(layerFor(nodeId)).derivedFrom.push(nodeId);
  }
  for (const nodeId of candidate.dependsOn) {
    section(layerFor(nodeId)).dependsOn.push(nodeId);
  }
  return [
    section(currentLayer),
    ...[...sections.values()].filter((entry) => entry.layer !== currentLayer),
  ];
}

function layerLabel(layer: 'discovery' | 'product-design') {
  return layer === 'product-design' ? 'Product Design' : 'Discovery';
}

function RelationshipColumns({
  title,
  leftLabel,
  leftIds,
  rightLabel,
  rightIds,
  onSelect,
}: {
  title: string;
  leftLabel: string;
  leftIds: string[];
  rightLabel: string;
  rightIds: string[];
  onSelect: (nodeId: string) => void;
}) {
  const rowCount = Math.max(leftIds.length, rightIds.length, 1);
  return (
    <section>
      <p className="mb-1.5 text-[10px] font-semibold tracking-wide text-foreground">
        {title}
      </p>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="grid grid-cols-2 border-b border-border bg-secondary/45 text-[10px] font-medium text-muted-foreground">
          <p className="px-2.5 py-2">{leftLabel}</p>
          <p className="border-l border-border px-2.5 py-2">{rightLabel}</p>
        </div>
        {Array.from({ length: rowCount }, (_, index) => (
          <div
            key={index}
            className="grid grid-cols-2 border-b border-border/70 last:border-b-0"
          >
            <RelationshipCell nodeId={leftIds[index]} onSelect={onSelect} />
            <RelationshipCell
              nodeId={rightIds[index]}
              onSelect={onSelect}
              divided
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function RelationshipCell({
  nodeId,
  onSelect,
  divided = false,
}: {
  nodeId?: string;
  onSelect: (nodeId: string) => void;
  divided?: boolean;
}) {
  return (
    <div className={cn('min-w-0 p-1.5', divided && 'border-l border-border')}>
      {nodeId ? (
        <button
          type="button"
          className="w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-[10px] text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          title={nodeId}
          onClick={() => onSelect(nodeId)}
        >
          {nodeId}
        </button>
      ) : (
        <span className="block px-2 py-1.5 text-[10px] text-muted-foreground">
          —
        </span>
      )}
    </div>
  );
}

function toggle(current: string[], value: string) {
  return current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
}

function resourceName(resourcePath: string) {
  return resourcePath.split('/').at(-1) ?? resourcePath;
}

function withoutFirstHeading(markdown: string) {
  return markdown.replace(/^#\s+[^\n]+\n+/, '').trim();
}

function agentForRun(run: WhatsNextRunRecord | undefined): LocalAgentKind {
  if (run?.transport === 'codex-cli') return 'codex';
  if (run?.transport === 'deepseek-cli') return 'deepseek';
  return 'claude';
}

function mergePreviews(
  current: TaskGraphPreview[],
  incoming: TaskGraphPreview[],
) {
  const merged = new Map(current.map((preview) => [preview.id, preview]));
  for (const preview of incoming) {
    const previous = merged.get(preview.id);
    merged.set(
      preview.id,
      previous?.kind === 'candidate' &&
        preview.kind === 'run' &&
        preview.revisionOf === previous.id
        ? {
            ...preview,
            title: previous.title,
            description: previous.description,
            candidate: previous.candidate,
            outputPath: previous.outputPath,
            previousOutputPath: previous.previousOutputPath,
            previousMarkdown: previous.previousMarkdown,
          }
        : previous?.kind === 'candidate' && preview.kind === 'candidate'
          ? {
              ...preview,
              previousOutputPath:
                preview.previousOutputPath ?? previous.outputPath,
              previousMarkdown:
                previous.candidate && 'outputMarkdown' in previous.candidate
                  ? previous.candidate.outputMarkdown
                  : undefined,
            }
          : preview,
    );
  }
  return [...merged.values()];
}

function mergeTerminalRunPreviews(
  current: TaskGraphPreview[],
  run: WhatsNextRunRecord,
) {
  return replaceRunWithPreviewsInPlace(
    current,
    run.runId,
    whatsNextRunToPreviews(run),
  );
}

function upsertRun(current: WhatsNextRunRecord[], run: WhatsNextRunRecord) {
  return [...current.filter((item) => item.runId !== run.runId), run].sort(
    (left, right) => left.startedAt.localeCompare(right.startedAt),
  );
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function lineDiff(previous: string, current: string) {
  const before = previous.split('\n');
  const after = current.split('\n');
  const rows = Array.from(
    { length: before.length + 1 },
    () => Array(after.length + 1).fill(0) as number[],
  );
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      rows[left]![right] =
        before[left] === after[right]
          ? rows[left + 1]![right + 1]! + 1
          : Math.max(rows[left + 1]![right]!, rows[left]![right + 1]!);
    }
  }
  const lines: Array<{
    kind: 'same' | 'added' | 'removed';
    text: string;
  }> = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      lines.push({ kind: 'same', text: before[left]! });
      left += 1;
      right += 1;
    } else if (rows[left + 1]![right]! >= rows[left]![right + 1]!) {
      lines.push({ kind: 'removed', text: before[left]! });
      left += 1;
    } else {
      lines.push({ kind: 'added', text: after[right]! });
      right += 1;
    }
  }
  while (left < before.length) {
    lines.push({ kind: 'removed', text: before[left]! });
    left += 1;
  }
  while (right < after.length) {
    lines.push({ kind: 'added', text: after[right]! });
    right += 1;
  }
  return lines;
}
