'use client';
import { useUiText } from '@/components/ui-language-provider';

import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BookOpen,
  FileText,
  FolderOpen,
  Maximize2,
  MessageSquarePlus,
  MessageSquareText,
  Minimize2,
  Trash2,
  X,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { feedbackPopoverPosition } from '@/lib/markdown-feedback-position';

export function MarkdownReader(
  props: Parameters<typeof MarkdownReaderContent>[0],
) {
  return (
    <MarkdownReaderContent
      key={`${props.filePath}\u0000${props.markdown}`}
      {...props}
    />
  );
}

function MarkdownReaderContent({
  title,
  filePath,
  markdown,
  onReveal,
  onDelete,
  onClose,
  showFocusButton = true,
  deleting = false,
  onAddFeedback,
  initialAnnotationsEnabled,
  feedbackMarkers = [],
  onEditFeedback,
  compact = false,
  className,
}: {
  title: string;
  filePath: string;
  markdown: string;
  onReveal?: () => Promise<void>;
  onDelete?: () => void;
  onClose?: () => void;
  showFocusButton?: boolean;
  deleting?: boolean;
  onAddFeedback?: (selection: MarkdownFeedbackSelection) => void;
  initialAnnotationsEnabled?: boolean;
  feedbackMarkers?: MarkdownFeedbackMarker[];
  onEditFeedback?: (feedbackId: string) => void;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useUiText();
  const [focusMode, setFocusMode] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState('');
  const [selection, setSelection] = useState<MarkdownFeedbackSelection | null>(
    null,
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLElement>(null);
  const [annotationsEnabled, setAnnotationsEnabled] = useState(
    initialAnnotationsEnabled ?? Boolean(onAddFeedback),
  );
  const [feedbackPosition, setFeedbackPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const selectionRange = useRef<Range | null>(null);

  function positionFeedback() {
    const reader = readerRef.current;
    const content = contentRef.current;
    const range = selectionRange.current;
    if (
      !reader ||
      !content ||
      !range ||
      !content.contains(range.commonAncestorContainer)
    ) {
      setFeedbackPosition(null);
      return;
    }
    const visible = {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
    for (
      let element: HTMLElement | null = content;
      element;
      element = element.parentElement
    ) {
      const css = getComputedStyle(element);
      if (
        !/(auto|scroll|hidden|clip)/.test(`${css.overflowX} ${css.overflowY}`)
      )
        continue;
      const bounds = element.getBoundingClientRect();
      visible.left = Math.max(visible.left, bounds.left);
      visible.top = Math.max(visible.top, bounds.top);
      visible.right = Math.min(visible.right, bounds.right);
      visible.bottom = Math.min(visible.bottom, bounds.bottom);
    }
    const rects = Array.from(range.getClientRects()).filter(
      (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > visible.top &&
        rect.top < visible.bottom,
    );
    const anchor = rects.at(-1);
    const position = anchor
      ? feedbackPopoverPosition(
          {
            left: anchor.left,
            right: anchor.right,
            top: Math.min(...rects.map((rect) => rect.top)),
            bottom: Math.max(...rects.map((rect) => rect.bottom)),
          },
          reader.getBoundingClientRect(),
          visible,
        )
      : null;
    setFeedbackPosition(
      position
        ? {
            left: position.left + reader.scrollLeft,
            top: position.top + reader.scrollTop,
          }
        : null,
    );
  }

  useEffect(() => {
    if (!focusMode) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setFocusMode(false);
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [focusMode]);

  async function reveal() {
    if (!onReveal) return;
    setRevealing(true);
    setRevealError('');
    try {
      await onReveal();
    } catch (error) {
      setRevealError(
        error instanceof Error ? error.message : 'Could not open the folder.',
      );
    } finally {
      setRevealing(false);
    }
  }

  function readFeedbackSelection() {
    if (!annotationsEnabled || !onAddFeedback || !contentRef.current)
      return null;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || selected.rangeCount === 0) {
      return null;
    }
    const range = selected.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      return null;
    }
    const start = closestPositionedElement(range.startContainer);
    const end = closestPositionedElement(range.endContainer);
    const excerpt = selected.toString().trim();
    const startLine = Number(start?.dataset.lineStart);
    const endLine = Number(end?.dataset.lineEnd);
    if (!excerpt || !Number.isFinite(startLine) || !Number.isFinite(endLine)) {
      return null;
    }
    return {
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
      excerpt: excerpt.slice(0, 1_200),
    };
  }

  function addSelectedFeedback(candidate = selection) {
    if (!candidate || !onAddFeedback) return;
    window.setTimeout(() => onAddFeedback(candidate), 0);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setFeedbackPosition(null);
    selectionRange.current = null;
  }

  const refreshFeedback = useEffectEvent(() => {
    const candidate = readFeedbackSelection();
    if (!candidate) {
      setSelection(null);
      setFeedbackPosition(null);
      selectionRange.current = null;
      return;
    }
    selectionRange.current = window.getSelection()!.getRangeAt(0).cloneRange();
    setSelection(candidate);
    positionFeedback();
  });
  const repositionFeedback = useEffectEvent(() => {
    if (selectionRange.current) positionFeedback();
  });
  const commitFeedbackSelection = useEffectEvent(() => {
    const candidate = readFeedbackSelection();
    if (candidate) addSelectedFeedback(candidate);
    else refreshFeedback();
  });

  useEffect(() => {
    if (!annotationsEnabled || !onAddFeedback) return;
    let selecting = false;
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (selecting) return;
        refreshFeedback();
      });
    };
    const down = (event: PointerEvent) => {
      if ((event.target as Element).closest?.('[data-feedback-popover]'))
        return;
      selecting = true;
      setFeedbackPosition(null);
    };
    const up = () => {
      selecting = false;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        commitFeedbackSelection();
      });
    };
    const scroll = () => {
      repositionFeedback();
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('selectionchange', refresh);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', scroll);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('selectionchange', refresh);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', scroll);
    };
  }, [annotationsEnabled, onAddFeedback, focusMode]);

  const markdownComponents = useMemo<Components>(
    () => ({
      h1: ({ children, node }) => (
        <h1
          {...sourcePosition(node)}
          className="mb-5 text-3xl font-semibold tracking-tight"
        >
          {children}
        </h1>
      ),
      h2: ({ children, node }) => (
        <h2
          {...sourcePosition(node)}
          className="mt-8 mb-3 text-lg font-semibold"
        >
          {children}
        </h2>
      ),
      h3: ({ children, node }) => (
        <h3 {...sourcePosition(node)} className="mt-6 mb-2 font-semibold">
          {children}
        </h3>
      ),
      p: ({ children, node }) => (
        <div
          className={cn(
            'group/feedback relative rounded-md',
            feedbackForNode(node, feedbackMarkers).length > 0 &&
              'bg-amber-500/8 ring-1 ring-amber-500/20',
          )}
        >
          <p
            {...sourcePosition(node)}
            className="my-3 pr-8 text-sm leading-7 text-foreground/78"
          >
            {children}
          </p>
          {onAddFeedback && annotationsEnabled ? (
            <FeedbackButton
              node={node}
              excerpt={childrenText(children)}
              onAddFeedback={onAddFeedback}
              feedbackMarkers={feedbackForNode(node, feedbackMarkers)}
              onEditFeedback={onEditFeedback}
            />
          ) : null}
        </div>
      ),
      ul: ({ children }) => (
        <ul className="my-3 list-disc space-y-2 pl-5 text-sm leading-6 text-foreground/78">
          {children}
        </ul>
      ),
      ol: ({ children }) => (
        <ol className="my-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-foreground/78">
          {children}
        </ol>
      ),
      a: ({ children, href }) => (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-4"
        >
          {children}
        </a>
      ),
      li: ({ children, node }) => (
        <li
          {...sourcePosition(node)}
          className={cn(
            'group/feedback relative rounded-md pr-8',
            feedbackForNode(node, feedbackMarkers).length > 0 &&
              'bg-amber-500/8 ring-1 ring-amber-500/20',
          )}
        >
          {children}
          {onAddFeedback && annotationsEnabled ? (
            <FeedbackButton
              node={node}
              excerpt={childrenText(children)}
              onAddFeedback={onAddFeedback}
              feedbackMarkers={feedbackForNode(node, feedbackMarkers)}
              onEditFeedback={onEditFeedback}
            />
          ) : null}
        </li>
      ),
      blockquote: ({ children, node }) => (
        <blockquote
          {...sourcePosition(node)}
          className="my-5 border-l-2 border-foreground/25 pl-4 text-muted-foreground"
        >
          {children}
        </blockquote>
      ),
      pre: ({ children }) => (
        <pre className="my-5 max-w-full overflow-x-auto rounded-xl bg-secondary p-4 font-mono text-sm leading-6 whitespace-pre-wrap break-words [&>code]:bg-transparent [&>code]:p-0">
          {children}
        </pre>
      ),
      code: ({ children }) => (
        <code className="break-words rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.85em]">
          {children}
        </code>
      ),
      table: ({ children }) => (
        <div className="my-5 overflow-x-auto">
          <table className="w-full border-collapse text-sm">{children}</table>
        </div>
      ),
      th: ({ children }) => (
        <th className="border border-border bg-secondary px-3 py-2 text-left font-medium">
          {children}
        </th>
      ),
      td: ({ children }) => (
        <td className="border border-border px-3 py-2">{children}</td>
      ),
    }),
    [annotationsEnabled, feedbackMarkers, onAddFeedback, onEditFeedback],
  );

  const reader = (
    <article
      ref={readerRef}
      className={cn(
        'relative min-w-0 overflow-hidden border border-border bg-card shadow-[0_1px_0_rgb(15_23_42/5%),0_14px_40px_rgb(15_23_42/5%)]',
        focusMode
          ? 'flex h-[min(88vh,960px)] w-full flex-col rounded-2xl sm:w-[80vw] sm:max-w-6xl'
          : compact
            ? 'rounded-xl'
            : 'min-h-[560px] rounded-2xl',
        className,
      )}
    >
      <header
        className={cn(
          'flex shrink-0 items-center gap-3 border-b border-border',
          compact ? 'sticky top-0 z-10 bg-card px-4 py-3' : 'px-6 py-4',
        )}
      >
        <div className="grid size-9 place-items-center rounded-xl bg-secondary">
          <BookOpen className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium">{title}</p>
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <FileText className="size-3 shrink-0" />
            <span className="truncate">{filePath}</span>
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {onAddFeedback ? (
            <Button
              type="button"
              variant={annotationsEnabled ? 'default' : 'ghost'}
              size="icon"
              aria-label={
                annotationsEnabled
                  ? t('Disable annotations')
                  : t('Enable annotations')
              }
              aria-pressed={annotationsEnabled}
              title={
                annotationsEnabled
                  ? t('Disable annotations')
                  : t('Enable annotations')
              }
              onClick={() => {
                setAnnotationsEnabled((enabled) => !enabled);
                setSelection(null);
                setFeedbackPosition(null);
                selectionRange.current = null;
              }}
            >
              <MessageSquarePlus />
            </Button>
          ) : null}
          {onReveal ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('Show README folder in file manager')}
              title={t('Show in file manager')}
              disabled={revealing}
              onClick={reveal}
            >
              <FolderOpen />
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('Delete Markdown document')}
              title={t('Delete document')}
              disabled={deleting}
              onClick={() => {
                setFocusMode(false);
                onDelete();
              }}
            >
              <Trash2 />
            </Button>
          ) : null}
          {showFocusButton ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={
                focusMode ? t('Exit focus reading') : t('Open focus reading')
              }
              aria-pressed={focusMode}
              title={
                focusMode ? t('Exit focus mode (Esc)') : t('Open focus mode')
              }
              onClick={() => setFocusMode((current) => !current)}
            >
              {focusMode ? <Minimize2 /> : <Maximize2 />}
            </Button>
          ) : null}
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('Close Markdown reader')}
              title={t('Close')}
              onClick={onClose}
            >
              <X />
            </Button>
          ) : null}
        </div>
      </header>

      {annotationsEnabled && selection && feedbackPosition && onAddFeedback ? (
        <div
          data-feedback-popover
          role="toolbar"
          aria-label={t('Selected text feedback')}
          className="absolute z-40 flex h-9 w-[190px] items-center justify-between gap-1 rounded-lg border border-border bg-popover px-1 shadow-lg"
          style={{ left: feedbackPosition.left, top: feedbackPosition.top }}
        >
          <Button
            type="button"
            size="sm"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => addSelectedFeedback()}
          >
            {t('Add feedback')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('Clear selected feedback text')}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              window.getSelection()?.removeAllRanges();
              setSelection(null);
              setFeedbackPosition(null);
              selectionRange.current = null;
            }}
          >
            <X />
          </Button>
        </div>
      ) : null}

      {revealError ? (
        <p
          role="alert"
          className="shrink-0 border-b border-border px-6 py-2 text-xs text-destructive"
        >
          {revealError}
        </p>
      ) : null}

      <div
        ref={contentRef}
        className={cn(
          'relative min-w-0 px-6 py-7 sm:px-9 sm:py-9',
          compact && 'px-4 py-4 sm:px-4 sm:py-4',
          focusMode && 'mx-auto w-full max-w-4xl flex-1 overflow-y-auto',
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={markdownComponents}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </article>
  );

  if (!focusMode) return reader;

  return (
    <dialog
      open
      aria-modal="true"
      aria-label={`${title} focus reader`}
      className="fixed inset-0 z-50 m-0 grid h-full max-h-none w-full max-w-none place-items-center border-0 bg-black/45 p-4 backdrop-blur-[2px] sm:p-8"
    >
      <button
        type="button"
        aria-label={t('Close focus reading')}
        className="absolute inset-0 cursor-default"
        onClick={() => setFocusMode(false)}
      />
      <div className="relative z-10">{reader}</div>
    </dialog>
  );
}

export type MarkdownFeedbackSelection = {
  startLine: number;
  endLine: number;
  excerpt: string;
};

export type MarkdownFeedbackMarker = MarkdownFeedbackSelection & {
  feedbackId: string;
};

function feedbackForNode(
  node:
    | {
        position?: {
          start: { line: number };
          end: { line: number };
        };
      }
    | undefined,
  feedbackMarkers: MarkdownFeedbackMarker[],
) {
  const startLine = node?.position?.start.line;
  const endLine = node?.position?.end.line;
  if (!startLine || !endLine) return [];
  return feedbackMarkers.filter(
    (feedback) =>
      feedback.startLine <= endLine && feedback.endLine >= startLine,
  );
}

function sourcePosition(
  node:
    | {
        position?: {
          start: { line: number };
          end: { line: number };
        };
      }
    | undefined,
) {
  return {
    'data-line-start': node?.position?.start.line,
    'data-line-end': node?.position?.end.line,
  };
}

function closestPositionedElement(node: Node) {
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  return element?.closest<HTMLElement>('[data-line-start]') ?? null;
}

function FeedbackButton({
  node,
  excerpt,
  onAddFeedback,
  feedbackMarkers,
  onEditFeedback,
}: {
  node:
    | {
        position?: {
          start: { line: number };
          end: { line: number };
        };
      }
    | undefined;
  excerpt: string;
  onAddFeedback: (selection: MarkdownFeedbackSelection) => void;
  feedbackMarkers: MarkdownFeedbackMarker[];
  onEditFeedback?: (feedbackId: string) => void;
}) {
  const { t } = useUiText();
  const startLine = node?.position?.start.line;
  const endLine = node?.position?.end.line;
  if (!startLine || !endLine || !excerpt.trim()) return null;
  const existingFeedback = feedbackMarkers[0];
  return (
    <button
      type="button"
      className={cn(
        'absolute top-1 right-0 grid size-7 place-items-center rounded-full transition focus:opacity-100',
        existingFeedback
          ? 'bg-amber-500/15 text-amber-700 opacity-100 dark:text-amber-300'
          : 'text-muted-foreground opacity-60 hover:bg-secondary hover:text-foreground sm:opacity-0 sm:group-hover/feedback:opacity-100',
      )}
      aria-label={
        existingFeedback
          ? t('Edit feedback')
          : t('Add feedback for lines {start} to {end}', {
              start: startLine,
              end: endLine,
            })
      }
      title={existingFeedback ? t('Edit feedback') : t('Add feedback')}
      onClick={() => {
        if (existingFeedback && onEditFeedback) {
          onEditFeedback(existingFeedback.feedbackId);
          return;
        }
        onAddFeedback({
          startLine,
          endLine,
          excerpt: excerpt.trim().slice(0, 1_200),
        });
      }}
    >
      {existingFeedback ? (
        <span className="relative">
          <MessageSquareText className="size-3.5" />
          {feedbackMarkers.length > 1 ? (
            <span className="absolute -top-2 -right-2 text-[8px] font-semibold">
              {feedbackMarkers.length}
            </span>
          ) : null}
        </span>
      ) : (
        <MessageSquarePlus className="size-3.5" />
      )}
    </button>
  );
}

function childrenText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(childrenText).join('');
  if (value && typeof value === 'object' && 'props' in value) {
    const element = value as { props?: { children?: ReactNode } };
    return childrenText(element.props?.children);
  }
  return '';
}
