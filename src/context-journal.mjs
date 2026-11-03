import {
  appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const JOURNAL_MAX_BYTES = 256 * 1024;
export const JOURNAL_MAX_LINES = 20_000;
export const JOURNAL_COMPACT_MS = 10 * 60_000;

const LIMITS = { agent: 255, response: 512, session: 512, project: 255, branch: 255, language: 255 };
const FIELDS = [
  ["a", "agent"], ["r", "response"], ["s", "session"],
  ["p", "project"], ["b", "branch"], ["l", "language"],
];

function text(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

// Only the identifiers needed to match a usage row and the three WakaTime
// dimensions are persisted. Prompt text, replies, cwd and account data are
// deliberately absent; callers only ever pass a WakaTime context object.
function encode(entry) {
  if (!Number.isFinite(entry?.t) || entry.t <= 0) return null;
  const line = {};
  for (const [key, name] of FIELDS) {
    const value = text(entry[name], LIMITS[name]);
    if (value) line[key] = value;
  }
  if (!line.p && !line.b && !line.l) return null;
  if (!line.r && !line.s) return null;
  line.t = entry.t;
  return JSON.stringify(line);
}

function decode(line) {
  let raw;
  try { raw = JSON.parse(line); }
  catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Number.isFinite(raw.t) || raw.t <= 0) return null;
  const entry = { t: raw.t };
  for (const [key, name] of FIELDS) {
    const value = text(raw[key], LIMITS[name]);
    if (value) entry[name] = value;
  }
  if (!entry.response && !entry.session) return null;
  if (!entry.project && !entry.branch && !entry.language) return null;
  return entry;
}

// Append-only journal that makes request contexts survive an unclean restart.
// Writes are synchronous and last-line-tolerant: a crash can tear the final
// line, so load drops it before the next append. Compaction rewrites only
// unexpired entries through a temporary file and an atomic rename.
export class ContextJournal {
  constructor(file, {
    maxBytes = JOURNAL_MAX_BYTES,
    maxLines = JOURNAL_MAX_LINES,
    compactMs = JOURNAL_COMPACT_MS,
  } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
    this.compactMs = compactMs;
    this.lineCount = null;
    this.lastCheck = 0;
  }

  append(entry) {
    const line = encode(entry);
    if (!line) return false;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
    if (this.lineCount !== null) this.lineCount++;
    return true;
  }

  // Returns valid, unexpired entries oldest first. A trailing line without a
  // newline was torn by a crash; truncate it so the next append starts clean.
  // The scan is byte-based: a UTF-16 index can land inside a multi-byte
  // character and cut valid JSON before the previous newline.
  load(now = Date.now(), ttl = Infinity) {
    let raw;
    try { raw = readFileSync(this.file); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.lineCount = 0;
      return [];
    }
    let content;
    if (raw.length && raw[raw.length - 1] !== 0x0a) {
      let cut = -1;
      for (let index = raw.length - 1; index >= 0; index--) {
        if (raw[index] === 0x0a) { cut = index; break; }
      }
      truncateSync(this.file, cut + 1);
      content = raw.subarray(0, cut + 1).toString("utf8");
    } else {
      content = raw.toString("utf8");
    }
    this.lineCount = content ? content.split("\n").length - 1 : 0;
    const entries = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      const entry = decode(line);
      if (entry && now - entry.t <= ttl) entries.push(entry);
    }
    return entries;
  }

  // Check at most once per interval. Called from the single event loop, so no
  // second writer can interleave with the rewrite.
  maybeCompact(now = Date.now(), ttl = Infinity) {
    if (this.lastCheck && now - this.lastCheck < this.compactMs) return false;
    this.lastCheck = now;
    let size;
    try { size = statSync(this.file).size; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.lineCount = 0;
      return false;
    }
    const tooManyLines = this.lineCount === null ? false : this.lineCount > this.maxLines;
    if (size <= this.maxBytes && !tooManyLines) return false;
    return this.compact(now, ttl);
  }

  compact(now = Date.now(), ttl = Infinity, entries = null) {
    try { statSync(this.file); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.lineCount = 0;
      return false;
    }
    if (!entries) entries = this.load(now, ttl);
    const content = entries.map(encode).filter(Boolean).map((line) => `${line}\n`).join("");
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, content, { mode: 0o600 });
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* keep the original error */ }
      throw error;
    }
    try {
      renameSync(temp, this.file);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* keep the original error */ }
      throw error;
    }
    this.lineCount = entries.length;
    this.lastCheck = now;
    return true;
  }
}
