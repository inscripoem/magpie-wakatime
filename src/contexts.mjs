import { ContextJournal } from "./context-journal.mjs";

// Contexts must outlive the cursor's replay window: a batch that was sent but
// whose cursor flush was interrupted is replayed after a restart, and the
// replay must map to the same project, branch and language.
export const CONTEXT_TTL_MS = 10 * 60_000;

export class Contexts {
  constructor({
    ttl = CONTEXT_TTL_MS, capacity = 2_048, journal = null, now = Date.now(),
  } = {}) {
    this.ttl = ttl;
    this.capacity = capacity;
    this.byResponse = new Map();
    this.bySession = new Map();
    this.journal = journal instanceof ContextJournal ? journal : journal ? new ContextJournal(journal) : null;
    this.counts = {
      responseHit: 0, sessionHit: 0, miss: 0, pruned: 0, expired: 0, noKey: 0, journalErrors: 0,
    };
    const loaded = this.loadJournal(now);
    if (loaded !== null) this.compactJournal(now, loaded);
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

  // The response hook has both identifiers at hand; one journal line feeds
  // both lookups, so a restart can still match either one.
  record(agent, { response, session } = {}, value, now = Date.now()) {
    let updated = this.setResponse(agent, response, value, now);
    if (this.setSession(agent, session, value, now)) updated = true;
    if (this.journal && value && typeof value === "object" && !Array.isArray(value)) {
      try {
        this.journal.append({
          agent, response, session, t: now,
          project: value.project, branch: value.branch, language: value.language,
        });
      } catch { this.counts.journalErrors++; }
    }
    return updated;
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
    if (now - entry.at > this.ttl) { map.delete(key); this.counts.expired++; return null; }
    return entry.value;
  }

  // The response id is exact; the session is a bounded fallback because a
  // usage row may be rescanned after the response id is no longer known.
  get(row, now = Date.now()) {
    const agent = row?.agent;
    const responseKey = Contexts.key(agent, row?.response_id);
    const sessionKey = Contexts.key(agent, row?.native_session || row?.session);
    if (!responseKey && !sessionKey) { this.counts.noKey++; return null; }
    const response = this.lookup(this.byResponse, agent, row?.response_id, now);
    if (response) { this.counts.responseHit++; return response; }
    const session = this.lookup(this.bySession, agent, row?.native_session || row?.session, now);
    if (session) { this.counts.sessionHit++; return session; }
    this.counts.miss++;
    return null;
  }

  loadJournal(now = Date.now()) {
    if (!this.journal) return [];
    let entries;
    try { entries = this.journal.load(now, this.ttl); }
    catch { this.counts.journalErrors++; return null; }
    for (const entry of entries) {
      const value = {};
      if (entry.project) value.project = entry.project;
      if (entry.branch) value.branch = entry.branch;
      if (entry.language) value.language = entry.language;
      if (!Object.keys(value).length) continue;
      // The journal's original timestamp keeps the TTL honest across restarts.
      if (entry.response) this.set(this.byResponse, entry.agent, entry.response, value, entry.t);
      if (entry.session) this.set(this.bySession, entry.agent, entry.session, value, entry.t);
    }
    return entries;
  }

  compactJournal(now = Date.now(), entries = null) {
    if (!this.journal) return false;
    try { return this.journal.compact(now, this.ttl, entries); }
    catch { this.counts.journalErrors++; return false; }
  }

  maintain(now = Date.now()) {
    this.prune(now);
    if (!this.journal) return false;
    try { return this.journal.maybeCompact(now, this.ttl); }
    catch { this.counts.journalErrors++; return false; }
  }

  prune(now = Date.now()) {
    for (const map of [this.byResponse, this.bySession]) {
      for (const [key, entry] of map) {
        if (now - entry.at > this.ttl) { map.delete(key); this.counts.pruned++; }
        else break; // insertion order is oldest first
      }
    }
  }

  stats() { return { ...this.counts }; }

  size() { return this.byResponse.size + this.bySession.size; }

  clear() { this.byResponse.clear(); this.bySession.clear(); }

  // Values only, newest last. Used by tests and status output.
  values() {
    return [...this.byResponse.values()].map((entry) => ({ ...entry.value }));
  }
}
