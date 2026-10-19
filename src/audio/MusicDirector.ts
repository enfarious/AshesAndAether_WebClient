import { ClientConfig } from '@/config/ClientConfig';

/**
 * MusicDirector — web twin of the UE client's AA_MusicSubsystem.
 *
 * Twice a second it reads the moment (zone, where you stand, ward anchors,
 * aether density, time of day, nearby bosses) and picks a state. A state has
 * to hold for a moment before the music follows (no flapping at a ward's
 * edge), except a boss pull, which cuts in fast.
 *
 *   Ambient  (town, night, Albany, travel, aether, reaver camp, vault) play
 *            once, then a quiet stretch (Music frequency setting), then again
 *            if the state still holds.
 *   Driving  (title, boss, defense) loop — crossfaded into a fresh copy a few
 *            seconds before the end, so there's no gap.
 *
 * Tracks: <server>/world/assets/audio/music/MUS_<Name>.mp3 (the same masters
 * as the UE client's /Game/Audio/Music, loudness-matched by
 * SourceArt/Tools/aa_music_prep.py). Settings live in localStorage beside the
 * Audio tab's other sliders; volume = master × music.
 *
 * Browsers only start audio after a user gesture — the login click is the
 * first one, so title music begins once you've clicked anything.
 */

export type MusicState =
  | 'none' | 'title' | 'town' | 'townNight' | 'albany' | 'travel' | 'aether'
  | 'reaverCamp' | 'vaultExplore' | 'vaultBoss' | 'defense';

/** What the director reads each tick (wired by app.ts). */
export interface MusicContext {
  inWorld(): boolean;
  zoneId(): string;
  playerId(): string | null;
  playerXZ(): { x: number; z: number } | null;
  /** Entities known to the client (server shape: type, position, tag, bossKind…). */
  entities(): ReadonlyArray<{
    id: string; type: string; position: { x: number; z: number };
    tag?: string; bossKind?: string; notorious?: boolean; combatTargetId?: string | null;
  }>;
  /** Civic ward anchors (server metres). Empty = beaconless zone (or not loaded yet). */
  wardAnchors(): ReadonlyArray<{ x: number; z: number; r: number }>;
  isVillage(): boolean;
  timeOfDay(): number;       // 0..1, 0.25 = 06:00
  aetherDensity(): number;   // server AD at the player, 0..1
}

// ── Settings (localStorage, beside the Audio tab's master / sfx keys) ───────

export const KEY_MUSIC_VOL  = 'aa_music_volume';
export const KEY_MUSIC_FREQ = 'aa_music_frequency';
const KEY_MASTER_VOL = 'aa_master_volume';
export const DEF_MUSIC_VOL  = 60;
export const DEF_MUSIC_FREQ = 2;
export const MUSIC_FREQ_OPTIONS = [
  { value: '0', label: 'Always' },
  { value: '1', label: 'Often' },
  { value: '2', label: 'Normal' },
  { value: '3', label: 'Sparse' },
];

function readNum(key: string, def: number): number {
  try {
    const v = localStorage.getItem(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : def;
  } catch { return def; }
}

// ── Tuning (mirrors AA_MusicSubsystem.cpp) ──────────────────────────────────

const TICK_MS           = 500;
const BOSS_RANGE_M      = 70;
const BOSS_LINGER_S     = 8;
const REAVER_CAMP_M     = 60;
const WARD_MARGIN_M     = 10;
const AETHER_DEEP_AD    = 0.8;
const LOOP_OVERLAP_S    = 4;
const GAPS: Array<[number, number]> = [[2, 4], [15, 40], [45, 120], [120, 300]];

const ASSET: Record<Exclude<MusicState, 'none'>, string> = {
  title: 'MUS_Title', town: 'MUS_Town', townNight: 'MUS_TownNight', albany: 'MUS_Albany',
  travel: 'MUS_Travel', aether: 'MUS_Aether', reaverCamp: 'MUS_ReaverCamp',
  vaultExplore: 'MUS_VaultExplore', vaultBoss: 'MUS_VaultBoss', defense: 'MUS_Defense',
};

const isDriving = (s: MusicState): boolean => s === 'title' || s === 'vaultBoss' || s === 'defense';
/** Town, night and Albany are one family: a day/night flip lets the track finish. */
const family = (s: MusicState): string => (s === 'town' || s === 'townNight' || s === 'albany') ? 'town' : s;

function holdSeconds(to: MusicState): number {
  switch (to) {
    case 'title': case 'vaultBoss': case 'defense': return 0.5;
    case 'vaultExplore': return 1;
    case 'travel': return 5;
    case 'aether': return 6;   // also rides out the anchor fetch on zone load
    default: return 3;
  }
}

/** One playing track with its own fade. */
class Voice {
  readonly el: HTMLAudioElement;
  private fade = 0;          // 0..1
  private target = 0;
  private rate = 1;          // fade units / s
  private last = performance.now();
  done = false;

  constructor(readonly state: MusicState, url: string, private gain: () => number) {
    this.el = new Audio(url);
    this.el.preload = 'auto';
    this.el.volume = 0;
    this.el.addEventListener('ended', () => { this.done = true; });
    this.el.addEventListener('error', () => { this.done = true; });
  }

  start(fadeInS: number): void {
    this.fadeTo(1, fadeInS);
    void this.el.play().catch(() => { /* autoplay blocked until a gesture; retried by the director */ });
  }

  fadeTo(target: number, seconds: number): void {
    this.target = target;
    this.rate = seconds > 0 ? 1 / seconds : 1000;
  }

  /** Returns false once faded out and stopped. */
  step(): boolean {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (this.fade < this.target) this.fade = Math.min(this.target, this.fade + this.rate * dt);
    else if (this.fade > this.target) this.fade = Math.max(this.target, this.fade - this.rate * dt);
    this.el.volume = Math.max(0, Math.min(1, this.fade * this.gain()));
    if (this.target === 0 && this.fade <= 0) { this.stop(); return false; }
    return true;
  }

  get playing(): boolean { return !this.done && !this.el.paused; }
  get elapsed(): number { return this.el.currentTime || 0; }
  get duration(): number { return Number.isFinite(this.el.duration) ? this.el.duration : 0; }

  stop(): void {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.done = true;
  }
}

export class MusicDirector {
  private current: MusicState = 'none';
  private pending: MusicState = 'none';
  private pendingSince = 0;
  private forced: MusicState = 'none';
  private lastBossSeen = -1000;
  private gapUntil = 0;
  private active: Voice | null = null;
  private fading: Voice[] = [];
  private tickTimer: number;
  private fadeTimer: number;
  private unlocked = false;

  constructor(private readonly ctx: MusicContext) {
    this.tickTimer = window.setInterval(() => this._tick(), TICK_MS);
    this.fadeTimer = window.setInterval(() => this._stepFades(), 50);
    // First user gesture unlocks audio: retry whatever should be playing.
    const unlock = (): void => {
      this.unlocked = true;
      if (this.active && this.active.el.paused && !this.active.done) void this.active.el.play().catch(() => {});
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    // Console hooks, like aa.Music.Force on the UE client.
    (window as unknown as { aaMusic?: unknown }).aaMusic = {
      force: (s: MusicState | 'off') => { this.forced = s === 'off' ? 'none' : s; },
      state: () => this.current,
    };
  }

  /** Settings window: volume / frequency changed. */
  applySettings(): void {
    if (this.active) this.active.step();
    if (!this.active && this._gain() > 0 && this.current !== 'none') this.gapUntil = this._now() + 1;
  }

  get state(): MusicState { return this.current; }

  dispose(): void {
    window.clearInterval(this.tickTimer);
    window.clearInterval(this.fadeTimer);
    this.active?.stop();
    this.fading.forEach(v => v.stop());
    this.active = null;
    this.fading = [];
  }

  // ── Reading the moment ──────────────────────────────────────────────────

  private _evaluate(): MusicState {
    const c = this.ctx;
    const zoneId = c.zoneId();
    const me = c.playerXZ();
    if (!c.inWorld() || !zoneId || !me) return 'title';

    const near = (p: { x: number; z: number }, r: number): boolean =>
      (p.x - me.x) ** 2 + (p.z - me.z) ** 2 <= r * r;

    const defense = zoneId.startsWith('defense:');
    const dungeon = zoneId.startsWith('vault:') || zoneId.startsWith('dungeon_entry:')
      || zoneId.startsWith('deep_dungeon:') || zoneId.startsWith('boss_arena:');

    const t = this._now();
    let reaverCamp = false;
    const myId = c.playerId();
    for (const e of c.entities()) {
      if (e.id === myId) continue;
      if (e.type === 'mob' && (e.bossKind || e.notorious) && e.combatTargetId && near(e.position, BOSS_RANGE_M)) {
        this.lastBossSeen = t;
      } else if (!defense && e.type === 'npc' && e.tag?.startsWith('reaver_') && near(e.position, REAVER_CAMP_M)) {
        reaverCamp = true;
      }
    }
    if (t - this.lastBossSeen < BOSS_LINGER_S) return 'vaultBoss';
    if (defense) return 'defense';
    if (dungeon) return 'vaultExplore';
    if (reaverCamp) return 'reaverCamp';

    const anchors = c.wardAnchors();
    const inWard = c.isVillage() || zoneId.startsWith('village:')
      || anchors.some(a => near(a, a.r + WARD_MARGIN_M));
    if (inWard) {
      const tod = c.timeOfDay();
      if (tod < 0.23 || tod > 0.81) return 'townNight';
      return zoneId.includes('Albany') ? 'albany' : 'town';
    }
    if (anchors.length === 0 || c.aetherDensity() >= AETHER_DEEP_AD) return 'aether';
    return 'travel';
  }

  // ── Playback ────────────────────────────────────────────────────────────

  private _now(): number { return performance.now() / 1000; }

  private _gain(): number {
    return Math.max(0, Math.min(1, (readNum(KEY_MASTER_VOL, 100) / 100) * (readNum(KEY_MUSIC_VOL, DEF_MUSIC_VOL) / 100)));
  }

  private _fadeOutActive(seconds: number): void {
    if (this.active) {
      this.active.fadeTo(0, seconds);
      this.fading.push(this.active);
    }
    this.active = null;
  }

  private _start(state: MusicState, fadeInS: number): void {
    if (state === 'none') return;
    const url = `${ClientConfig.serverUrl}/world/assets/audio/music/${ASSET[state]}.mp3`;
    const v = new Voice(state, url, () => this._gain());
    v.start(fadeInS);
    this.active = v;
    this.gapUntil = 0;
  }

  private _scheduleGap(): void {
    const f = Math.max(0, Math.min(3, Math.round(readNum(KEY_MUSIC_FREQ, DEF_MUSIC_FREQ))));
    const [lo, hi] = GAPS[f]!;
    this.gapUntil = this._now() + lo + Math.random() * (hi - lo);
  }

  private _commit(next: MusicState): void {
    const old = this.current;
    this.current = next;
    if (isDriving(next)) {
      const boss = next === 'vaultBoss';
      this._fadeOutActive(boss ? 1.5 : 2.5);
      this._start(next, boss ? 1 : 2.5);
      return;
    }
    if (this.active?.playing && !isDriving(this.active.state) && family(this.active.state) === family(next)) {
      return;   // town day <-> night: let this track finish
    }
    const wasPlaying = !!this.active?.playing;
    this._fadeOutActive(isDriving(old) ? 3 : 4);
    this.gapUntil = this._now() + (old === 'none' ? 1 : (wasPlaying ? 5 + Math.random() * 4 : 2));
  }

  private _tick(): void {
    const t = this._now();
    const desired = this.forced !== 'none' ? this.forced : this._evaluate();
    if (desired !== this.pending) { this.pending = desired; this.pendingSince = t; }
    if (this.pending !== this.current && t - this.pendingSince >= holdSeconds(this.pending)) {
      this._commit(this.pending);
    }

    if (this._gain() <= 0) {
      if (this.active) this._fadeOutActive(1);
      this.gapUntil = 0;
      return;
    }
    if (this.current === 'none') return;

    const a = this.active;
    // Blocked by autoplay policy: paused but not done — wait for the gesture.
    if (a && !a.done && a.el.paused && !this.unlocked) return;

    if (isDriving(this.current)) {
      if (!a || a.done || a.state !== this.current) {
        this._start(this.current, 1.5);
      } else if (a.duration > LOOP_OVERLAP_S * 2 && a.elapsed >= a.duration - LOOP_OVERLAP_S) {
        this._fadeOutActive(LOOP_OVERLAP_S);    // seamless loop: overlap a fresh copy
        this._start(this.current, LOOP_OVERLAP_S);
      }
      return;
    }

    if (a && !a.done) return;
    if (a && a.done) {
      // Finished on its own: quiet stretch before it comes round again.
      this.active = null;
      this._scheduleGap();
      return;
    }
    if (this.gapUntil <= 0) this._scheduleGap();
    else if (t >= this.gapUntil) this._start(this.current, 3);
  }

  private _stepFades(): void {
    this.active?.step();
    this.fading = this.fading.filter(v => v.step());
  }
}
