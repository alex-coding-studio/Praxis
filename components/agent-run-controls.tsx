'use client';

import { LoaderCircle, Plus, SendHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { AgentProfileSelector } from '@/components/agent-profile-selector';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useUiText } from '@/components/ui-language-provider';
import type { AgentProfile } from '@/lib/agents/profile';

export function AgentRunControls({
  value,
  onChange,
  onRun,
  disabled = false,
  mode = 'live',
  label = 'Agent configuration',
  actionLabel = 'Ask',
  actionType = 'button',
  running = false,
  extraInfo,
  extraInfoCount = 0,
  extraInfoLabel = 'Extra info',
  agents,
}: {
  value: AgentProfile;
  onChange: (profile: AgentProfile) => void;
  onRun?: () => void;
  disabled?: boolean;
  mode?: 'live' | 'demo';
  label?: string;
  actionLabel?: string;
  actionType?: 'button' | 'submit';
  running?: boolean;
  extraInfo?: ReactNode;
  extraInfoCount?: number;
  extraInfoLabel?: string;
  agents?: readonly AgentProfile['agent'][];
}) {
  const { t } = useUiText();
  return (
    <div className="flex items-stretch justify-between gap-2">
      {extraInfo ? (
        <Popover>
          <PopoverTrigger
            aria-label={t(extraInfoLabel)}
            className="relative grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" />
            {extraInfoCount > 0 ? (
              <span className="absolute -top-1 -right-1 grid min-w-3.5 place-items-center rounded-full bg-foreground px-1 text-[8px] leading-3.5 text-background">
                {extraInfoCount}
              </span>
            ) : null}
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[440px]"
            aria-label={t(extraInfoLabel)}
          >
            {extraInfo}
          </PopoverContent>
        </Popover>
      ) : null}
      <div className="ml-auto flex items-stretch gap-2">
        <AgentProfileSelector
          value={value}
          onChange={onChange}
          mode={mode}
          label={label}
          showStatus={false}
          agents={agents}
        />
        <Button
          type={actionType}
          size="icon"
          className="size-8 shrink-0 rounded-full"
          aria-label={t(actionLabel)}
          disabled={disabled || !value.model}
          onClick={onRun}
        >
          {running ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <SendHorizontal className="size-3" />
          )}
        </Button>
      </div>
    </div>
  );
}
