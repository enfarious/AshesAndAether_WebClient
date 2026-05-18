import * as THREE from 'three';

/**
 * One-shot scene cost breakdown for perf detective work.
 *
 * Walks the entire scene graph, buckets every Mesh / InstancedMesh by its
 * top-level ancestor under `scene` (the named groups added directly to
 * `SceneManager.scene` — worldRoot, sky, weather containers, etc.), and
 * dumps a sorted table to the console.
 *
 * Tables are sorted by visible draws first (since recent investigation
 * showed draw + shader cost > triangle cost for our zones), then by
 * visible triangles. Hidden meshes are counted separately so toggling
 * `.visible` on a chunk can be verified.
 *
 * Instanced meshes count as 1 draw (one submission per call) but their
 * tri total multiplies by `instanceCount` — that's the real GPU shading
 * load, which matters when comparing forest (heavily instanced) against
 * terrain (one giant non-instanced mesh).
 */

interface CategoryStat {
  name:          string;
  meshes:        number;
  visibleMeshes: number;
  tris:          number;
  visibleTris:   number;
  instanced:     number;
  visibleInstances: number;
  /** Unique material UUIDs across all meshes (visible + hidden). */
  materials:     Set<string>;
  /** Unique material UUIDs across visible meshes only — gap vs `materials`
   *  indicates hidden-but-alive meshes with their own materials (often a
   *  leak from a rebuild path that doesn't dispose stale meshes). */
  visibleMaterials: Set<string>;
  /** First few mesh descriptors for identification. Format:
   *   `name|InstancedMesh×count|tris` or `name|Mesh|tris` */
  samples:       string[];
  /** For categories with lots of hidden meshes — fingerprint = `tris|matType`
   *  — used to histogram and find duplicate-shape leaks. */
  hiddenFingerprints: Map<string, number>;
}

function ancestorCategory(obj: THREE.Object3D, directChildSet: Set<string>): string {
  let cur: THREE.Object3D | null = obj;
  while (cur && !directChildSet.has(cur.uuid)) {
    cur = cur.parent;
  }
  if (!cur) return '(detached)';
  return cur.name || `<${cur.type}>`;
}

function isVisibleToRoot(obj: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

function trianglesOf(geo: THREE.BufferGeometry | undefined): number {
  if (!geo) return 0;
  if (geo.index)                       return geo.index.count / 3;
  if (geo.attributes['position'])      return (geo.attributes['position'] as THREE.BufferAttribute).count / 3;
  return 0;
}

export function dumpScenePerfBreakdown(
  scene:    THREE.Scene,
  renderer: THREE.WebGLRenderer,
  label = 'scene-breakdown',
): void {
  const directChildSet = new Set(scene.children.map(c => c.uuid));
  const stats          = new Map<string, CategoryStat>();

  let totalMeshes        = 0;
  let totalVisibleMeshes = 0;
  let totalTris          = 0;
  let totalVisibleTris   = 0;

  scene.traverse(obj => {
    if (!(obj instanceof THREE.Mesh)) return;
    const cat = ancestorCategory(obj, directChildSet);
    let stat  = stats.get(cat);
    if (!stat) {
      stat = {
        name: cat, meshes: 0, visibleMeshes: 0,
        tris: 0, visibleTris: 0,
        instanced: 0, visibleInstances: 0,
        materials: new Set(), visibleMaterials: new Set(),
        samples: [],
        hiddenFingerprints: new Map(),
      };
      stats.set(cat, stat);
    }

    const triPerInstance = trianglesOf(obj.geometry as THREE.BufferGeometry | undefined);
    const isInstanced    = obj instanceof THREE.InstancedMesh;
    const instanceCount  = isInstanced ? (obj as THREE.InstancedMesh).count : 1;
    const meshTris       = triPerInstance * instanceCount;
    const visible        = isVisibleToRoot(obj);

    stat.meshes++;
    stat.tris += meshTris;
    if (isInstanced) stat.instanced++;
    if (visible) {
      stat.visibleMeshes++;
      stat.visibleTris += meshTris;
      if (isInstanced) stat.visibleInstances += instanceCount;
    }

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      stat.materials.add(m.uuid);
      if (visible) stat.visibleMaterials.add(m.uuid);
    }

    if (stat.samples.length < 5) {
      const meshLabel  = obj.name || '(unnamed)';
      const kind       = isInstanced ? `InstancedMesh×${instanceCount}` : 'Mesh';
      const parentName = obj.parent?.name || obj.parent?.type || 'detached';
      stat.samples.push(`${meshLabel} (${kind}, tris=${meshTris}, parent=${parentName}, vis=${visible})`);
    }

    // Fingerprint hidden meshes for histogram bucketing — "tris|materialType"
    // collapses to a small set when many hidden meshes are clones of the same
    // primitive (e.g. 1500 hidden chevrons all `7|ShaderMaterial`).
    if (!visible) {
      const firstMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const matType  = firstMat?.type ?? 'NoMaterial';
      const key      = `${meshTris}|${matType}`;
      stat.hiddenFingerprints.set(key, (stat.hiddenFingerprints.get(key) ?? 0) + 1);
    }

    totalMeshes++;
    totalTris += meshTris;
    if (visible) {
      totalVisibleMeshes++;
      totalVisibleTris += meshTris;
    }
  });

  const pct = (n: number, total: number): string =>
    total > 0 ? `${(n / total * 100).toFixed(1)}%` : '—';

  const sortedByDraws = [...stats.values()].sort((a, b) => b.visibleMeshes - a.visibleMeshes);
  const sortedByTris  = [...stats.values()].sort((a, b) => b.visibleTris   - a.visibleTris);

  const info = renderer.info;
  /* eslint-disable no-console */
  console.group(
    `[${label}] visible ${totalVisibleMeshes}/${totalMeshes} meshes, ${totalVisibleTris.toLocaleString()} tris ` +
    `| renderer.info: ${info.render.calls} calls, ${info.render.triangles.toLocaleString()} tris, ` +
    `${info.programs?.length ?? 0} progs`,
  );

  console.log('— by submission count (visible meshes ≈ draws/pass) —');
  console.table(sortedByDraws.map(s => ({
    category:   s.name,
    meshes:     s.visibleMeshes,
    hidden:     s.meshes - s.visibleMeshes,
    matsVis:    s.visibleMaterials.size,
    matsTotal:  s.materials.size,
    instMeshes: s.instanced,
    instances:  s.visibleInstances,
    tris:       s.visibleTris,
    trisPct:    pct(s.visibleTris, totalVisibleTris),
  })));

  console.log('— by triangle load (visible × instanceCount) —');
  console.table(sortedByTris.slice(0, 15).map(s => ({
    category: s.name,
    tris:     s.visibleTris,
    trisPct:  pct(s.visibleTris, totalVisibleTris),
    meshes:   s.visibleMeshes,
    mats:     s.visibleMaterials.size,
  })));

  // Sample mesh identifiers per top category — first 5 meshes traversed.
  // Critical for identifying anonymous categories like `<Mesh>` (meshes
  // added directly to scene.scene without a wrapping group). The format is
  //   <name> (Mesh|InstancedMesh×count, tris=N, parent=X, vis=true|false)
  console.log('— samples per top category —');
  for (const s of sortedByDraws.slice(0, 8)) {
    if (s.samples.length === 0) continue;
    console.log(`[${s.name}] ${s.visibleMeshes} visible / ${s.meshes} total`);
    for (const sample of s.samples) console.log('   ' + sample);
  }

  // Hidden-mesh histograms — only printed for categories with >100 hidden
  // meshes, since the goal is finding leaks (1000+ duplicated chevrons,
  // beacons, telegraphs left as `.visible = false` instead of removed).
  // Bins by `tris|materialType` so a single dominant fingerprint betrays
  // a single leak source.
  const histCandidates = [...stats.values()].filter(s => (s.meshes - s.visibleMeshes) > 100);
  if (histCandidates.length > 0) {
    console.log('— hidden-mesh histogram (categories with >100 hidden) —');
    for (const s of histCandidates) {
      const hidden = s.meshes - s.visibleMeshes;
      console.log(`[${s.name}] ${hidden} hidden meshes — top fingerprints (tris|matType):`);
      const top = [...s.hiddenFingerprints.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      for (const [key, count] of top) {
        const pctStr = (count / hidden * 100).toFixed(1);
        console.log(`   ${count.toString().padStart(5)} × ${key}  (${pctStr}%)`);
      }
    }
  }

  console.groupEnd();
  /* eslint-enable no-console */
}
