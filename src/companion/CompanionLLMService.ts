/**
 * CompanionLLMService — Client-side LLM integration for BYOLLM companions.
 *
 * Handles both combat and social triggers:
 *   - Builds system + user prompts from trigger payloads
 *   - Calls the configured LLM API (Anthropic, OpenAI-compatible, Ollama, custom)
 *   - Parses and validates response JSON
 *   - Routes results back to server via SocketClient
 */

import type { SocketClient } from '@/network/SocketClient';
import { ChatLogger, type ChatHistorySettings } from './ChatLogger';
import { loadSettings, type CompanionLLMConfig, type CompanionIdentitySettings } from './CompanionSettings';
import type { CompanionConfigPayload } from '@/network/Protocol';

// ── Trigger payload types (mirror server protocol) ───────────────────────

export interface CompanionCombatTriggerPayload {
  companionId: string;
  triggerReason: string;
  companion: {
    id: string;
    name: string;
    archetype: string;
    personalityType: string | null;
    currentSettings: Record<string, unknown>;
    healthRatio: number;
    manaRatio: number;
    staminaRatio: number;
  };
  partner: {
    id: string;
    name: string;
    healthRatio: number;
    inCombat: boolean;
  };
  party: Array<{ id: string; name: string; healthRatio: number; role: string }>;
  enemies: Array<{
    id: string;
    name: string;
    species: string | null;
    family: string | null;
    level: number;
    healthRatio: number;
    isTaunted: boolean;
    isRooted: boolean;
  }>;
  enmity: Array<{ targetId: string; attackers: string[] }>;
  fightDurationSec: number;
  playerCommand: string | null;
}

export interface CompanionSocialTriggerPayload {
  companionId: string;
  triggerReason: 'player_spoke' | 'entity_nearby' | 'zone_change' | 'idle';
  companion: {
    id: string;
    name: string;
    archetype: string;
    personalityType: string | null;
  };
  zone: {
    id: string;
    name: string;
    description: string;
    contentRating: 'T' | 'M' | 'AO';
    lighting: string;
    weather: string;
  };
  proximitySummary: {
    sayCount: number;
    shoutCount: number;
    partyCount: number;
  };
}

// ── Content rating constraints ───────────────────────────────────────────

const CONTENT_RATING_TEXT: Record<string, string> = {
  T:  'Keep all dialogue and actions family-friendly. No violence descriptions, no profanity, no sexual content.',
  M:  'Moderate content allowed. Combat descriptions okay, mild language acceptable. No explicit sexual content.',
  AO: 'Adult content zone. You may be descriptive but stay tasteful and in-character.',
};

// ── Cooldown ─────────────────────────────────────────────────────────────

const LLM_GLOBAL_COOLDOWN_MS = 15_000;

/** Providers that work without an API key (local inference). */
const KEYLESS_PROVIDERS = new Set(['ollama', 'lmstudio']);

// ── Service class ────────────────────────────────────────────────────────

export class CompanionLLMService {
  private socket: SocketClient;
  private chatLogger: ChatLogger;
  private lastCallAt = 0;

  /** Cached companion identity from companion_config (used as fallback for /cc). */
  private companionConfig: {
    name: string;
    archetype: string;
    personalityType: string | null;
    traits: string[];
    description: string | null;
  } | null = null;

  /** Cached LM Studio model identifier (resolved once, reused). */
  private lmStudioModelCache: string | null = null;

  constructor(socket: SocketClient, chatLogger: ChatLogger) {
    this.socket = socket;
    this.chatLogger = chatLogger;
  }

  /** Store companion identity data from companion_config events (fallback for /cc prompts). */
  setCompanionConfig(config: CompanionConfigPayload | null): void {
    if (!config) {
      this.companionConfig = null;
      return;
    }
    this.companionConfig = {
      name:            config.name,
      archetype:       config.archetype,
      personalityType: config.personalityType ?? null,
      traits:          config.traits ?? [],
      description:     config.description ?? null,
    };
  }

  // ── URL proxy helper ──────────────────────────────────────────────────

  /**
   * When the page is served from a localhost dev server (Vite), rewrite
   * `http://localhost:PORT/path` → `/llm-proxy/PORT/path` so the request
   * routes through Vite's middleware and avoids CORS.
   *
   * In production (Tauri) the origin is `https://tauri.localhost` (no port),
   * so this check never matches and the URL is used as-is.
   */
  private proxyUrl(url: string): string {
    const origin = window.location.origin;             // e.g. "http://localhost:5173"
    if (!origin.match(/^https?:\/\/localhost:\d+$/)) return url;   // not a dev server

    const m = url.match(/^https?:\/\/localhost:(\d+)(\/.*)/);
    if (!m) return url;

    // Don't proxy requests to our own dev server
    if (origin.endsWith(`:${m[1]}`)) return url;

    return `/llm-proxy/${m[1]}${m[2]}`;
  }

  // ── Combat trigger handler ─────────────────────────────────────────────

  async handleCombatTrigger(payload: CompanionCombatTriggerPayload): Promise<void> {
    const settings = loadSettings();
    if (!settings.llm.apiKey && !KEYLESS_PROVIDERS.has(settings.llm.provider)) return; // No key configured — BT-only mode

    // Client-side cooldown
    const now = Date.now();
    if (payload.triggerReason !== 'player_command' && now - this.lastCallAt < LLM_GLOBAL_COOLDOWN_MS) {
      console.debug('[CompanionLLM] Combat trigger skipped (cooldown)', payload.triggerReason);
      return;
    }
    this.lastCallAt = now;

    console.log('[CompanionLLM] ── Combat trigger ──', payload.triggerReason, `companion=${payload.companion.name}`);
    console.debug('[CompanionLLM] Combat payload:', payload);

    try {
      const { system, user } = this.buildCombatPrompt(payload);
      console.debug('[CompanionLLM] Combat system prompt:\n', system);
      console.debug('[CompanionLLM] Combat user prompt:\n', user);

      const response = await this.callLLM(settings.llm, system, user);
      if (!response) return;

      // Parse and validate
      const parsed = this.parseJSON(response);
      if (!parsed) return;

      console.log('[CompanionLLM] → Sending settings update:', parsed);
      // Send settings update to server
      this.socket.sendCompanionSettingsUpdate(payload.companionId, parsed);
    } catch (err) {
      console.warn('[CompanionLLM] Combat trigger LLM call failed:', err);
    }
  }

  // ── Social trigger handler ─────────────────────────────────────────────

  async handleSocialTrigger(payload: CompanionSocialTriggerPayload): Promise<void> {
    const settings = loadSettings();
    if (!settings.llm.apiKey && !KEYLESS_PROVIDERS.has(settings.llm.provider)) return;

    // Client-side cooldown
    const now = Date.now();
    if (now - this.lastCallAt < LLM_GLOBAL_COOLDOWN_MS) {
      console.debug('[CompanionLLM] Social trigger skipped (cooldown)', payload.triggerReason);
      return;
    }
    this.lastCallAt = now;

    console.log('[CompanionLLM] ── Social trigger ──', payload.triggerReason, `companion=${payload.companion.name}`);
    console.debug('[CompanionLLM] Social payload:', payload);

    try {
      // Get chat history
      const chatHistory = await this.chatLogger.getFilteredHistory(settings.chatHistory);
      console.debug('[CompanionLLM] Chat history lines:', chatHistory.length);

      const { system, user } = this.buildSocialPrompt(payload, chatHistory);
      console.debug('[CompanionLLM] Social system prompt:\n', system);
      console.debug('[CompanionLLM] Social user prompt:\n', user);

      const response = await this.callLLM(settings.llm, system, user);
      if (!response) return;

      const parsed = this.parseJSON(response);
      if (!parsed) return;

      // Route social action
      const action = parsed.action as string | undefined;
      const VALID_ACTIONS = new Set(['say', 'emote', 'move']);
      if (settings.behavior.socialActionsEnabled && action && action !== 'none' && VALID_ACTIONS.has(action)) {
        console.log('[CompanionLLM] → Sending social action:', action, parsed.message ?? '');
        this.socket.sendCompanionSocialAction(
          payload.companionId,
          action as 'say' | 'emote' | 'move',
          parsed.message as string | undefined,
          parsed.bearing as number | undefined,
          parsed.distance as number | undefined,
        );
      } else {
        console.debug('[CompanionLLM] Social action not routed:', { action, socialEnabled: settings.behavior.socialActionsEnabled, parsed });
      }
    } catch (err) {
      console.warn('[CompanionLLM] Social trigger LLM call failed:', err);
    }
  }

  // ── /cc chat handler (client-side, no server round-trip) ───────────────

  /**
   * Handle a /cc companion chat message. Returns the companion's plain-text
   * reply, or null if LLM is not configured or the call fails.
   *
   * Unlike combat/social triggers, /cc has NO cooldown (player-initiated).
   */
  async handleChat(playerName: string, message: string): Promise<string | null> {
    if (!this.companionConfig) return null;

    const settings = loadSettings();
    if (!settings.llm.apiKey && !KEYLESS_PROVIDERS.has(settings.llm.provider)) {
      return null;
    }

    const chatHistory = await this.chatLogger.getFilteredHistory(settings.chatHistory);

    const { system, user } = this.buildChatPrompt(playerName, message, chatHistory, settings.identity);
    console.log('[CompanionLLM] ── Chat /cc ──', `companion=${this.companionConfig.name}`);
    console.debug('[CompanionLLM] Chat system prompt:\n', system);
    console.debug('[CompanionLLM] Chat user prompt:\n', user);

    try {
      const response = await this.callLLM(settings.llm, system, user);
      if (!response) return null;

      // Clean up: strip any accidental prefixes or companion name echo
      let cleaned = response.trim();
      cleaned = cleaned.replace(/^(SAY|SHOUT|EMOTE|NONE):\s*/i, '');
      const namePrefix = `${this.companionConfig.name}:`;
      if (cleaned.startsWith(namePrefix)) {
        cleaned = cleaned.substring(namePrefix.length).trim();
      }
      // Strip markdown code blocks if the LLM wraps its response
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:\w+)?\s*/, '').replace(/\s*```$/, '');
      }

      console.log('[CompanionLLM] ← Chat response:', cleaned);
      return cleaned || null;
    } catch (err) {
      console.warn('[CompanionLLM] /cc chat LLM call failed:', err);
      return null;
    }
  }

  private buildChatPrompt(
    playerName: string,
    playerMessage: string,
    chatHistory: string[],
    identity: CompanionIdentitySettings,
  ): { system: string; user: string } {
    const c = this.companionConfig!;

    // Resolution: client-side identity settings (if non-empty) → server config → generic defaults
    const personality = identity.personalityType || c.personalityType || 'loyal companion';
    const description = identity.description    || c.description     || 'a loyal companion';
    const traits      = identity.traits         || c.traits.join(', ') || 'loyal, curious';

    const system = [
      `You are ${c.name}, ${description}.`,
      `Personality: ${personality}. Traits: ${traits}.`,
      `You are speaking privately with your partner, ${playerName}.`,
      `Respond in character with 1-2 short sentences.`,
      `Do not include any prefixes, formatting, or JSON — just speak naturally.`,
    ].join(' ');

    const userLines: string[] = [];
    if (chatHistory.length > 0) {
      userLines.push('Recent conversation context:');
      userLines.push(...chatHistory);
      userLines.push('');
    }
    userLines.push(`${playerName}: ${playerMessage}`);
    userLines.push('');
    userLines.push(`Respond as ${c.name}:`);

    return { system, user: userLines.join('\n') };
  }

  // ── Prompt builders ────────────────────────────────────────────────────

  private buildCombatPrompt(payload: CompanionCombatTriggerPayload): { system: string; user: string } {
    const c = payload.companion;

    const system = [
      `You are the tactical AI for ${c.name}, a ${c.archetype} companion${c.personalityType ? ` with a ${c.personalityType} personality` : ''}.`,
      `Your role: adjust behavior tree settings based on the current combat situation.`,
      ``,
      `Available settings you may adjust (include only fields you want to change):`,
      `- stance: "aggressive" | "cautious" | "support"`,
      `- preferredRange: "close" | "mid" | "long" (close = melee ~1m, mid = polearm ~4m, long = ranged/caster ~15m)`,
      `- priority: "weakest" | "nearest" | "threatening_player"`,
      `- retreatThreshold: 0.0-1.0 (HP ratio to retreat at)`,
      `- healAllyThreshold: 0.0-1.0 (ally HP to switch to healing)`,
      `- healPriorityMode: "lowest_hp" | "most_damage_taken" | "tank_first"`,
      `- engagementMode: "aggressive" | "defensive" | "passive"`,
      `- saveCooldownsForElites: true | false`,
      `- resourceReservePercent: 0-100`,
      `- defensiveThreshold: 0.0-1.0 (HP to use defensive abilities)`,
      `- abilityWeights: { "damage": 0-1, "heal": 0-1, "cc": 0-1 }`,
      ``,
      `Respond with ONLY a JSON object containing the settings fields you want to change.`,
      `Example: {"stance":"support","healAllyThreshold":0.5,"abilityWeights":{"heal":0.8,"damage":0.2}}`,
    ].join('\n');

    const enemyTable = payload.enemies.map(e =>
      `  ${e.name} (lv${e.level}) HP:${Math.round(e.healthRatio * 100)}%` +
      `${e.species ? ` [${e.species}]` : ''}${e.isTaunted ? ' TAUNTED' : ''}${e.isRooted ? ' ROOTED' : ''}`
    ).join('\n');

    const partyTable = [
      `  ${payload.partner.name} (partner) HP:${Math.round(payload.partner.healthRatio * 100)}%${payload.partner.inCombat ? ' IN COMBAT' : ''}`,
      ...payload.party.map(p => `  ${p.name} (${p.role}) HP:${Math.round(p.healthRatio * 100)}%`),
    ].join('\n');

    const user = [
      `Trigger: ${payload.triggerReason}`,
      `Fight duration: ${Math.round(payload.fightDurationSec)}s`,
      payload.playerCommand ? `Player command: "${payload.playerCommand}"` : null,
      ``,
      `${c.name} status: HP:${Math.round(c.healthRatio * 100)}% Mana:${Math.round(c.manaRatio * 100)}% Stamina:${Math.round(c.staminaRatio * 100)}%`,
      `Current settings: ${JSON.stringify(c.currentSettings)}`,
      ``,
      `Enemies:`,
      enemyTable || '  (none)',
      ``,
      `Party:`,
      partyTable,
      ``,
      `Enmity:`,
      payload.enmity.length > 0
        ? payload.enmity.map(e => `  ${e.targetId} attacked by: ${e.attackers.join(', ')}`).join('\n')
        : '  (none)',
    ].filter(Boolean).join('\n');

    return { system, user };
  }

  private buildSocialPrompt(
    payload: CompanionSocialTriggerPayload,
    chatHistory: string[],
  ): { system: string; user: string } {
    const c = payload.companion;
    const z = payload.zone;
    const ratingText = CONTENT_RATING_TEXT[z.contentRating] ?? CONTENT_RATING_TEXT.T;

    const system = [
      `You are ${c.name}, a ${c.archetype} companion${c.personalityType ? ` with a ${c.personalityType} personality` : ''}.`,
      `You are in ${z.name}. ${z.description}`,
      ``,
      `This zone is rated ${z.contentRating}. ${ratingText}`,
      `Current conditions: ${z.weather}, ${z.lighting} lighting.`,
      ``,
      `Available actions:`,
      `- "say": speak out loud (message required)`,
      `- "emote": perform an emote action (message required)`,
      `- "none": do nothing (appropriate if the situation doesn't warrant a response)`,
      ``,
      `Respond with ONLY a JSON object.`,
      `Example: {"action":"say","message":"Hello there, traveler!"}`,
      `Example: {"action":"emote","message":"stretches and yawns"}`,
      `Example: {"action":"none"}`,
    ].join('\n');

    const user = [
      `Trigger: ${payload.triggerReason}`,
      `Nearby: ${payload.proximitySummary.sayCount} players in say range`,
      ``,
      chatHistory.length > 0
        ? `Recent chat:\n${chatHistory.join('\n')}`
        : 'No recent chat.',
    ].join('\n');

    return { system, user };
  }

  // ── LLM API call ───────────────────────────────────────────────────────

  private async callLLM(config: CompanionLLMConfig, systemPrompt: string, userPrompt: string): Promise<string | null> {
    console.log(`[CompanionLLM] Calling ${config.provider} @ ${config.apiEndpoint}${config.modelName ? ` model=${config.modelName}` : ''}`);
    const t0 = performance.now();
    try {
      let result: string | null;
      switch (config.provider) {
        case 'anthropic':
          result = await this.callAnthropic(config, systemPrompt, userPrompt);
          break;
        case 'openai':
        case 'custom':
          result = await this.callOpenAICompatible(config, systemPrompt, userPrompt);
          break;
        case 'lmstudio':
          result = await this.callLMStudio(config, systemPrompt, userPrompt);
          break;
        case 'ollama':
          result = await this.callOllama(config, systemPrompt, userPrompt);
          break;
        default:
          console.warn('[CompanionLLM] Unknown provider:', config.provider);
          return null;
      }
      const elapsed = Math.round(performance.now() - t0);
      if (result) {
        console.log(`[CompanionLLM] ← Response (${elapsed}ms, ${result.length} chars):`, result);
      } else {
        console.warn(`[CompanionLLM] ← No response (${elapsed}ms)`);
      }
      return result;
    } catch (err) {
      const elapsed = Math.round(performance.now() - t0);
      console.error(`[CompanionLLM] API call failed (${elapsed}ms):`, err);
      return null;
    }
  }

  private async callAnthropic(config: CompanionLLMConfig, system: string, user: string): Promise<string | null> {
    const requestBody = {
      model: config.modelName,
      max_tokens: 256,
      system,
      messages: [{ role: 'user', content: user }],
    };
    console.debug('[CompanionLLM] Anthropic request body:', requestBody);

    const resp = await fetch(this.proxyUrl(config.apiEndpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(requestBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[CompanionLLM] Anthropic API error:', resp.status, errText);
      return null;
    }

    const data = await resp.json();
    console.debug('[CompanionLLM] Anthropic response data:', data);
    return data.content?.[0]?.text ?? null;
  }

  private async callOpenAICompatible(config: CompanionLLMConfig, system: string, user: string): Promise<string | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const requestBody: Record<string, unknown> = {
      max_tokens: 256,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (config.modelName) requestBody.model = config.modelName;
    console.debug('[CompanionLLM] OpenAI-compat request body:', requestBody);

    const resp = await fetch(this.proxyUrl(config.apiEndpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[CompanionLLM] OpenAI API error:', resp.status, errText);
      return null;
    }

    const data = await resp.json();
    console.debug('[CompanionLLM] OpenAI-compat response data:', data);
    return data.choices?.[0]?.message?.content ?? null;
  }

  private async callOllama(config: CompanionLLMConfig, system: string, user: string): Promise<string | null> {
    const requestBody = {
      model: config.modelName,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    console.debug('[CompanionLLM] Ollama request body:', requestBody);

    const resp = await fetch(this.proxyUrl(config.apiEndpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[CompanionLLM] Ollama API error:', resp.status, errText);
      return null;
    }

    const data = await resp.json();
    console.debug('[CompanionLLM] Ollama response data:', data);
    return data.message?.content ?? null;
  }

  private async callLMStudio(config: CompanionLLMConfig, system: string, user: string): Promise<string | null> {
    // model is REQUIRED by LM Studio v1 API — resolve it if not configured
    let modelId: string | null = config.modelName || null;
    if (!modelId) {
      modelId = await this.resolveLMStudioModel(config);
      if (!modelId) {
        console.error('[CompanionLLM] LM Studio: no model configured and could not auto-detect a loaded model');
        return null;
      }
    }

    const requestBody: Record<string, unknown> = {
      model: modelId,
      input: user,
      system_prompt: system,
      max_output_tokens: 256,
      temperature: 0.7,
      store: false,
    };
    console.debug('[CompanionLLM] LM Studio v1 request body:', requestBody);

    const resp = await fetch(this.proxyUrl(config.apiEndpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[CompanionLLM] LM Studio v1 API error:', resp.status, errText);
      return null;
    }

    const data = await resp.json();
    console.debug('[CompanionLLM] LM Studio v1 response data:', data);
    if (data.stats) {
      console.debug('[CompanionLLM] LM Studio stats:', {
        inputTokens: data.stats.input_tokens,
        outputTokens: data.stats.total_output_tokens,
        tokPerSec: data.stats.tokens_per_second?.toFixed(1),
        ttft: data.stats.time_to_first_token_seconds?.toFixed(3) + 's',
      });
    }

    // v1 response: { output: [{ type: "message", content: "..." }, ...], stats: {...} }
    const output = data.output as Array<{ type: string; content?: string }> | undefined;
    if (!output || !Array.isArray(output)) return null;

    // Find the last message-type output (skip reasoning, tool_call, etc.)
    for (let i = output.length - 1; i >= 0; i--) {
      const item = output[i];
      if (item && item.type === 'message' && item.content) {
        return item.content;
      }
    }

    return null;
  }

  /**
   * Resolve the LM Studio model identifier by querying /api/v1/models.
   * Caches the result so subsequent calls don't re-query.
   */
  private async resolveLMStudioModel(config: CompanionLLMConfig): Promise<string | null> {
    if (this.lmStudioModelCache) return this.lmStudioModelCache;

    try {
      const modelsUrl = config.apiEndpoint.replace(/\/chat\/?$/, '/models');
      console.log('[CompanionLLM] Auto-detecting LM Studio model via', modelsUrl);

      const resp = await fetch(this.proxyUrl(modelsUrl), {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!resp.ok) {
        console.warn('[CompanionLLM] LM Studio models endpoint returned', resp.status);
        return null;
      }

      const data = await resp.json();
      const models = data.models as Array<{
        type: string;
        key?: string;
        display_name?: string;
        loaded_instances?: Array<unknown>;
      }> | undefined;

      if (!models || !Array.isArray(models)) return null;

      // Prefer a loaded LLM; fall back to first available LLM
      const llms = models.filter(m => m.type === 'llm');
      const loaded = llms.filter(m => m.loaded_instances && m.loaded_instances.length > 0);
      const chosen = (loaded[0] ?? llms[0]);

      if (!chosen?.key) {
        console.warn('[CompanionLLM] No LLM models found in LM Studio');
        return null;
      }

      this.lmStudioModelCache = chosen.key;
      console.log(`[CompanionLLM] Auto-detected LM Studio model: ${chosen.display_name ?? chosen.key} (key=${chosen.key})`);
      return chosen.key;
    } catch (err) {
      console.warn('[CompanionLLM] Failed to auto-detect LM Studio model:', err);
      return null;
    }
  }

  // ── Response parsing ───────────────────────────────────────────────────

  private parseJSON(text: string): Record<string, unknown> | null {
    try {
      // Strip markdown code blocks if present
      let cleaned = text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        console.debug('[CompanionLLM] Stripped markdown code block from response');
      }

      const parsed = JSON.parse(cleaned);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.warn('[CompanionLLM] Response is not an object:', parsed);
        return null;
      }
      console.debug('[CompanionLLM] Parsed JSON:', parsed);
      return parsed as Record<string, unknown>;
    } catch {
      console.warn('[CompanionLLM] Failed to parse JSON response:', text);
      return null;
    }
  }

  // ── Connection test ────────────────────────────────────────────────────

  /**
   * Test the LLM connection.
   * For LM Studio: queries the /api/v1/models endpoint to list loaded models.
   * For others: sends a minimal prompt and checks for a response.
   */
  async testConnection(config: CompanionLLMConfig): Promise<{ ok: boolean; message?: string; error?: string }> {
    console.log(`[CompanionLLM] Testing connection: provider=${config.provider} endpoint=${config.apiEndpoint}`);

    if (config.provider === 'lmstudio') {
      return this.testLMStudio(config);
    }

    try {
      const result = await this.callLLM(
        config,
        'You are a test assistant. Respond with exactly: {"ok":true}',
        'Test connection.',
      );

      if (result) {
        return { ok: true, message: '✓ Connected' };
      }
      return { ok: false, error: 'No response from LLM' };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Test LM Studio by querying its /api/v1/models endpoint.
   * Reports which models are available and which are loaded into memory.
   */
  private async testLMStudio(config: CompanionLLMConfig): Promise<{ ok: boolean; message?: string; error?: string }> {
    try {
      // Derive the base URL from the configured chat endpoint
      // e.g. "http://localhost:11434/api/v1/chat" → "http://localhost:11434/api/v1/models"
      const baseUrl = config.apiEndpoint.replace(/\/chat\/?$/, '/models');
      console.log('[CompanionLLM] LM Studio models endpoint:', baseUrl);

      const resp = await fetch(this.proxyUrl(baseUrl), {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!resp.ok) {
        return { ok: false, error: `LM Studio returned ${resp.status}` };
      }

      const data = await resp.json();
      console.debug('[CompanionLLM] LM Studio models response:', data);

      const models = data.models as Array<{
        type: string;
        display_name?: string;
        key?: string;
        quantization?: { name: string };
        params_string?: string;
        loaded_instances?: Array<unknown>;
      }> | undefined;

      if (!models || !Array.isArray(models) || models.length === 0) {
        return { ok: true, message: '✓ Connected — no models available' };
      }

      // Separate LLMs from embedding models
      const llms = models.filter(m => m.type === 'llm');
      const loaded = llms.filter(m => m.loaded_instances && m.loaded_instances.length > 0);

      // Build a concise summary
      const parts: string[] = [`✓ Connected`];

      if (loaded.length > 0) {
        const loadedNames = loaded.map(m => {
          const name = m.display_name ?? m.key ?? 'unknown';
          const quant = m.quantization?.name ? ` (${m.quantization.name})` : '';
          return `${name}${quant}`;
        });
        parts.push(`Loaded: ${loadedNames.join(', ')}`);
      } else {
        parts.push(`No models loaded`);
      }

      if (llms.length > loaded.length) {
        parts.push(`${llms.length - loaded.length} more available`);
      }

      return { ok: true, message: parts.join(' · ') };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        return { ok: false, error: 'Cannot reach LM Studio — is it running?' };
      }
      return { ok: false, error: msg };
    }
  }
}
