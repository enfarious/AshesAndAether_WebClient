import type { PlayerState }  from '@/state/PlayerState';
import type { WorldState }   from '@/state/WorldState';
import type { SocketClient } from '@/network/SocketClient';
import type { CorruptionState } from '@/network/Protocol';

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
  private _fpsFrames = 0;
  private _fpsTime   = 0;

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

        .hud-combat {
          display: flex;
          gap: 6px;
          width: 100%;
        }

        .hud-atb {
          flex: 1;
          height: 10px;
          background: rgba(10,8,6,0.7);
          border: 1px solid rgba(74,127,165,0.3);
          position: relative;
          overflow: hidden;
        }

        .hud-atb-fill {
          position: absolute;
          inset: 0;
          transform-origin: left;
          background: linear-gradient(90deg, #1a3a5a, #4a7fa5);
          transition: transform 0.15s linear;
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

      <div id="hud-combat" class="hud-combat" style="display:none">
        <div class="hud-atb" title="ATB">
          <div class="hud-atb-fill" id="hud-atb-fill"></div>
        </div>
        <div class="hud-atb" title="Auto Attack">
          <div class="hud-atb-fill" id="hud-aa-fill" style="background: linear-gradient(90deg, #4a2a10, #c85a20)"></div>
        </div>
      </div>

      <div id="hud-effects-wrapper">
        <div id="hud-buffs"></div>
        <div id="hud-debuffs"></div>
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
    `;

    this.deathOverlay = el.querySelector<HTMLElement>('#hud-death')!;
    this.deathTimerEl = el.querySelector<HTMLElement>('#hud-death-timer')!;
    this.clockEl      = el.querySelector<HTMLElement>('#hud-clock')!;
    this.fpsEl        = el.querySelector<HTMLElement>('#hud-fps')!;

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

    const combat = p.combat;
    const combatEl = this.root.querySelector<HTMLElement>('#hud-combat')!;
    combatEl.style.display = combat.inCombat ? '' : 'none';

    if (combat.atb) {
      const pct = combat.atb.max > 0 ? combat.atb.current / combat.atb.max : 0;
      this._setFill('hud-atb-fill', pct);
    }
    if (combat.autoAttack) {
      const pct = combat.autoAttack.max > 0 ? combat.autoAttack.current / combat.autoAttack.max : 0;
      this._setFill('hud-aa-fill', pct);
    }

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
    const textEl = this.root.querySelector<HTMLElement>(`#${textId}`);
    if (textEl) textEl.textContent = `${label} ${stat.current}/${stat.max}`;
  }

  private _setFill(id: string, pct: number): void {
    const el = this.root.querySelector<HTMLElement>(`#${id}`);
    if (el) el.style.transform = `scaleX(${Math.max(0, Math.min(1, pct))})`;
  }

  /**
   * Called every frame from the game loop. Updates the FPS counter ~2×/sec.
   * @param entityCount — optional entity count for debug display
   */
  updateFps(now: number, entityCount?: number): void {
    this._fpsFrames++;
    if (this._fpsTime === 0) { this._fpsTime = now; return; }

    const elapsed = now - this._fpsTime;
    if (elapsed >= 500) {
      const fps = Math.round((this._fpsFrames * 1000) / elapsed);
      let text = `${fps} FPS`;
      if (entityCount !== undefined) text += ` · ${entityCount} ent`;
      if (this.fpsEl) this.fpsEl.textContent = text;
      this._fpsFrames = 0;
      this._fpsTime   = now;
    }
  }
}
