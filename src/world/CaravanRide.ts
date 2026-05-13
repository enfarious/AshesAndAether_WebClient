import * as THREE from 'three';
import type { EntityFactory } from '@/entities/EntityFactory';
import type { HeightmapService } from '@/world/HeightmapService';
import type { SocketClient } from '@/network/SocketClient';
import type { WorldState } from '@/state/WorldState';
import type {
  CaravanRideStartedData,
  CaravanRideEndedData,
} from '@/network/Protocol';

/**
 * CaravanRide — client-side driver for caravan rides.
 *
 * The server emits a single `caravan_ride_started` event with the path,
 * speed, and party offsets, then stops broadcasting per-tick positions
 * for the rider + party for the ride's duration. This class drives the
 * rider and party visuals locally along the same path the server is
 * simulating — both ends use identical math, so positions stay in sync
 * to within float precision.
 *
 * On `caravan_ride_ended` the manager drops the ride state and (if the
 * client's prediction drifted) snaps the rider to the server's reported
 * final position.
 *
 * Why client-side prediction here:
 *  - Path is deterministic (A* fixed at boot).
 *  - Speed is fixed (CARAVAN_SPEED_MPS).
 *  - No player input deflects motion (WASD/jump end the ride, they don't
 *    redirect it).
 *  - So the only "wire smoothing" was source of visible jitter at 30 m/s.
 */

interface ActiveRide {
  riderId:    string;
  /** Remaining waypoints. Front of array = next target. Same shape as
   *  the server's player.caravanPath. */
  path:       { x: number; z: number }[];
  speedMPS:   number;
  hoverM:     number;
  party:      { entityId: string; offsetX: number; offsetZ: number }[];
  /** Current predicted rider XZ. Y is sampled from heightmap + hover. */
  curX:       number;
  curZ:       number;
  curHeading: number;
  /** True after the rider reaches the last waypoint locally. Visual is
   *  frozen at final pos while we wait for the server's authoritative
   *  caravan_ride_ended. Catches the rare drift case cleanly. */
  arrived:    boolean;
}

const ARRIVAL_THRESHOLD_M = 1.5;

export class CaravanRide {
  private readonly rides = new Map<string, ActiveRide>(); // riderId → ride
  /** Reverse lookup: passenger entity id → riderId. Used to mark
   *  companions/hirelings as "in ride" without scanning all rides. */
  private readonly memberOf = new Map<string, string>();

  constructor(
    private readonly factory:    EntityFactory,
    private readonly localPlayerId: () => string | null,
    private readonly getHeightmap: () => HeightmapService | null,
    private readonly socket:     SocketClient,
  ) {}

  bind(world: WorldState): void {
    world.onEvent((payload) => {
      if (payload.eventType === 'caravan_ride_started') {
        this._handleStart(payload.eventTypeData as unknown as CaravanRideStartedData);
      } else if (payload.eventType === 'caravan_ride_ended') {
        this._handleEnd(payload.eventTypeData as unknown as CaravanRideEndedData);
      }
    });
  }

  /** Is this entity (rider or passenger) currently locked to a caravan?
   *  PlayerEntity / RemoteEntity check this to skip their own position
   *  updates — the manager owns position while a ride is active. */
  isInRide(entityId: string): boolean {
    return this.rides.has(entityId) || this.memberOf.has(entityId);
  }

  /** Local player riding? Used by input layer to redirect WASD/jump
   *  to `/dismount` instead of normal motion. */
  isLocalRiding(): boolean {
    const me = this.localPlayerId();
    return me !== null && this.rides.has(me);
  }

  /** Cancel the local rider's caravan. Fires `/dismount` to the server;
   *  the eventual `caravan_ride_ended` will finalize state. The visual
   *  freezes at the current predicted position immediately so input
   *  feels responsive — no waiting for the server round-trip. */
  dismountLocal(): void {
    const me = this.localPlayerId();
    if (!me || !this.rides.has(me)) return;
    this.socket.sendCommand('/dismount');
    // Mark arrived so tick stops advancing. Server's ride_ended will
    // clear the entry shortly.
    const ride = this.rides.get(me);
    if (ride) ride.arrived = true;
  }

  /** Advance all active rides. Call once per frame. */
  tick(dt: number): void {
    for (const ride of this.rides.values()) {
      if (ride.arrived) continue;
      this._advanceRide(ride, dt);
      this._applyVisuals(ride);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private _handleStart(data: CaravanRideStartedData): void {
    const ride: ActiveRide = {
      riderId:    data.riderId,
      path:       data.path.map(p => ({ x: p.x, z: p.z })),
      speedMPS:   data.speedMPS,
      hoverM:     data.hoverM,
      party:      data.partyOffsets.map(p => ({ ...p })),
      curX:       data.startPosition.x,
      curZ:       data.startPosition.z,
      curHeading: data.heading,
      arrived:    false,
    };
    this.rides.set(ride.riderId, ride);
    for (const p of ride.party) this.memberOf.set(p.entityId, ride.riderId);
    // Snap to starting position so frame 0 of the ride is correct even
    // before tick() runs (avoids a one-frame teleport from prior pos).
    this._applyVisuals(ride);
  }

  private _handleEnd(data: CaravanRideEndedData): void {
    const ride = this.rides.get(data.riderId);
    if (!ride) return;
    // Snap rider to server's authoritative final position so any drift
    // resolves cleanly. The post-ride state_update will re-enable
    // normal position handling for rider + party.
    const obj = this.factory.getObject(data.riderId);
    if (obj) {
      obj.snapToPosition(new THREE.Vector3(
        data.finalPosition.x,
        data.finalPosition.y,
        data.finalPosition.z,
      ));
    }
    for (const p of ride.party) {
      this.memberOf.delete(p.entityId);
      // Party members get a snap to the rider's reported final XZ + their
      // formation offset. Server will follow with a state_update that
      // restores normal Y-snap behavior.
      const pObj = this.factory.getObject(p.entityId);
      if (!pObj) continue;
      pObj.snapToPosition(new THREE.Vector3(
        data.finalPosition.x + p.offsetX,
        data.finalPosition.y,
        data.finalPosition.z + p.offsetZ,
      ));
    }
    this.rides.delete(data.riderId);
  }

  private _advanceRide(ride: ActiveRide, dt: number): void {
    if (ride.path.length === 0) { ride.arrived = true; return; }
    let remaining = ride.speedMPS * dt;

    while (remaining > 0 && ride.path.length > 0) {
      const wp   = ride.path[0]!;
      const dx   = wp.x - ride.curX;
      const dz   = wp.z - ride.curZ;
      const dist = Math.hypot(dx, dz);
      if (dist <= ARRIVAL_THRESHOLD_M) {
        ride.path.shift();
        if (ride.path.length === 0) { ride.arrived = true; return; }
        continue;
      }
      const step = Math.min(remaining, dist);
      ride.curX  += (dx / dist) * step;
      ride.curZ  += (dz / dist) * step;
      // Face along travel direction. atan2(x, z) so heading=0 = +Z south,
      // matching server convention.
      ride.curHeading = Math.atan2(dx, dz) * 180 / Math.PI;
      remaining -= step;
    }
  }

  private _applyVisuals(ride: ActiveRide): void {
    const hm = this.getHeightmap();
    const groundY = hm?.getElevation(ride.curX, ride.curZ) ?? 0;
    const y = groundY + ride.hoverM;

    const rider = this.factory.getObject(ride.riderId);
    if (rider) {
      rider.snapToPosition(new THREE.Vector3(ride.curX, y, ride.curZ));
      const r = rider.object3d;
      r.rotation.y = THREE.MathUtils.degToRad(ride.curHeading);
    }

    for (const p of ride.party) {
      const obj = this.factory.getObject(p.entityId);
      if (!obj) continue;
      obj.snapToPosition(new THREE.Vector3(
        ride.curX + p.offsetX,
        y,
        ride.curZ + p.offsetZ,
      ));
      obj.object3d.rotation.y = THREE.MathUtils.degToRad(ride.curHeading);
    }
  }
}
