# AGENTS.md — Web Client

Working on `AshesAndAether_Web_Client/`. See `README.md` for stack, project
structure, and dev-quickstart. This file is the agent-specific guide:
what to run to verify changes, what to *not* touch by accident, and the
non-obvious traps the codebase will silently swallow.

---

## Build / verify commands

```bash
npm install            # first time only
npm run typecheck      # tsc --noEmit — fast type verification, no emit
npm run build          # tsc + vite build — full production build
npm run dev            # vite dev server with HMR (default port 5173)
```

**Typecheck first, build later.** Most TS errors surface in `typecheck`
without the cost of a full `vite build`. Use `build` when you need the
emitted `dist/` (Tauri packaging, deploy, etc).

**Dev server picks up source edits via HMR** for most files — no need
to rebuild while iterating. Hard-refresh the browser when in doubt
about WebGL state.

---

## Testing UI changes

- `npm run dev` then open the served URL
- Server must be running too — defaults to `http://localhost:3100`; override
  with `VITE_SERVER_URL=http://other:port npm run dev`
- For protocol changes (new server → client events, payload shape edits),
  the server also needs to rebuild + restart. The client-side Protocol.ts
  is a hand-mirrored copy of the server types.

---

## Pitfalls (these will bite silently)

### Protocol drift
Server defines event payloads in
`../AshesAndAether_Server_v2/packages/zone-server/src/...`. Client mirrors
them in `src/network/Protocol.ts`. After changing a server event:
- Update Protocol.ts to match
- Hand-verify the field names — TS can't catch a typo'd JSON key

### SocketClient event allowlist
New server → client events silently fail until added to the forwarded-
events allowlist in `src/network/SocketClient.ts`. Symptom: you wired
the server emit but the client `onEvent` handler never fires.

### HUD widget LayoutEditor registration
F10 layout mode reads a hardcoded `DRAGGABLE` list in
`src/ui/LayoutEditor.ts`. Every new HUD widget element id must be
registered there or it's silently un-moveable for the player.

### Modal panel registration
New modal panels (windows that should Esc-close, share modal-stack
ordering) must:
- Register with `App.modalStack`
- Expose an `isVisible` getter
- Expose a `close()` alias

The user wants every modal window to behave uniformly; `ModalStack` is the
chokepoint. Skipping any of the three breaks Esc / stack ordering.

### Custom ShaderMaterial + logarithmic depth
The Three.js renderer is constructed with `logarithmicDepthBuffer: true`.
Custom `ShaderMaterial` instances MUST include the `logdepthbuf` chunks
in their vertex + fragment shaders. Skipping = silently invisible from
every angle (when `depthTest: true`). See existing materials for the
include pattern.

### three-mesh-bvh + geometry swaps
Client raycasts use `three-mesh-bvh`. Any code that swaps a mesh's
geometry (e.g. `_thickenMesh`) must rebuild the BVH on the new geometry
or the old reference goes stale and raycasts miss.

### Don't commit `dist/`
Vite output. In `.gitignore`. If you see it staged, something went
wrong — `git restore --staged dist/`.

### CRLF warnings on Windows
Expected and harmless. Don't fight them.

---

## Conventions

- **TypeScript strict** — no `any`. Use `unknown` + narrow if a value is
  truly opaque.
- **No global state** outside the State modules (`src/state/`). Components
  read via injected references, not module-level singletons.
- **DOM panels in `src/ui/`** — each panel owns its DOM subtree. No
  shared mutable HTML state across panels.
- **Three.js objects in `src/entities/` and `src/world/`** — never mutate
  shared geometries; clone instead.

---

## Tauri (desktop)

`npm run tauri:dev` / `npm run tauri:build`. Only touch if explicitly
working on the desktop wrapper. Most iteration is browser-based via
`npm run dev`.

---

## Don't do these without explicit user confirmation

- Commit (`git commit`)
- Force-push or rewrite history
- Delete branches or tags
- Modify `vite.config.ts` build targets, output dirs, or alias config
  without surfacing the change first — these affect every other
  developer's setup
- Touch `package.json` dependency versions without saying so first
