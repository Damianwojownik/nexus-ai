export type MemoryCategory =
  | 'identity/config'
  | 'preferences'
  | 'projects'
  | 'decisions'
  | 'tasks'
  | 'episodic'
  | 'artifacts'
  | 'user-turn'
  | 'assistant-turn';

export type MemoryKind = 'conversation' | 'durable';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  category: MemoryCategory;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  owner?: string;
  scope?: string;
  source?: string;
  reference?: string;
  relevance: number;
  hash: string;
  sensitive?: boolean;
}

export interface MemoryBackend {
  load(): Promise<MemoryEntry[]>;
  save(entries: MemoryEntry[]): Promise<void>;
}

export class InMemoryMemoryBackend implements MemoryBackend {
  private entries: MemoryEntry[] = [];

  async load(): Promise<MemoryEntry[]> {
    return [...this.entries];
  }

  async save(entries: MemoryEntry[]): Promise<void> {
    this.entries = [...entries];
  }
}

export class BrowserMemoryBackend implements MemoryBackend {
  readonly key: string;
  private readonly strict: boolean;

  constructor(key = 'nexus-memory-v1', strict = false) {
    this.key = key;
    this.strict = strict;
  }

  async load(): Promise<MemoryEntry[]> {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(this.key);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (this.strict && (!Array.isArray(parsed) || !parsed.every(isMemoryEntry))) {
        throw new Error('Zapisana pamiec firmy ma nieprawidlowy format.');
      }
      return parsed as MemoryEntry[];
    } catch (error) {
      if (this.strict) throw error;
      return [];
    }
  }

  async save(entries: MemoryEntry[]): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this.key, JSON.stringify(entries));
  }
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<MemoryEntry>;
  return typeof item.id === 'string' && typeof item.text === 'string'
    && (item.kind === 'conversation' || item.kind === 'durable')
    && typeof item.category === 'string' && Array.isArray(item.tags)
    && item.tags.every(tag => typeof tag === 'string')
    && typeof item.createdAt === 'number' && typeof item.updatedAt === 'number'
    && typeof item.relevance === 'number' && typeof item.hash === 'string'
    && (item.sensitive === undefined || typeof item.sensitive === 'boolean');
}

export class FileSystemMemoryBackend implements MemoryBackend {
  private readonly filePath: string;

  constructor(filePath = `${process.cwd()}/.nexus-memory.json`) {
    this.filePath = filePath;
  }

  async load(): Promise<MemoryEntry[]> {
    try {
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(this.filePath, 'utf8');
      return raw ? (JSON.parse(raw) as MemoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  async save(entries: MemoryEntry[]): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      await fs.mkdir(`${process.cwd()}`, { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(entries, null, 2));
    } catch {
      // ignore storage failures; in-memory state remains available
    }
  }
}

export function createDefaultMemoryBackend(): MemoryBackend {
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    return new BrowserMemoryBackend();
  }
  return new FileSystemMemoryBackend();
}

export interface MemoryStoreContract {
  saveMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'hash' | 'relevance'> & Partial<Pick<MemoryEntry, 'relevance' | 'hash'>>): Promise<MemoryEntry>;
  searchMemory(query: string, limit?: number, kind?: MemoryKind): Promise<MemoryEntry[]>;
  getRelevantMemories(query: string, limit?: number): Promise<MemoryEntry[]>;
  updateMemory(id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>): Promise<MemoryEntry>;
  deleteMemory(id: string): Promise<boolean>;
}

export class MemoryStore implements MemoryStoreContract {
  private entries: MemoryEntry[] = [];
  private readonly backend: MemoryBackend;
  private ready: Promise<void>;
  private loadError: Error | undefined;

  constructor(backend: MemoryBackend = createDefaultMemoryBackend()) {
    this.backend = backend;
    this.ready = this.loadFromBackend();
  }

  private async loadFromBackend(): Promise<void> {
    try {
      this.entries = await this.backend.load();
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error('Nie mozna wczytac pamieci.');
    }
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
    if (this.loadError) throw this.loadError;
  }

  private computeHash(text: string, category: string, owner?: string, scope?: string): string {
    const raw = `${category}:${owner ?? 'system'}:${scope ?? 'global'}:${text.trim().toLowerCase()}`;
    let hash = 2166136261;
    for (let index = 0; index < raw.length; index += 1) {
      hash ^= raw.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  async saveMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'hash' | 'relevance'> & Partial<Pick<MemoryEntry, 'relevance' | 'hash'>>): Promise<MemoryEntry> {
    await this.ensureReady();
    const now = Date.now();
    const hash = entry.hash ?? this.computeHash(entry.text, entry.category, entry.owner, entry.scope);
    const existing = this.entries.find((item) => item.hash === hash);
    if (existing) {
      const updated = { ...existing, text: entry.text, tags: entry.tags ?? existing.tags, updatedAt: now, owner: entry.owner ?? existing.owner, scope: entry.scope ?? existing.scope, source: entry.source ?? existing.source, reference: entry.reference ?? existing.reference, sensitivity: entry.sensitive ?? existing.sensitive } as MemoryEntry;
      this.entries = this.entries.map((item) => item.id === existing.id ? updated : item);
      await this.backend.save(this.entries);
      return updated;
    }

    const item: MemoryEntry = {
      id: `memory-${now}-${Math.random().toString(16).slice(2)}`,
      kind: entry.kind ?? 'durable',
      text: entry.text,
      category: entry.category,
      tags: entry.tags ?? [],
      createdAt: now,
      updatedAt: now,
      owner: entry.owner,
      scope: entry.scope,
      source: entry.source,
      reference: entry.reference,
      relevance: entry.relevance ?? 0.5,
      hash,
      sensitive: entry.sensitive ?? false,
    };

    this.entries.unshift(item);
    await this.backend.save(this.entries);
    return item;
  }

  async searchMemory(query: string, limit = 5, kind: MemoryKind = 'durable'): Promise<MemoryEntry[]> {
    await this.ensureReady();
    if (!query.trim()) return [];

    const q = query.toLowerCase();
    return this.entries
      .filter((entry) => entry.kind === kind && !entry.sensitive && entry.text.toLowerCase().includes(q))
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, limit);
  }

  async getRelevantMemories(query: string, limit = 5): Promise<MemoryEntry[]> {
    await this.ensureReady();
    const q = query.toLowerCase();
    return this.entries
      .filter((entry) => entry.kind === 'durable' && !entry.sensitive)
      .map((entry) => ({ ...entry, relevance: this.scoreEntry(entry, q) }))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit)
      .map(({ relevance, ...rest }) => ({ ...rest, relevance }));
  }

  private scoreEntry(entry: MemoryEntry, query: string): number {
    const text = entry.text.toLowerCase();
    const tagBoost = entry.tags.some((tag) => query.includes(tag.toLowerCase())) ? 0.35 : 0;
    const exact = text.includes(query) ? 1 : 0;
    const categoryBoost = entry.category.includes('tasks') || entry.category.includes('decisions') ? 0.2 : 0;
    return Math.min(1, 0.35 + exact * 0.45 + tagBoost + categoryBoost);
  }

  async updateMemory(id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>): Promise<MemoryEntry> {
    await this.ensureReady();
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new Error(`Memory not found: ${id}`);
    }

    const current = this.entries[index];
    const updated: MemoryEntry = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
      hash: patch.hash ?? current.hash,
      relevance: patch.relevance ?? current.relevance,
    };
    this.entries[index] = updated;
    await this.backend.save(this.entries);
    return updated;
  }

  async deleteMemory(id: string): Promise<boolean> {
    await this.ensureReady();
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    await this.backend.save(this.entries);
    return this.entries.length !== before;
  }
}
