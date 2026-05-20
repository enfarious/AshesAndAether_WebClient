import type { PlayerState }  from '@/state/PlayerState';
import type { WorldState }   from '@/state/WorldState';
import type { SocketClient } from '@/network/SocketClient';
import type { CorruptionState } from '@/network/Protocol';

/** Display label for the contextual-interact key. Sourced as a const here so
 *  there's exactly one place to swap when rebindable keybinds ship — that
 *  swap becomes "read from ClientConfig.keybinds.interact" instead of this
 *  hardcoded literal. The actual key handler still lives in WASDController. */
const INTERACT_KEY_LABEL = 'F';

// ── Corruption display data ──────────────────────────────────────────────────

const CORRUPTION_COLORS: Record<CorruptionState, { gradient: string; label: string }> = {
  CLEAN:   { gradient: 'linear-gradient(90deg, #2a3a2a, #3a5a3a)', label: 'rgba(180,200,180,0.50)' },
  STAINED: { gradient: 'linear-gradient(90deg, #3a3a1a, #6a6a20)', label: 'rgba(200,200,100,0.70)' },
  WARPED:  { gradient: 'linear-gradient(90deg, #3a2a10, #8a5a10)', label: 'rgba(220,160,60,0.85)' },
  LOST:    { gradient: 'linear-gradient(90deg, #2a1030, #6a2080)', label: 'rgba(180,100,220,0.90)' },
};

const CORRUPTION_TOOLTIPS: Record<CorruptionState, string> = {
  CLEAN:   'Corruption: Clean — No benefits, no taint.',
  STAINED: 'Corruption: Stained — +5% cache detection.',
  WARPED:  'Corruption: Warped — +15% cache detection, +10% hazard resist, dead system interface.',
  LOST:    'Corruption: Lost — +30% cache detection, +25% hazard resist, dead system interface.',
};

/**
 * HUD — vitals bars, combat gauges, target display, and death overlay.
 * Pure HTML/CSS over the canvas. Three.js is not involved here.
 */
export class HUD {
  private root:          HTMLElement;
  private deathOverlay:  HTMLElement | null = null;
  private deathTimerEl:  HTMLElement | null = null;
  private clockEl:       HTMLElement | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private clockInterval: ReturnType<typeof setInterval> | null = null;
  private _lastCorruptionState: CorruptionState = 'CLEAN';
  private effectsInterval: ReturnType<typeof setInterval> | null = null;
  private _lastBuffCount   = 0;
  private _lastDebuffCount = 0;
  private cleanup: (() => void)[] = [];
  /** RAF coalescing — prevents DOM thrashing from rapid state updates. */
  private _rafId: number | null = null;
  private fpsEl:           HTMLElement | null = null;
  private harvestPromptEl: HTMLElement | null = null;
  private interactKeyEl:   HTMLElement | null = null;
  private interactLabelEl: HTMLElement | null = null;
  private aetherFillEl:    HTMLElement | null = null;
  private aetherValueEl:   HTMLElement | null = null;
  private aetherTierEl:    HTMLElement | null = null;
  private activityBandEl:  HTMLElement | null = null;
  private bossStateRowEl:  HTMLElement | null = null;
  private bossStateLabelEl: HTMLElement | null = null;
  private bossStateEl:     HTMLElement | null = null;
  private _fpsFrames = 0;
  private _fpsTime   = 0;
  /** F9 — extended GPU/perf readout under the FPS line. */
  private _perfMode  = false;

  // ── Cast bar state ──────────────────────────────────────────────────
  /** performance.now() at cast_start / channel_start receipt — drives the
   *  local-only progress fill so the bar smooths between server events. */
  private _castStartedAt = 0;
  private _castDurationMs = 0;
  private _castActive = false;
  /** True while in channel-drain mode (1 → 0 instead of 0 → 1). Same widget,
   *  same RAF loop — only the fill direction changes. */
  private _castDrain = false;
  private _castRafId: number | null = null;
  /** Auto-hide timer for the brief complete/break flash. */
  private _castFadeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly player:  PlayerState,
    private readonly socket:  SocketClient,
    private readonly world:   WorldState,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    const unsubPlayer = player.onChange(() => this._scheduleRefresh());
    const unsubZone   = world.onZoneChange(() => this._updateClock());
    this.cleanup.push(unsubPlayer, unsubZone);

    // Tick the clock every second (≈ 1 in-game minute).
    this.clockInterval = setInterval(() => this._updateClock(), 1_000);

    // Tick effect durations every 100ms for smooth countdown display.
    this.effectsInterval = setInterval(() => {
      this.player.tickEffects(0.1);
      this._updateEffects();
    }, 100);

    this._refresh();
    this._updateClock();
  }

  show(): void { this.root.style.display = ''; }
  hide(): void { this.root.style.display = 'none'; }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    if (this.timerInterval   !== null) clearInterval(this.timerInterval);
    if (this.clockInterval   !== null) clearInterval(this.clockInterval);
    if (this.effectsInterval !== null) clearInterval(this.effectsInterval);
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._castRafId !== null) { cancelAnimationFrame(this._castRafId); this._castRafId = null; }
    this._cancelCastFade();
    this.root.remove();
  }

  /** Coalesce rapid state updates into a single refresh per frame. */
  private _scheduleRefresh(): void {
    if (this._rafId !== null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._refresh();
    });
  }

  // ── Cast bar API ────────────────────────────────────────────────────

  /** Open the cast bar with the given ability + duration. Server emits
   *  cast_start when a cast-time ability begins; app.ts router callback
   *  forwards the payload here. Local performance.now() drives the smooth
   *  fill — we don't need server progress polling. */
  showCast(abilityName: string, durationMs: number): void {
    this._cancelCastFade();
    this._castStartedAt  = performance.now();
    this._castDurationMs = durationMs;
    this._castActive     = true;
    this._castDrain      = false;

    const bar = this.root.querySelector<HTMLElement>('#hud-cast');
    const text = this.root.querySelector<HTMLElement>('#hud-cast-text');
    if (!bar || !text) return;
    bar.classList.remove('complete', 'broken', 'channel');
    bar.classList.add('casting');
    text.textContent = abilityName;
    this._tickCastFill();
  }

  /** Open the cast bar in DRAIN mode for a channeled ability. Same widget
   *  as showCast, just runs the fill from 1 → 0 over durationMs. Called on
   *  channel_start receipt (cast_complete is also fired by the server but
   *  the channel_start follows immediately and takes over the bar). */
  showChannel(abilityName: string, durationMs: number): void {
    this._cancelCastFade();
    this._castStartedAt  = performance.now();
    this._castDurationMs = durationMs;
    this._castActive     = true;
    this._castDrain      = true;

    const bar = this.root.querySelector<HTMLElement>('#hud-cast');
    const text = this.root.querySelector<HTMLElement>('#hud-cast-text');
    if (!bar || !text) return;
    bar.classList.remove('complete', 'broken');
    bar.classList.add('casting', 'channel');
    text.textContent = abilityName;
    this._tickCastFill();
  }

  /** Cast resolved successfully — flash green, then fade out. */
  completeCast(): void {
    if (!this._castActive) return;
    this._castActive = false;
    if (this._castRafId !== null) { cancelAnimationFrame(this._castRafId); this._castRafId = null; }
    const bar = this.root.querySelector<HTMLElement>('#hud-cast');
    const fill = this.root.querySelector<HTMLElement>('#hud-cast-fill');
    if (!bar || !fill) return;
    fill.style.transform = 'scaleX(1)';
    bar.classList.add('complete');
    this._scheduleCastFade(250);
  }

  /** Cast interrupted — double-flash red across the full bar width, then
   *  fade out. Scaling the fill to 1 first means the red flash covers the
   *  whole bar regardless of how far the cast had progressed. The 600ms
   *  hold matches the keyframes animation so the second flash actually
   *  plays before the bar disappears. */
  breakCast(): void {
    if (!this._castActive) return;
    this._castActive = false;
    if (this._castRafId !== null) { cancelAnimationFrame(this._castRafId); this._castRafId = null; }
    const bar  = this.root.querySelector<HTMLElement>('#hud-cast');
    const fill = this.root.querySelector<HTMLElement>('#hud-cast-fill');
    if (!bar || !fill) return;
    fill.style.transform = 'scaleX(1)';
    bar.classList.add('broken');
    this._scheduleCastFade(650);
  }

  private _tickCastFill = (): void => {
    if (!this._castActive) return;
    const fill = this.root.querySelector<HTMLElement>('#hud-cast-fill');
    if (fill) {
      const elapsed = performance.now() - this._castStartedAt;
      const ratio   = Math.min(1, this._castDurationMs > 0 ? elapsed / this._castDurationMs : 0);
      // Cast: 0 → 1 fill. Channel (drain): 1 → 0.
      const pct = this._castDrain ? 1 - ratio : ratio;
      fill.style.transform = `scaleX(${pct})`;
    }
    this._castRafId = requestAnimationFrame(this._tickCastFill);
  };

  private _scheduleCastFade(delayMs: number): void {
    this._cancelCastFade();
    this._castFadeTimer = setTimeout(() => {
      const bar = this.root.querySelector<HTMLElement>('#hud-cast');
      if (bar) bar.classList.remove('casting', 'complete', 'broken');
      this._castFadeTimer = null;
    }, delayMs);
  }

  private _cancelCastFade(): void {
    if (this._castFadeTimer !== null) {
      clearTimeout(this._castFadeTimer);
      this._castFadeTimer = null;
    }
  }

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'hud';
    el.innerHTML = `
      <style>
        #hud {
          position: absolute;
          bottom: 24px;
          left: calc(50% - min(250px, 45vw));
          pointer-events: none;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          width: min(500px, 90vw);
        }

        /* The bottom-center "combat cluster" — cast bar above vitals
         * above corruption. LayoutEditor moves this whole group as one. */
        #hud-vitals-cluster {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          width: 100%;
        }

        .hud-vitals {
          display: flex;
          gap: 6px;
          width: 100%;
        }

        .hud-bar {
          flex: 1;
          height: 28px;
          background: rgba(10,8,6,0.7);
          border: 1px solid rgba(200,98,42,0.2);
          position: relative;
          overflow: hidden;
        }

        .hud-bar-fill {
          position: absolute;
          inset: 0;
          transform-origin: left;
          transition: transform 0.25s ease;
        }

        .hud-bar-fill.hp   { background: linear-gradient(90deg, #5a0f0f, #8b2020); }
        .hud-bar-fill.mp   { background: linear-gradient(90deg, #0d2e4d, #1e4d7a); }
        .hud-bar-fill.stam { background: linear-gradient(90deg, #152e0a, #2d5a1e); }

        /* ── Cast bar ──────────────────────────────────────────────────
         * Floats above the action bar (which sits at viewport-bottom 104,
         * 48px tall → top edge at 152). Cast bar's bottom relative to #hud
         * (which is bottom: 24px) is 140 → bottom edge at viewport 164,
         * giving ~12px clearance above the action bar. 2/3 of the HUD's
         * 500px max width (333px / 60vw). Absolute-positioned so it's not
         * part of the vitals flex column — when hidden, vitals stay put. */
        .hud-cast {
          position: absolute;
          bottom: 140px;
          left: 50%;
          transform: translateX(-50%);
          width: 67%;          /* ~2/3 of #hud's width — proportional at any viewport */
          height: 22px;
          background: rgba(10,8,6,0.7);
          border: 1px solid rgba(220,170,60,0.35);
          overflow: hidden;
          z-index: 51;
          display: none;  /* shown only during a cast */
        }
        .hud-cast.casting   { display: block; }
        .hud-cast-fill {
          position: absolute;
          inset: 0;
          transform: scaleX(0);
          transform-origin: left;
          background: linear-gradient(90deg, #5a3a0a, #d4a020);
        }
        .hud-cast.complete .hud-cast-fill { background: linear-gradient(90deg, #2a5a1a, #4d8a2a); }
        .hud-cast.broken   .hud-cast-fill { background: linear-gradient(90deg, #5a1a1a, #8a3a3a); }
        /* Channel mode — purple/blue to distinguish from the gold cast fill */
        .hud-cast.channel  .hud-cast-fill { background: linear-gradient(90deg, #2a1a4a, #5a3a8a); }
        .hud-cast.channel  { border-color: rgba(140,100,210,0.45); }
        /* Double-flash on break — single solid red was too fast to register. */
        @keyframes hud-cast-broken-flash {
          0%   { opacity: 1; }
          20%  { opacity: 0.15; }
          40%  { opacity: 1; }
          60%  { opacity: 0.15; }
          80%  { opacity: 1; }
          100% { opacity: 1; }
        }
        .hud-cast.broken { animation: hud-cast-broken-flash 0.6s ease-in-out; }
        .hud-cast-text {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: var(--font-mono);
          font-size: 13px;
          color: rgba(212,201,184,0.95);
          letter-spacing: 0.05em;
          text-shadow: 0 1px 3px #000;
          pointer-events: none;
        }

        .hud-bar-text {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: var(--font-mono);
          font-size: 14px;
          color: rgba(212,201,184,0.9);
          letter-spacing: 0.05em;
          text-shadow: 0 1px 3px #000;
          pointer-events: none;
        }

        /* ── Death overlay ────────────────────────────────────────────── */
        #hud-death {
          position: fixed;
          inset: 0;
          background: radial-gradient(ellipse at 50% 40%,
            rgba(20,0,40,0.92) 0%,
            rgba(0,0,0,0.97)   100%);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          z-index: 500;
          pointer-events: none;
          opacity: 0;
          transition: opacity 1.2s ease;
        }
        #hud-death.visible { opacity: 1; pointer-events: auto; }

        .death-title {
          font-family: var(--font-display, serif);
          font-size: clamp(1.8rem, 5vw, 3rem);
          color: #5a006e;
          text-shadow: 0 0 60px #aa00ff, 0 0 20px #440055;
          letter-spacing: 0.25em;
          margin-bottom: 0.5rem;
          text-transform: uppercase;
        }

        .death-subtitle {
          font-family: var(--font-body, serif);
          font-size: 0.95rem;
          color: #7040a0;
          font-style: italic;
          margin-bottom: 2rem;
          letter-spacing: 0.06em;
          max-width: 36ch;
          text-align: center;
          line-height: 1.5;
        }

        .death-timer {
          font-family: var(--font-mono, monospace);
          font-size: 0.85rem;
          color: #4a2060;
          letter-spacing: 0.12em;
          margin-bottom: 2.4rem;
        }

        .death-release-btn {
          font-family: var(--font-body, serif);
          font-size: 0.95rem;
          color: rgba(212,201,184,0.85);
          background: rgba(60,0,80,0.55);
          border: 1px solid rgba(160,0,220,0.35);
          padding: 0.55em 2.2em;
          cursor: pointer;
          letter-spacing: 0.12em;
          transition: background 0.2s, border-color 0.2s, color 0.2s;
          text-transform: uppercase;
        }
        .death-release-btn:hover {
          background: rgba(120,0,180,0.45);
          border-color: rgba(200,0,255,0.55);
          color: #e8e0f8;
        }

        /* ── FPS counter ─────────────────────────────────────────────── */
        #hud-fps {
          position: fixed;
          top: 18px;
          left: 18px;
          background: rgba(8, 6, 4, 0.72);
          border: 1px solid rgba(200, 145, 60, 0.18);
          padding: 4px 10px;
          pointer-events: none;
          font-family: var(--font-mono);
          font-size: 12px;
          color: rgba(212, 201, 184, 0.85);
          letter-spacing: 0.1em;
          z-index: 1000;
          white-space: pre;
          line-height: 1.45;
        }

        /* ── Clock ────────────────────────────────────────────────────── */
        #hud-clock {
          position: fixed;
          top: 18px;
          right: 18px;
          background: rgba(8, 6, 4, 0.72);
          border: 1px solid rgba(200, 145, 60, 0.22);
          box-shadow: 0 2px 8px rgba(0,0,0,0.5);
          padding: 7px 18px 8px 14px;
          display: flex;
          flex-direction: column;
          gap: 5px;
          pointer-events: none;
          white-space: nowrap;
        }

        .hud-clock-main {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .hud-clock-icon {
          font-size: 20px;
          line-height: 1;
          width: 22px;
          text-align: center;
        }

        .hud-clock-time {
          font-family: var(--font-mono);
          font-size: 16px;
          color: rgba(212, 201, 184, 0.88);
          letter-spacing: 0.12em;
          text-shadow: 0 1px 3px #000;
        }

        .hud-clock-period {
          font-family: var(--font-mono);
          font-size: 12px;
          color: rgba(212, 201, 184, 0.42);
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }

        .hud-clock-env {
          font-family: var(--font-mono);
          font-size: 13px;
          color: rgba(212, 201, 184, 0.55);
          letter-spacing: 0.08em;
          padding-left: 32px; /* align under time text */
        }

        .hud-clock-wx-icon {
          margin-right: 2px;
        }

        /* ── Status effects — top of screen, split buffs / debuffs ──── */
        #hud-effects-wrapper {
          position: fixed;
          top: 12px;
          left: 0;
          right: 0;
          display: flex;
          pointer-events: none;
        }

        #hud-buffs {
          flex: 1;
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          align-content: flex-start;
          gap: 4px;
          padding-right: 6px;
        }

        #hud-debuffs {
          flex: 1;
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-start;
          align-content: flex-start;
          gap: 4px;
          padding-left: 6px;
        }

        .hud-effect {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-width: 52px;
          max-width: 80px;
          height: 34px;
          padding: 1px 6px;
          border-radius: 3px;
          pointer-events: auto;
          cursor: default;
        }

        .hud-effect.buff {
          background: rgba(40,80,40,0.7);
          border: 1px solid rgba(80,160,80,0.4);
        }

        .hud-effect.debuff {
          background: rgba(80,30,30,0.7);
          border: 1px solid rgba(180,60,60,0.4);
        }

        .hud-effect-name {
          font-family: var(--font-mono);
          font-size: 11px;
          color: rgba(212,201,184,0.85);
          letter-spacing: 0.06em;
          text-transform: uppercase;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
          line-height: 1.2;
        }

        .hud-effect-timer {
          font-family: var(--font-mono);
          font-size: 12px;
          color: rgba(200,180,140,0.75);
          letter-spacing: 0.08em;
          line-height: 1.2;
        }

        /* ── Corruption bar ──────────────────────────────────────────── */
        .hud-corruption {
          width: 100%;
          height: 18px;
          background: rgba(10,8,6,0.7);
          border: 1px solid rgba(200,98,42,0.15);
          position: relative;
          overflow: hidden;
          pointer-events: auto;
          cursor: default;
        }

        .hud-corruption-fill {
          position: absolute;
          inset: 0;
          transform-origin: left;
          transition: transform 0.4s ease;
        }

        .hud-corruption-text {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.12em;
          text-shadow: 0 1px 2px #000;
          pointer-events: none;
          text-transform: uppercase;
        }

        @keyframes hud-corruption-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(160,80,220,0.6); }
          50%  { box-shadow: 0 0 8px 2px rgba(160,80,220,0.4); }
          100% { box-shadow: 0 0 0 0 rgba(160,80,220,0); }
        }
        .hud-corruption.pulse {
          animation: hud-corruption-pulse 0.6s ease-out;
        }
      </style>

      <div id="hud-fps"></div>

      <div id="hud-clock">
        <div class="hud-clock-main">
          <span class="hud-clock-icon" id="hud-clock-icon">☀</span>
          <span class="hud-clock-time" id="hud-clock-time">—</span>
          <span class="hud-clock-period" id="hud-clock-period"></span>
        </div>
        <div class="hud-clock-env" id="hud-clock-env"></div>
        <div class="hud-clock-env" id="hud-clock-climate"></div>
      </div>

      <div id="hud-death">
        <div class="death-title">You Have Fallen</div>
        <div class="death-subtitle">
          The black tendrils of the aether reach upward,<br>
          hungry to reclaim what once breathed.
        </div>
        <div class="death-timer" id="hud-death-timer"></div>
        <button class="death-release-btn" id="hud-death-release">
          Release to Homepoint
        </button>
      </div>

      <div id="hud-effects-wrapper">
        <div id="hud-buffs"></div>
        <div id="hud-debuffs"></div>
      </div>

      <!-- Bottom-center cluster — cast bar, vitals, corruption move
           together as one draggable. LayoutEditor transforms THIS wrapper,
           not #hud, so #hud's fixed-positioned children (clock, fps,
           aether, etc.) keep their viewport anchoring instead of being
           dragged with the cluster. -->
      <div id="hud-vitals-cluster">
        <div class="hud-cast" id="hud-cast">
          <div class="hud-cast-fill" id="hud-cast-fill"></div>
          <div class="hud-cast-text" id="hud-cast-text"></div>
        </div>

        <div class="hud-vitals">
          <div class="hud-bar">
            <div class="hud-bar-fill hp" id="hud-hp-fill"></div>
            <div class="hud-bar-text" id="hud-hp-text"></div>
          </div>
          <div class="hud-bar">
            <div class="hud-bar-fill stam" id="hud-stam-fill"></div>
            <div class="hud-bar-text" id="hud-stam-text"></div>
          </div>
          <div class="hud-bar">
            <div class="hud-bar-fill mp" id="hud-mp-fill"></div>
            <div class="hud-bar-text" id="hud-mp-text"></div>
          </div>
        </div>

        <div class="hud-corruption" id="hud-corruption">
          <div class="hud-corruption-fill" id="hud-corruption-fill"></div>
          <div class="hud-corruption-text" id="hud-corruption-text"></div>
        </div>
      </div>

      <div id="hud-aether" class="hud-aether">
        <div class="hud-aether-label">AETHER DENSITY</div>
        <div class="hud-aether-bar"><div class="hud-aether-fill" id="hud-aether-fill"></div></div>
        <div class="hud-aether-text">
          <span id="hud-aether-value">0.00</span>
          <span class="hud-aether-tier" id="hud-aether-tier">T1</span>
        </div>
        <div class="hud-aether-activity">
          <span class="hud-aether-activity-label">ACTIVITY</span>
          <span class="hud-aether-activity-band" id="hud-aether-activity-band">QUIET</span>
        </div>
        <div class="hud-aether-boss" id="hud-aether-boss-row" style="display:none;">
          <span class="hud-aether-activity-label" id="hud-aether-boss-label">ZONE BOSS</span>
          <span class="hud-aether-boss-state" id="hud-aether-boss-state">DORMANT</span>
        </div>
      </div>

      <style>
        /* Aether Density panel — sits below the clock, top-right. Tells
         * the player where they are on the danger gradient at a glance:
         * bar fill + value + tier badge. Color bands match NodePool tier
         * colors so "what mats can I farm here" is implicit. */
        .hud-aether {
          position: fixed;
          top: 95px;
          right: 18px;
          background: rgba(8, 6, 4, 0.72);
          border: 1px solid rgba(200, 145, 60, 0.22);
          box-shadow: 0 2px 8px rgba(0,0,0,0.5);
          padding: 7px 12px 8px 12px;
          width: 156px;
          display: flex;
          flex-direction: column;
          gap: 4px;
          pointer-events: none;
          font-family: var(--font-mono);
        }
        .hud-aether-label {
          font-size: 9px;
          letter-spacing: 0.18em;
          color: rgba(212, 201, 184, 0.55);
          text-transform: uppercase;
        }
        .hud-aether-bar {
          height: 6px;
          background: rgba(0,0,0,0.6);
          border: 1px solid rgba(200, 145, 60, 0.2);
          border-radius: 1px;
          overflow: hidden;
        }
        .hud-aether-fill {
          height: 100%;
          width: 0%;
          background: #cccccc;
          transition: width 0.3s ease-out, background-color 0.3s ease-out;
        }
        .hud-aether-text {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          font-size: 12px;
          color: rgba(212, 201, 184, 0.82);
          letter-spacing: 0.06em;
        }
        .hud-aether-tier {
          font-weight: bold;
          letter-spacing: 0.12em;
          padding: 1px 5px;
          border-radius: 2px;
          background: rgba(0,0,0,0.4);
          border: 1px solid rgba(200, 145, 60, 0.25);
        }
        /* Activity band — zone-wide hysteretic heat from the activity pool.
         * Sits below the AD readout because they're different signals
         * (AD = local mat tier / lethality; activity = how lived-in the
         * zone is). Named bands per WORLD_STATE_AND_ACTIVITY.md §7.2 —
         * no raw number, no player count, just the mood. */
        .hud-aether-activity {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          font-size: 10px;
          letter-spacing: 0.10em;
          color: rgba(212, 201, 184, 0.55);
        }
        .hud-aether-activity-label {
          text-transform: uppercase;
        }
        .hud-aether-activity-band {
          font-weight: bold;
          letter-spacing: 0.14em;
          color: rgba(160, 160, 160, 0.85);
          transition: color 0.4s ease-out;
        }
        /* Zone boss row — hidden while slumbering (the empty state is
         * the default and doesn't need a label). Visible during windup /
         * engaged / recently_defeated. Same row shape as activity, but
         * the state name is the dramatic content so we give it more
         * weight via color, not size. */
        .hud-aether-boss {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          font-size: 10px;
          letter-spacing: 0.10em;
          color: rgba(212, 201, 184, 0.55);
        }
        .hud-aether-boss-state {
          font-weight: bold;
          letter-spacing: 0.14em;
          color: rgba(255, 200, 120, 0.95);
          transition: color 0.4s ease-out;
        }
      </style>

      <div id="hud-interact-prompt" class="hud-interact-prompt">
        <span id="hud-interact-key" class="hud-interact-key"></span>
        <span id="hud-interact-label" class="hud-interact-label"></span>
      </div>

      <style>
        /* Floating prompt for contextual interactions. Shows a key-cap and an
         * optional label ("Enter Vault", "Hire Console", ...). The label is
         * empty for the harvest fallback — player learns context from the glint
         * + key-cap alone. */
        .hud-interact-prompt {
          position: fixed;
          bottom: 38vh;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          gap: 8px;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.18s ease-out;
          font-family: var(--font-mono);
        }
        .hud-interact-prompt.visible { opacity: 1; }
        .hud-interact-key {
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(20, 14, 8, 0.72);
          border: 1.5px solid rgba(255, 170, 80, 0.65);
          border-radius: 4px;
          color: rgba(255, 230, 200, 1);
          font-size: 16px;
          font-weight: bold;
          letter-spacing: 0.02em;
          text-shadow: 0 1px 2px #000;
          box-shadow: 0 0 8px rgba(255, 170, 80, 0.25);
        }
        .hud-interact-label {
          background: rgba(20, 14, 8, 0.72);
          padding: 4px 10px;
          border: 1px solid rgba(255, 170, 80, 0.35);
          border-radius: 3px;
          color: rgba(255, 230, 200, 0.92);
          font-size: 13px;
          letter-spacing: 0.02em;
          text-shadow: 0 1px 2px #000;
        }
        .hud-interact-label:empty { display: none; }
      </style>
    `;

    this.deathOverlay = el.querySelector<HTMLElement>('#hud-death')!;
    this.deathTimerEl = el.querySelector<HTMLElement>('#hud-death-timer')!;
    this.clockEl      = el.querySelector<HTMLElement>('#hud-clock')!;
    this.fpsEl        = el.querySelector<HTMLElement>('#hud-fps')!;
    this.harvestPromptEl = el.querySelector<HTMLElement>('#hud-interact-prompt')!;
    this.interactKeyEl   = el.querySelector<HTMLElement>('#hud-interact-key')!;
    this.interactLabelEl = el.querySelector<HTMLElement>('#hud-interact-label')!;
    this.interactKeyEl.textContent = INTERACT_KEY_LABEL;
    this.aetherFillEl    = el.querySelector<HTMLElement>('#hud-aether-fill')!;
    this.aetherValueEl   = el.querySelector<HTMLElement>('#hud-aether-value')!;
    this.aetherTierEl    = el.querySelector<HTMLElement>('#hud-aether-tier')!;
    this.activityBandEl  = el.querySelector<HTMLElement>('#hud-aether-activity-band')!;
    this.bossStateRowEl   = el.querySelector<HTMLElement>('#hud-aether-boss-row')!;
    this.bossStateLabelEl = el.querySelector<HTMLElement>('#hud-aether-boss-label')!;
    this.bossStateEl      = el.querySelector<HTMLElement>('#hud-aether-boss-state')!;

    // Release button
    el.querySelector<HTMLButtonElement>('#hud-death-release')!
      .addEventListener('click', () => {
        this.socket.sendRespawn();
      });

    return el;
  }

  private _updateClock(): void {
    if (!this.clockEl) return;

    const t            = this.world.getTimeOfDayNormalized(); // 0–1
    const totalMinutes = Math.floor(t * 24 * 60);
    const h24          = Math.floor(totalMinutes / 60) % 24;
    const min          = totalMinutes % 60;

    const ampm  = h24 < 12 ? 'AM' : 'PM';
    const h12   = h24 % 12 || 12;
    const mm    = String(min).padStart(2, '0');
    const label = `${h12}:${mm} ${ampm}`;

    // ── ToD icon + colour ────────────────────────────────────────────────────
    let icon: string;
    let color: string;
    if      (t >= 0.25 && t < 0.75) { icon = '☀';  color = '#d4c040'; } // day
    else if (t >= 0.75 && t < 0.833){ icon = '◐';  color = '#d07030'; } // dusk
    else if (t >= 0.167 && t < 0.25){ icon = '◑';  color = '#d09040'; } // dawn
    else                             { icon = '☽';  color = '#8090c8'; } // night

    // ── Period label (more granular than the 4 buckets) ──────────────────────
    let period: string;
    if      (h24 >= 20 || h24 <  4) period = 'Night';
    else if (h24 >=  4 && h24 <  6) period = 'Dawn';
    else if (h24 >=  6 && h24 < 10) period = 'Morning';
    else if (h24 >= 10 && h24 < 14) period = 'Midday';
    else if (h24 >= 14 && h24 < 18) period = 'Afternoon';
    else                             period = 'Dusk';

    const iconEl   = this.clockEl.querySelector<HTMLElement>('#hud-clock-icon')!;
    const timeEl   = this.clockEl.querySelector<HTMLElement>('#hud-clock-time')!;
    const periodEl = this.clockEl.querySelector<HTMLElement>('#hud-clock-period')!;
    iconEl.textContent = icon;
    iconEl.style.color = color;
    timeEl.textContent = label;
    periodEl.textContent = `· ${period}`;

    // ── Weather + zone row ───────────────────────────────────────────────────
    const envEl = this.clockEl.querySelector<HTMLElement>('#hud-clock-env')!;
    const zone  = this.world.zone;
    if (zone) {
      const wx    = HUD._weatherLabel(zone.weather);
      const zname = HUD._truncate(zone.name, 22);
      envEl.textContent = `${wx}  ·  ${zname}`;
    } else {
      envEl.textContent = '';
    }

    // ── Climate row: season · day · temp · wind ──────────────────────────────
    const climateEl = this.clockEl.querySelector<HTMLElement>('#hud-clock-climate')!;
    if (zone) {
      const parts: string[] = [];
      const season = HUD._seasonLabel(this.world.season);
      const day    = this.world.dayOfYear ? `Day ${this.world.dayOfYear}` : null;
      if (season) parts.push(season);
      if (day)    parts.push(day);

      const temp = this.world.temperature;
      if (temp != null) parts.push(HUD._tempLabel(temp));

      const wind = this.world.wind;
      if (wind && wind.speed > 0.5) parts.push(HUD._windLabel(wind.speed, wind.direction));

      climateEl.textContent = parts.join('  ·  ');
    } else {
      climateEl.textContent = '';
    }
  }

  /** Season label with a small icon. */
  private static _seasonLabel(season: string): string {
    switch (season) {
      case 'spring': return '✿ Spring';
      case 'summer': return '☀ Summer';
      case 'fall':   return '🍂 Fall';
      case 'winter': return '❄ Winter';
      default:       return '';
    }
  }

  /** Temperature normalised −1 (cold) → 1 (hot) → readable °F-ish label. */
  private static _tempLabel(t: number): string {
    // Map -1..1 onto roughly 0°F..100°F
    const f = Math.round(50 + t * 50);
    return `${f}°`;
  }

  /** Compass arrow + speed. */
  private static _windLabel(speed: number, direction: number): string {
    const arrows = ['↓','↙','←','↖','↑','↗','→','↘']; // 8-way, starting at N (wind FROM N)
    const idx = Math.round(((direction % 360) / 45)) % 8;
    return `${arrows[idx]} ${speed.toFixed(1)}m/s`;
  }

  /** Map weather string to a compact unicode + text label. */
  private static _weatherLabel(weather: string): string {
    switch (weather) {
      case 'clear':  return '✦ Clear';
      case 'cloudy': return '◈ Overcast';
      case 'fog':    return '≋ Foggy';
      case 'mist':   return '≀ Misty';
      case 'rain':   return '⌇ Rain';
      case 'storm':  return '⚡ Storm';
      default:       return weather;
    }
  }

  /** Truncate a string to maxLen chars, appending … if clipped. */
  private static _truncate(s: string, maxLen: number): string {
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
  }

  private _refresh(): void {
    const p = this.player;

    this._setBar('hud-hp-fill',   'hud-hp-text',   p.health,  'HP');
    this._setBar('hud-stam-fill', 'hud-stam-text', p.stamina, 'ST');
    this._setBar('hud-mp-fill',   'hud-mp-text',   p.mana,    'MP');

    // ── Status effects ──────────────────────────────────────────────────────
    this._updateEffects();

    // ── Corruption ─────────────────────────────────────────────────────────
    this._updateCorruption();

    // ── Death overlay ───────────────────────────────────────────────────────
    this._updateDeathOverlay();
  }

  private _updateCorruption(): void {
    const state = this.player.corruptionState;
    const value = this.player.corruption;
    const colors = CORRUPTION_COLORS[state];

    // Fill
    const fillEl = this.root.querySelector<HTMLElement>('#hud-corruption-fill');
    if (fillEl) {
      fillEl.style.background = colors.gradient;
      fillEl.style.transform  = `scaleX(${Math.max(0, Math.min(1, value / 100))})`;
    }

    // Label
    const textEl = this.root.querySelector<HTMLElement>('#hud-corruption-text');
    if (textEl) {
      textEl.textContent = `${state} ${Math.round(value)}`;
      textEl.style.color = colors.label;
    }

    // Tooltip
    const barEl = this.root.querySelector<HTMLElement>('#hud-corruption');
    if (barEl) barEl.title = CORRUPTION_TOOLTIPS[state];

    // Pulse on state change
    if (state !== this._lastCorruptionState) {
      this._lastCorruptionState = state;
      if (barEl) {
        barEl.classList.remove('pulse');
        // Force reflow so re-adding the class restarts the animation
        void barEl.offsetWidth;
        barEl.classList.add('pulse');
      }
    }
  }

  private _updateEffects(): void {
    const buffContainer   = this.root.querySelector<HTMLElement>('#hud-buffs');
    const debuffContainer = this.root.querySelector<HTMLElement>('#hud-debuffs');
    if (!buffContainer || !debuffContainer) return;

    const effects = this.player.effects;
    const buffs   = effects.filter(e => e.type !== 'debuff');
    const debuffs = effects.filter(e => e.type === 'debuff');

    HUD._syncEffectContainer(buffContainer,   buffs,   this._lastBuffCount);
    HUD._syncEffectContainer(debuffContainer, debuffs, this._lastDebuffCount);

    this._lastBuffCount   = buffs.length;
    this._lastDebuffCount = debuffs.length;
  }

  private static _syncEffectContainer(
    container: HTMLElement,
    effects: { id: string; name: string; duration: number; type?: string; description?: string }[],
    lastCount: number,
  ): void {
    if (effects.length === 0) {
      if (container.childElementCount > 0) container.innerHTML = '';
      return;
    }

    if (effects.length !== lastCount) {
      container.innerHTML = '';
      for (const fx of effects) {
        const badge = document.createElement('div');
        badge.className = `hud-effect ${fx.type === 'debuff' ? 'debuff' : 'buff'}`;
        badge.title = fx.description ?? fx.name;
        badge.innerHTML = `
          <span class="hud-effect-name">${HUD._truncate(fx.name, 10)}</span>
          <span class="hud-effect-timer">${HUD._formatDuration(fx.duration)}</span>
        `;
        container.appendChild(badge);
      }
    } else {
      const badges = container.children;
      for (let i = 0; i < effects.length && i < badges.length; i++) {
        const timerEl = (badges[i] as HTMLElement).querySelector<HTMLElement>('.hud-effect-timer');
        if (timerEl) timerEl.textContent = HUD._formatDuration(effects[i]!.duration);
      }
    }
  }

  private static _formatDuration(secs: number): string {
    if (secs < 0) return '0s';
    const s = Math.ceil(secs);
    if (s < 60)   return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  }

  private _updateDeathOverlay(): void {
    if (!this.deathOverlay) return;
    const alive = this.player.isAlive;

    if (!alive) {
      // Fade in (slight delay to let the 3D tendril effect start first)
      requestAnimationFrame(() => {
        this.deathOverlay!.classList.add('visible');
      });

      // Start countdown timer tick
      if (this.timerInterval === null) {
        this.timerInterval = setInterval(() => this._tickTimer(), 1000);
        this._tickTimer(); // Immediate first tick
      }
    } else {
      // Player is alive — hide overlay and stop timer
      this.deathOverlay.classList.remove('visible');
      if (this.timerInterval !== null) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
    }
  }

  private _tickTimer(): void {
    if (!this.deathTimerEl) return;
    const dissolveAt = this.player.corpseDissolvesAt;

    if (dissolveAt === null) {
      this.deathTimerEl.textContent = '';
      return;
    }

    const remaining = Math.max(0, Math.floor((dissolveAt - Date.now()) / 1000));
    if (remaining === 0) {
      this.deathTimerEl.textContent = 'Corpse dissolving…';
      // Client-side auto-release once the timer hits zero
      this.socket.sendRespawn();
      if (this.timerInterval !== null) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
      return;
    }

    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    const hh = h > 0 ? `${h}:` : '';
    const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
    const ss = String(s).padStart(2, '0');
    this.deathTimerEl.textContent = `Corpse dissolves in ${hh}${mm}:${ss}`;
  }

  private _setBar(fillId: string, textId: string, stat: { current: number; max: number }, label: string): void {
    const pct = stat.max > 0 ? stat.current / stat.max : 0;
    this._setFill(fillId, pct);
    // Display int part only — sprint stamina drains by `5 * dt` per tick so
    // `current` carries fractional values; the bar fill stays smooth (uses
    // raw pct above) but the readout shouldn't show "76.43 / 100".
    const textEl = this.root.querySelector<HTMLElement>(`#${textId}`);
    if (textEl) textEl.textContent = `${label} ${Math.floor(stat.current)}/${Math.floor(stat.max)}`;
  }

  private _setFill(id: string, pct: number): void {
    const el = this.root.querySelector<HTMLElement>(`#${id}`);
    if (el) el.style.transform = `scaleX(${Math.max(0, Math.min(1, pct))})`;
  }

  /**
   * Called every frame from the game loop. Updates the FPS counter ~2×/sec.
   * @param entityCount — optional entity count for debug display
   * @param perf — when present and perfMode is on, appended as a second line
   *               with renderer.info + shadow-light count + frame ms
   */
  updateFps(
    now: number,
    entityCount?: number,
    pos?: { x: number; y: number; z: number },
    perf?: PerfSnapshot,
  ): void {
    this._fpsFrames++;
    if (this._fpsTime === 0) { this._fpsTime = now; return; }

    const elapsed = now - this._fpsTime;
    if (elapsed >= 500) {
      const fps = Math.round((this._fpsFrames * 1000) / elapsed);
      let text = `${fps} FPS`;
      if (entityCount !== undefined) text += ` · ${entityCount} ent`;
      if (pos) text += ` · X:${pos.x.toFixed(1)} Y:${pos.y.toFixed(1)} Z:${pos.z.toFixed(1)}`;
      if (this._perfMode && perf) {
        const tris = perf.triangles >= 1000
          ? `${(perf.triangles / 1000).toFixed(1)}k`
          : `${perf.triangles}`;
        // Split frame time into render (renderer.render) and cpu (the rest
        // of the rAF tick — entity update, AI, input, etc). A big cpu line
        // with a small render line means GPU work isn't the bottleneck.
        const cpuMs    = Math.max(0, perf.totalFrameMs - perf.frameMs);
        const sections = perf.topSections.length === 0
          ? ''
          : '\ntop: ' + perf.topSections.map(s => `${s.label} ${s.ms.toFixed(1)}`).join(' · ');
        const camDbg = perf.cameraDebug
          ? `\ncam: ${perf.cameraDebug.candidates} cand · ${perf.cameraDebug.nearby} nearby · broad ${perf.cameraDebug.broadMs.toFixed(2)}ms · narrow ${perf.cameraDebug.narrowMs.toFixed(2)}ms`
          : '';
        text += `\nframe ${perf.totalFrameMs.toFixed(1)}ms = render ${perf.frameMs.toFixed(1)} + cpu ${cpuMs.toFixed(1)}`
              + sections
              + camDbg
              + `\n${perf.drawCalls} draws · ${tris} tri · ${perf.programs} prog · g${perf.geometries} t${perf.textures}`
              + `\n${perf.shadowLights} shadow lights · ${perf.totalLights} lights total`
              + ` · ${perf.indoor ? 'INDOOR' : 'outdoor'}`;
      }
      if (this.fpsEl) this.fpsEl.textContent = text;
      this._fpsFrames = 0;
      this._fpsTime   = now;
    }
  }

  /** F9 toggles the extended GPU readout under the FPS line. */
  togglePerfMode(): boolean {
    this._perfMode = !this._perfMode;
    return this._perfMode;
  }

  get perfMode(): boolean { return this._perfMode; }

  /** Show or hide the contextual harvest prompt above the vitals bar.
   *  Driven from the app render loop based on proximity to a live node.
   *  Harvest is the no-label fallback — the key-cap renders alone. */
  setHarvestPromptVisible(visible: boolean): void {
    if (!this.harvestPromptEl || !this.interactLabelEl) return;
    if (visible) this.interactLabelEl.textContent = '';
    this.harvestPromptEl.classList.toggle('visible', visible);
  }

  /** Show the [F] prompt with a descriptive label next to the key-cap
   *  (e.g. "Enter Vault", "Hire Console"). Pass null label to hide.
   *  Takes precedence over setHarvestPromptVisible — if both want to fire
   *  in a single frame, the app loop calls this first and only falls back
   *  to harvest when no interactable is in range. */
  setInteractPrompt(label: string | null): void {
    if (!this.harvestPromptEl || !this.interactLabelEl) return;
    if (label === null) {
      this.interactLabelEl.textContent = '';
      this.harvestPromptEl.classList.remove('visible');
      return;
    }
    this.interactLabelEl.textContent = label;
    this.harvestPromptEl.classList.add('visible');
  }

  /** Update the Aether Density panel from the server's per-player push.
   *  value is 0..1 (clamped DangerMap output). `lethal` fires when the
   *  player is outside the playable circle — renders a distinct red
   *  "LETHAL" tier so the in-wall T5 plateau (gold) is visibly different
   *  from the past-the-wall damage zone. */
  setAetherDensity(value: number, lethal = false): void {
    if (!this.aetherFillEl || !this.aetherValueEl || !this.aetherTierEl) return;

    const clamped = Math.max(0, Math.min(1, value));
    const tier    = lethal ? 6 : aetherTier(clamped);
    const color   = AETHER_TIER_COLORS[tier] ?? '#cccccc';
    const label   = lethal ? 'LETHAL' : `T${tier}`;

    this.aetherFillEl.style.width = `${(clamped * 100).toFixed(1)}%`;
    this.aetherFillEl.style.background = color;
    this.aetherValueEl.textContent = clamped.toFixed(2);
    this.aetherTierEl.textContent  = label;
    this.aetherTierEl.style.color  = color;
  }

  /** Update the activity-band readout from the server's per-zone hysteretic
   *  heat value (0..1, piggy-backed onto the aether_density push).
   *  Named bands rather than numbers — players read "the zone is bustling"
   *  not "0.74" (per WORLD_STATE_AND_ACTIVITY.md §7.2). */
  setActivityHeat(heat: number): void {
    if (!this.activityBandEl) return;
    const band = activityBand(Math.max(0, Math.min(1, heat)));
    this.activityBandEl.textContent = band.label;
    this.activityBandEl.style.color = band.color;
  }

  /** Update the zone-boss state row. Hides the row entirely while
   *  slumbering (default state — no need to advertise "nothing's
   *  happening"); shows + colors it during windup / engaged /
   *  recently_defeated / zone_lost. The row label itself switches
   *  framing in zone_lost — the threat is no longer the subject; the
   *  town is. */
  setZoneBossState(state: string): void {
    if (!this.bossStateRowEl || !this.bossStateEl || !this.bossStateLabelEl) return;
    const shape = zoneBossDisplay(state);
    if (!shape) {
      this.bossStateRowEl.style.display = 'none';
      return;
    }
    this.bossStateRowEl.style.display = 'flex';
    this.bossStateLabelEl.textContent = shape.rowLabel;
    this.bossStateEl.textContent = shape.stateLabel;
    this.bossStateEl.style.color = shape.color;
  }
}

// ── Aether Density tier mapping ─────────────────────────────────────────
// Mirrors NodePool's tier roll on the server (see project_nodepool_harvest.md).
// Player reads the band off the HUD bar to know what mats can be farmed.
function aetherTier(density: number): number {
  if (density < 0.2) return 1;
  if (density < 0.4) return 2;
  if (density < 0.6) return 3;
  if (density < 0.8) return 4;
  return 5;
}
const AETHER_TIER_COLORS: Record<number, string> = {
  1: '#cccccc', // silver — civic, safe
  2: '#66ff66', // green
  3: '#4ea0ff', // blue
  4: '#c060ff', // purple
  5: '#ffcc44', // gold — deep, brave or dead
  6: '#ff3030', // red — lethal, past the wall
};

// ── Activity band mapping (zone-wide heat → mood label) ────────────────
// Slight offset on the low end (< 0.15 vs the doc's 0.25) so a brief
// warm-up from a couple of kills doesn't immediately flip to "steady".
function activityBand(heat: number): { label: string; color: string } {
  if (heat < 0.15) return { label: 'QUIET',    color: 'rgba(160,160,160,0.75)' }; // dormant, restful
  if (heat < 0.40) return { label: 'STEADY',   color: '#7ac8c8' };                // pale teal
  if (heat < 0.65) return { label: 'BUSY',     color: '#ddc060' };                // warm yellow
  if (heat < 0.85) return { label: 'BUSTLING', color: '#ff9040' };                // orange
  return                  { label: 'BOILING',  color: '#ff5530' };                // hot — every spawn is elite
}

// ── Zone boss state mapping ─────────────────────────────────────────────
// Maps the server's ZoneBossState enum to display text + color. Returns
// null for 'slumbering' so the HUD hides the row entirely.
//
// Note the rowLabel swap on 'zone_lost' — when the town is gone, the
// row is no longer about the boss. "ZONE BOSS: FALLEN" reads exactly
// backwards (it sounds like the boss fell = victory). So the row's
// subject changes too: TOWNHALL: DESTROYED.
function zoneBossDisplay(state: string): { rowLabel: string; stateLabel: string; color: string } | null {
  switch (state) {
    case 'windup':            return { rowLabel: 'ZONE BOSS', stateLabel: 'STIRRING',  color: '#ffb060' }; // amber — countdown
    case 'engaged':           return { rowLabel: 'ZONE BOSS', stateLabel: 'AWAKE',     color: '#ff4030' }; // hot red — fight in progress
    case 'recently_defeated': return { rowLabel: 'ZONE BOSS', stateLabel: 'DEFEATED',  color: '#7ad080' }; // green — victory
    case 'zone_lost':         return { rowLabel: 'TOWNHALL',  stateLabel: 'DESTROYED', color: '#a04050' }; // muted red — town fell
    case 'slumbering':
    default:                  return null;                                                                 // hide row
  }
}

/** Per-frame perf snapshot fed into HUD.updateFps for the F9 overlay. */
export interface PerfSnapshot {
  /** Time spent inside renderer.render() + nameplate CSS render. */
  frameMs:      number;
  /** Wall-clock between rAF callbacks. (Total - frameMs) is CPU JS time
   *  outside the render call (entity ticks, AI, click-move, etc).
   *  When that gap dwarfs frameMs, the bottleneck is CPU, not GPU. */
  totalFrameMs: number;
  drawCalls:    number;
  triangles:    number;
  programs:     number;
  geometries:   number;
  textures:     number;
  shadowLights: number;
  totalLights:  number;
  indoor:       boolean;
  /** Top per-section CPU times (EMA-smoothed ms), descending. The 'render'
   *  section is included so it can be seen against the others. */
  topSections:  Array<{ label: string; ms: number }>;
  /** Camera spring-arm diagnostics — populated when F9 is on. */
  cameraDebug?: {
    candidates: number;  // total in _collisionCandidates
    nearby:     number;  // last frame's broad-phase result
    broadMs:    number;  // EMA ms of broad phase
    narrowMs:   number;  // EMA ms of intersectObjects
  };
}
