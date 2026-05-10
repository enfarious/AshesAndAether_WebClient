// ---------------------------------------------------------------------------
// yieldUtil — main-thread chunking primitives
//
// Browsers fire the "page is unresponsive" warning when JS doesn't yield to
// the event loop for ~10 s. Long synchronous loops (extruding 5 000 OSM
// buildings, planting 5 000 trees) easily blow that.  These helpers break
// such loops into chunks that yield between batches so the browser can
// paint, process input, and tick its watchdog.
//
// Cost: each yield is ~4 ms minimum due to setTimeout(0) clamping.  Pick a
// chunk size that keeps total chunk count low (overhead) but each chunk
// short enough to hit a target ms budget — typically 100–500 items per
// chunk for "do a few hundred ops per item" workloads.
// ---------------------------------------------------------------------------

/** Yield once to the browser so it can paint and process input.
 *
 *  Uses requestAnimationFrame to GUARANTEE a paint cycle between yields —
 *  setTimeout(0) only yields to the event loop, and modern browsers
 *  routinely batch multiple JS-driven DOM mutations across several
 *  setTimeout-yields into a single paint, which makes per-chunk progress
 *  text appear to skip.  rAF runs at ~60 fps so each chunk costs ~16 ms
 *  of overhead — acceptable for the small number of chunks we run, and
 *  the visible progress is worth it. */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Walk an array in chunks, running `onItem` synchronously within each
 *  chunk and yielding to the event loop between chunks.  `onProgress` (if
 *  given) is called once per chunk with `(processed, total)` so callers
 *  can drive a progress bar. */
export async function chunkedFor<T>(
  items:      readonly T[],
  chunkSize:  number,
  onItem:     (item: T, index: number) => void,
  onProgress?: (processed: number, total: number) => void,
): Promise<void> {
  const total = items.length;
  if (total === 0) {
    onProgress?.(0, 0);
    return;
  }
  for (let i = 0; i < total; i += chunkSize) {
    const end = Math.min(i + chunkSize, total);
    for (let j = i; j < end; j++) onItem(items[j]!, j);
    onProgress?.(end, total);
    if (end < total) await yieldToBrowser();
  }
}
