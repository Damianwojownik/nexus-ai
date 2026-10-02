import type { MemoryBackend, MemoryEntry } from './memoryStore.ts';
import { BrowserMemoryBackend } from './memoryStore.ts';

export class HubMemoryBackend implements MemoryBackend {
  private readonly baseUrl: string;
  private readonly fallback: MemoryBackend;

  constructor(baseUrl: string, fallback: MemoryBackend = new BrowserMemoryBackend()) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fallback = fallback;
  }

  async load(): Promise<MemoryEntry[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/memory/snapshot`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Memory Hub HTTP ${response.status}`);
      const body = await response.json() as { entries?: MemoryEntry[] };
      return Array.isArray(body.entries) ? body.entries : [];
    } catch {
      return this.fallback.load();
    }
  }

  async save(entries: MemoryEntry[]): Promise<void> {
    await this.fallback.save(entries);
    try {
      const response = await fetch(`${this.baseUrl}/api/memory/snapshot`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ entries }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Memory Hub HTTP ${response.status}`);
    } catch {
      // Local browser copy remains available while the Hub is offline.
    }
  }
}
