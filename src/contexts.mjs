// Request contexts are intentionally volatile. They only need to bridge the
// few seconds between a response hook and the next gateway usage scan. After
// a restart, or after the TTL, a row falls back to the configured project.
export class Contexts {
  constructor({ ttl = 120_000, capacity = 2_048 } = {}) {
    this.ttl = ttl;
    this.capacity = capacity;
    this.byResponse = new Map();
    this.bySession = new Map();
  }

  static key(agent, id) {
    if (typeof id !== "string" || id.length === 0 || id.length > 512) return null;
    const owner = typeof agent === "string" ? agent.slice(0, 255) : "";
    return `${owner}\0${id}`;
  }

  setResponse(agent, id, value, now = Date.now()) {
    return this.set(this.byResponse, agent, id, value, now);
  }

  setSession(agent, id, value, now = Date.now()) {
    return this.set(this.bySession, agent, id, value, now);
  }

  set(map, agent, id, value, now) {
    const key = Contexts.key(agent, id);
    if (!key || !value || typeof value !== "object" || Array.isArray(value)) return false;
    map.delete(key);
    map.set(key, { value: { ...value }, at: now });
    this.trim(map);
    return true;
  }

  trim(map) {
    while (map.size > this.capacity) map.delete(map.keys().next().value);
  }

  lookup(map, agent, id, now) {
    const key = Contexts.key(agent, id);
    if (!key) return null;
    const entry = map.get(key);
    if (!entry) return null;
    if (now - entry.at > this.ttl) { map.delete(key); return null; }
    return entry.value;
  }

  // The response id is exact; the session is a bounded fallback because a
  // usage row may be rescanned after the response id is no longer known.
  get(row, now = Date.now()) {
    const agent = row?.agent;
    return this.lookup(this.byResponse, agent, row?.response_id, now) ??
      this.lookup(this.bySession, agent, row?.native_session || row?.session, now);
  }

  prune(now = Date.now()) {
    for (const map of [this.byResponse, this.bySession]) {
      for (const [key, entry] of map) {
        if (now - entry.at > this.ttl) map.delete(key);
        else break; // insertion order is oldest first
      }
    }
  }

  size() { return this.byResponse.size + this.bySession.size; }

  clear() { this.byResponse.clear(); this.bySession.clear(); }

  // Values only, newest last. Used by tests and status output.
  values() {
    return [...this.byResponse.values()].map((entry) => ({ ...entry.value }));
  }
}
