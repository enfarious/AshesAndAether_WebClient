/**
 * CompanionSettings — Typed settings + localStorage persistence for BYOLLM.
 *
 * Stores LLM provider config, chat history settings, and behavior flags.
 * API key stored separately under `companion_api_key` for easy selective clearing.
 */

import type { CommunicationChannel } from '@/network/Protocol';
import type { ChatHistorySettings } from './ChatLogger';

// ── LLM Provider Config ─────────────────────────────────────────────────

export type LLMProvider = 'anthropic' | 'openai' | 'lmstudio' | 'ollama' | 'custom';

export interface CompanionLLMConfig {
  provider:    LLMProvider;
  apiEndpoint: string;       // pre-filled per provider, editable
  apiKey:      string;       // stored client-side only, NEVER sent to server
  modelName:   string;
}

// ── Behavior Settings ────────────────────────────────────────────────────

export interface CompanionBehaviorSettings {
  socialActionsEnabled: boolean;   // default false
}

// ── Identity Settings (player-editable, stored client-side) ─────────────

export interface CompanionIdentitySettings {
  personalityType: string;   // e.g. "loyal and curious"
  traits:          string;   // comma-separated, e.g. "brave, witty, protective"
  description:     string;   // freeform, e.g. "a battle-scarred wolf companion"
}

// ── Full Settings Object ─────────────────────────────────────────────────

export interface CompanionFullSettings {
  llm:       CompanionLLMConfig;
  chatHistory: ChatHistorySettings;
  behavior:  CompanionBehaviorSettings;
  identity:  CompanionIdentitySettings;
}

// ── Default values ───────────────────────────────────────────────────────

const DEFAULT_ENDPOINTS: Record<LLMProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai:    'https://api.openai.com/v1/chat/completions',
  lmstudio:  'http://localhost:11434/api/v1/chat',
  ollama:    'http://localhost:11434/api/chat',
  custom:    '',
};

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai:    'gpt-4o-mini',
  lmstudio:  '',   // LM Studio uses whatever model is loaded
  ollama:    'llama3',
  custom:    '',
};

export function getDefaultSettings(): CompanionFullSettings {
  return {
    llm: {
      provider:    'anthropic',
      apiEndpoint: DEFAULT_ENDPOINTS.anthropic,
      apiKey:      '',
      modelName:   DEFAULT_MODELS.anthropic,
    },
    chatHistory: {
      lookbackMinutes:    15,
      maxLines:           50,
      minLines:           5,
      crossDayMaxMinutes: 30,
      enabledChannels:    ['say', 'emote', 'companion'] as CommunicationChannel[],
    },
    behavior: {
      socialActionsEnabled: false,
    },
    identity: {
      personalityType: '',
      traits:          '',
      description:     '',
    },
  };
}

// ── Storage keys ─────────────────────────────────────────────────────────

const SETTINGS_KEY = 'companion_settings';
const API_KEY_KEY  = 'companion_api_key';

// ── Load / Save ──────────────────────────────────────────────────────────

export function loadSettings(): CompanionFullSettings {
  const defaults = getDefaultSettings();

  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CompanionFullSettings>;

      // Merge with defaults (handles newly added fields)
      if (parsed.llm) Object.assign(defaults.llm, parsed.llm);
      if (parsed.chatHistory) Object.assign(defaults.chatHistory, parsed.chatHistory);
      if (parsed.behavior) Object.assign(defaults.behavior, parsed.behavior);
      if (parsed.identity) Object.assign(defaults.identity, parsed.identity);
    }
  } catch {
    // Corrupt storage — use defaults
  }

  // API key stored separately
  try {
    const key = localStorage.getItem(API_KEY_KEY);
    if (key) defaults.llm.apiKey = key;
  } catch {
    // ignore
  }

  return defaults;
}

export function saveSettings(settings: CompanionFullSettings): void {
  // Save everything except API key
  const toStore = {
    llm: { ...settings.llm, apiKey: '' }, // never persist key with main settings
    chatHistory: settings.chatHistory,
    behavior: settings.behavior,
    identity: settings.identity,
  };

  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(toStore));
  } catch {
    console.warn('[CompanionSettings] Failed to save settings to localStorage');
  }

  // API key stored separately for easy clearing
  try {
    if (settings.llm.apiKey) {
      localStorage.setItem(API_KEY_KEY, settings.llm.apiKey);
    } else {
      localStorage.removeItem(API_KEY_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * Get the default endpoint for a provider.
 */
export function getDefaultEndpoint(provider: LLMProvider): string {
  return DEFAULT_ENDPOINTS[provider] ?? '';
}

/**
 * Get the default model for a provider.
 */
export function getDefaultModel(provider: LLMProvider): string {
  return DEFAULT_MODELS[provider] ?? '';
}
