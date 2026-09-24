/**
 * Optional in-memory cache for the redirect lookup (REDIRECT_CACHE_TTL_MS, 0 = disabled).
 *
 * Correctness rules:
 *  - every admin write in THIS process invalidates the affected code immediately;
 *  - other processes see changes after the TTL at the latest;
 *  - a "generation" counter stops a reader that started before an invalidation from
 *    re-inserting the stale row it just fetched.
 */
export function createRedirectCache(ttlMs, maxEntries = 20000) {
  const map = new Map();
  let generation = 0;

  return {
    enabled: ttlMs > 0,

    get generation() {
      return generation;
    },

    get(code) {
      if (!ttlMs) return undefined;
      const entry = map.get(code);
      if (!entry) return undefined;
      if (entry.expires <= Date.now()) {
        map.delete(code);
        return undefined;
      }
      return entry.value;
    },

    /** `seenGeneration` = value of `generation` read BEFORE the database lookup. */
    set(code, value, seenGeneration) {
      if (!ttlMs || seenGeneration !== generation) return;
      if (map.size >= maxEntries) map.delete(map.keys().next().value);
      map.set(code, { value, expires: Date.now() + ttlMs });
    },

    invalidate(code) {
      generation += 1;
      map.delete(code);
    },

    clear() {
      generation += 1;
      map.clear();
    },

    get size() {
      return map.size;
    },
  };
}
