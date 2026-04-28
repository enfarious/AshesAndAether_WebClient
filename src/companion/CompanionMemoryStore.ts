/**
 * CompanionMemoryStore — Persistent long-term memory for BYOLLM companions.
 *
 * Stores notable facts extracted from /cc conversations in IndexedDB.
 * Each companion has its own memory keyed by lowercased name.
 * Follows the same IndexedDB patterns as ChatLogger.
 */

export interface MemoryEntry {
  fact:    string;   // e.g. "Player grew up in Thorndale"
  addedAt: number;   // Date.now()
  source:  'chat';   // extensible: may add 'event', 'combat' later
}

const DB_NAME      = 'companion_memories';
const DB_VERSION   = 1;
const STORE_NAME   = 'memories';
const MAX_MEMORIES = 40;

export class CompanionMemoryStore {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    try {
      this.db = await this.openDB();
    } catch (err) {
      console.warn('[CompanionMemory] Failed to open IndexedDB — memory disabled:', err);
    }
  }

  async getMemories(companionKey: string): Promise<MemoryEntry[]> {
    return this.load(companionKey);
  }

  async addMemory(companionKey: string, fact: string): Promise<void> {
    if (!this.db) return;

    const existing = await this.load(companionKey);

    // Dedup: case-insensitive trim match
    const normalized = fact.trim().toLowerCase();
    if (existing.some(e => e.fact.trim().toLowerCase() === normalized)) return;

    existing.push({ fact: fact.trim(), addedAt: Date.now(), source: 'chat' });

    // FIFO eviction when over cap
    while (existing.length > MAX_MEMORIES) {
      existing.shift();
    }

    await this.save(companionKey, existing);
  }

  async clearMemories(companionKey: string): Promise<void> {
    if (!this.db) return;

    try {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(companionKey);
    } catch {
      // Silent fail
    }
  }

  // ── IndexedDB helpers ──────────────────────────────────────────────────

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror   = () => reject(request.error);
    });
  }

  private async load(companionKey: string): Promise<MemoryEntry[]> {
    if (!this.db) return [];

    return new Promise((resolve) => {
      try {
        const tx    = this.db!.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req   = store.get(companionKey);
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror   = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  private async save(companionKey: string, entries: MemoryEntry[]): Promise<void> {
    if (!this.db) return;

    try {
      const tx    = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entries, companionKey);
    } catch {
      // Silent fail
    }
  }
}
