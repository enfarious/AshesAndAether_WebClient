/**
 * Minimap — circular canvas-based minimap in the top-right corner.
 *
 * Shows the player arrow at center (rotates with heading, north-up),
 * nearby entities as colored dots, distance rings, and a zone name label.
 * Redrawn at ~10 fps via setInterval.
 */

import type { PlayerState }    from '@/state/PlayerState';
import type { EntityRegistry } from '@/state/EntityRegistry';
import type { WorldState }     from '@/state/WorldState';
import type { Entity }         from '@/network/Protocol';

// ── Constants ────────────────────────────────────────────────────────────────

/** View radius in world metres. */
const VIEW_RADIUS   = 80;

/** Canvas pixel diameter. */
const CANVAS_SIZE   = 160;

/** Half canvas — center point in pixels. */
const HALF          = CANVAS_SIZE / 2;

/** Redraw interval in ms (~10 fps). */
const DRAW_INTERVAL = 100;

/** Entity dot radius in pixels. */
const DOT_RADIUS    = 3.5;

/** Player arrow half-size in pixels. */
const ARROW_SIZE    = 7;

// ── Minimap ──────────────────────────────────────────────────────────────────

export class Minimap {
  private root:      HTMLElement;
  private canvas!:   HTMLCanvasElement;
  private ctx!:      CanvasRenderingContext2D;
  private zoneLabel!: HTMLElement;
  private cleanup:   (() => void)[] = [];
  private drawTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly uiRoot:   HTMLElement,
    private readonly player:   PlayerState,
    private readonly entities: EntityRegistry,
    private readonly world:    WorldState,
  ) {
    this.root = document.createElement('div');
    this._injectStyles();
    this._buildDOM();
    this.uiRoot.appendChild(this.root);

    const unsubZone = this.world.onZoneChange(() => this._updateZoneLabel());
    this.cleanup.push(unsubZone);
    this._updateZoneLabel();

    this.drawTimer = setInterval(() => this._draw(), DRAW_INTERVAL);
    this._draw();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  show(): void { this.root.style.display = ''; }
  hide(): void { this.root.style.display = 'none'; }

  dispose(): void {
    this.cleanup.forEach(fn => fn());
    if (this.drawTimer !== null) clearInterval(this.drawTimer);
    this.root.remove();
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  private _injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      #minimap {
        position: fixed;
        top: 100px;
        right: 18px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        pointer-events: none;
        z-index: 50;
      }

      #minimap-frame {
        width: ${CANVAS_SIZE}px;
        height: ${CANVAS_SIZE}px;
        border-radius: 50%;
        overflow: hidden;
        border: 1px solid rgba(200, 145, 60, 0.30);
        box-shadow:
          0 2px 12px rgba(0, 0, 0, 0.6),
          inset 0 0 20px rgba(0, 0, 0, 0.4);
        position: relative;
      }

      #minimap-canvas {
        width: 100%;
        height: 100%;
        display: block;
      }

      #minimap-zone {
        font-family: var(--font-mono);
        font-size: 11px;
        color: rgba(212, 201, 184, 0.55);
        letter-spacing: 0.08em;
        text-shadow: 0 1px 3px #000;
        text-align: center;
        max-width: ${CANVAS_SIZE + 20}px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  private _buildDOM(): void {
    this.root.id = 'minimap';

    const frame = document.createElement('div');
    frame.id = 'minimap-frame';

    this.canvas = document.createElement('canvas');
    this.canvas.id     = 'minimap-canvas';
    this.canvas.width  = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.ctx = this.canvas.getContext('2d')!;

    frame.appendChild(this.canvas);
    this.root.appendChild(frame);

    this.zoneLabel = document.createElement('div');
    this.zoneLabel.id = 'minimap-zone';
    this.root.appendChild(this.zoneLabel);
  }

  // ── Draw pipeline ──────────────────────────────────────────────────────────

  private _draw(): void {
    const ctx = this.ctx;
    const cx  = HALF;
    const cy  = HALF;
    const r   = HALF - 1;

    // 1. Background
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 5, 3, 0.85)';
    ctx.fill();

    // 2. Distance rings
    this._drawDistanceRings(ctx, cx, cy, r);

    // 3. Cardinal cross-hairs
    this._drawCardinalLines(ctx, cx, cy, r);

    // 4. Entity dots
    const playerPos = this.player.position;
    const allEntities = this.entities.getAll();
    const playerId    = this.entities.playerId;
    const scale       = r / VIEW_RADIUS;

    for (const entity of allEntities) {
      if (entity.id === playerId) continue;
      if (entity.type === 'plant') continue;

      const dx   = entity.position.x - playerPos.x;
      const dz   = entity.position.z - playerPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > VIEW_RADIUS) continue;

      // World X → canvas X, world +Z = South → canvas down
      const px = cx + dx * scale;
      const py = cy + dz * scale;

      ctx.beginPath();
      ctx.arc(px, py, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = Minimap._dotColor(entity);
      ctx.fill();
    }

    // 5. Player arrow at center
    this._drawPlayerArrow(ctx, cx, cy);

    // 6. North indicator
    this._drawNorthIndicator(ctx, cx, cy, r);

    // 7. Compass border ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(200, 145, 60, 0.18)';
    ctx.lineWidth   = 1;
    ctx.stroke();
  }

  // ── Drawing helpers ────────────────────────────────────────────────────────

  private _drawDistanceRings(
    ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number,
  ): void {
    ctx.strokeStyle = 'rgba(200, 145, 60, 0.06)';
    ctx.lineWidth   = 1;

    ctx.beginPath();
    ctx.arc(cx, cy, r / 3, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, (r * 2) / 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  private _drawCardinalLines(
    ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number,
  ): void {
    ctx.strokeStyle = 'rgba(200, 145, 60, 0.04)';
    ctx.lineWidth   = 1;

    // N-S
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();

    // E-W
    ctx.beginPath();
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.stroke();
  }

  private _drawPlayerArrow(
    ctx: CanvasRenderingContext2D, cx: number, cy: number,
  ): void {
    const heading = this.player.heading;
    // Heading: 0 = +Z = South (down on map), increases clockwise.
    // Canvas rotation: 0 = right (+X), increases clockwise.
    // heading 0 → South → down → canvas 90°, so: angle = 90 - heading
    const angle = (90 - heading) * (Math.PI / 180);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // Chevron/dart: tip at +X, notched tail
    ctx.beginPath();
    ctx.moveTo(ARROW_SIZE, 0);
    ctx.lineTo(-ARROW_SIZE * 0.6, -ARROW_SIZE * 0.55);
    ctx.lineTo(-ARROW_SIZE * 0.3, 0);
    ctx.lineTo(-ARROW_SIZE * 0.6,  ARROW_SIZE * 0.55);
    ctx.closePath();

    ctx.fillStyle   = '#e0d8c8';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth   = 1;
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  private _drawNorthIndicator(
    ctx: CanvasRenderingContext2D, cx: number, _cy: number, r: number,
  ): void {
    ctx.font         = 'bold 11px var(--font-mono, monospace)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle    = 'rgba(200, 145, 60, 0.7)';
    ctx.fillText('N', cx, HALF - r + 12);
  }

  // ── Zone label ─────────────────────────────────────────────────────────────

  private _updateZoneLabel(): void {
    const zone = this.world.zone;
    this.zoneLabel.textContent = zone ? zone.name : '';
  }

  // ── Entity colors ──────────────────────────────────────────────────────────

  private static _dotColor(entity: Entity): string {
    const type = entity.type?.toLowerCase() ?? '';
    if (type === 'player')    return '#4488ff';
    if (type === 'companion') return '#44cc66';
    if (type === 'npc')       return '#44cc66';
    if (entity.hostile)       return '#dd3333';
    if (type === 'mob')       return '#ddaa22';
    if (type === 'wildlife')  return '#c8a870';
    return '#888888';
  }
}
