import L from 'leaflet';
import type { Entity } from '@/network/Protocol';

/**
 * Settlement-defense battle overlay for the world map (web port of the UE
 * AA_WorldMapDefense). Fed by `defense_state` (1 Hz) — layout, machines,
 * lanes, dropped crates, supply, militia — plus raider dots from the entity
 * registry. Only drawn while the player is in a `defense:` slice.
 */

export interface DefenseStateMsg {
  phase:        'forming' | 'prep' | 'raid' | 'won' | 'lost';
  msRemaining:  number;
  leader:       'pending' | 'alive' | 'dead';
  objectives:   Array<{ id: string; name: string; hp: number; maxHp: number; alive: boolean; supply: number; x: number; z: number }>;
  raidersAlive: number;
  tier:         number;
  stockpile:    number;
  stockpileCap: number;
  carriers:     number;
  layout: {
    bounds:      { centerX: number; centerZ: number; halfExtentM: number };
    muster:      { x: number; z: number } | null;
    stockpile:   { x: number; z: number } | null;
    ringRadiusM: number;
    rallyRadiusM?: number;
  };
  lanes: Array<{ x: number; z: number }>;
  drops: Array<{ id: string; x: number; z: number }>;
  militia?: { openerName: string; visibility: string; state: string; max: number;
    members: Array<{ id: string; name: string; level: number; realLevel: number; hp: number; maxHp: number;
      alive: boolean; partyId: string | null; carrying: boolean; kills: number; opener: boolean; volunteer: boolean }> } | null;
}

type ToLL = (x: number, z: number) => L.LatLng;

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function hpColor(frac: number): string {
  return frac > 0.6 ? '#4caf50' : frac > 0.3 ? '#e0a030' : '#d04030';
}

export class DefenseMapLayer {
  private group: L.LayerGroup | null = null;
  private raiders = new Map<string, L.CircleMarker>();
  private card: HTMLElement | null = null;

  /** Slice bounds as a LatLngBounds, for fit-to-fight. */
  boundsLL(state: DefenseStateMsg, toLL: ToLL): L.LatLngBounds {
    const b = state.layout.bounds;
    return L.latLngBounds(toLL(b.centerX - b.halfExtentM, b.centerZ - b.halfExtentM),
                          toLL(b.centerX + b.halfExtentM, b.centerZ + b.halfExtentM));
  }

  /** Full redraw of the static-ish layers (1 Hz with each state push). */
  render(map: L.Map, toLL: ToLL, s: DefenseStateMsg, host: HTMLElement): void {
    this.group?.remove();
    const g = L.layerGroup().addTo(map);
    this.group = g;

    // Fence
    L.rectangle(this.boundsLL(s, toLL), {
      color: 'rgba(220,170,90,0.9)', weight: 2, dashArray: '6 4', fillColor: '#000', fillOpacity: 0.08, interactive: false,
    }).addTo(g);

    // Muster + ring (ring only while forming)
    const lay = s.layout;
    if (lay.muster) {
      const m = toLL(lay.muster.x, lay.muster.z);
      if (s.phase === 'forming' && lay.ringRadiusM > 0) {
        L.circle(m, { radius: lay.ringRadiusM, color: '#e0c070', weight: 1.5, dashArray: '3 4', fillOpacity: 0.05, interactive: false }).addTo(g);
      }
      L.circleMarker(m, { radius: 6, color: '#e0c070', fillColor: '#806020', fillOpacity: 0.9, weight: 2 })
        .bindTooltip('Militia Muster', { direction: 'top' }).addTo(g);
    }
    if (lay.stockpile) {
      L.circleMarker(toLL(lay.stockpile.x, lay.stockpile.z), { radius: 6, color: '#c9a060', fillColor: '#6b4a20', fillOpacity: 0.9, weight: 2 })
        .bindTooltip(`Supply Stockpile — ${s.stockpile}/${s.stockpileCap}`, { direction: 'top' }).addTo(g);
    }

    // Raider lanes
    for (const l of s.lanes) {
      L.circleMarker(toLL(l.x, l.z), { radius: 5, color: '#d04030', fillColor: '#d04030', fillOpacity: 0.35, weight: 1.5 })
        .bindTooltip('Raider approach', { direction: 'top' }).addTo(g);
    }

    // Machines
    for (const o of s.objectives) {
      const frac = o.maxHp > 0 ? o.hp / o.maxHp : 0;
      const ll = toLL(o.x, o.z);
      const col = o.alive ? hpColor(frac) : '#555';
      // Rally ring — supplied machines steady whoever holds them.
      if (o.alive && o.supply > 0 && (lay.rallyRadiusM ?? 0) > 0) {
        L.circle(ll, { radius: lay.rallyRadiusM!, color: '#6fcf6f', weight: 1, opacity: 0.6, fillColor: '#6fcf6f', fillOpacity: 0.07, interactive: false }).addTo(g);
      }
      L.circleMarker(ll, { radius: 9, color: col, fillColor: col, fillOpacity: o.alive ? 0.55 : 0.2, weight: 2 })
        .bindTooltip(o.alive
          ? `${esc(o.name)}<br>HP ${o.hp}/${o.maxHp} · supply ${o.supply}%`
          : `${esc(o.name)} — wrecked`, { direction: 'top' })
        .addTo(g);
      if (o.alive) {
        L.marker(ll, { interactive: false, icon: L.divIcon({
          className: 'wm-anchor-icon',
          html: `<div style="width:30px;transform:translate(-15px,14px);font:9px var(--font-mono,monospace);color:#ddd;text-align:center">
                   <div style="height:3px;background:#222"><div style="height:3px;width:${Math.round(frac * 100)}%;background:${hpColor(frac)}"></div></div>
                   <div style="height:3px;background:#222;margin-top:1px"><div style="height:3px;width:${Math.max(0, Math.min(100, o.supply))}%;background:#c9a060"></div></div>
                 </div>`,
          iconSize: [0, 0],
        }) }).addTo(g);
      }
    }

    // Dropped crates
    for (const d of s.drops) {
      L.circleMarker(toLL(d.x, d.z), { radius: 4, color: '#f0d060', fillColor: '#f0d060', fillOpacity: 0.9, weight: 1 })
        .bindTooltip('Dropped crate', { direction: 'top' }).addTo(g);
    }

    this.raiders.clear();   // their markers lived in the old group
    this._renderCard(s, host);
  }

  /** Raider dots — called from the 4 Hz follow tick. */
  tickRaiders(map: L.Map, toLL: ToLL, s: DefenseStateMsg, entities: Entity[]): void {
    if (!this.group) return;
    const b = s.layout.bounds;
    const seen = new Set<string>();
    for (const e of entities) {
      if (e.type !== 'mob' || e.isAlive === false) continue;
      if (Math.abs(e.position.x - b.centerX) > b.halfExtentM + 5 || Math.abs(e.position.z - b.centerZ) > b.halfExtentM + 5) continue;
      seen.add(e.id);
      const ll = toLL(e.position.x, e.position.z);
      const m = this.raiders.get(e.id);
      if (m) m.setLatLng(ll);
      else this.raiders.set(e.id, L.circleMarker(ll, { radius: 3, color: '#ff5040', fillColor: '#ff5040', fillOpacity: 1, weight: 1, interactive: false }).addTo(this.group));
    }
    for (const [id, m] of this.raiders) if (!seen.has(id)) { m.remove(); this.raiders.delete(id); }
    void map;
  }

  private _renderCard(s: DefenseStateMsg, host: HTMLElement): void {
    if (!this.card) {
      this.card = document.createElement('div');
      this.card.style.cssText = 'position:absolute;top:52px;left:12px;z-index:1000;min-width:210px;max-width:260px;'
        + 'background:rgba(8,6,4,0.88);border:1px solid rgba(200,145,60,0.35);padding:8px 10px;'
        + 'font:11px var(--font-mono,monospace);color:rgba(212,201,184,0.9);pointer-events:none;line-height:1.45';
    }
    if (this.card.parentElement !== host) host.appendChild(this.card);
    this.card.style.display = '';

    const head = s.phase === 'forming' ? 'MUSTERING'
      : s.phase === 'prep' ? `PREP · raiders in ${clock(s.msRemaining)}`
      : s.phase === 'raid' ? `RAID · ${clock(s.msRemaining)} left`
      : s.phase === 'won'  ? 'THE TOWN HELD' : 'THE TOWN FELL';
    const headCol = s.phase === 'won' ? '#6fcf6f' : s.phase === 'lost' ? '#e05040' : '#e0c070';
    const alive = s.objectives.filter((o) => o.alive).length;
    const leader = s.leader === 'pending' ? 'not yet seen' : s.leader === 'alive' ? 'in the field' : 'slain';
    let html = `<div style="color:${headCol};letter-spacing:.12em">${head}</div>`
      + `<div>Machines ${alive}/${s.objectives.length} · Raiders ${s.raidersAlive}</div>`
      + `<div>Supply T${s.tier} · stockpile ${s.stockpile}/${s.stockpileCap} · ${s.carriers} hauling</div>`
      + `<div>Warlord: ${leader}</div>`;
    const mil = s.militia;
    if (mil) {
      const def = mil.members.filter((m) => !m.volunteer);
      const vol = mil.members.length - def.length;
      html += `<div style="margin-top:4px;color:#c9a060">${esc(mil.openerName)}'s militia · ${def.length}/${mil.max}${vol ? ` +${vol} volunteers` : ''}</div>`;
      for (const m of mil.members) {
        const lv = m.realLevel !== m.level ? `${m.level} (${m.realLevel})` : `${m.level}`;
        const col = !m.alive ? '#a05040' : m.volunteer ? '#8fa0c0' : '#ddd';
        html += `<div style="color:${col}">${m.opener ? '★ ' : ''}${esc(m.name)} <span style="opacity:.6">Lv${lv}</span>`
          + `${m.kills ? ` ⚔${m.kills}` : ''}${m.carrying ? ' [crate]' : ''}${m.alive ? '' : ' — down'}</div>`;
      }
    }
    this.card.innerHTML = html;
  }

  clear(): void {
    this.group?.remove();
    this.group = null;
    this.raiders.clear();
    if (this.card) this.card.style.display = 'none';
  }
}
