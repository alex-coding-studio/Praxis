'use client';

import { useEffect, useState } from 'react';

export function useDeliveryStates(projectId: string) {
  const [states, setStates] = useState<
    Record<string, 'in-progress' | 'completed'>
  >({});
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const response = await fetch(
          `/api/projects/${projectId}/contract-completion`,
          { cache: 'no-store' },
        );
        if (!response.ok) return;
        const result = await response.json();
        if (active) setStates(result.states);
      } catch {}
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId]);
  return states;
}
