// --- CacheAdapter: pluggable cache with single-flight, SWR, tags (§9.2) ---
//
// Implements the CacheAdapter interface from the runtime-security design:
//   - SHA-256 keys for normalized identity
//   - temp + atomic rename writes
//   - single-flight per process (deduplicates concurrent gets for same key)
//   - stale-while-revalidate (serves stale, refreshes in background)
//   - tag-based invalidation
//   - size limits and periodic cleanup
//
// The filesystem adapter is the default. External adapters (Redis, KV, etc.)
// can implement the same interface and be plugged in via config.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

// Types

export interface CacheEntry {
  html: string;
  generatedAt: number;
  revalidate: number;
  tags?: string[];
  version?: string;
}

export interface CacheWriteOptions {
  revalidate: number;
  tags?: string[];
  version?: string;
}

export interface CacheAdapter {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, value: CacheEntry, options: CacheWriteOptions): Promise<void>;
  delete(key: string): Promise<void>;
  invalidateTags(tags: readonly string[]): Promise<void>;
}

// Helpers

/** Computes a SHA-256 key from a normalized identity string. */
export function cacheKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// Filesystem CacheAdapter

export interface FsCacheAdapterOptions {
  cacheDir: string;
  /** Max entries before cleanup runs. Default: 1000. */
  maxEntries?: number;
  /** Max age in ms for entries. Default: 24h. */
  maxAgeMs?: number;
}

export function createFsCacheAdapter(options: FsCacheAdapterOptions): CacheAdapter {
  const { cacheDir } = options;
  const maxEntries = options.maxEntries ?? 1000;
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;

  // Single-flight: deduplicates concurrent gets for the same key.
  const inFlight = new Map<string, Promise<CacheEntry | null>>();

  // Tag index: maps tag -> set of cache keys.
  // Persisted to a JSON file for cross-process visibility.
  const tagIndexPath = join(cacheDir, "_tag-index.json");

  async function loadTagIndex(): Promise<Record<string, string[]>> {
    try {
      const raw = await readFile(tagIndexPath, "utf8");
      return JSON.parse(raw) as Record<string, string[]>;
    } catch {
      return {};
    }
  }

  async function saveTagIndex(index: Record<string, string[]>): Promise<void> {
    await mkdir(dirname(tagIndexPath), { recursive: true });
    const tmp = `${tagIndexPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(index), "utf8");
      await rename(tmp, tagIndexPath);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  function entryPath(key: string): string {
    return join(cacheDir, `${key}.html.json`);
  }

  async function get(key: string): Promise<CacheEntry | null> {
    // Single-flight: if a get is already in progress for this key, wait for it.
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const raw = await readFile(entryPath(key), "utf8");
        const entry = JSON.parse(raw) as CacheEntry;
        return entry;
      } catch {
        return null;
      }
    })();

    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  }

  async function set(key: string, value: CacheEntry, opts: CacheWriteOptions): Promise<void> {
    const path = entryPath(key);
    await mkdir(dirname(path), { recursive: true });

    const entry: CacheEntry = {
      html: value.html,
      generatedAt: value.generatedAt ?? Date.now(),
      revalidate: opts.revalidate,
      tags: opts.tags,
      version: opts.version,
    };

    // Atomic write: temp + rename.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(entry), "utf8");
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }

    // Update tag index.
    if (opts.tags && opts.tags.length > 0) {
      const index = await loadTagIndex();
      for (const tag of opts.tags) {
        if (!index[tag]) index[tag] = [];
        if (!index[tag].includes(key)) index[tag].push(key);
      }
      await saveTagIndex(index);
    }

    // Periodic cleanup.
    await maybeCleanup();
  }

  async function del(key: string): Promise<void> {
    await rm(entryPath(key), { force: true });
  }

  async function invalidateTags(tags: readonly string[]): Promise<void> {
    if (tags.length === 0) return;
    const index = await loadTagIndex();
    const keysToDelete = new Set<string>();
    for (const tag of tags) {
      const keys = index[tag];
      if (keys) {
        for (const key of keys) keysToDelete.add(key);
        delete index[tag];
      }
    }
    await Promise.all([...keysToDelete].map((key) => del(key)));
    await saveTagIndex(index);
  }

  let lastCleanup = 0;
  async function maybeCleanup(): Promise<void> {
    const now = Date.now();
    if (now - lastCleanup < 60_000) return; // at most once per minute
    lastCleanup = now;
    try {
      const files = await readdir(cacheDir);
      let entryCount = 0;
      const toDelete: string[] = [];
      for (const file of files) {
        if (!file.endsWith(".html.json")) continue;
        entryCount++;
        const filePath = join(cacheDir, file);
        try {
          const stats = await stat(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            toDelete.push(filePath);
          }
        } catch {
          // stat failed, skip
        }
      }
      // If over limit, delete oldest (by mtime).
      if (entryCount - toDelete.length > maxEntries) {
        const candidates: Array<{ path: string; mtime: number }> = [];
        for (const file of files) {
          if (!file.endsWith(".html.json")) continue;
          const filePath = join(cacheDir, file);
          if (toDelete.includes(filePath)) continue;
          try {
            const stats = await stat(filePath);
            candidates.push({ path: filePath, mtime: stats.mtimeMs });
          } catch {
            // skip
          }
        }
        candidates.sort((a, b) => a.mtime - b.mtime);
        const excess = entryCount - toDelete.length - maxEntries;
        for (let i = 0; i < excess && i < candidates.length; i++) {
          toDelete.push(candidates[i].path);
        }
      }
      await Promise.all(toDelete.map((p) => rm(p, { force: true })));
    } catch {
      // cleanup is best-effort
    }
  }

  return { get, set, delete: del, invalidateTags };
}

// Stale-while-revalidate wrapper

/**
 * Gets a cached entry. If the entry is stale (past revalidate), serves it
 * immediately and triggers a background revalidation.
 *
 * @param adapter The cache adapter.
 * @param key The cache key.
 * @param revalidate The revalidation function (called if stale or missing).
 * @returns The cache entry (fresh or stale), or null if missing.
 */
export async function getWithSWR(
  adapter: CacheAdapter,
  key: string,
  revalidate: () => Promise<CacheEntry | null>,
): Promise<{ entry: CacheEntry | null; stale: boolean }> {
  const entry = await adapter.get(key);
  if (!entry) {
    // Cache miss: revalidate synchronously.
    const fresh = await revalidate();
    return { entry: fresh, stale: false };
  }

  const ageMs = Date.now() - entry.generatedAt;
  const isStale = ageMs >= entry.revalidate * 1000;

  if (isStale) {
    // Serve stale, revalidate in background (fire-and-forget).
    revalidate().then(
      (fresh) => {
        if (fresh) {
          adapter.set(key, fresh, {
            revalidate: entry.revalidate,
            tags: entry.tags,
            version: entry.version,
          }).catch((err) => {
            console.error("[nix-js-kit] background cache write failed:", err);
          });
        }
      },
      (err) => {
        console.error("[nix-js-kit] background revalidation failed:", err);
      },
    );
    return { entry, stale: true };
  }

  return { entry, stale: false };
}
