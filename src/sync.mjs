#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { State } from "./state.mjs";
import { Contexts, CONTEXT_TTL_MS } from "./contexts.mjs";
import { Queue, QueueFullError, QUEUE_CAPACITY, ACK_RETENTION_MS, queueStatus } from "./queue.mjs";
import { BATCH_ROWS, EnqueueBuffer, AckGate } from "./batching.mjs";
import { collectDay, localDay } from "./source.mjs";
import { ClaudeSessions } from "./claude-session.mjs";
import { CodexSessions } from "./codex-session.mjs";
import { readApiKey, defaultDirectory } from "./config.mjs";
import { defaultUserAgent } from "./user-agent.mjs";

const SCAN_MS = 30_000;
const REVIEW_MS = 10 * 60_000;
// A tick reads at most this many 25-row windows across backfill, today and
// reviews. The cap bounds source reads and HTTP work per tick; the cursor
// keeps exact progress between ticks.
const SCAN_WINDOWS = 32;
const PRUNE_MS = 6 * 3_600_000;
const SEEN_TTL_MS = 3 * 86_400_000;
const SEEN_CAPACITY = 60_000;
// Internal bound for distinct agent names seen without cwd; status reports
// only the largest eight so one unusual client cannot grow the diagnostic.
const NO_CWD_AGENT_CAPACITY = 64;
const NO_CWD_AGENT_TOP = 8;
// The mapped-language diagnostic is bounded the same way: 64 distinct agents
// internally, the eight largest in status and persisted diagnostics.
const MAPPED_AGENT_CAPACITY = 64;
const MAPPED_AGENT_TOP = 8;

export function retryDelay(attempt, header, now) {
  const seconds = header && Number(header);
  const server = header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now) : 0;
  const backoff = Math.min(300_000, 5000 * 2 ** Math.min(attempt, 6));
  return Math.max(5000, Math.min(300_000, backoff * (0.8 + Math.random() * 0.4)), Number.isFinite(server) ? server : 0);
}

// Process-local memory of rows already offered. It is a performance cache
// only: the durable queue dedupes by source id, so correctness never depends
// on this surviving a restart.
export class Seen {
  constructor({ ttl = SEEN_TTL_MS, capacity = SEEN_CAPACITY } = {}) {
    this.ttl = ttl;
    this.capacity = capacity;
    this.map = new Map();
  }

  has(id) { return this.map.has(id); }

  add(id, now = Date.now()) {
    const expiry = now + this.ttl;
    this.map.delete(id);
    this.map.set(id, expiry);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }

  prune(now = Date.now()) {
    for (const [id, expiry] of this.map) {
      if (expiry <= now) this.map.delete(id);
      else break;
    }
  }

  get size() { return this.map.size; }
}

// One WakaTime bulk request. The caller decides what each per-item code means;
// this function only reports them and never turns a network failure into an
// acknowledgement.
async function postChunk(key, items, { now = Date.now(), fetcher = fetch, signal } = {}) {
  let response, codes, error = null, retryAfter;
  try {
    response = await fetcher("https://api.wakatime.com/api/v1/users/current/heartbeats.bulk", {
      method: "POST", redirect: "manual",
      headers: {
        "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(key).toString("base64")}`,
        "User-Agent": defaultUserAgent,
        "X-Machine-Name": new URLSearchParams({ name: hostname() }).toString().slice(5),
        Timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      body: `[${items.map((item) => JSON.stringify(item.payload)).join(",")}]`,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    retryAfter = response.headers.get("retry-after");
    if ([401, 403].includes(response.status)) {
      return { codes: items.map(() => response.status), error: `wakatime-http-${response.status}`, retryAfter, auth: true };
    }
    if ([201, 202].includes(response.status)) {
      const body = await response.json();
      if (!Array.isArray(body?.responses) || body.responses.length > items.length) throw new Error("schema");
      codes = items.map((_, index) => {
        const entry = body.responses[index];
        return Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[1]) && entry[1] >= 200 && entry[1] <= 599 ? entry[1] : 0;
      });
      if (codes.includes(0)) error = "wakatime-schema";
    } else {
      codes = items.map(() => response.status);
      error = `wakatime-http-${response.status}`;
      await response.body?.cancel();
    }
  } catch {
    if (signal?.aborted) return { codes: items.map(() => 0), aborted: true };
    codes = items.map(() => 0);
    error = response ? "wakatime-schema" : "wakatime-network";
  }
  return { codes, error, retryAfter };
}

function permanent(code) {
  return code >= 400 && code < 500 && ![401, 403, 408, 429].includes(code);
}

export class Sync {
  constructor(directory, options, {
    env = process.env, enabled = () => true, fetcher = fetch, sourceFetcher = fetch, now = Date.now(),
    queueCapacity = QUEUE_CAPACITY, claudeSessions = null, codexSessions = null,
  } = {}) {
    const stateDirectory = join(directory, "magpie-wakatime");
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    this.state = new State(join(stateDirectory, "state.json"), { now });
    this.contexts = new Contexts({
      ttl: CONTEXT_TTL_MS, journal: join(stateDirectory, "contexts.log"), now,
    });
    this.claudeSessions = claudeSessions ?? new ClaudeSessions({
      root: options.claudeProjectsRoot ?? null, env,
    });
    // The hook keeps its own reader. Both only read the transcript, and each
    // keeps its own byte offset, so a scan and a hook cannot corrupt progress.
    this.codexSessions = codexSessions ?? new CodexSessions({
      home: options.codexHome ?? null, env,
    });
    this.queue = new Queue(join(stateDirectory, "queue.sqlite"), { capacity: queueCapacity });
    // A's buffer and staged commits are reused unchanged: mapped rows wait
    // here until 25 rows or one window, and no cursor moves past them.
    this.buffer = new EnqueueBuffer();
    this.ackGate = new AckGate();
    // Cursor and backfill commits that cover rows still sitting in the buffer.
    // They run only after the buffer is fully handled.
    this.pendingCommits = [];
    this.seen = new Seen();
    this.directory = directory;
    this.options = options;
    this.env = env;
    this.enabled = enabled;
    this.fetcher = fetcher;
    this.sourceFetcher = sourceFetcher;
    this.owner = randomUUID();
    this.abort = new AbortController();
    this.nextScan = 0;
    this.nextReview = 0;
    this.nextPrune = 0;
    this.hasLease = false;
    this.activated = false;
    this.sourceBlocked = false;
    this.blockedKey = null;
    this.stats = { sent: 0, rejected: 0, lastConfirmedAt: null };
    this.hookStats = {
      ok: 0, stopped: 0, disabled: 0, notActivated: 0, origin: 0, excludedAgent: 0,
      noCwd: 0, aborted: 0, notDirectory: 0, projectEmpty: 0, discarded: 0, error: 0,
    };
    this.noCwdAgents = new Map();
    this.mappedAgents = new Map();
    this.mappedTotal = 0;
    this.mappedNoLanguage = 0;
    this.stopped = false;
  }

  countHook(reason, agent) {
    if (Object.hasOwn(this.hookStats, reason)) this.hookStats[reason]++;
    if (reason === "noCwd") this.countNoCwdAgent(agent);
  }

  countNoCwdAgent(value) {
    const agent = typeof value === "string" && value.trim()
      ? value.trim().slice(0, 255) : "unknown";
    this.noCwdAgents.set(agent, (this.noCwdAgents.get(agent) ?? 0) + 1);
    if (this.noCwdAgents.size <= NO_CWD_AGENT_CAPACITY) return;
    let smallest = null;
    for (const [key, count] of this.noCwdAgents) {
      if (!smallest || count < smallest.count || (count === smallest.count && key > smallest.key)) {
        smallest = { key, count };
      }
    }
    this.noCwdAgents.delete(smallest.key);
  }

  // Counts plus the bounded per-agent noCwd map used in diagnostics and
  // status. A new object each time keeps the state snapshot immutable.
  hookSnapshot() {
    const noCwdAgents = [...this.noCwdAgents.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, NO_CWD_AGENT_TOP);
    return { ...this.hookStats, noCwdAgents: Object.fromEntries(noCwdAgents) };
  }

  // Counted after a row becomes a heartbeat. Only aggregate counts are kept;
  // no row, path, project or language value is stored here.
  countMapped(value, hasLanguage) {
    const agent = typeof value === "string" && value.trim()
      ? value.trim().slice(0, 255) : "unknown";
    this.mappedTotal++;
    if (!hasLanguage) this.mappedNoLanguage++;
    const entry = this.mappedAgents.get(agent) ?? { total: 0, noLanguage: 0 };
    entry.total++;
    if (!hasLanguage) entry.noLanguage++;
    this.mappedAgents.set(agent, entry);
    if (this.mappedAgents.size <= MAPPED_AGENT_CAPACITY) return;
    let smallest = null;
    for (const [key, value] of this.mappedAgents) {
      if (!smallest || value.total < smallest.total ||
          (value.total === smallest.total && (value.noLanguage < smallest.noLanguage ||
          (value.noLanguage === smallest.noLanguage && key > smallest.key)))) {
        smallest = { key, total: value.total, noLanguage: value.noLanguage };
      }
    }
    this.mappedAgents.delete(smallest.key);
  }

  mappedSnapshot() {
    const agents = [...this.mappedAgents.entries()]
      .sort((a, b) => b[1].total - a[1].total || b[1].noLanguage - a[1].noLanguage ||
        (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, MAPPED_AGENT_TOP)
      .map(([name, value]) => [name, { ...value }]);
    return {
      total: this.mappedTotal,
      noLanguage: this.mappedNoLanguage,
      agents: Object.fromEntries(agents),
    };
  }

  // Diagnose why usage rows lose their project and language: how often the
  // request hook set a context, and how often the scan failed to find one.
  // Numbers only; they ride the next cursor flush and appear in `status`.
  persistContextStats() {
    this.state.setDiagnostic("contextStats", {
      hook: this.hookSnapshot(),
      lookup: this.contexts.stats(),
      mapped: this.mappedSnapshot(),
    });
  }

  // Each call maps at most the free room in the 25-row buffer, so the buffer
  // can never exceed the flush threshold and the crash duplicate bound stays
  // at one flush. The source returns the cursor for exactly that prefix.
  collectOptions(now, limit = BATCH_ROWS) {
    // The opt-out guarantees that a scan performs no local session-file reads.
    const fallback = this.options.sessionFallback !== false;
    return {
      now, signal: this.abort.signal, fetcher: this.sourceFetcher,
      contexts: this.contexts,
      claudeSessions: fallback ? this.claudeSessions : null,
      codexSessions: fallback ? this.codexSessions : null,
      onMapped: (agent, hasLanguage) => this.countMapped(agent, hasLanguage),
      seen: this.seen, budget: 20, limit,
    };
  }

  // Persist rows that a direct send could not deliver. One transaction covers
  // the whole remainder: either every row becomes durable or the caller leaves
  // the cursor behind all of them. The enqueue window is bypassed because a
  // failed send needs durability immediately.
  persist(items, now) {
    if (!items.length) return true;
    try {
      this.queue.enqueue(items, now);
      this.state.setDiagnostic("queueError", null);
      return true;
    } catch (error) {
      this.state.setDiagnostic("queueError",
        error instanceof QueueFullError ? "queue-full" : "enqueue-failed");
      this.state.setDiagnostic("runtime", "backlog");
      return false;
    }
  }

  // Option A's staged commits: a cursor or backfill advance waits until no
  // mapped row is still in the buffer, so a committed cursor never passes an
  // unsent row. Applying a commit also flushes the state.
  stage(commit, now) {
    this.pendingCommits.push(commit);
    this.applyCommits(now);
  }

  applyCommits(now) {
    if (this.buffer.length || !this.pendingCommits.length) return false;
    const commits = this.pendingCommits;
    this.pendingCommits = [];
    for (const commit of commits) commit();
    if (now !== undefined) this.state.flush(now, true);
    return true;
  }

  // Send the buffered rows directly in BATCH_ROWS requests. The buffer is
  // cleared and the staged cursors apply only after every buffered row is
  // delivered (2xx), permanently rejected (4xx), or durable in one queue
  // transaction. Buffered rows are never durable themselves, so a crash after
  // a 2xx but before the cursor flush re-sends at most the current buffer.
  async flushBuffer(now, key) {
    if (!this.buffer.ready(now)) return "idle";
    const items = this.buffer.items.slice();
    for (let start = 0; start < items.length; start += BATCH_ROWS) {
      const batch = items.slice(start, start + BATCH_ROWS);
      const result = await postChunk(key, batch, { now, fetcher: this.fetcher, signal: this.abort.signal });
      if (result.aborted) return "aborted";
      if (result.auth) {
        // Every unacknowledged row of this buffer must be durable before the
        // worker pauses; otherwise the buffer stays and the cursor behind it.
        this.blockedKey = key;
        this.state.setDiagnostic("credentials", "invalid-key");
        this.state.setDiagnostic("sendError", result.error);
        if (!this.persist(items.slice(start), now)) return "blocked";
        this.finishBuffer(now);
        return "auth";
      }
      const sent = [], rejected = [], deferred = [];
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index], code = result.codes[index];
        if (code >= 200 && code < 300) sent.push(item);
        else if (permanent(code)) rejected.push(item);
        else deferred.push(item);
      }
      this.stats.sent += sent.length;
      this.stats.rejected += rejected.length;
      if (deferred.length) {
        // Stop direct sending at the first transient failure. Only the
        // unacknowledged rows of this buffer become durable, in one
        // transaction that bypasses the 60-second enqueue window.
        const pending = [...deferred, ...items.slice(start + batch.length)];
        this.state.setDiagnostic("sendError", result.error ?? "wakatime-transient");
        if (!this.persist(pending, now)) return "blocked";
        this.finishBuffer(now);
        return "queued";
      }
    }
    // A clean buffer confirms the send only when no older offline row waits.
    if (this.queue.pendingCount() === 0) {
      this.stats.lastConfirmedAt = now;
      this.state.setDiagnostic("sendError", null);
    }
    this.finishBuffer(now);
    return "ok";
  }

  // The whole buffer is handled: drop it, then let the staged cursors move.
  finishBuffer(now) {
    this.buffer.clear();
    this.applyCommits(now);
  }

  // Buffer mapped rows across stable scans exactly like option A, marking them
  // seen immediately so a re-read from the unchanged cursor skips them. A full
  // buffer leaves the rest of the scan result for a later pass.
  async bufferItems(items, now, key) {
    const accepted = this.buffer.add(items, now);
    for (let index = 0; index < accepted.length; index++) this.seen.add(accepted[index].id, now);
    if (!this.buffer.ready(now)) return { accepted: accepted.length, status: "idle" };
    return { accepted: accepted.length, status: await this.flushBuffer(now, key) };
  }

  // Process one day in windows. Each collectDay call names the cursor for the
  // rows it mapped; the staged commit applies only after the buffer sends or
  // durably enqueues them. Returns the windows used and whether the day ended.
  async scanDay(target, now, key, budget, kind) {
    let used = 0;
    while (used < budget) {
      const limit = Math.max(1, BATCH_ROWS - this.buffer.length);
      const result = await collectDay(this.state, this.options, target, this.collectOptions(now, limit));
      used++;
      if (!result.stable) return { used, stop: true };
      const { accepted, status } = await this.bufferItems(result.items, now, key);
      if (accepted < result.items.length) return { used, stop: true };
      const next = result.complete && kind === "backfill"
        ? localDay(`${target}T12:00:00`, 1) : null;
      this.stage(() => {
        this.state.setCursor(target, result.cursor);
        if (result.complete) {
          if (kind === "today") {
            this.state.set("backfillDay", target);
          } else if (kind === "backfill") {
            const last = this.state.get("lastCompleteDay");
            if (!last || target > last) this.state.set("lastCompleteDay", target);
            this.state.set("backfillDay", next);
          }
        }
      }, now);
      // A queued failure, a paused key or an unfixable buffer ends the pass.
      if (status !== "ok" && status !== "idle") return { used, stop: true };
      if (result.complete) return { used, complete: true };
    }
    return { used, complete: false };
  }

  async scan(now, key) {
    if (this.buffer.full) return;
    const firstDay = localDay(this.state.get("enabledAt"));
    const today = localDay(now);
    let day = this.state.get("backfillDay") ?? firstDay;
    if (day > today) day = today;
    let budget = SCAN_WINDOWS;

    for (let count = 0; count < 3 && day < today && budget > 0; count++) {
      const target = day;
      const outcome = await this.scanDay(target, now, key, budget, "backfill");
      budget -= outcome.used;
      if (outcome.stop) return;
      if (!outcome.complete) return;
      day = localDay(`${target}T12:00:00`, 1);
    }

    if (day >= today && budget > 0) {
      const outcome = await this.scanDay(today, now, key, budget, "today");
      budget -= outcome.used;
      if (outcome.stop || !outcome.complete) return;
    }

    // A day that has already been completed can still receive a request that
    // finished late. Its cursor makes the check cheap: an unchanged head and
    // total means two page reads and no write. Only days with a cursor are
    // reviewed here; an older day without one is still handled by backfill.
    if (now >= this.nextReview && budget > 0) {
      this.nextReview = now + REVIEW_MS;
      for (const offset of [-1, -2]) {
        if (budget <= 0) break;
        const target = localDay(now, offset);
        if (target < firstDay || !this.state.cursor(target)) continue;
        const outcome = await this.scanDay(target, now, key, budget, "review");
        budget -= outcome.used;
        if (outcome.stop) return;
      }
    }
  }

  // Send the oldest due entries. The gate holds a small trickle for at most
  // one window, while a full batch opens immediately; once open, every due
  // batch is sent and acknowledged before the next request. Acks are durable
  // before the next batch is requested; transient failures stay queued with a
  // backoff.
  async drain(key, now) {
    if (this.queue.pendingCount() === 0) {
      this.stats.lastConfirmedAt = now;
      this.state.setDiagnostic("sendError", null);
      return { ok: true };
    }
    if (!this.ackGate.open(this.queue.pendingDue(now), now)) return { ok: false, gated: true };
    for (;;) {
      const entries = this.queue.pending(now, BATCH_ROWS);
      if (!entries.length) {
        // Deferred entries are still pending, just not due yet: keep the last
        // transient error visible instead of reporting a clean queue.
        if (this.queue.pendingCount() > 0) return { ok: false };
        break;
      }
      const result = await postChunk(key, entries, { now, fetcher: this.fetcher, signal: this.abort.signal });
      if (result.aborted) return { ok: false, sent: 0 };
      if (result.auth) {
        this.blockedKey = key;
        this.state.setDiagnostic("credentials", "invalid-key");
        this.state.setDiagnostic("sendError", result.error);
        return { ok: false, auth: true };
      }
      const sentIds = [], rejectedIds = [], deferred = [];
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index], code = result.codes[index];
        if (code >= 200 && code < 300) sentIds.push(entry.id);
        else if (permanent(code)) rejectedIds.push(entry.id);
        else deferred.push(entry);
      }
      if (sentIds.length || rejectedIds.length) this.queue.ack([...sentIds, ...rejectedIds], now);
      this.stats.sent += sentIds.length;
      this.stats.rejected += rejectedIds.length;
      if (deferred.length) {
        const attempts = deferred.reduce((max, entry) => Math.max(max, entry.attempts), 0);
        this.queue.defer(deferred, now + retryDelay(attempts, result.retryAfter, now));
        this.state.setDiagnostic("sendError", result.error ?? "wakatime-transient");
        return { ok: false };
      }
    }
    this.stats.lastConfirmedAt = now;
    this.state.setDiagnostic("sendError", null);
    return { ok: true };
  }

  async tick(now = Date.now()) {
    if (this.stopped) return;
    if (!this.enabled()) {
      this.state.setDiagnostic("runtime", "disabled");
      this.abort.abort();
      return;
    }
    let key;
    try {
      key = readApiKey(this.directory, this.options.apiKeyEnv, this.env, this.options.authAccount);
    } catch (error) {
      this.state.setDiagnostic("credentials",
        ["key-account-missing", "key-account-ambiguous"].includes(error.message) ? error.message : "key-config-unreadable");
      if (this.hasLease) { this.state.release(this.owner); this.hasLease = false; }
      return;
    }
    if (!key) {
      this.state.setDiagnostic("credentials", "missing-key");
      if (this.hasLease) { this.state.release(this.owner); this.hasLease = false; }
      return;
    }
    if (!this.hasLease) {
      if (!this.state.acquire(this.owner, now)) { this.hasLease = false; return; }
      this.hasLease = true;
    }
    if (!this.state.owns(this.owner, now)) {
      this.hasLease = false;
      this.state.setDiagnostic("runtime", "lease-lost");
      return;
    }
    this.state.setDiagnostic("credentials", key === this.blockedKey ? "invalid-key" : "configured");
    this.state.setDiagnostic("runtime", "running");
    if (this.blockedKey !== null && key !== this.blockedKey) {
      this.blockedKey = null;
      this.nextScan = 0;
    }
    if (!this.activated && !this.sourceBlocked) {
      try { this.state.activate(this.options.gatewayUrl, now); this.activated = true; }
      catch {
        this.state.setDiagnostic("sourceError", "source-changed");
        this.sourceBlocked = true;
      }
    }
    if (this.sourceBlocked) return;
    if (key === this.blockedKey) { this.persistContextStats(); this.state.flush(now); return; }

    this.contexts.maintain(now);
    this.seen.prune(now);
    if (now >= this.nextPrune) {
      this.nextPrune = now + PRUNE_MS;
      this.state.pruneCursors(localDay(now, -3));
      // While an old backfill day is still unscanned, a cursor reset can
      // re-read it. Keep its acknowledgement tombstones even past the normal
      // retention so those rows cannot be re-sent.
      const backlogStart = this.state.get("backfillDay") ?? localDay(this.state.get("enabledAt"));
      if (!backlogStart || backlogStart >= localDay(now, -3)) {
        this.queue.pruneAcked(now - ACK_RETENTION_MS);
      }
    }

    // A buffer that reached 25 rows or one window is sent directly before any
    // new scan. A failure durably queues it, then the offline queue drains.
    if (this.buffer.length) {
      const status = await this.flushBuffer(now, key);
      if (status !== "ok" && status !== "idle") {
        // A blocked enqueue usually means the offline queue is full; draining
        // it is what frees room for the next attempt. A key pause never drains.
        if ((status === "queued" || status === "blocked") && this.queue.pendingCount() > 0) {
          await this.drain(key, now);
        }
        this.persistContextStats();
        this.state.flush(now, true);
        this.state.flush(now);
        return;
      }
    }
    // Offline rows go next. A restart finishes the durable queue before
    // reading new rows, and the cursor already sits after those rows.
    if (this.queue.pendingCount() > 0) {
      const drained = await this.drain(key, now);
      if (drained.auth) {
        this.persistContextStats();
        this.state.flush(now, true);
        this.state.flush(now);
        return;
      }
    }
    if (now >= this.nextScan) {
      this.nextScan = now + SCAN_MS;
      if (this.queue.status().full) {
        this.state.setDiagnostic("queueError", "queue-full");
        this.state.setDiagnostic("runtime", "backlog");
      } else {
        try {
          await this.scan(now, key);
          this.state.setDiagnostic("sourceError", null);
        } catch (error) {
          this.state.setDiagnostic("sourceError",
            /^(source-|invalid-row)/.test(error.message) ? error.message : "scan-stopped");
        }
      }
    }
    // The direct path already flushed each advanced cursor. Diagnostics and
    // any commit that did not run still ride this flush.
    this.persistContextStats();
    this.state.flush(now, true);
    this.state.flush(now);
    if (key !== this.blockedKey && this.queue.pendingCount() > 0) await this.drain(key, now);
  }

  start() {
    const poll = () => {
      if (this.working || this.stopped) return;
      this.working = this.tick().catch(() => this.state.setDiagnostic("sourceError", "internal-error")).finally(() => {
        this.working = null;
        if (this.abort.signal.aborted) void this.stop();
      });
    };
    this.timer = setInterval(poll, 1000);
    poll();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    await this.working;
    this.persistContextStats();
    this.state.flush(Date.now(), true);
    this.state.release(this.owner);
    this.hasLease = false;
    this.close();
  }

  close() {
    try { this.queue.close(); } catch { /* already closed */ }
  }

  status(now = Date.now()) {
    return {
      ...this.state.status(now),
      ...this.stats,
      active: this.hasLease,
      contextStats: { hook: this.hookSnapshot(), lookup: this.contexts.stats(), mapped: this.mappedSnapshot() },
      contexts: this.contexts.size(),
      seen: this.seen.size,
      queue: this.queue.status(),
    };
  }
}

function cli(args) {
  const command = args.shift();
  if (!command || command === "--help") {
    console.log("magpie-wakatime status|preview [--directory <Magpie config directory>] [--limit 5]");
    return;
  }
  let directory = defaultDirectory();
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (flag === "--directory" && value) directory = resolve(value);
    else if (flag === "--limit" && /^[1-9]\d*$/.test(value ?? "") && Number(value) <= 100) continue;
    else throw new Error("invalid-arguments");
  }
  if (!["status", "preview"].includes(command)) throw new Error("invalid-arguments");
  const stateDirectory = join(directory, "magpie-wakatime");
  const file = join(stateDirectory, "state.json");
  if (!existsSync(file)) {
    console.log(JSON.stringify(command === "status" ? { runtime: "not-started" } : [], null, 2));
    return;
  }
  const data = JSON.parse(readFileSync(file, "utf8"));
  delete data.salt;
  let identity = {};
  try {
    identity = JSON.parse(readFileSync(join(stateDirectory, "identity.json"), "utf8"));
    if (identity && typeof identity === "object") delete identity.salt;
  } catch { /* no identity */ }
  let lock = null;
  try { lock = JSON.parse(readFileSync(join(stateDirectory, "owner.lock", "owner.json"), "utf8")); } catch { /* no lock */ }
  let active = !!lock?.owner;
  if (active && lock.host === hostname() && Number.isSafeInteger(lock.pid)) {
    try { process.kill(lock.pid, 0); }
    catch (error) { active = error.code !== "ESRCH"; }
  }
  if (command === "preview") {
    console.log(JSON.stringify([], null, 2));
    return;
  }
  const output = { ...identity, ...data, active };
  const queue = queueStatus(join(stateDirectory, "queue.sqlite"));
  if (queue) output.queue = queue;
  console.log(JSON.stringify(output, null, 2));
}

if (import.meta.main) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message === "invalid-arguments" ? "invalid-arguments" : "state-unreadable"); process.exitCode = 1; }
}
