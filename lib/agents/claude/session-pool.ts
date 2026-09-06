import { ClaudeResidentProcess } from './resident-process.ts';
import type { ClaudeResidentOptions } from './resident-process.ts';

export const residentIdleReclaimMs = 15 * 60 * 1000;
export const residentSessionCap = 12;

type Entry = {
  process: ClaudeResidentProcess;
  leases: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastUsedAt: number;
};

export class ClaudeSessionPool {
  private entries = new Map<string, Entry>();
  private launches = new Map<string, number>();
  private idleMs: number;
  private cap: number;

  constructor(idleMs = residentIdleReclaimMs, cap = residentSessionCap) {
    this.idleMs = idleMs;
    this.cap = cap;
  }

  get size() {
    return this.entries.size;
  }
  has(threadId: string) {
    return this.entries.has(threadId);
  }
  leasesOf(threadId: string) {
    return this.entries.get(threadId)?.leases ?? 0;
  }
  launchesOf(threadId: string) {
    return this.launches.get(threadId) ?? 0;
  }

  async acquire(threadId: string, options: ClaudeResidentOptions) {
    const existing = this.entries.get(threadId);
    if (existing) {
      if (existing.process.signature === options.signature) {
        if (existing.idleTimer) clearTimeout(existing.idleTimer);
        existing.idleTimer = undefined;
        existing.leases += 1;
        existing.lastUsedAt = Date.now();
        if (existing.process.running) return existing.process;
      }
      this.entries.delete(threadId);
      await existing.process.dispose(
        existing.process.signature === options.signature
          ? 'The Claude session process was no longer running and is being replaced.'
          : 'The Claude session configuration changed and its process was recycled.',
      );
    }
    await this.reclaimForCapacity();
    const launch = (this.launches.get(threadId) ?? 0) + 1;
    this.launches.set(threadId, launch);
    const entry: Entry = {
      process: new ClaudeResidentProcess({ ...options, launch }).start(),
      leases: 1,
      lastUsedAt: Date.now(),
    };
    this.entries.set(threadId, entry);
    return entry.process;
  }

  release(threadId: string) {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    entry.leases = Math.max(0, entry.leases - 1);
    entry.lastUsedAt = Date.now();
    if (entry.leases > 0) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.dispose(
        threadId,
        'The Claude session process was reclaimed after being idle.',
      );
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  async dispose(threadId: string, reason?: string) {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    this.entries.delete(threadId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await entry.process.dispose(reason);
  }

  killAll() {
    for (const [threadId, entry] of this.entries) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.process.kill();
      this.entries.delete(threadId);
    }
  }

  async disposeAll(reason?: string) {
    const ids = [...this.entries.keys()];
    for (const id of ids) await this.dispose(id, reason);
  }

  private async reclaimForCapacity() {
    while (this.entries.size >= this.cap) {
      const idle = [...this.entries.entries()]
        .filter(([, entry]) => entry.leases === 0)
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (!idle) return;
      await this.dispose(
        idle[0],
        'The Claude session process was reclaimed to stay under the session cap.',
      );
    }
  }
}

export const claudeSessionPool = new ClaudeSessionPool();

const shutdown = globalThis as typeof globalThis & {
  claudeResidentShutdown?: boolean;
};
if (!shutdown.claudeResidentShutdown) {
  shutdown.claudeResidentShutdown = true;
  process.once('exit', () => claudeSessionPool.killAll());
}
