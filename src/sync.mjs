#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { State } from "./state.mjs";
import { Contexts } from "./contexts.mjs";
import { collectDay, localDay } from "./source.mjs";
import { readApiKey, defaultDirectory } from "./config.mjs";
import { defaultUserAgent } from "./user-agent.mjs";

const BATCH = 25;
const SCAN_MS = 30_000;
const REVIEW_MS = 10 * 60_000;
const PRUNE_MS = 6 * 3_600_000;
const SEEN_TTL_MS = 3 * 86_400_000;
const SEEN_CAPACITY = 60_000;

export function retryDelay(attempt, header, now) {
  const seconds = header && Number(header);
  const server = header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now) : 0;
  const backoff = Math.min(300_000, 5000 * 2 ** Math.min(attempt, 6));
  return Math.max(5000, Math.min(300_000, backoff * (0.8 + Math.random() * 0.4)), Number.isFinite(server) ? server : 0);
}

// Process-local memory of rows already offered. It keeps partial scans and
// restarted cursors from resending rows during the same run. It is not
// durable: a restart deliberately replays from the cursor.
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
  } = {}) {
    const stateDirectory = join(directory, "magpie-wakatime");
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    this.state = new State(join(stateDirectory, "state.json"), { now });
    this.contexts = new Contexts({ ttl: 120_000 });
    this.seen = new Seen();
    this.retry = [];
    this.retryIds = new Set();
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
    this.stopped = false;
  }

  collectOptions(now) {
    return {
      now, signal: this.abort.signal, fetcher: this.sourceFetcher,
      contexts: this.contexts, seen: this.seen, retryIds: this.retryIds, budget: 20,
    };
  }

  async sendItems(key, items, now) {
    if (!items.length) return { ok: true, sent: 0 };
    // A row waiting in the retry queue is not acknowledged: its day's cursor
    // must stay behind so a restart cannot forget it. Rows whose retry already
    // succeeded are in seen and no longer counted here.
    const pending = items.some((item) => this.retryIds.has(item.id));
    let sent = 0;
    for (let start = 0; start < items.length; start += BATCH) {
      const live = items.slice(start, start + BATCH)
        .filter((item) => !this.seen.has(item.id) && !this.retryIds.has(item.id));
      if (!live.length) continue;
      const result = await postChunk(key, live, { now, fetcher: this.fetcher, signal: this.abort.signal });
      if (result.aborted) return { ok: false, sent };
      if (result.auth) {
        this.blockedKey = key;
        this.state.setDiagnostic("credentials", "invalid-key");
        this.state.setDiagnostic("sendError", result.error);
        return { ok: false, sent, auth: true };
      }
      const failed = [];
      for (let index = 0; index < live.length; index++) {
        const item = live[index], code = result.codes[index];
        if (code >= 200 && code < 300) {
          this.seen.add(item.id, now);
          this.stats.sent++;
          sent++;
        } else if (permanent(code)) {
          this.seen.add(item.id, now);
          this.stats.rejected++;
        } else {
          failed.push(item);
        }
      }
      if (failed.length) {
        this.enqueueRetry(failed, now, result.retryAfter);
        this.state.setDiagnostic("sendError", result.error ?? "wakatime-transient");
        return { ok: false, sent };
      }
    }
    this.stats.lastConfirmedAt = now;
    this.state.setDiagnostic("sendError", null);
    return { ok: !pending, sent };
  }

  enqueueRetry(items, now, retryAfter) {
    const fresh = items.filter((item) => !this.retryIds.has(item.id));
    if (!fresh.length) return;
    for (const item of fresh) this.retryIds.add(item.id);
    this.retry.push({ items: fresh, attempts: 0, nextAt: now + retryDelay(0, retryAfter, now) });
  }

  async flushRetries(key, now) {
    if (!this.retry.length) return { ok: true };
    const kept = [];
    for (const entry of this.retry) {
      for (const item of entry.items) {
        if (this.seen.has(item.id)) this.retryIds.delete(item.id);
      }
      entry.items = entry.items.filter((item) => !this.seen.has(item.id));
      if (!entry.items.length) continue;
      if (entry.nextAt > now) { kept.push(entry); continue; }
      const result = await postChunk(key, entry.items, { now, fetcher: this.fetcher, signal: this.abort.signal });
      if (result.aborted) { kept.push(entry); continue; }
      if (result.auth) {
        this.blockedKey = key;
        this.state.setDiagnostic("credentials", "invalid-key");
        kept.push(entry);
        return { ok: false, auth: true };
      }
      const failed = [];
      for (let index = 0; index < entry.items.length; index++) {
        const item = entry.items[index], code = result.codes[index];
        if (code >= 200 && code < 300) {
          this.seen.add(item.id, now);
          this.stats.sent++;
          this.retryIds.delete(item.id);
        } else if (permanent(code)) {
          this.seen.add(item.id, now);
          this.stats.rejected++;
          this.retryIds.delete(item.id);
        } else {
          failed.push(item);
        }
      }
      if (failed.length) {
        entry.items = failed;
        entry.nextAt = now + retryDelay(entry.attempts++, result.retryAfter, now);
        kept.push(entry);
        this.state.setDiagnostic("sendError", result.error ?? "wakatime-transient");
      }
    }
    this.retry = kept;
    if (kept.length) return { ok: false };
    this.stats.lastConfirmedAt = now;
    this.state.setDiagnostic("sendError", null);
    return { ok: true };
  }

  async scan(now, key) {
    const firstDay = localDay(this.state.get("enabledAt"));
    const today = localDay(now);
    let day = this.state.get("backfillDay") ?? firstDay;
    if (day > today) day = today;

    for (let count = 0; count < 3 && day < today; count++) {
      const result = await collectDay(this.state, this.options, day, this.collectOptions(now));
      const sent = await this.sendItems(key, result.items, now);
      if (sent.auth) return;
      if (result.complete && sent.ok && !result.pendingRetry) {
        this.state.setCursor(day, result.cursor);
        const last = this.state.get("lastCompleteDay");
        if (!last || day > last) this.state.set("lastCompleteDay", day);
        day = localDay(`${day}T12:00:00`, 1);
        this.state.set("backfillDay", day);
      } else {
        break;
      }
    }

    if (day >= today) {
      const result = await collectDay(this.state, this.options, today, this.collectOptions(now));
      const sent = await this.sendItems(key, result.items, now);
      if (sent.auth) return;
      if (result.complete && sent.ok && !result.pendingRetry) {
        this.state.setCursor(today, result.cursor);
        this.state.set("backfillDay", today);
      }
    }

    // A day that has already been completed can still receive a request that
    // finished late. Its cursor makes the check cheap: an unchanged head and
    // total means two page reads and no write. Only days with a cursor are
    // reviewed here; an older day without one is still handled by backfill.
    if (now >= this.nextReview) {
      this.nextReview = now + REVIEW_MS;
      for (const offset of [-1, -2]) {
        const day = localDay(now, offset);
        if (day < firstDay || !this.state.cursor(day)) continue;
        const result = await collectDay(this.state, this.options, day, this.collectOptions(now));
        const sent = await this.sendItems(key, result.items, now);
        if (sent.auth) return;
        if (result.complete && sent.ok && !result.pendingRetry) this.state.setCursor(day, result.cursor);
      }
    }
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
    if (key === this.blockedKey) { this.state.flush(now); return; }

    this.contexts.prune(now);
    this.seen.prune(now);
    if (now >= this.nextPrune) {
      this.nextPrune = now + PRUNE_MS;
      this.state.pruneCursors(localDay(now, -3));
    }

    const retried = await this.flushRetries(key, now);
    if (retried.auth) return;

    if (now >= this.nextScan) {
      this.nextScan = now + SCAN_MS;
      try {
        await this.scan(now, key);
        this.state.setDiagnostic("sourceError", null);
      } catch (error) {
        this.state.setDiagnostic("sourceError",
          /^(source-|invalid-row)/.test(error.message) ? error.message : "scan-stopped");
      }
    }
    this.state.flush(now);
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
    this.state.flush(Date.now(), true);
    this.state.release(this.owner);
    this.hasLease = false;
  }

  status(now = Date.now()) {
    return {
      ...this.state.status(now),
      ...this.stats,
      active: this.hasLease,
      pendingRetry: this.retry.length,
      contexts: this.contexts.size(),
      seen: this.seen.size,
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
  console.log(JSON.stringify({ ...identity, ...data, active }, null, 2));
}

if (import.meta.main) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message === "invalid-arguments" ? "invalid-arguments" : "state-unreadable"); process.exitCode = 1; }
}
