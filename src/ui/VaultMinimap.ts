/**
 * VaultMinimap — top-down vault layout in the same UI slot as the overworld
 * Minimap. Replaces the circular compass while inside a `vault:` zone.
 *
 * Renders the entire vault grid scaled-to-fit a square canvas: walls dark,
 * floor light, gates light once opened (the renderer mutates its own tile
 * data on `vault_gate_opened`, and we read straight from it).
 *
 * Highlights:
 *   - Player as oriented arrow at the live (server-authoritative) position.
 *   - Active room (last `vault_room_enter`) — soft amber tint.
 *   - Cleared rooms — green check overlay.
 *   - Boss room — red tint, always visible once revealed.
 *   - Exit portal — bright marker, post-`vault_complete`.
 */

import type { PlayerState }      from '@/state/PlayerState';
import type { MessageRouter }    from '@/network/MessageRouter';
import type { VaultRenderer, VaultTileData } from '@/world/VaultRenderer';
import type {
  VaultRoomEnterPayload,
  VaultRoomClearedPayload,
  VaultCompletePayload,
} from '@/network/Protocol';

// ── Constants ────────────────────────────────────────────────────────────────

/** Outer canvas dimension. Matches overworld Minimap so the corner slot
 *  stays consistent when swapping between them. */
const CANVAS_SIZE = 160;

/** Inner padding (px) so the layout never touches the frame edge. */
const MARGIN      = 6;

/** ~10 fps redraw — only the player arrow moves; cheap enough to do this way. */
const DRAW_INTERVAL = 100;

/** Player arrow half-size (px). */
const ARROW_SIZE = 6;

// Tile color palette — calibrated for low-light vault aesthetic.
const COLOR_BG       = 'rgba(6, 5, 3, 0.85)';
const COLOR_FLOOR    = 'rgba(180, 165, 140, 0.55)';
const COLOR_WALL     = 'rgba(70, 60, 48, 0.85)';
const COLOR_ACTIVE   = 'rgba(220, 180, 90, 0.18)';
const COLOR_CLEARED  = 'rgba(120, 200, 120, 0.18)';
const COLOR_BOSS     = 'rgba(220, 80, 80, 0.22)';
const COLOR_EXIT     = 'rgba(140, 240, 200, 1.0)';

const FLOOR = 1;
const WALL  = 2;

// ── VaultMinimap ─────────────────────────────────────────────────────────────

export class VaultMinimap {
  private root:    HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!:    CanvasRenderingContext2D;
  private nameEl!: HTMLElement;

  private cleanup:   (() => void)[] = [];
  private drawTimer: ReturnType<typeof setInterval> | null = null;

  /** roomIndex of the room the player most recently entered. */
  private activeRoom: number | null = null;
  /** roomIndex of the boss room — populated by `vault_room_enter` with
   *  isBossRoom=true (we can't infer it from tileData alone). */
  private bossRoom:   number | null = null;
  /** Set of cleared room indices. */
  private clearedRooms = new Set<number>();
  /** World-space exit portal once the vault completes. null while in progress. */
  private exitPortal: { x: number; z: number } | null = null;

  /** Cached scale + origin for grid → canvas. Recomputed on tile data load. */
  private _scale     = 1;
  private _gridHalfW = 0;
  private _gridHalfH = 0;

  constructor(
    private readonly uiRoot:   HTMLElement,
    private readonly player:   PlayerState,
    private readonly renderer: VaultRenderer,
    private readonly router:   MessageRouter,
    private readonly vaultName: string,
  ) {
    this.root = document.createElement('div');
    this._injectStyles();
    this._buildDOM();
    this.uiRoot.appendChild(this.root);

    this._recomputeScale();

    this.cleanup.push(this.router.onVaultRoomEnter((p) => this._onRoomEnter(p)));
    this.cleanup.push(this.router.onVaultRoomCleared((p) => this._onRoomCleared(p)));
    this.cleanup.push(this.router.onVaultGateOpened(() => {
      // Renderer has already mutated its tile data; force a redraw next tick.
      // No state of our own to update.
    }));
    this.cleanup.push(this.router.onVaultComplete((p) => this._onComplete(p)));

    this.drawTimer = setInterval(() => this._draw(), DRAW_INTERVAL);
    this._draw();
  }

  dispose(): void {
    this.cleanup.forEach((fn) => fn());
    if (this.drawTimer !== null) clearInterval(this.drawTimer);
    this.root.remove();
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  private _onRoomEnter(p: VaultRoomEnterPayload): void {
    this.activeRoom = p.roomIndex;
    if (p.isBossRoom) this.bossRoom = p.roomIndex;
  }

  private _onRoomCleared(p: VaultRoomClearedPayload): void {
    this.clearedRooms.add(p.roomIndex);
  }

  private _onComplete(p: VaultCompletePayload): void {
    if (p.exitPortal) {
      this.exitPortal = { x: p.exitPortal.position.x, z: p.exitPortal.position.z };
    }
  }

  // ── Coordinate math ────────────────────────────────────────────────────────

  private _recomputeScale(): void {
    const data = this.renderer.tileData;
    if (!data) return;
    this._gridHalfW = (data.width  * data.tileSize) / 2;
    this._gridHalfH = (data.height * data.tileSize) / 2;
    const half = Math.max(this._gridHalfW, this._gridHalfH);
    this._scale = (CANVAS_SIZE / 2 - MARGIN) / half;
  }

  /** World (x, z) → canvas pixel. World +Z is south = canvas down (no flip). */
  private _w2cX(x: number): number { return CANVAS_SIZE / 2 + x * this._scale; }
  private _w2cZ(z: number): number { return CANVAS_SIZE / 2 + z * this._scale; }

  // ── Draw pipeline ──────────────────────────────────────────────────────────

  private _draw(): void {
    const data = this.renderer.tileData;
    if (!data) {
      // Renderer hasn't built yet — clear and bail.
      this.ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      return;
    }

    // Recompute scale lazily — handles vault zone changes on the same renderer.
    if (this._gridHalfW === 0 || this._gridHalfH === 0) this._recomputeScale();

    const ctx = this.ctx;

    // Background
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Tiles
    this._drawTiles(ctx, data);

    // Room overlays (active / cleared / boss). Stacks over tiles, under player.
    this._drawRoomOverlays(ctx, data);

    // Exit portal (post-completion)
    if (this.exitPortal) {
      this._drawExitPortal(ctx);
    }

    // Player arrow
    this._drawPlayerArrow(ctx);

    // Border
    ctx.strokeStyle = 'rgba(200, 145, 60, 0.18)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(0.5, 0.5, CANVAS_SIZE - 1, CANVAS_SIZE - 1);
  }

  private _drawTiles(ctx: CanvasRenderingContext2D, data: VaultTileData): void {
    const { width, height, tileSize, tiles } = data;
    // Each tile spans tileSize world metres → tileSize * scale px.
    const pxPerTile = tileSize * this._scale;
    // Tile (col,row) world position (from VaultTileGrid.tileToWorld):
    //   x = (col - width/2 + 0.5) * tileSize
    //   z = (row - height/2 + 0.5) * tileSize
    // We draw the tile as a square centred on that point.
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const t = tiles[row * width + col];
        if (t !== FLOOR && t !== WALL) continue;
        const wx = (col - width  / 2 + 0.5) * tileSize;
        const wz = (row - height / 2 + 0.5) * tileSize;
        const px = this._w2cX(wx);
        const pz = this._w2cZ(wz);
        ctx.fillStyle = (t === FLOOR) ? COLOR_FLOOR : COLOR_WALL;
        ctx.fillRect(px - pxPerTile / 2, pz - pxPerTile / 2, pxPerTile + 1, pxPerTile + 1);
      }
    }
  }

  private _drawRoomOverlays(ctx: CanvasRenderingContext2D, data: VaultTileData): void {
    const centers = data.roomCenters;
    const sizes   = data.roomSizes;
    if (!centers || !sizes) return;

    for (let i = 0; i < centers.length; i++) {
      const c = centers[i];
      const s = sizes[i];
      if (!c || !s) continue;

      const wPx = s.width  * this._scale;
      const hPx = s.height * this._scale;
      const xPx = this._w2cX(c.x) - wPx / 2;
      const zPx = this._w2cZ(c.z) - hPx / 2;

      // Stack: cleared first (subtle base tint), then active highlight on top
      // so re-entering a cleared room still glows as active.
      if (this.clearedRooms.has(i)) {
        ctx.fillStyle = COLOR_CLEARED;
        ctx.fillRect(xPx, zPx, wPx, hPx);
      }
      if (i === this.bossRoom) {
        ctx.fillStyle = COLOR_BOSS;
        ctx.fillRect(xPx, zPx, wPx, hPx);
      }
      if (i === this.activeRoom) {
        ctx.fillStyle = COLOR_ACTIVE;
        ctx.fillRect(xPx, zPx, wPx, hPx);
      }
    }
  }

  private _drawExitPortal(ctx: CanvasRenderingContext2D): void {
    if (!this.exitPortal) return;
    const px = this._w2cX(this.exitPortal.x);
    const pz = this._w2cZ(this.exitPortal.z);
    ctx.fillStyle = COLOR_EXIT;
    ctx.beginPath();
    ctx.arc(px, pz, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth   = 1;
    ctx.stroke();
  }

  private _drawPlayerArrow(ctx: CanvasRenderingContext2D): void {
    const pos = this.player.position;
    const px  = this._w2cX(pos.x);
    const pz  = this._w2cZ(pos.z);

    // Heading: 0 = +Z = south = canvas down; clockwise increasing.
    // Canvas rotation: 0 = +X = right; clockwise increasing.
    // So canvas angle = 90 - heading (degrees), to turn the chevron tip in
    // the direction the player is facing.
    const angle = (90 - this.player.heading) * (Math.PI / 180);

    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(angle);

    ctx.beginPath();
    ctx.moveTo(ARROW_SIZE, 0);
    ctx.lineTo(-ARROW_SIZE * 0.6, -ARROW_SIZE * 0.55);
    ctx.lineTo(-ARROW_SIZE * 0.3, 0);
    ctx.lineTo(-ARROW_SIZE * 0.6,  ARROW_SIZE * 0.55);
    ctx.closePath();
    ctx.fillStyle   = '#e0d8c8';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.lineWidth   = 1;
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  // ── DOM / styles ───────────────────────────────────────────────────────────

  private _injectStyles(): void {
    // Re-inject is harmless — id-guarded.
    if (document.getElementById('vault-minimap-style')) return;
    const style = document.createElement('style');
    style.id = 'vault-minimap-style';
    style.textContent = `
      #vault-minimap {
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
      #vault-minimap-frame {
        width: ${CANVAS_SIZE}px;
        height: ${CANVAS_SIZE}px;
        border: 1px solid rgba(200, 145, 60, 0.30);
        box-shadow:
          0 2px 12px rgba(0, 0, 0, 0.6),
          inset 0 0 18px rgba(0, 0, 0, 0.45);
        background: #06050a;
      }
      #vault-minimap-canvas {
        width: 100%;
        height: 100%;
        display: block;
      }
      #vault-minimap-name {
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

  private _buildDOM(): void {
    this.root.id = 'vault-minimap';

    const frame = document.createElement('div');
    frame.id = 'vault-minimap-frame';

    this.canvas = document.createElement('canvas');
    this.canvas.id     = 'vault-minimap-canvas';
    this.canvas.width  = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.ctx = this.canvas.getContext('2d')!;

    frame.appendChild(this.canvas);
    this.root.appendChild(frame);

    this.nameEl = document.createElement('div');
    this.nameEl.id          = 'vault-minimap-name';
    this.nameEl.textContent = this.vaultName;
    this.root.appendChild(this.nameEl);
  }
}
