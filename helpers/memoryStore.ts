export type MemoryCategory =
  | 'identity'
  | 'config'
  | 'preferences'
  | 'projects'
  | 'decisions'
  | 'tasks'
  | 'episodic'
  | 'artifacts'
  | 'user-turn'
  | 'assistant-turn';

export interface MemoryEntry {
  id: string;
  text: string;
  category: MemoryCategory;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  owner?: string;
  sensitive?: boolean;
}

export interface MemoryStoreContract {
  saveMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry>;
  searchMemory(query: string, limit?: number): Promise<MemoryEntry[]>;
  getRelevantMemories(query: string, limit?: number): Promise<MemoryEntry[]>;
  updateMemory(id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>): Promise<MemoryEntry>;
  deleteMemory(id: string): Promise<boolean>;
}

export class MemoryStore implements MemoryStoreContract {
  private entries: MemoryEntry[] = [];

  async saveMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry> {
    const now = Date.now();
    const item: MemoryEntry = {
      id: `memory-${now}-${Math.random().toString(16).slice(2)}`,
      text: entry.text,
      category: entry.category,
      tags: entry.tags ?? [],
      createdAt: now,
      updatedAt: now,
      owner: entry.owner,
      sensitive: entry.sensitive ?? false,
    };

    this.entries.unshift(item);
    return item;
  }

  async searchMemory(query: string, limit = 5): Promise<MemoryEntry[]> {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return this.entries
      .filter((entry) => !entry.sensitive && entry.text.toLowerCase().includes(q))
      .slice(0, limit);
  }

  async getRelevantMemories(query: string, limit = 5): Promise<MemoryEntry[]> {
    return this.searchMemory(query, limit);
  }

  async updateMemory(id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>): Promise<MemoryEntry> {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new Error(`Memory not found: ${id}`);
    }

    const current = this.entries[index];
    const updated: MemoryEntry = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };
    this.entries[index] = updated;
    return updated;
  }

  async deleteMemory(id: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    return this.entries.length !== before;
  }
}
