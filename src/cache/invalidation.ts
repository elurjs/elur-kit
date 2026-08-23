// --- Cache invalidation hooks (runtime-security §9.4) ---
//
// Actions can emit tags/paths to invalidate via a generic context. The cache
// server listens to these hooks and invalidates the appropriate entries.
// Integrations like nix-query can also listen, but they are NOT a dependency
// of the cache server.
//
// Design:
//   - `CacheInvalidator` is a simple pub/sub for invalidation events.
//   - The runtime registers an invalidator with the cache adapter.
//   - Actions call `invalidateTags()` / `invalidatePaths()` from their context.
//   - The invalidator dispatches to all registered listeners.

export interface InvalidationEvent {
  tags?: readonly string[];
  paths?: readonly string[];
  /** Source of the invalidation (e.g. action name). */
  source?: string;
}

export type InvalidationListener = (event: InvalidationEvent) => void | Promise<void>;

/**
 * A pub/sub hub for cache invalidation events. Actions emit events;
 * the cache adapter (and optionally nix-query or other integrations) listen.
 */
export class CacheInvalidator {
  private listeners = new Set<InvalidationListener>();

  /** Registers a listener for invalidation events. Returns an unsubscribe function. */
  on(listener: InvalidationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emits an invalidation event to all listeners. */
  async emit(event: InvalidationEvent): Promise<void> {
    const promises: Array<Promise<void>> = [];
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          // Wrap to prevent unhandled rejection from failing the whole emit.
          promises.push(result.catch((err) => {
            console.error("[nix-js-kit] invalidation listener error:", err);
          }));
        }
      } catch (err) {
        console.error("[nix-js-kit] invalidation listener error:", err);
      }
    }
    await Promise.all(promises);
  }

  /** Convenience: invalidate by tags. */
  async invalidateTags(tags: readonly string[], source?: string): Promise<void> {
    if (tags.length === 0) return;
    await this.emit({ tags, source });
  }

  /** Convenience: invalidate by paths. */
  async invalidatePaths(paths: readonly string[], source?: string): Promise<void> {
    if (paths.length === 0) return;
    await this.emit({ paths, source });
  }

  /** Removes all listeners. */
  clear(): void {
    this.listeners.clear();
  }
}

/** Global default invalidator. The runtime registers the cache adapter here. */
export const defaultInvalidator = new CacheInvalidator();

/**
 * Connects a CacheAdapter to the default invalidator so that tag/path
 * invalidation events from actions are dispatched to the cache.
 *
 * Returns an unsubscribe function.
 */
export function connectCacheAdapter(
  adapter: {
    invalidateTags: (tags: readonly string[]) => Promise<void>;
    delete?: (key: string) => Promise<void>;
  },
  invalidator: CacheInvalidator = defaultInvalidator,
): () => void {
  return invalidator.on(async (event) => {
    if (event.tags && event.tags.length > 0) {
      await adapter.invalidateTags(event.tags);
    }
    // Path-based invalidation: the adapter needs to know which cache keys
    // correspond to which paths. This is handled by the runtime mapping
    // paths to cache keys before calling delete().
    if (event.paths && event.paths.length > 0 && adapter.delete) {
      // The runtime should register a path-to-key mapper.
      // For now, we use the path as the cache key directly (SHA-256 of path).
      const { cacheKey } = await import("./adapter.js");
      await Promise.all(event.paths.map((p) => adapter.delete!(cacheKey(p))));
    }
  });
}
