/**
 * ChatLogger — Dual chat log system for BYOLLM companion context.
 *
 * Maintains two logs per day:
 *   - Raw log: every message, unfiltered
 *   - Filtered log: only channels in user's config (used for LLM context)
 *
 * Storage: IndexedDB via simple key-value abstraction.
 * Retention: 30 days, pruned on startup.
 */

import type { CommunicationChannel } from '@/network/Protocol';

export interface ChatLogEntry {
  timestamp: string;    // ISO 8601
  channel: string;
  sender: string;
  message: string;
}

export interface ChatHistorySettings {
  lookbackMinutes:    number;   // default 15
  maxLines:           number;   // default 50
  minLines:           number;   // default 5
  crossDayMaxMinutes: number;   // default 30
  enabledChannels:    CommunicationChannel[];  // default: ['say', 'emote', 'companion']
}

const DB_NAME = 'companion_chat_logs';
const DB_VERSION = 1;
const STORE_NAME = 'logs';
const RETENTION_DAYS = 30;

function dateKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateKey(d);
}

export class ChatLogger {
  private db: IDBDatabase | null = null;
  private enabledChannels: Set<CommunicationChannel>;

  // In-memory buffer for today's filtered lines (fast lookback)
  private filteredBuffer: ChatLogEntry[] = [];
  private rawBuffer: ChatLogEntry[] = [];
  private currentDay: string;

  constructor(enabledChannels: CommunicationChannel[] = ['say', 'emote', 'companion']) {
    this.enabledChannels = new Set(enabledChannels);
    // 'companion' channel always included
    this.enabledChannels.add('companion');
    this.currentDay = dateKey();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.db = await this.openDB();
    await this.loadTodayBuffers();
    void this.pruneOldLogs();
  }

  // ── Write ──────────────────────────────────────────────────────────────

  /**
   * Record a chat message. Call after rendering to DOM.
   */
  write(channel: string, sender: string, message: string): void {
    // Check for day rollover
    const today = dateKey();
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.filteredBuffer = [];
      this.rawBuffer = [];
    }

    const entry: ChatLogEntry = {
      timestamp: new Date().toISOString(),
      channel,
      sender,
      message,
    };

    // Always write to raw
    this.rawBuffer.push(entry);
    void this.appendToDB(`raw_${this.currentDay}`, entry);

    // Write to filtered if channel matches config
    if (this.enabledChannels.has(channel as CommunicationChannel)) {
      this.filteredBuffer.push(entry);
      void this.appendToDB(`filtered_${this.currentDay}`, entry);
    }
  }

  // ── Read (lookback for LLM context) ────────────────────────────────────

  /**
   * Get filtered chat history for LLM prompt context.
   * Returns lines in chronological order (oldest first).
   */
  async getFilteredHistory(settings: ChatHistorySettings): Promise<string[]> {
    const now = Date.now();
    const lookbackMs = settings.lookbackMinutes * 60_000;
    const cutoff = now - lookbackMs;
    const lines: string[] = [];

    // 1. Read today's filtered buffer backwards
    for (let i = this.filteredBuffer.length - 1; i >= 0; i--) {
      const entry = this.filteredBuffer[i]!;
      const entryTime = new Date(entry.timestamp).getTime();

      if (entryTime < cutoff && lines.length >= settings.minLines) break;
      if (lines.length >= settings.maxLines) break;

      lines.unshift(this.formatEntry(entry));
    }

    // 2. If we haven't hit minLines, check yesterday's log
    if (lines.length < settings.minLines) {
      const crossDayMs = settings.crossDayMaxMinutes * 60_000;
      const crossDayCutoff = now - crossDayMs;
      const yesterdayEntries = await this.loadFromDB(`filtered_${yesterdayKey()}`);

      for (let i = yesterdayEntries.length - 1; i >= 0; i--) {
        if (lines.length >= settings.minLines) break;

        const entry = yesterdayEntries[i]!;
        const entryTime = new Date(entry.timestamp).getTime();
        if (entryTime < crossDayCutoff) break;

        lines.unshift(this.formatEntry(entry));
      }
    }

    return lines;
  }

  // ── Config update ──────────────────────────────────────────────────────

  updateEnabledChannels(channels: CommunicationChannel[]): void {
    this.enabledChannels = new Set(channels);
    this.enabledChannels.add('companion'); // always on
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
      request.onerror = () => reject(request.error);
    });
  }

  private async appendToDB(key: string, entry: ChatLogEntry): Promise<void> {
    if (!this.db) return;

    try {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      // Get existing entries and append
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const existing: ChatLogEntry[] = getReq.result ?? [];
        existing.push(entry);
        store.put(existing, key);
      };
    } catch {
      // Silent fail — chat logging is best-effort
    }
  }

  private async loadFromDB(key: string): Promise<ChatLogEntry[]> {
    if (!this.db) return [];

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  private async loadTodayBuffers(): Promise<void> {
    this.rawBuffer = await this.loadFromDB(`raw_${this.currentDay}`);
    this.filteredBuffer = await this.loadFromDB(`filtered_${this.currentDay}`);
  }

  private async pruneOldLogs(): Promise<void> {
    if (!this.db) return;

    try {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAllKeys();

      req.onsuccess = () => {
        const keys = req.result as string[];
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
        const cutoffStr = dateKey(cutoffDate);

        for (const key of keys) {
          // Keys are like "raw_2026-03-01" or "filtered_2026-03-01"
          const datePart = key.replace(/^(raw|filtered)_/, '');
          if (datePart < cutoffStr) {
            store.delete(key);
          }
        }
      };
    } catch {
      // Silent fail
    }
  }

  private formatEntry(entry: ChatLogEntry): string {
    return `[${entry.timestamp}] [${entry.channel}] ${entry.sender}: ${entry.message}`;
  }
}
