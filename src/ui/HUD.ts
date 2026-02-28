import type { PlayerState } from '@/state/PlayerState';

/**
 * HUD — vitals bars, combat gauges, target display.
 * Pure HTML/CSS over the canvas. Three.js is not involved here.
 */
export class HUD {
  private root: HTMLElement;
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly uiRoot: HTMLElement,
    private readonly player: PlayerState,
  ) {
    this.root = this._build();
    uiRoot.appendChild(this.root);

    const unsub = player.onChange(() => this._refresh());
    this.cleanup.push(unsub);
    this._refresh();
  }

  show(): void { this.root.style.display = ''; }
  hide(): void { this.root.style.display = 'none'; }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
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
          left: 50%;
          transform: translateX(-50%);
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
          height: 18px;
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
          font-size: 10px;
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
          height: 6px;
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
          font-size: 13px;
          color: var(--ember);
          letter-spacing: 0.08em;
          font-style: italic;
          text-shadow: 0 1px 4px rgba(0,0,0,0.8);
        }
      </style>

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
    return el;
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
