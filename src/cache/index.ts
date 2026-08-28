// --- @elurjs/kit/cache — pluggable cache adapters (§9.2) ---

export {
  type CacheAdapter,
  type CacheEntry,
  type CacheWriteOptions,
  type FsCacheAdapterOptions,
  createFsCacheAdapter,
  cacheKey,
  getWithSWR,
} from "./adapter.js";

// Redis / Upstash / Cloudflare KV adapters (v2.1 — Fix #3)
export {
  type RedisCacheAdapterOptions,
  type RedisClient,
  createRedisCacheAdapter,
  type CloudflareKVAdapterOptions,
  type CloudflareKVNamespace,
  createCloudflareKVCacheAdapter,
} from "./redis-adapter.js";

export {
  type CacheMode,
  type CachePolicy,
  DEFAULT_CACHE_POLICY,
  normalizeCachePolicy,
  shouldCachePublic,
} from "./policy.js";

export {
  type InvalidationEvent,
  type InvalidationListener,
  CacheInvalidator,
  defaultInvalidator,
  connectCacheAdapter,
} from "./invalidation.js";

// Legacy cache functions (kept for backward compatibility).
export {
  getCachedHtml,
  setCachedHtml,
  isStale,
  clearCache,
  type CacheOptions,
} from "../cache.js";
