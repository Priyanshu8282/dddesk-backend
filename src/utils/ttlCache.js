// Tiny in-process cache with a short TTL and prefix invalidation (dashboard summaries).
// Per process only: other server instances catch up when their entry expires.
class TtlCache {
  constructor({ ttlMs = 20000, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
    this.inflight = new Map();
    this.gen = 0; // bumped on every invalidation so a slow computation started before it is not cached
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) { this.map.delete(key); return undefined; }
    return hit.value;
  }

  set(key, value) {
    if (!this.ttlMs) return;
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { at: Date.now(), value });
  }

  /** Cached value, or compute it once even when several requests ask at the same time. */
  async wrap(key, compute) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const gen = this.gen;
    const p = (async () => {
      try {
        const value = await compute();
        if (gen === this.gen) this.set(key, value);
        return value;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /** Drop every entry whose key starts with the prefix. */
  invalidate(prefix) {
    this.gen++;
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
    for (const k of this.inflight.keys()) if (k.startsWith(prefix)) this.inflight.delete(k);
  }

  clear() { this.gen++; this.map.clear(); this.inflight.clear(); }
}

module.exports = TtlCache;
