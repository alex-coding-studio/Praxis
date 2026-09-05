'use client';

import { Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useUiText } from '@/components/ui-language-provider';
import type { AgentProfile } from '@/lib/agents/profile';
import { cn } from '@/lib/utils';

export function AgentGraphRunningCard({
  agent,
  startedAt,
  activity,
  fallback,
  onCancel,
  cancelDisabled = false,
  className,
}: {
  agent: AgentProfile['agent'];
  startedAt: string;
  activity: Array<{ summary: string }>;
  fallback: string;
  onCancel: () => void;
  cancelDisabled?: boolean;
  className?: string;
}) {
  const { t } = useUiText();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return (
    <section
      data-planning-run-header="true"
      className={cn(
        'flex flex-wrap items-start justify-between gap-4 border border-border bg-background/95 p-4 shadow-sm backdrop-blur',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-3 text-sm">
          <RunningIndicator />
          {t('{agent} is running', {
            agent:
              agent === 'codex'
                ? 'Codex'
                : agent === 'deepseek'
                  ? 'DeepSeek'
                  : 'Claude',
          })}{' '}
          · {formatDuration(elapsed)}
        </span>
        <p className="mt-2 line-clamp-4 overflow-hidden text-xs break-words text-muted-foreground">
          {t(latestReadableAgentActivity(activity, fallback))}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={cancelDisabled}
        onClick={onCancel}
      >
        <Square className="size-3.5" /> {t('Cancel')}
      </Button>
    </section>
  );
}

function RunningIndicator() {
  return (
    <span className="relative flex size-2.5">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-60" />
      <span className="relative inline-flex size-2.5 rounded-full bg-sky-500" />
    </span>
  );
}

export function latestReadableAgentActivity(
  activity: Array<{ summary: string }>,
  fallback: string,
) {
  return (
    activity.findLast(
      (item) =>
        !/^(?:Running|Finished):\s/.test(item.summary) &&
        !['Agent report received.', 'Agent call completed.'].includes(
          item.summary,
        ),
    )?.summary ?? fallback
  );
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
