import * as THREE from 'three';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';
import { App, LoadingScreen } from './app';

// Globally accelerate Three.js raycasting via per-geometry BVH. Cost paid
// once when geometry.computeBoundsTree() is called (we do this in
// AssetLoader for loaded GLB meshes); after that any code path that goes
// through Mesh.raycast — camera spring-arm, player wall-slide,
// click-to-move terrain probe, F-key probes — is 10-100× faster on
// dense building chunks. Camera narrow phase in Albany dropped from
// the 48ms/frame ballpark to <1ms with this in place.
(THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
console.log('[BVH] patched. computeBoundsTree=' +
  typeof (THREE.BufferGeometry.prototype as unknown as { computeBoundsTree?: unknown }).computeBoundsTree +
  ', accelerated raycast=' + (THREE.Mesh.prototype.raycast === acceleratedRaycast));

const canvas  = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot  = document.getElementById('ui-root') as HTMLElement;
const loading = new LoadingScreen();

const app = new App(canvas, uiRoot, loading);
app.start();
