import {
  appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// Sent keys are a best-effort local memory of what already reached WakaTime.
// The cursor is still the primary progress record; losing the newest lines can
// only cause a replay, never a skipped row. Lines carry their own time so old
// keys can be dropped without another database.
export const SENT_RETENTION_MS = 3 * 86_400_000;
const MAX_ENTRIES = 120_000;
const MAX_BYTES = 16 * 1024 * 1024;
const KEY = /^[0-9a-f]{64}$/;

function validLine(line) {
  const tab = line.indexOf("\t");
  if (tab <= 0) return null;
  const at = Number(line.slice(0, tab));
  const key = line.slice(tab + 1).trim();
  return Number.isFinite(at) && at > 0 && KEY.test(key) ? { at, key } : null;
}

export class SentLog {
  constructor(file, {
    ttl = SENT_RETENTION_MS, capacity = MAX_ENTRIES, maxBytes = MAX_BYTES, now = Date.now(),
  } = {}) {
    this.file = file;
    this.ttl = ttl;
    this.capacity = capacity;
    this.maxBytes = maxBytes;
    this.keys = new Set();
    this.loaded = 0;
    this.entries = 0;
    this.bytes = 0;
    this.lastCompact = now;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.load(now);
  }

  load(now) {
    let text;
    try { text = readFileSync(this.file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; return; }
    this.bytes = Buffer.byteLength(text);
    const cutoff = now - this.ttl;
    for (const line of text.split("\n")) {
      const entry = validLine(line);
      if (!entry || entry.at < cutoff) continue;
      this.keys.add(entry.key);
    }
    this.entries = this.keys.size;
    this.loaded = this.keys.size;
    if (this.entries > this.capacity || this.bytes > this.maxBytes) this.compact(now);
  }

  has(key) { return this.keys.has(key); }
  get size() { return this.keys.size; }

  // Rows already durable in the queue are equally safe to skip on a re-read,
  // but they are not appended: the queue itself restores them after a restart.
  remember(keys) {
    for (const key of keys) if (KEY.test(key)) this.keys.add(key);
  }

  add(keys, now = Date.now()) {
    const fresh = [];
    for (const key of keys) {
      if (typeof key !== "string" || !KEY.test(key) || this.keys.has(key)) continue;
      this.keys.add(key);
      fresh.push(key);
    }
    if (!fresh.length) return 0;
    const text = `${fresh.map((key) => `${now}\t${key}`).join("\n")}\n`;
    appendFileSync(this.file, text, { mode: 0o600 });
    this.entries += fresh.length;
    this.bytes += Buffer.byteLength(text);
    if (this.entries > this.capacity || this.bytes > this.maxBytes) this.compact(now);
    return fresh.length;
  }

  // Rewrite only when the file is large or a day has passed since the last
  // rewrite. The log is append-only between passes, so the common path is one
  // small write per sent batch.
  prune(now = Date.now(), interval = 86_400_000) {
    if (this.entries <= this.capacity && this.bytes <= this.maxBytes &&
        now - this.lastCompact < interval) return false;
    this.compact(now);
    return true;
  }

  // Rewrite the file without entries older than the retention window. The
  // rewrite uses the same temp-plus-rename rule as the cursor, so a crash can
  // leave the old complete log in place but never a torn one.
  compact(now = Date.now()) {
    const cutoff = now - this.ttl;
    let text = "";
    try { text = readFileSync(this.file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const kept = [], seen = new Set();
    for (const line of text.split("\n")) {
      const entry = validLine(line);
      if (!entry || entry.at < cutoff || seen.has(entry.key)) continue;
      seen.add(entry.key);
      kept.push(`${entry.at}\t${entry.key}`);
    }
    const body = kept.length ? `${kept.join("\n")}\n` : "";
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, body, { mode: 0o600 });
      renameSync(temp, this.file);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* keep the original error */ }
      throw error;
    }
    this.keys = seen;
    this.entries = kept.length;
    this.bytes = Buffer.byteLength(body);
    this.lastCompact = now;
  }
}
