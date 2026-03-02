import type { PlayerState }  from '@/state/PlayerState';
import type { WorldState }   from '@/state/WorldState';
import type { SocketClient } from '@/network/SocketClient';

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
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly uiRoot:  HTMLElement,
    private readonly player:  PlayerState,
    private readonly socket:  SocketClient,
    private readonly world:   WorldState,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    const unsubPlayer = player.onChange(() => this._refresh());
    const unsubZone   = world.onZoneChange(() => this._updateClock());
    this.cleanup.push(unsubPlayer, unsubZone);

    // Tick the clock every second (≈ 1 in-game minute).
    this.clockInterval = setInterval(() => this._updateClock(), 1_000);

    this._refresh();
    this._updateClock();
  }

  show(): void { this.root.style.display = ''; }
  hide(): void { this.root.style.display = 'none'; }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    if (this.timerInterval !== null) clearInterval(this.timerInterval);
    if (this.clockInterval !== null) clearInterval(this.clockInterval);
    this.root.remove();
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

        .hud-target {
          font-family: var(--font-body);
          font-size: 17px;
          color: var(--ember);
          letter-spacing: 0.08em;
          font-style: italic;
          text-shadow: 0 1px 4px rgba(0,0,0,0.8);
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
      </style>

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

      <div class="hud-target" id="hud-target"></div>

      <div id="hud-combat" class="hud-combat" style="display:none">
        <div class="hud-atb" title="ATB">
          <div class="hud-atb-fill" id="hud-atb-fill"></div>
        </div>
        <div class="hud-atb" title="Auto Attack">
          <div class="hud-atb-fill" id="hud-aa-fill" style="background: linear-gradient(90deg, #4a2a10, #c85a20)"></div>
        </div>
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
    `;

    this.deathOverlay = el.querySelector<HTMLElement>('#hud-death')!;
    this.deathTimerEl = el.querySelector<HTMLElement>('#hud-death-timer')!;
    this.clockEl      = el.querySelector<HTMLElement>('#hud-clock')!;

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

    const targetEl = this.root.querySelector<HTMLElement>('#hud-target')!;
    targetEl.textContent = p.targetName ? `⟨ ${p.targetName} ⟩` : '';

    // ── Death overlay ───────────────────────────────────────────────────────
    this._updateDeathOverlay();
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
}
