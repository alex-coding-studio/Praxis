'use client';
import { useDeliveryStates } from '@/hooks/use-delivery-states';
import { useUiText } from '@/components/ui-language-provider';

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  FileText,
  Folder,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  AgentComposerAttachments,
  AgentComposerShell,
} from '@/components/agent-composer-shell';
import { AgentRunControls } from '@/components/agent-run-controls';
import { ModuleContextTrigger } from '@/components/module-context-trigger';
import { AgentGraphComposerCard } from '@/components/agent-graph-composer-card';
import { LatestResponseCard } from '@/components/latest-response-card';
import { useLatestResponse } from '@/hooks/use-latest-response';
import { useSurfacePreference } from '@/hooks/use-surface-preference';
import type { LatestResponseDocument } from '@/lib/execution-observability/types';
import { AgentGraphIntentionSelect } from '@/components/agent-graph-intention-select';
import { AgentGraphMotionSelect } from '@/components/agent-graph-motion-select';
import {
  ContextAttachmentPicker,
  contextAttachmentTitle,
} from '@/components/context-attachment-picker';
import { LatestResponseActions } from '@/components/latest-response';
import {
  CandidateMetadataSections,
  CandidateResourceList,
  ProposalWorkspaceStatus,
} from '@/components/agent-graph-proposal-workspace';
import type { AgentProfile } from '@/lib/agents/profile';
import { MarkdownReaderDialog } from '@/components/markdown-reader-dialog';
import { ProjectModuleHeader } from '@/components/project-module-header';
import {
  NodeProvenanceFacts,
  NodeResourceSections,
} from '@/components/node-property-sections';
import { TaskGraphCanvas } from '@/components/task-graph-canvas';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
import { getTaskGraphRelationships } from '@/lib/graph/task/rules';
import type { LocalAgentKind } from '@/lib/agents/transport';
import type {
  TaskDecompositionRunRecord,
  TaskDecompositionRunTransport,
} from '@/lib/modules/scope-decomposition/runs';
import { replaceRunWithPreviewsInPlace } from '@/lib/graph/task/preview-state';
import {
  latestTaskDecompositionResponse,
  latestTerminalTaskDecompositionRun,
} from '@/lib/latest-response';
import { cn } from '@/lib/utils';
import {
  mergeLatestCandidatePreview,
  proposalFocusNodeIds,
  reconcileProposalRuns,
} from '@/lib/graph/agent/proposal';
import { titleFromAgentGraphIdea } from '@/lib/graph/agent/source';
import {
  taskDecompositionIntentionRegistry,
  type TaskDecompositionIntention,
} from '@/lib/modules/scope-decomposition/intention';
import { unresolvedCandidateDependencies } from '@/lib/modules/scope-decomposition/dependencies';
import {
  taskDecompositionMotionRegistry,
  type TaskDecompositionMotion,
} from '@/lib/modules/scope-decomposition/motion';
import {
  successfulRecomposeOutputCandidateIds,
  successfulRecomposeSupersededCandidateIds,
} from '@/lib/graph/agent/recompose';

type DecompositionRequestPreview = TaskGraphPreview & {
  contextRefs: string[];
  files: File[];
  intention?: TaskDecompositionIntention;
  motion?: TaskDecompositionMotion;
  recomposeCandidateIds?: string[];
};

const AGENT_LABELS: Record<LocalAgentKind, string> = {
  codex: 'Codex',
  claude: 'Claude',
  deepseek: 'DeepSeek',
};

const TRANSPORT_LABELS: Record<TaskDecompositionRunTransport, string> = {
  'codex-cli': 'Codex',
  'claude-cli': 'Claude',
  'deepseek-cli': 'DeepSeek',
};

type RunSnapshot = {
  sourceNodeId: string;
  instruction: string;
  contextRefs: string[];
  files: File[];
  revisionTarget?: { runId: string; candidateId: string };
  revisionPreview?: DecompositionRequestPreview;
  operation: 'propose' | 'append-candidates' | 'recompose-candidates';
  intention: TaskDecompositionIntention;
  motion: TaskDecompositionMotion;
  recomposeCandidateIds: string[];
};

export function TaskDecompositionWorkspace({
  projectId,
  folders,
  initialNodes,
  initialPreviews,
  initialRuns,
  initialResponse = null,
  developmentPreview,
  developmentPreviewSequence,
}: {
  projectId: string;
  folders: ContextBrowserFolder[];
  initialNodes: TaskGraphNode[];
  initialPreviews: TaskGraphPreview[];
  initialRuns: TaskDecompositionRunRecord[];
  initialResponse?: LatestResponseDocument | null;
  developmentPreview: boolean;
  developmentPreviewSequence?: {
    running: TaskGraphPreview;
    completed: TaskGraphPreview;
  };
}) {
  const { t } = useUiText();
  const deliveryStates = useDeliveryStates(projectId);
  const [nodes, setNodes] = useState(initialNodes);
  const [runs, setRuns] = useState(initialRuns);
  const [startIdea, setStartIdea] = useState('');
  const [title, setTitle] = useState('');
  const [selectedRefs, setSelectedRefs] = useState<string[]>([]);
  const [selectedFolderPath, setSelectedFolderPath] = useState(
    folders[0]?.path ?? '',
  );
  const [files, setFiles] = useState<File[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [focusedNodeId, setFocusedNodeId] = useState('');
  const [inspectorNodeId, setInspectorNodeId] = useState('');
  const [locateRequest, setLocateRequest] = useState<{
    nodeId: string;
    sequence: number;
  } | null>(null);
  const [proposalFocusSequence, setProposalFocusSequence] = useState(0);
  const [requestPreviews, setRequestPreviews] = useState<
    DecompositionRequestPreview[]
  >(() => {
    let previews: DecompositionRequestPreview[] = initialPreviews.map(
      (preview) => ({
        ...preview,
        contextRefs: [],
        files: [],
      }),
    );
    for (const run of initialRuns) {
      for (const preview of taskDecompositionProposalPreviews(
        run,
        initialNodes,
      )) {
        previews = mergeLatestCandidatePreview(previews, preview);
      }
    }
    const superseded = supersededCandidateIds(initialRuns);
    return previews.filter((preview) => !superseded.has(preview.id));
  });
  const [decomposeSourceId, setDecomposeSourceId] = useState('');
  const [decompositionGoal, setDecompositionGoal] = useState('');
  const [agentProfile, setAgentProfile] = useState<AgentProfile>({
    agent: 'codex',
    model: '',
    effort: '',
  });
  const [intention, setIntention] = useState<TaskDecompositionIntention>(
    initialRuns.at(-1)?.intention ??
      taskDecompositionIntentionRegistry.defaultId,
  );
  const [motion, setMotion] = useState<TaskDecompositionMotion>(
    initialRuns.at(-1)?.motion ?? taskDecompositionMotionRegistry.defaultId,
  );
  const [recomposeCandidateIds, setRecomposeCandidateIds] = useState<string[]>(
    [],
  );
  const selectedAgent = agentProfile.agent;
  const [revisionTarget, setRevisionTarget] = useState<{
    runId: string;
    candidateId: string;
  } | null>(null);
  const [runOperation, setRunOperation] = useState<
    'propose' | 'append-candidates' | 'recompose-candidates'
  >('propose');
  const [requestSelectedRefs, setRequestSelectedRefs] = useState<string[]>([]);
  const [requestFiles, setRequestFiles] = useState<File[]>([]);
  const [requestFolderPath, setRequestFolderPath] = useState(
    folders[0]?.path ?? '',
  );
  const [requestError, setRequestError] = useState('');
  const [retainedAttachmentRefs, setRetainedAttachmentRefs] = useState<
    string[]
  >([]);
  const [preview, setPreview] = useState<{
    title: string;
    path: string;
    markdown: string;
  } | null>(null);
  const [previewingPath, setPreviewingPath] = useState('');
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [accepting, setAccepting] = useState(false);
  const [candidateDeleteOpen, setCandidateDeleteOpen] = useState(false);
  const [discardingCandidate, setDiscardingCandidate] = useState(false);
  const [candidateActionError, setCandidateActionError] = useState('');
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runSnapshots = useRef(new Map<string, RunSnapshot>());
  const restoredRuns = useRef(false);
  const selectedFolder =
    folders.find((folder) => folder.path === selectedFolderPath) ?? folders[0];
  const availableSourceCount = folders.reduce(
    (count, folder) =>
      count + folder.entries.filter((entry) => entry.kind === 'file').length,
    0,
  );
  const sourceCount =
    selectedRefs.length +
    retainedAttachmentRefs.length +
    files.length +
    Number(
      nodes
        .find((node) => node.id === editingId)
        ?.resources.some(
          (resource) =>
            resource.kind === 'user-input' || resource.kind === 'idea',
        ),
    );
  const selectedNode =
    nodes.find((node) => node.id === inspectorNodeId) ?? null;
  const selectedCandidatePreview =
    requestPreviews.find(
      (preview) =>
        preview.id === inspectorNodeId && preview.kind === 'candidate',
    ) ?? null;
  const selectedCandidate = selectedCandidatePreview?.candidate ?? null;
  const selectedCandidateIsRecomposeOutput = Boolean(
    selectedCandidate &&
    successfulRecomposeOutputCandidateIds(runs).has(
      selectedCandidate.candidateId,
    ),
  );
  const unresolvedAcceptanceDependencies = selectedCandidate
    ? unresolvedCandidateDependencies(selectedCandidate.dependsOn, nodes).map(
        (dependencyId) => {
          const preview = requestPreviews.find(
            (candidate) => candidate.id === dependencyId,
          );
          return {
            id: dependencyId,
            title: preview?.title ?? dependencyId,
          };
        },
      )
    : [];
  const selectedCandidateIsRevising = selectedCandidate
    ? requestPreviews.some(
        (preview) =>
          preview.kind === 'run' &&
          preview.revisionOf === selectedCandidate.candidateId,
      )
    : false;
  const selectedRelationships = selectedNode
    ? getTaskGraphRelationships(nodes, selectedNode.id)
    : null;
  const deletionBlockers = selectedRelationships
    ? [
        ...new Map(
          [
            ...selectedRelationships.derivedNodes,
            ...selectedRelationships.dependents,
          ].map((node) => [node.id, node]),
        ).values(),
      ]
    : [];
  const decomposeSource =
    nodes.find((node) => node.id === decomposeSourceId) ?? null;
  const moduleResponse = useLatestResponse(
    projectId,
    'task-decomposition',
    initialResponse,
  );
  const [responseCollapsed, setResponseCollapsed] = useSurfacePreference(
    projectId,
    'task-decomposition',
    'latest-response',
  );
  const [composerCollapsed, setComposerCollapsed] = useSurfacePreference(
    projectId,
    'task-decomposition',
    'composer',
  );
  const latestRun = latestTerminalTaskDecompositionRun(runs);
  const latestRunPresentation = latestRun
    ? latestTaskDecompositionResponse(latestRun)
    : null;
  const currentCandidatePreviews = requestPreviews.filter(
    (preview) => preview.kind === 'candidate',
  );
  const currentCandidateIds = new Set(
    currentCandidatePreviews.map((preview) => preview.id),
  );
  const activeProposalNodeIds = proposalFocusNodeIds(currentCandidatePreviews);
  const activeProposalKey = activeProposalNodeIds.join('|');
  const fitRequest = activeProposalKey
    ? {
        nodeIds: activeProposalNodeIds,
        sequence: `${activeProposalKey}:${proposalFocusSequence}`,
      }
    : null;

  function upsertRun(run: TaskDecompositionRunRecord) {
    setRuns((current) => [
      ...current.filter((candidate) => candidate.runId !== run.runId),
      run,
    ]);
  }

  function toggleSource(ref: string, selected: boolean) {
    setSelectedRefs((current) =>
      selected
        ? [...current, ref]
        : current.filter((candidate) => candidate !== ref),
    );
    setError('');
  }

  function addFiles(candidates: File[]) {
    const markdownFiles = candidates.filter((file) =>
      /\.(md|markdown)$/i.test(file.name),
    );
    if (markdownFiles.length !== candidates.length) {
      setError('Only Markdown source files can be added right now.');
    } else {
      setError('');
    }
    setFiles((current) => {
      const known = new Set(
        current.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
      );
      const additions = markdownFiles.filter(
        (file) => !known.has(`${file.name}:${file.size}:${file.lastModified}`),
      );
      return [...current, ...additions].slice(0, 20);
    });
  }

  async function saveTask(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || sourceCount === 0) return;
    setCreating(true);
    setError('');
    const formData = new FormData();
    if (editingId) formData.set('id', editingId);
    formData.set('title', title.trim());
    for (const ref of selectedRefs) formData.append('contextRefs', ref);
    for (const ref of retainedAttachmentRefs) {
      formData.append('retainedAttachmentRefs', ref);
    }
    for (const file of files) formData.append('files', file);
    const response = await fetch(`/api/projects/${projectId}/nodes`, {
      method: editingId ? 'PATCH' : 'POST',
      body: formData,
    });
    const result = (await response.json()) as {
      node?: TaskGraphNode;
      nodes?: TaskGraphNode[];
      error?: string;
    };
    setCreating(false);
    if (!response.ok || !result.node || !result.nodes) {
      setError(
        result.error ??
          (editingId
            ? 'Could not update the start node.'
            : 'Could not create the start node.'),
      );
      return;
    }
    setNodes(result.nodes);
    setFocusedNodeId(result.node.id);
    setTitle('');
    setSelectedRefs([]);
    setEditingId('');
    setRetainedAttachmentRefs([]);
    setFiles([]);
    setFormOpen(false);
  }

  async function beginFromIdea() {
    const instruction = startIdea.trim();
    if (!instruction || creating || developmentPreview) return;
    setCreating(true);
    setError('');
    try {
      const formData = new FormData();
      formData.set('title', titleFromAgentGraphIdea(instruction));
      formData.set('idea', instruction);
      for (const ref of selectedRefs) formData.append('contextRefs', ref);
      for (const file of files) formData.append('files', file);
      const response = await fetch(`/api/projects/${projectId}/nodes`, {
        method: 'POST',
        body: formData,
      });
      const result = (await response.json()) as {
        node?: TaskGraphNode;
        nodes?: TaskGraphNode[];
        error?: string;
      };
      if (!response.ok || !result.node || !result.nodes) {
        setError(result.error ?? 'Could not create the Start.');
        return;
      }
      setNodes(result.nodes);
      setStartIdea('');
      setSelectedRefs([]);
      setFiles([]);
      const started = await startDecompositionRun({
        source: result.node,
        instruction: '',
        contextRefs: [],
        files: [],
        operation: 'propose',
        intention,
        motion,
        recomposeCandidateIds: [],
      });
      if (!started) {
        setDecomposeSourceId(result.node.id);
        setDecompositionGoal(instruction);
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not create the Start.',
      );
    } finally {
      setCreating(false);
    }
  }

  function editNode(node: TaskGraphNode) {
    setEditingId(node.id);
    setTitle(node.title);
    setSelectedRefs(
      node.resources
        .filter((resource) => resource.kind === 'context')
        .map((resource) => resource.path),
    );
    setRetainedAttachmentRefs(
      node.resources
        .filter((resource) => resource.kind === 'attachment')
        .map((resource) => resource.path),
    );
    setFiles([]);
    setError('');
    setInspectorNodeId('');
    setFormOpen(true);
  }

  function cancelEditing() {
    setEditingId('');
    setTitle('');
    setSelectedRefs([]);
    setRetainedAttachmentRefs([]);
    setFiles([]);
    setError('');
    setFormOpen(false);
  }

  function openDecomposition(nodeId: string) {
    const hasExistingChildren =
      nodes.some((node) => node.derivedFrom?.includes(nodeId)) ||
      requestPreviews.some(
        (candidate) =>
          candidate.kind === 'candidate' &&
          candidate.derivedFrom?.includes(nodeId),
      );
    setDecomposeSourceId(nodeId);
    setDecompositionGoal('');
    setRequestSelectedRefs([]);
    setRequestFiles([]);
    setRequestError('');
    setRevisionTarget(null);
    setRecomposeCandidateIds([]);
    setRunOperation(hasExistingChildren ? 'append-candidates' : 'propose');
    setIntention(
      [...runs].reverse().find((run) => run.sourceNodeId === nodeId)
        ?.intention ?? taskDecompositionIntentionRegistry.defaultId,
    );
    setMotion(
      [...runs].reverse().find((run) => run.sourceNodeId === nodeId)?.motion ??
        taskDecompositionMotionRegistry.defaultId,
    );
  }

  function toggleRecomposeCandidate(candidateId: string) {
    const candidate = requestPreviews.find(
      (preview) => preview.kind === 'candidate' && preview.id === candidateId,
    );
    if (!candidate) return;
    setRecomposeCandidateIds((current) => {
      if (current.includes(candidateId)) {
        const next = current.filter((id) => id !== candidateId);
        if (next.length === 0) closeDecomposition();
        return next;
      }
      const selected = requestPreviews.filter((preview) =>
        current.includes(preview.id),
      );
      if (
        selected.some(
          (preview) => preview.sourceNodeId !== candidate.sourceNodeId,
        )
      ) {
        setRequestError('Recompose Candidates must share one source Node.');
        return current;
      }
      setDecomposeSourceId(candidate.sourceNodeId);
      setRevisionTarget(null);
      setRunOperation('recompose-candidates');
      setDecompositionGoal('');
      setRequestError('');
      return [...current, candidateId];
    });
  }

  function selectRequestPreview(previewId: string) {
    const preview = requestPreviews.find(
      (candidate) => candidate.id === previewId,
    );
    if (!preview) return;
    setDecomposeSourceId(preview.sourceNodeId);
    setDecompositionGoal(preview.instruction);
    setRequestSelectedRefs(preview.contextRefs);
    setRequestFiles(preview.files);
    setIntention(
      preview.intention ?? taskDecompositionIntentionRegistry.defaultId,
    );
    setMotion(preview.motion ?? taskDecompositionMotionRegistry.defaultId);
    setRecomposeCandidateIds(preview.recomposeCandidateIds ?? []);
    setRequestError('');
  }

  function closeDecomposition() {
    setDecomposeSourceId('');
    setDecompositionGoal('');
    setRequestSelectedRefs([]);
    setRequestFiles([]);
    setRequestError('');
    setRevisionTarget(null);
    setRecomposeCandidateIds([]);
    setRunOperation('propose');
  }

  function toggleRequestSource(ref: string, selected: boolean) {
    setRequestSelectedRefs((current) =>
      selected
        ? [...current, ref]
        : current.filter((candidate) => candidate !== ref),
    );
    setRequestError('');
  }

  function addRequestFiles(candidates: File[]) {
    const markdownFiles = candidates.filter((file) =>
      /\.(md|markdown|txt|html|htm)$/i.test(file.name),
    );
    if (markdownFiles.length !== candidates.length) {
      setRequestError(t('Only Markdown Resources can be added right now.'));
    } else {
      setRequestError('');
    }
    setRequestFiles((current) => {
      const known = new Set(
        current.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
      );
      const additions = markdownFiles.filter(
        (file) => !known.has(`${file.name}:${file.size}:${file.lastModified}`),
      );
      return [...current, ...additions].slice(0, 20);
    });
  }

  async function previewDecomposition(
    event: React.SyntheticEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const goal = decompositionGoal.trim();
    if (!decomposeSource || !goal) return;
    if (!developmentPreview) {
      const started = await startDecompositionRun({
        source: decomposeSource,
        instruction: goal,
        contextRefs: requestSelectedRefs,
        files: requestFiles,
        operation: runOperation,
        revisionTarget,
        intention,
        motion,
        recomposeCandidateIds,
      });
      if (started) closeDecomposition();
      return;
    }
    const preview: DecompositionRequestPreview = {
      id: `REQUEST-PREVIEW-${decomposeSource.id}`,
      sourceNodeId: decomposeSource.id,
      instruction: goal,
      inheritedResourceCount: decomposeSource.resources.length,
      additionalResourceCount: requestSelectedRefs.length + requestFiles.length,
      contextRefs: requestSelectedRefs,
      files: requestFiles,
      intention,
      motion,
      recomposeCandidateIds,
      kind: 'request',
    };
    setRequestPreviews((current) => [
      ...current.filter((candidate) => candidate.id !== preview.id),
      preview,
    ]);
    closeDecomposition();
  }

  async function startDecompositionRun({
    source,
    instruction,
    contextRefs,
    files,
    operation,
    revisionTarget: target,
    intention: selectedIntention,
    motion: selectedMotion,
    recomposeCandidateIds: selectedCandidateIds,
  }: {
    source: TaskGraphNode;
    instruction: string;
    contextRefs: string[];
    files: File[];
    operation: 'propose' | 'append-candidates' | 'recompose-candidates';
    revisionTarget?: { runId: string; candidateId: string } | null;
    intention: TaskDecompositionIntention;
    motion: TaskDecompositionMotion;
    recomposeCandidateIds: string[];
  }) {
    setRequestError('');
    const revisionPreview = target
      ? requestPreviews.find(
          (preview) =>
            preview.kind === 'candidate' && preview.id === target.candidateId,
        )
      : undefined;
    const snapshot: RunSnapshot = {
      sourceNodeId: source.id,
      instruction,
      contextRefs: [...contextRefs],
      files: [...files],
      revisionTarget: target ?? undefined,
      revisionPreview,
      operation,
      intention: selectedIntention,
      motion: selectedMotion,
      recomposeCandidateIds: [...selectedCandidateIds],
    };
    const formData = new FormData();
    formData.set('sourceNodeId', source.id);
    formData.set('instruction', instruction);
    formData.set('agent', selectedAgent);
    formData.set('model', agentProfile.model);
    formData.set('effort', agentProfile.effort);
    formData.set('operation', operation);
    formData.set('intention', selectedIntention);
    formData.set('motion', selectedMotion);
    for (const candidateId of selectedCandidateIds)
      formData.append('recomposeCandidateIds', candidateId);
    if (target) {
      formData.set('revisionRunId', target.runId);
      formData.set('revisionCandidateId', target.candidateId);
    }
    for (const ref of contextRefs) formData.append('contextRefs', ref);
    for (const file of files) formData.append('files', file);
    const response = await fetch(
      `/api/projects/${projectId}/decomposition-runs`,
      { method: 'POST', body: formData },
    );
    const result = (await response.json()) as {
      run?: TaskDecompositionRunRecord;
      error?: string;
    };
    if (!response.ok || !result.run) {
      setRequestError(result.error ?? 'Could not start the Agent Run.');
      return false;
    }
    const run = result.run;
    upsertRun(run);
    runSnapshots.current.set(run.runId, snapshot);
    const runningPreview = runPreview(run, snapshot, source.resources.length);
    setRequestPreviews((current) => {
      if (snapshot.revisionPreview && target) {
        return replaceRunWithPreviewsInPlace(current, run.runId, [
          {
            ...runningPreview,
            id: target.candidateId,
            title: snapshot.revisionPreview.title,
            description: snapshot.revisionPreview.description,
            color: snapshot.revisionPreview.color,
            derivedFrom: snapshot.revisionPreview.derivedFrom,
            dependsOn: snapshot.revisionPreview.dependsOn,
            candidate: snapshot.revisionPreview.candidate,
            outputPath: snapshot.revisionPreview.outputPath,
          },
        ]);
      }
      return [
        ...(operation === 'append-candidates' ||
        operation === 'recompose-candidates'
          ? current
          : current.filter(
              (candidate) => candidate.sourceNodeId !== source.id,
            )),
        runningPreview,
      ];
    });
    if (target) setFocusedNodeId('');
    return true;
  }

  function applyRunRecord(run: TaskDecompositionRunRecord) {
    upsertRun(run);
    if (['running', 'validating'].includes(run.status)) {
      const activity = run.activity.at(-1)?.summary;
      setRequestPreviews((current) =>
        current.map((preview) =>
          preview.id === run.runId || preview.runId === run.runId
            ? {
                ...preview,
                status: run.status,
                description: activity ?? preview.description,
                updatedAt: run.updatedAt,
              }
            : preview,
        ),
      );
      return;
    }
    const snapshot = runSnapshots.current.get(run.runId);
    if (run.status === 'canceled') {
      setRequestPreviews((current) =>
        snapshot?.revisionPreview
          ? replaceRunWithPreviewsInPlace(current, run.runId, [
              snapshot.revisionPreview,
            ])
          : current.filter(
              (preview) =>
                preview.id !== run.runId && preview.runId !== run.runId,
            ),
      );
      if (snapshot?.revisionPreview) setFocusedNodeId('');
      return;
    }
    if (run.status === 'proposal' && run.result?.outcome === 'proposal') {
      const retained = new Set(
        run.result.recomposition?.effects
          .filter((effect) => effect.kind === 'retain')
          .flatMap((effect) => effect.from) ?? [],
      );
      const superseded = new Set(
        (run.recomposeCandidateIds ?? []).filter((id) => !retained.has(id)),
      );
      const candidatePreviews = taskDecompositionProposalPreviews(
        run,
        nodes,
        snapshot,
      );
      setRequestPreviews((current) =>
        replaceRunWithPreviewsInPlace(
          current.filter((preview) => !superseded.has(preview.id)),
          run.runId,
          candidatePreviews,
        ),
      );
      if (run.revisionOf) setFocusedNodeId('');
      runSnapshots.current.delete(run.runId);
      return;
    }
    finishRunWithoutCandidates(run.runId);
  }

  function finishRunWithoutCandidates(runId: string) {
    const snapshot = runSnapshots.current.get(runId);
    setRequestPreviews((current) =>
      snapshot?.revisionPreview
        ? replaceRunWithPreviewsInPlace(current, runId, [
            snapshot.revisionPreview,
          ])
        : current.filter(
            (preview) => preview.id !== runId && preview.runId !== runId,
          ),
    );
    if (snapshot?.revisionPreview) setFocusedNodeId('');
    runSnapshots.current.delete(runId);
  }

  async function cancelRun(runId: string) {
    const snapshot = runSnapshots.current.get(runId);
    const response = await fetch(
      `/api/projects/${projectId}/decomposition-runs`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      },
    );
    if (!response.ok) return;
    const payload = (await response.json()) as {
      run?: TaskDecompositionRunRecord;
    };
    if (payload.run) upsertRun(payload.run);
    setRequestPreviews((current) =>
      snapshot?.revisionPreview
        ? replaceRunWithPreviewsInPlace(current, runId, [
            snapshot.revisionPreview,
          ])
        : current.filter(
            (preview) => preview.id !== runId && preview.runId !== runId,
          ),
    );
    if (snapshot) {
      if (snapshot.revisionTarget) setFocusedNodeId('');
      setDecomposeSourceId(snapshot.sourceNodeId);
      setDecompositionGoal(snapshot.instruction);
      setRequestSelectedRefs(snapshot.contextRefs);
      setRequestFiles(snapshot.files);
      setRevisionTarget(snapshot.revisionTarget ?? null);
      setRunOperation(snapshot.operation);
      setIntention(snapshot.intention);
      setMotion(snapshot.motion);
      setRecomposeCandidateIds(snapshot.recomposeCandidateIds);
    }
    runSnapshots.current.delete(runId);
  }

  function reviseCandidate() {
    if (!selectedCandidatePreview?.runId || !selectedCandidate) return;
    setRevisionTarget({
      runId: selectedCandidatePreview.runId,
      candidateId: selectedCandidate.candidateId,
    });
    setDecomposeSourceId(selectedCandidate.derivedFrom[0] ?? '');
    setDecompositionGoal('');
    setRequestSelectedRefs([]);
    setRequestFiles([]);
    setRequestError('');
    setRunOperation('propose');
    setIntention(
      runs.find((run) => run.runId === selectedCandidatePreview.runId)
        ?.intention ?? taskDecompositionIntentionRegistry.defaultId,
    );
    setMotion(
      runs.find((run) => run.runId === selectedCandidatePreview.runId)
        ?.motion ?? taskDecompositionMotionRegistry.defaultId,
    );
    setRecomposeCandidateIds([]);
    setCandidateActionError('');
    setInspectorNodeId('');
  }

  async function acceptCandidate() {
    if (!selectedCandidatePreview?.runId || !selectedCandidate) return;
    setAccepting(true);
    setCandidateActionError('');
    const response = await fetch(
      `/api/projects/${projectId}/decomposition-runs`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'accept',
          runId: selectedCandidatePreview.runId,
          candidateId: selectedCandidate.candidateId,
        }),
      },
    );
    const payload = (await response.json()) as {
      node?: TaskGraphNode;
      nodes?: TaskGraphNode[];
      error?: string;
    };
    setAccepting(false);
    if (!response.ok || !payload.node || !payload.nodes) {
      setCandidateActionError(
        payload.error ?? 'Could not accept the Candidate.',
      );
      return;
    }
    setNodes(payload.nodes);
    setRequestPreviews((current) =>
      current
        .filter((preview) => preview.id !== selectedCandidate.candidateId)
        .map((preview) => {
          if (!preview.dependsOn?.includes(selectedCandidate.candidateId)) {
            return preview;
          }
          const dependsOn = preview.dependsOn.map((dependencyId) =>
            dependencyId === selectedCandidate.candidateId
              ? (payload.node?.id ?? dependencyId)
              : dependencyId,
          );
          return {
            ...preview,
            dependsOn,
            candidate: preview.candidate
              ? { ...preview.candidate, dependsOn }
              : undefined,
          };
        }),
    );
    setInspectorNodeId('');
    setFocusedNodeId(payload.node.id);
    setLocateRequest((current) => ({
      nodeId: payload.node?.id ?? '',
      sequence: (current?.sequence ?? 0) + 1,
    }));
  }

  async function discardCandidate() {
    if (!selectedCandidate) return;
    if (developmentPreview || !selectedCandidatePreview?.runId) {
      setRequestPreviews((current) =>
        current.filter(
          (preview) => preview.id !== selectedCandidate.candidateId,
        ),
      );
      finishCandidateDiscard();
      return;
    }
    setDiscardingCandidate(true);
    setCandidateActionError('');
    const response = await fetch(
      `/api/projects/${projectId}/decomposition-runs`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'discard',
          runId: selectedCandidatePreview.runId,
          candidateId: selectedCandidate.candidateId,
        }),
      },
    );
    const payload = (await response.json()) as {
      error?: string;
      runDeleted?: boolean;
      deletedRunIds?: string[];
      runs?: TaskDecompositionRunRecord[];
    };
    setDiscardingCandidate(false);
    if (!response.ok) {
      setCandidateActionError(
        payload.error ?? 'Could not discard the Candidate.',
      );
      return;
    }
    setRequestPreviews((current) =>
      current.filter((preview) => preview.id !== selectedCandidate.candidateId),
    );
    setRuns((current) =>
      reconcileProposalRuns(current, {
        requestedRunId: selectedCandidatePreview.runId!,
        runDeleted: payload.runDeleted,
        deletedRunIds: payload.deletedRunIds,
        runs: payload.runs,
      }),
    );
    finishCandidateDiscard();
  }

  function finishCandidateDiscard() {
    setCandidateDeleteOpen(false);
    setInspectorNodeId('');
    setFocusedNodeId('');
    setLocateRequest(null);
  }

  const applyRunRecordEvent = useEffectEvent(applyRunRecord);

  useEffect(() => {
    if (developmentPreview || restoredRuns.current) return;
    restoredRuns.current = true;
    void fetch(`/api/projects/${projectId}/decomposition-runs`)
      .then(async (response) => {
        const payload = (await response.json()) as {
          runs?: TaskDecompositionRunRecord[];
        };
        if (!response.ok || !payload.runs) return;
        for (const run of payload.runs) {
          if (['running', 'validating'].includes(run.status)) {
            const snapshot: RunSnapshot = {
              sourceNodeId: run.sourceNodeId,
              instruction: 'Agent Run restored from disk.',
              contextRefs: [],
              files: [],
              operation:
                run.operation === 'append-candidates' ||
                run.operation === 'recompose-candidates'
                  ? run.operation
                  : 'propose',
              intention:
                run.intention ?? taskDecompositionIntentionRegistry.defaultId,
              motion: run.motion ?? taskDecompositionMotionRegistry.defaultId,
              recomposeCandidateIds: run.recomposeCandidateIds ?? [],
            };
            setRequestPreviews((current) =>
              current.some((preview) => preview.id === run.runId)
                ? current
                : [...current, runPreview(run, snapshot, 0)],
            );
          } else {
            applyRunRecordEvent(run);
          }
        }
      })
      .catch(() => undefined);
  }, [developmentPreview, projectId]);

  useEffect(() => {
    if (!developmentPreviewSequence) return;
    const transitionTimeout = window.setTimeout(() => {
      setRequestPreviews((current) =>
        replaceRunWithPreviewsInPlace(
          current,
          developmentPreviewSequence.running.runId ?? '',
          [
            {
              ...developmentPreviewSequence.running,
              contextRefs: [],
              files: [],
            },
          ],
        ),
      );
      setFocusedNodeId('');
    }, 800);
    const completionTimeout = window.setTimeout(() => {
      setRequestPreviews((current) =>
        replaceRunWithPreviewsInPlace(
          current,
          developmentPreviewSequence.running.runId ?? '',
          [
            {
              ...developmentPreviewSequence.completed,
              contextRefs: [],
              files: [],
            },
          ],
        ),
      );
    }, 1_800);

    return () => {
      window.clearTimeout(transitionTimeout);
      window.clearTimeout(completionTimeout);
    };
  }, [developmentPreviewSequence]);

  useEffect(() => {
    if (developmentPreview) return;
    const running = requestPreviews.filter(
      (preview) =>
        preview.kind === 'run' &&
        ['running', 'validating'].includes(preview.status ?? ''),
    );
    if (running.length === 0) return;

    const timer = window.setInterval(() => {
      void Promise.all(
        running.map(async (preview) => {
          const runId = preview.runId ?? preview.id;
          const response = await fetch(
            `/api/projects/${projectId}/decomposition-runs?runId=${encodeURIComponent(runId)}`,
          );
          const payload = (await response.json()) as {
            run?: TaskDecompositionRunRecord;
            error?: string;
          };
          if (!response.ok || !payload.run) {
            setError(payload.error ?? 'Could not read the Agent Run.');
            finishRunWithoutCandidates(runId);
            return;
          }
          applyRunRecordEvent(payload.run);
        }),
      );
    }, 750);
    return () => window.clearInterval(timer);
  }, [developmentPreview, projectId, requestPreviews]);

  async function previewResource(resourcePath: string, title?: string) {
    setPreviewingPath(resourcePath);
    setError('');
    const response = await fetch(
      `/api/projects/${projectId}/resources?path=${encodeURIComponent(resourcePath)}`,
    );
    const result = (await response.json()) as {
      fileName?: string;
      path?: string;
      markdown?: string;
      error?: string;
    };
    setPreviewingPath('');
    if (
      !response.ok ||
      !result.fileName ||
      !result.path ||
      result.markdown === undefined
    ) {
      setError(result.error ?? 'Could not read the source document.');
      return;
    }
    setPreview({
      title: title ?? result.fileName,
      path: result.path,
      markdown: result.markdown,
    });
  }

  function dropFiles(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  function locateNode(nodeId: string) {
    setInspectorNodeId('');
    setFocusedNodeId(nodeId);
    setLocateRequest((current) => ({
      nodeId,
      sequence: (current?.sequence ?? 0) + 1,
    }));
  }

  async function deleteSelectedNode() {
    if (!selectedNode || deletionBlockers.length > 0) return;
    setDeleting(true);
    setDeleteError('');

    if (developmentPreview) {
      setNodes((current) =>
        current.filter((node) => node.id !== selectedNode.id),
      );
      setRequestPreviews((current) =>
        current.filter((preview) => preview.sourceNodeId !== selectedNode.id),
      );
      finishNodeDeletion();
      return;
    }

    const response = await fetch(`/api/projects/${projectId}/nodes`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selectedNode.id }),
    });
    const result = (await response.json()) as {
      nodes?: TaskGraphNode[];
      error?: string;
    };
    if (!response.ok || !result.nodes) {
      setDeleting(false);
      setDeleteError(result.error ?? 'Could not delete the node.');
      return;
    }
    setNodes(result.nodes);
    setRequestPreviews((current) =>
      current.filter((preview) => preview.sourceNodeId !== selectedNode.id),
    );
    finishNodeDeletion();
  }

  function finishNodeDeletion() {
    setDeleting(false);
    setDeleteOpen(false);
    setInspectorNodeId('');
    setFocusedNodeId('');
    setLocateRequest(null);
  }

  return (
    <div className="flex h-dvh min-h-[480px] flex-col overflow-hidden">
      <ProjectModuleHeader
        title={t('Scope Decomposition')}
        description={t(
          'Break one scope into coherent, human-manageable nodes.',
        )}
        actions={
          <ModuleContextTrigger
            href={`/projects/${projectId}/decomposition/context`}
          />
        }
      />

      <div className="relative min-h-0 flex-1">
        <section className="relative h-full min-h-[480px] overflow-hidden">
          {nodes.length === 0 ? (
            <div className="min-h-full bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] bg-[size:22px_22px]">
              <AgentGraphComposerCard
                title={
                  <span className="flex items-center gap-2">
                    <Sparkles className="size-4 text-muted-foreground" />
                    {t('What do you want to break down?')}
                  </span>
                }
                description={t(
                  'Describe the scope in your own words. It becomes the Canvas Start and the first Agent instruction.',
                )}
              >
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <AgentGraphIntentionSelect
                    profiles={taskDecompositionIntentionRegistry.profiles}
                    value={intention}
                    onChange={setIntention}
                    label="Decomposition purpose"
                    showDescription={false}
                  />
                  <AgentGraphMotionSelect
                    profiles={taskDecompositionMotionRegistry.profiles}
                    value={motion}
                    onChange={setMotion}
                    label="Adjustment"
                  />
                </div>
                <AgentComposerAttachments
                  className="mt-4"
                  label={t('Optional sources')}
                  items={[
                    ...selectedRefs.map((ref) => ({
                      id: ref,
                      label: contextAttachmentTitle(folders, ref),
                      onRemove: () => toggleSource(ref, false),
                    })),
                    ...files.map((file, index) => ({
                      id: `${file.name}:${index}`,
                      label: file.name,
                      onRemove: () =>
                        setFiles((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        ),
                    })),
                  ]}
                />
                <AgentComposerShell
                  className="mt-4"
                  controls={
                    <AgentRunControls
                      extraInfo={
                        <ContextAttachmentPicker
                          embedded
                          folders={folders}
                          folderPath={selectedFolderPath}
                          onFolderPath={setSelectedFolderPath}
                          refs={selectedRefs}
                          onToggleRef={(ref) =>
                            toggleSource(ref, !selectedRefs.includes(ref))
                          }
                          files={files}
                          onAddFiles={addFiles}
                          onRemoveFile={(index) =>
                            setFiles((current) =>
                              current.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            )
                          }
                          label={t('Optional sources')}
                        />
                      }
                      extraInfoCount={selectedRefs.length + files.length}
                      extraInfoLabel="Optional sources"
                      value={agentProfile}
                      onChange={setAgentProfile}
                      mode={developmentPreview ? 'demo' : 'live'}
                      disabled={
                        !startIdea.trim() || creating || developmentPreview
                      }
                      running={creating}
                      actionLabel="Start and decompose"
                      onRun={() => void beginFromIdea()}
                    />
                  }
                >
                  <Textarea
                    value={startIdea}
                    onChange={(event) => setStartIdea(event.target.value)}
                    rows={4}
                    placeholder={t(
                      'A product, feature or technical scope that should become coherent boundaries…',
                    )}
                    className="resize-none text-sm"
                    aria-label={t('Decomposition scope')}
                  />
                </AgentComposerShell>
                {error ? (
                  <p className="mt-4 text-xs text-destructive">{error}</p>
                ) : null}
              </AgentGraphComposerCard>
            </div>
          ) : (
            <TaskGraphCanvas
              nodes={nodes.map((node) => ({
                ...node,
                metadata: {
                  ...node.metadata,
                  deliveryState: deliveryStates[node.uid ?? ''],
                },
              }))}
              previews={requestPreviews}
              focusedNodeId={focusedNodeId}
              locateRequest={locateRequest}
              fitRequest={fitRequest}
              selectedNodeIds={recomposeCandidateIds}
              selectionEnabled
              selectableKinds={['candidate']}
              avoidBottomRightPanel={
                decomposeSource !== null || recomposeCandidateIds.length > 0
              }
              onToggleSelection={toggleRecomposeCandidate}
              onFocusNode={setFocusedNodeId}
              onInspectNode={(nodeId) => {
                setFocusedNodeId(nodeId);
                setInspectorNodeId(nodeId);
              }}
              onSelectPreview={selectRequestPreview}
              onDecompose={openDecomposition}
              onCancelRun={cancelRun}
            />
          )}

          {moduleResponse.document ? (
            <LatestResponseCard
              document={moduleResponse.document}
              collapsed={responseCollapsed}
              onCollapsedChange={setResponseCollapsed}
              onCancel={() => void cancelRun(moduleResponse.document!.runId)}
              className="w-[min(320px,calc(100%-2rem))]"
            >
              {latestRun &&
              latestRunPresentation &&
              latestRun.runId === moduleResponse.document.runId ? (
                <LatestResponseActions
                  responseLabel={t('Response')}
                  summaryLabel={t('Summary')}
                  onOpenResponse={() =>
                    latestRun.result
                      ? void previewResource(
                          `task-decomposition/runs/${latestRun.runId}/response.md`,
                          t('Latest Response'),
                        )
                      : setPreview({
                          title: t('Latest Response'),
                          path: latestRun.runId,
                          markdown: `# ${t('Response')}\n\n${t(latestRunPresentation.summary)}\n`,
                        })
                  }
                  onOpenSummary={() =>
                    latestRun.result
                      ? void previewResource(
                          `task-decomposition/runs/${latestRun.runId}/summary.md`,
                          t('Summary'),
                        )
                      : setPreview({
                          title: t('Summary'),
                          path: latestRun.runId,
                          markdown: `# ${t('Summary')}\n\n${t(latestRunPresentation.summary)}\n`,
                        })
                  }
                />
              ) : null}
            </LatestResponseCard>
          ) : null}

          {nodes.length > 0 ? (
            <ProposalWorkspaceStatus
              className="absolute top-4 right-4 z-10"
              formalCount={nodes.length}
              candidateCount={currentCandidateIds.size}
              activeProposalCount={activeProposalNodeIds.length}
              onFocusProposal={() =>
                setProposalFocusSequence((current) => current + 1)
              }
            />
          ) : null}
        </section>

        <Dialog
          open={formOpen}
          onOpenChange={(open) => {
            if (open) setFormOpen(true);
            else cancelEditing();
          }}
        >
          <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
            <form onSubmit={saveTask} className="space-y-6">
              <div className="space-y-2">
                <label htmlFor="task-title" className="text-xs font-medium">
                  {t('Start-node title')}
                </label>
                <Input
                  id="task-title"
                  value={title}
                  maxLength={160}
                  placeholder={t('Scope Decomposition workspace')}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="context-folder" className="text-xs font-medium">
                  {t('Context Library folder')}
                </label>
                <div className="relative">
                  <select
                    id="context-folder"
                    value={selectedFolder?.path ?? ''}
                    onChange={(event) =>
                      setSelectedFolderPath(event.target.value)
                    }
                    className="h-10 w-full appearance-none rounded-xl border border-border bg-background px-3 pr-9 text-xs font-medium outline-none transition focus:border-ring focus:ring-3 focus:ring-ring/20"
                  >
                    {folders.map((folder) => {
                      const depth = folder.path.split('/').length - 2;
                      return (
                        <option key={folder.path} value={folder.path}>
                          {`${'— '.repeat(depth)}${folder.title}`}
                        </option>
                      );
                    })}
                  </select>
                  <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
                <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-xl border border-border">
                  {availableSourceCount === 0 ? (
                    <p className="p-4 text-xs text-muted-foreground">
                      {t('No Markdown documents are available yet.')}
                    </p>
                  ) : !selectedFolder || selectedFolder.entries.length === 0 ? (
                    <p className="p-4 text-xs text-muted-foreground">
                      {t('This folder is empty.')}
                    </p>
                  ) : (
                    selectedFolder.entries.map((entry, index) => {
                      if (entry.kind === 'folder') {
                        return (
                          <button
                            key={entry.path}
                            type="button"
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition hover:bg-muted/50"
                            onClick={() => setSelectedFolderPath(entry.path)}
                          >
                            <Folder className="size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                              {entry.name}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {t('Folder')}
                            </span>
                          </button>
                        );
                      }
                      const checked = selectedRefs.includes(entry.path);
                      const inputId = `context-source-${index}`;
                      return (
                        <label
                          key={entry.path}
                          htmlFor={inputId}
                          className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 transition hover:bg-muted/50"
                        >
                          <Checkbox
                            id={inputId}
                            checked={checked}
                            onCheckedChange={(value) =>
                              toggleSource(entry.path, value === true)
                            }
                            aria-label={`Use ${entry.name}`}
                            className="mt-0.5"
                          />
                          <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0">
                            <span className="block truncate font-mono text-[11px] font-medium">
                              {entry.name}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                              {entry.title}
                            </span>
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium">{t('Local Markdown')}</p>
                <button
                  type="button"
                  className={cn(
                    'flex min-h-24 w-full flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-4 text-center transition',
                    dragging && 'border-foreground bg-secondary',
                  )}
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDragging(false)}
                  onDrop={dropFiles}
                >
                  <Upload className="size-4" />
                  <span className="mt-2 text-xs font-medium">
                    {t('Drop Markdown or choose files')}
                  </span>
                  <span className="mt-1 text-[10px] text-muted-foreground">
                    {t('Up to 20 files, 2 MB each')}
                  </span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.markdown,text/markdown"
                  multiple
                  hidden
                  onChange={(event) => {
                    addFiles(Array.from(event.target.files ?? []));
                    event.target.value = '';
                  }}
                />
                {files.length > 0 ? (
                  <ul className="space-y-1.5 pt-1">
                    {files.map((file, index) => (
                      <li
                        key={`${file.name}:${file.size}:${file.lastModified}`}
                        className="flex items-center gap-2 rounded-lg bg-secondary px-2.5 py-2"
                      >
                        <FileText className="size-3 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-[11px]">
                          {file.name}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${file.name}`}
                          title={t('Remove source')}
                          onClick={() =>
                            setFiles((current) =>
                              current.filter(
                                (_, candidateIndex) => candidateIndex !== index,
                              ),
                            )
                          }
                        >
                          <X />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {retainedAttachmentRefs.length > 0 ? (
                  <ul className="space-y-1.5 pt-1">
                    {retainedAttachmentRefs.map((ref) => (
                      <li
                        key={ref}
                        className="flex items-center gap-2 rounded-lg bg-secondary px-2.5 py-2"
                      >
                        <FileText className="size-3 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-[11px]">
                          {resourceName(ref)}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${resourceName(ref)}`}
                          title={t('Remove source')}
                          onClick={() =>
                            setRetainedAttachmentRefs((current) =>
                              current.filter((candidate) => candidate !== ref),
                            )
                          }
                        >
                          <X />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              {error ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="border-t border-border pt-5">
                <Button
                  type="submit"
                  className="w-full"
                  size="lg"
                  disabled={!title.trim() || sourceCount === 0 || creating}
                >
                  {editingId ? <Pencil /> : <Plus />}{' '}
                  {creating
                    ? editingId
                      ? t('Saving…')
                      : t('Creating…')
                    : editingId
                      ? t('Save changes')
                      : t('Create start node')}
                </Button>
                <p className="mt-2 text-center text-[10px] text-muted-foreground">
                  {sourceCount} {sourceCount === 1 ? 'source' : 'sources'}{' '}
                  {t('selected')}
                </p>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {decomposeSource ? (
          <AgentGraphComposerCard
            running={moduleResponse.running}
            collapsed={composerCollapsed}
            onCollapsedChange={setComposerCollapsed}
            title={
              revisionTarget
                ? `Revise ${revisionTarget.candidateId}`
                : runOperation === 'recompose-candidates'
                  ? `Recompose ${recomposeCandidateIds.length} Candidates`
                  : runOperation === 'append-candidates'
                    ? `Extend ${decomposeSource.id}`
                    : t('Decompose from {id}', { id: decomposeSource.id })
            }
            description={
              revisionTarget
                ? t(
                    'Redefine this Candidate only. Revisions cannot create siblings or child Nodes.',
                  )
                : runOperation === 'recompose-candidates'
                  ? t(
                      'Replace the selected unaccepted Candidate working set atomically. Accepted Nodes remain unchanged.',
                    )
                  : runOperation === 'append-candidates'
                    ? t(
                        'Existing child boundaries will not be replaced. Add new evidence or guidance so {agent} can propose only genuinely new siblings.',
                        { agent: AGENT_LABELS[selectedAgent] },
                      )
                    : t(
                        'Define this round of work. Inherited Resources stay on the source Node; additions apply only to this request.',
                      )
            }
            action={
              <button
                type="button"
                className="text-muted-foreground transition hover:text-foreground"
                aria-label={t('Close')}
                onClick={closeDecomposition}
              >
                <X className="size-4" />
              </button>
            }
          >
            <form onSubmit={previewDecomposition} className="space-y-6">
              <div className="grid grid-cols-2 gap-2">
                <AgentGraphIntentionSelect
                  profiles={taskDecompositionIntentionRegistry.profiles}
                  value={intention}
                  onChange={setIntention}
                  label="Decomposition purpose"
                  disabled={Boolean(revisionTarget)}
                  showDescription={false}
                />

                <AgentGraphMotionSelect
                  profiles={taskDecompositionMotionRegistry.profiles}
                  value={motion}
                  onChange={setMotion}
                  label="Adjustment"
                  disabled={Boolean(revisionTarget)}
                />
              </div>

              <AgentComposerAttachments
                label={t('Optional sources')}
                items={[
                  ...requestSelectedRefs.map((ref) => ({
                    id: ref,
                    label: contextAttachmentTitle(folders, ref),
                    onRemove: () => toggleRequestSource(ref, false),
                  })),
                  ...requestFiles.map((file, index) => ({
                    id: `${file.name}:${index}`,
                    label: file.name,
                    onRemove: () =>
                      setRequestFiles((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      ),
                  })),
                ]}
              />

              {requestError ? (
                <p role="alert" className="text-xs text-destructive">
                  {requestError}
                </p>
              ) : null}

              <AgentComposerShell
                controls={
                  <AgentRunControls
                    extraInfo={
                      <ContextAttachmentPicker
                        embedded
                        folders={folders}
                        folderPath={requestFolderPath}
                        onFolderPath={setRequestFolderPath}
                        refs={requestSelectedRefs}
                        onToggleRef={(ref) =>
                          toggleRequestSource(
                            ref,
                            !requestSelectedRefs.includes(ref),
                          )
                        }
                        files={requestFiles}
                        onAddFiles={addRequestFiles}
                        onRemoveFile={(index) =>
                          setRequestFiles((current) =>
                            current.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          )
                        }
                        label={t('Optional sources')}
                      />
                    }
                    extraInfoCount={
                      requestSelectedRefs.length + requestFiles.length
                    }
                    extraInfoLabel="Optional sources"
                    value={agentProfile}
                    onChange={setAgentProfile}
                    mode={developmentPreview ? 'demo' : 'live'}
                    actionType="submit"
                    disabled={!decompositionGoal.trim()}
                    actionLabel={
                      developmentPreview
                        ? t('Create fixture request')
                        : revisionTarget
                          ? t('Send revision to {agent}', {
                              agent: AGENT_LABELS[selectedAgent],
                            })
                          : runOperation === 'append-candidates'
                            ? t('Find additional nodes')
                            : runOperation === 'recompose-candidates'
                              ? t('Recompose working set')
                              : t('Send to {agent}', {
                                  agent: AGENT_LABELS[selectedAgent],
                                })
                    }
                  />
                }
              >
                <Textarea
                  id="decomposition-goal"
                  value={decompositionGoal}
                  placeholder={
                    revisionTarget
                      ? t('Describe how this Candidate itself should change.')
                      : runOperation === 'append-candidates'
                        ? t(
                            'Describe the new evidence or boundary that may require additional siblings.',
                          )
                        : runOperation === 'recompose-candidates'
                          ? t(
                              'Describe how these Candidates should be retained, replaced, split, merged, added or removed.',
                            )
                          : 'Generate several candidate modules from this product definition.'
                  }
                  className="min-h-28 resize-none text-sm"
                  onChange={(event) => setDecompositionGoal(event.target.value)}
                />
              </AgentComposerShell>
            </form>
          </AgentGraphComposerCard>
        ) : moduleResponse.running ? (
          <AgentGraphComposerCard title="" running />
        ) : null}
      </div>

      <Sheet
        open={selectedNode !== null || selectedCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setInspectorNodeId('');
        }}
      >
        <SheetContent className="sm:max-w-md">
          {selectedNode ? (
            <>
              <SheetHeader className="border-b border-border px-6 py-6 pr-14">
                <div className="mb-3 flex items-center gap-2">
                  <span className="font-mono text-[10px] font-medium tracking-wide text-muted-foreground">
                    {selectedNode.id}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium capitalize text-secondary-foreground">
                    {selectedNode.type}
                  </span>
                </div>
                <SheetTitle className="text-xl font-semibold tracking-[-0.025em]">
                  {selectedNode.title}
                </SheetTitle>
                <SheetDescription>
                  {t('A captured')}
                  {selectedNode.role} {t('node and its fixed source boundary.')}
                </SheetDescription>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto px-6 py-5">
                <dl className="grid grid-cols-3 gap-3">
                  <NodeFact label={t('Role')} value={selectedNode.role} />
                  <NodeFact label={t('Type')} value={selectedNode.type} />
                  <NodeFact label={t('Status')} value={selectedNode.status} />
                </dl>

                {selectedRelationships ? (
                  <section className="mt-7">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {t('Relationships')}
                    </h3>
                    <div className="mt-3 grid gap-4">
                      <RelationshipList
                        title={t('Derived from')}
                        nodes={selectedRelationships.derivedFrom}
                        onSelect={locateNode}
                      />
                      <RelationshipList
                        title={t('Depends on')}
                        nodes={selectedRelationships.dependsOn}
                        onSelect={locateNode}
                      />
                      <RelationshipList
                        title={t('Derived nodes')}
                        nodes={selectedRelationships.derivedNodes}
                        onSelect={locateNode}
                      />
                      <RelationshipList
                        title={t('Dependents')}
                        nodes={selectedRelationships.dependents}
                        onSelect={locateNode}
                      />
                    </div>
                  </section>
                ) : null}

                <div className="mt-7">
                  <NodeResourceSections
                    node={selectedNode}
                    openingPath={previewingPath}
                    onOpen={(path) => void previewResource(path)}
                  />
                </div>

                <section className="mt-7 border-t border-border pt-5">
                  <NodeProvenanceFacts node={selectedNode} />
                </section>

                <section className="mt-7 border-t border-border pt-5">
                  <dl className="space-y-3 text-xs">
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{t('Created')}</dt>
                      <dd>{formatTimestamp(selectedNode.createdAt)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{t('Updated')}</dt>
                      <dd>{formatTimestamp(selectedNode.updatedAt)}</dd>
                    </div>
                  </dl>
                </section>
              </div>

              <SheetFooter className="border-t border-border px-6 py-4">
                <div className="flex gap-2">
                  {selectedNode.role === 'start' ? (
                    <Button
                      type="button"
                      className="flex-1"
                      onClick={() => editNode(selectedNode)}
                    >
                      <Pencil /> {t('Edit start node')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="destructive"
                    className="flex-1"
                    disabled={deletionBlockers.length > 0}
                    title={
                      deletionBlockers.length > 0
                        ? t('Delete the referencing nodes first')
                        : t('Move node to Trash')
                    }
                    onClick={() => {
                      setDeleteError('');
                      setDeleteOpen(true);
                    }}
                  >
                    <Trash2 /> {t('Delete node')}
                  </Button>
                </div>
                {deletionBlockers.length > 0 ? (
                  <p className="text-[10px] leading-4 text-muted-foreground">
                    {t('Referenced by')}
                    {deletionBlockers.length}{' '}
                    {deletionBlockers.length === 1 ? 'node' : 'nodes'}
                    {t('. Select them above and delete them first.')}
                  </p>
                ) : null}
              </SheetFooter>
            </>
          ) : selectedCandidate ? (
            <>
              <SheetHeader className="border-b border-border px-6 py-6 pr-14">
                <div className="mb-3 flex items-center gap-2">
                  <span className="font-mono text-[10px] font-medium tracking-wide text-muted-foreground">
                    {selectedCandidate.candidateId}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium capitalize text-secondary-foreground">
                    {t('Candidate · revision')}
                    {selectedCandidate.revision}
                  </span>
                </div>
                <SheetTitle className="text-xl font-semibold tracking-[-0.025em]">
                  {selectedCandidate.title}
                </SheetTitle>
                <SheetDescription>{selectedCandidate.summary}</SheetDescription>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto px-6 py-5">
                <dl className="grid grid-cols-2 gap-3">
                  <NodeFact label={t('Type')} value={selectedCandidate.type} />
                  <NodeFact
                    label={t('Revision')}
                    value={String(selectedCandidate.revision)}
                  />
                </dl>

                {selectedCandidatePreview?.outputPath ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-5 w-full"
                    disabled={
                      previewingPath === selectedCandidatePreview.outputPath
                    }
                    onClick={() =>
                      previewResource(selectedCandidatePreview.outputPath ?? '')
                    }
                  >
                    <FileText />
                    {previewingPath === selectedCandidatePreview.outputPath
                      ? t('Opening output…')
                      : t('Open output.md')}
                  </Button>
                ) : null}

                <section className="mt-7">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('Relationships')}
                  </h3>
                  <div className="mt-3 grid gap-4">
                    <CandidateRelationshipList
                      title={t('Derived from')}
                      nodeIds={selectedCandidate.derivedFrom}
                      nodes={nodes}
                      previews={requestPreviews}
                      onSelect={locateNode}
                    />
                    <CandidateRelationshipList
                      title={t('Depends on')}
                      nodeIds={selectedCandidate.dependsOn}
                      nodes={nodes}
                      previews={requestPreviews}
                      onSelect={locateNode}
                    />
                  </div>
                </section>

                <section className="mt-7">
                  <CandidateResourceList
                    resources={selectedCandidate.resources}
                    openingPath={previewingPath}
                    onOpen={(path) => void previewResource(path)}
                  />
                </section>

                {selectedCandidate.assumptions.length > 0 ? (
                  <section className="mt-7">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {t('Assumptions')}
                    </h3>
                    <ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
                      {selectedCandidate.assumptions.map((assumption) => (
                        <li key={assumption}>{assumption}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <div className="mt-7">
                  <CandidateMetadataSections
                    metadata={Object.fromEntries(
                      Object.entries(selectedCandidate.metadata).filter(
                        ([key]) => key !== 'moduleDependsOn',
                      ),
                    )}
                  />
                </div>
              </div>
              <SheetFooter className="border-t border-border px-6 py-4">
                {unresolvedAcceptanceDependencies.length > 0 ? (
                  <div className="w-full rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-[10px] leading-4 text-amber-800 dark:text-amber-200">
                    <p className="font-medium">
                      {t('Accept these prerequisites first')}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {unresolvedAcceptanceDependencies.map((dependency) => (
                        <button
                          key={dependency.id}
                          type="button"
                          className="rounded-full bg-background/80 px-2 py-1 text-foreground transition hover:bg-background"
                          onClick={() => locateNode(dependency.id)}
                        >
                          {dependency.title}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="flex w-full gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    disabled={
                      accepting ||
                      discardingCandidate ||
                      selectedCandidateIsRevising ||
                      selectedCandidateIsRecomposeOutput
                    }
                    aria-label={t('Discard Candidate')}
                    title={
                      selectedCandidateIsRecomposeOutput
                        ? t(
                            'Recompose outputs belong to one atomic working set and cannot be discarded individually.',
                          )
                        : t('Discard Candidate')
                    }
                    onClick={() => setCandidateDeleteOpen(true)}
                  >
                    <Trash2 />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    disabled={
                      accepting ||
                      discardingCandidate ||
                      selectedCandidateIsRevising
                    }
                    onClick={reviseCandidate}
                  >
                    <Pencil /> {t('Revise')}
                  </Button>
                  <Button
                    type="button"
                    className="flex-1"
                    disabled={
                      accepting ||
                      discardingCandidate ||
                      selectedCandidateIsRevising ||
                      unresolvedAcceptanceDependencies.length > 0
                    }
                    onClick={acceptCandidate}
                  >
                    {accepting ? t('Accepting…') : t('Accept revision')}
                  </Button>
                </div>
                {selectedCandidateIsRevising ? (
                  <p className="text-[10px] text-muted-foreground">
                    {t('The next revision is running.')}
                  </p>
                ) : null}
                {candidateActionError ? (
                  <p className="text-[10px] text-destructive">
                    {candidateActionError}
                  </p>
                ) : null}
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={candidateDeleteOpen}
        onOpenChange={(open) => {
          if (!discardingCandidate) setCandidateDeleteOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t('Discard')}
              {selectedCandidate?.title}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'This Candidate and its output will move to the operating system Trash. Other Candidates from the same proposal stay unchanged.',
              )}
              {candidateActionError ? (
                <span className="mt-2 block text-destructive">
                  {candidateActionError}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discardingCandidate}>
              {t('Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={discardingCandidate}
              onClick={discardCandidate}
            >
              {discardingCandidate ? t('Discarding…') : t('Discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deleting) setDeleteOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t('Delete')}
              {selectedNode?.title}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {developmentPreview
                ? t(
                    'This removes the node from the development preview until the page reloads.',
                  )
                : t(
                    'The node folder will move to the operating system Trash. Its upstream relationships will disappear with it.',
                  )}
              {deleteError ? (
                <span className="mt-2 block text-destructive">
                  {deleteError}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t('Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={deleteSelectedNode}
            >
              {deleting ? t('Deleting…') : t('Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MarkdownReaderDialog
        preview={preview}
        onClose={() => setPreview(null)}
        showFocusButton={false}
        readerClassName="min-h-[70vh]"
      />
    </div>
  );
}

function runPreview(
  run: TaskDecompositionRunRecord,
  snapshot: RunSnapshot,
  inheritedResourceCount: number,
): DecompositionRequestPreview {
  return {
    id: run.runId,
    sourceNodeId: run.sourceNodeId,
    instruction: snapshot.instruction,
    inheritedResourceCount,
    additionalResourceCount:
      snapshot.contextRefs.length + snapshot.files.length,
    contextRefs: snapshot.contextRefs,
    files: snapshot.files,
    intention: snapshot.intention,
    motion: snapshot.motion,
    recomposeCandidateIds: snapshot.recomposeCandidateIds,
    kind: 'run',
    title: `${TRANSPORT_LABELS[run.transport]} decomposition`,
    agentLabel: TRANSPORT_LABELS[run.transport],
    type: 'Running',
    description: run.activity.at(-1)?.summary ?? snapshot.instruction,
    status: run.status,
    revisionOf: run.revisionOf,
    runId: run.runId,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
}

function candidateOutputPath(runId: string, candidateId: string) {
  return `task-decomposition/runs/${runId}/candidates/${candidateId}/output.md`;
}

function taskDecompositionProposalPreviews(
  run: TaskDecompositionRunRecord,
  nodes: TaskGraphNode[],
  snapshot?: RunSnapshot,
): DecompositionRequestPreview[] {
  if (run.result?.outcome !== 'proposal') return [];
  const acceptedCandidateIds = new Set(
    nodes.flatMap((node) =>
      node.provenance?.candidateId ? [node.provenance.candidateId] : [],
    ),
  );
  return run.result.candidates
    .filter((candidate) => !acceptedCandidateIds.has(candidate.candidateId))
    .map((candidate) => {
      const dependsOn = resolveCandidateDependencyIds(
        candidate.dependsOn,
        nodes,
      );
      return {
        candidate: { ...candidate, dependsOn },
        id: candidate.candidateId,
        sourceNodeId: run.sourceNodeId,
        instruction: snapshot?.instruction ?? '',
        inheritedResourceCount: 0,
        additionalResourceCount: candidate.resources.length,
        contextRefs: [],
        files: [],
        kind: 'candidate' as const,
        title: candidate.title,
        type: candidate.type,
        description: candidate.summary,
        color: candidate.presentation.color,
        status: 'proposal',
        derivedFrom: candidate.derivedFrom,
        dependsOn,
        outputPath: candidateOutputPath(run.runId, candidate.candidateId),
        runId: run.runId,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
      };
    });
}

function supersededCandidateIds(runs: TaskDecompositionRunRecord[]) {
  return successfulRecomposeSupersededCandidateIds(runs);
}

function CandidateRelationshipList({
  title,
  nodeIds,
  nodes,
  previews,
  onSelect,
}: {
  title: string;
  nodeIds: string[];
  nodes: TaskGraphNode[];
  previews: TaskGraphPreview[];
  onSelect: (nodeId: string) => void;
}) {
  const relatedNodes = nodeIds.flatMap((nodeId) => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (node) return [{ ...node, relationshipStatus: 'Stabilized' }];
    const candidate = previews.find(
      (preview) => preview.id === nodeId && preview.kind === 'candidate',
    );
    return candidate
      ? [
          {
            id: candidate.id,
            title: candidate.title ?? candidate.id,
            relationshipStatus: 'Pending acceptance',
          },
        ]
      : [];
  });
  return (
    <RelationshipList title={title} nodes={relatedNodes} onSelect={onSelect} />
  );
}

function RelationshipList({
  title,
  nodes,
  onSelect,
}: {
  title: string;
  nodes: Array<{ id: string; title: string; relationshipStatus?: string }>;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useUiText();
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h4 className="text-[10px] font-medium text-muted-foreground">
          {title}
        </h4>
        <span className="text-[9px] text-muted-foreground">{nodes.length}</span>
      </div>
      {nodes.length > 0 ? (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-muted/50"
              onClick={() => onSelect(node.id)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">
                  {node.title}
                </span>
                <span className="mt-0.5 block font-mono text-[9px] text-muted-foreground">
                  {node.id}
                </span>
              </span>
              {node.relationshipStatus ? (
                <span className="shrink-0 rounded-full bg-secondary px-2 py-1 text-[9px] font-medium text-secondary-foreground">
                  {t(node.relationshipStatus)}
                </span>
              ) : null}
              <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-3 py-2.5 text-[10px] text-muted-foreground">
          {t('None')}
        </div>
      )}
    </div>
  );
}

function resolveCandidateDependencyIds(
  dependencyIds: string[],
  nodes: TaskGraphNode[],
) {
  return dependencyIds.map((dependencyId) => {
    if (!dependencyId.startsWith('CANDIDATE-')) return dependencyId;
    return (
      nodes.find((node) => node.provenance?.candidateId === dependencyId)?.id ??
      dependencyId
    );
  });
}

function resourceName(resourcePath: string) {
  return resourcePath.split('/').at(-1) ?? resourcePath;
}

function NodeFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-secondary px-3 py-2.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate text-xs font-medium capitalize">{value}</dd>
    </div>
  );
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}
