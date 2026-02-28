# Ashes & Aether — Web Client

Diablo-esque 3/4 perspective web client for the Ashes & Aether MMO server.

**Stack:** Vanilla TypeScript · Three.js · Vite · Socket.IO

---

## Quick Start

```bash
cd AshesAndAether_WebClient
npm install
npm run dev
```

Opens at `http://localhost:5173`. Expects the game server running at `http://localhost:3100`.

To point at a different server:

```bash
VITE_SERVER_URL=http://yourserver:3100 npm run dev
```

---

## Project Structure

```
src/
├── main.ts               # Entry point
├── app.ts                # App shell — bootstrap and game loop
│
├── config/
│   └── ClientConfig.ts   # Server URL, camera tuning, protocol version
│
├── network/
│   ├── Protocol.ts       # All server ↔ client message types (mirrors server)
│   ├── SocketClient.ts   # Raw connection + typed emit methods
│   └── MessageRouter.ts  # Routes socket events → state stores
│
├── state/
│   ├── SessionState.ts   # Auth, character selection, connection phase
│   ├── PlayerState.ts    # Local player vitals, position, combat gauges
│   ├── EntityRegistry.ts # All entities in the zone (add/update/remove/lookup)
│   └── WorldState.ts     # Zone info, proximity roster, chat log
│
├── world/
│   ├── SceneManager.ts   # Three.js renderer, scene, lighting presets
│   └── AssetLoader.ts    # Manifest fetch, GLB download, IndexedDB cache
│
├── entities/
│   ├── EntityObject.ts   # Base class: Three.js Object3D + entity metadata
│   ├── PlayerEntity.ts   # Local player visual (capsule + glow ring)
│   ├── RemoteEntity.ts   # Other players/NPCs/mobs with interpolation
│   └── EntityFactory.ts  # Bridges EntityRegistry events to scene objects
│
├── camera/
│   ├── OrbitCamera.ts    # 3/4 perspective: fixed elevation, free yaw, zoom
│   └── CameraInput.ts    # Right-drag yaw, scroll zoom
│
├── input/
│   └── ClickMoveController.ts  # Left-click raycast → sendMovePosition
│
└── ui/                   # HTML/CSS panels over the canvas
    ├── HUD.ts            # Vitals bars, ATB/auto-attack gauges, target name
    ├── ChatPanel.ts      # Scrolling chat log + input (say/shout/emote/party)
    ├── LoginScreen.ts    # Credentials + guest auth, account confirm flow
    └── CharacterSelect.ts # Character list, create, name confirm flow
```

---

## Architecture Principles

**Network boundary is explicit.** `SocketClient` emits raw events. `MessageRouter` is the only place that reads them and writes to state. Nothing else touches the socket.

**`EntityRegistry` is the single source of truth.** The Three.js scene objects observe it via `onAdd`/`onUpdate`/`onRemove`. No module keeps its own entity list.

**UI is HTML/CSS, not Three.js objects.** Panels are `<div>` elements positioned over the canvas. The game loop never touches the DOM except to position nameplates (not yet implemented — follow-up task).

**State is server-authoritative.** Positions in `PlayerState` and `EntityRegistry` reflect the last server message. `PlayerEntity` and `RemoteEntity` interpolate *toward* those positions but do not own them.

**Asset cache uses IndexedDB.** GLBs can be large binary blobs — `localStorage` is not suitable. ETags from the manifest enable cache invalidation.

---

## Camera Controls

| Action | Control |
|--------|---------|
| Rotate view | Right-click drag |
| Zoom | Scroll wheel |
| Move character | Left-click on world |
| Select entity | Left-click on entity |
| Deselect | Left-click on empty world |

---

## Next Steps (not yet implemented)

- **Nameplates** — `Vector3.project()` → screen-space `<div>` pool above entities
- **Keyboard WASD movement** — `KeyboardController` → `sendMoveHeading`
- **Zone info flash** — zone name fade-in on world entry (`ZoneInfo.ts`)
- **Entity animations** — replace placeholder capsules with GLB character models
- **Minimap** — render a top-down thumbnail of proximity entities
- **Ability bar** — active/passive loadout slots bound to keyboard
- **Inventory panel** — `InventoryComponent` integration
