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

/** Yield once to the browser so it can paint and process input.  Uses
 *  setTimeout(0) — most reliable cross-browser, accepts the ~4 ms clamp. */
export function yieldToBrowser(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
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
