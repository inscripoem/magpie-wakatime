import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { languageForFile } from "./language.mjs";

export const CLAUDE_SESSION_TTL_MS = 10 * 60_000;
// A miss is retried soon: a session that starts just after a heartbeat should
// not lose project and language for a full positive-cache lifetime.
export const CLAUDE_SESSION_MISS_TTL_MS = 5_000;
// A transcript is only tail-read. This cap rejects a file that is so large it
// is unlikely to be one session at all instead of scanning it on every miss.
export const CLAUDE_SESSION_MAX_BYTES = 256 * 1024 * 1024;

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 1 << 20;
const MAX_HEAD_LINES = 50;
const MAX_TAIL_LINES = 500;
const MAX_PATH_ENTRIES = 4_096;
const MAX_DIRECTORIES = 256;
const PATH_KEYS = ["file_path", "notebook_path"];
// The transcript file is named after the session, so the id must be a plain
// filename component: no separators, no traversal.
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

function readAt(fd, offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    let read;
    try { read = readSync(fd, buffer, total, length - total, offset + total); }
    catch { return buffer.subarray(0, total); }
    if (read <= 0) break;
    total += read;
  }
  return buffer.subarray(0, total);
}

// Extract only a top-level metadata string. Quotes inside a JSON string are
// escaped, so a match preceded by a backslash belongs to nested content and is
// skipped. Only the string literal is decoded; the rest of the line (prompts,
// replies, tool output) is never parsed by this helper.
function field(line, name) {
  const marker = `"${name}"`;
  let index = line.indexOf(marker);
  while (index >= 0) {
    if (index === 0 || line[index - 1] !== "\\") {
      const match = /^\s*:\s*("(?:[^"\\]|\\.)*")/.exec(line.slice(index + marker.length));
      if (!match) return null;
      try { return JSON.parse(match[1]); } catch { return null; }
    }
    index = line.indexOf(marker, index + marker.length);
  }
  return null;
}

function completeLines(text, atEnd) {
  if (!text) return [];
  if (!atEnd || !text.endsWith("\n")) {
    const last = text.lastIndexOf("\n");
    text = last < 0 ? "" : text.slice(0, last + 1);
  }
  return text ? text.split("\n").filter(Boolean) : [];
}

// A tool-use line is the only line this parser decodes in full. Everything
// except the input's file paths is discarded immediately and never cached.
function addToolPaths(line, paths, seen) {
  if (!line.includes('"tool_use"') || paths.size >= MAX_PATH_ENTRIES) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  const content = event?.message?.content ?? event?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || block.type !== "tool_use") continue;
    const input = block.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    for (const key of PATH_KEYS) {
      const value = input[key];
      if (typeof value !== "string" || !value || seen.has(value) || paths.size >= MAX_PATH_ENTRIES) continue;
      seen.add(value);
      paths.add(value);
    }
  }
}

// Tool-use paths are explicit file choices, so documents count here just as
// they do for a reply's tool call. This reuses the same WakaTime extension
// mapping as the reply parser.
function languageOf(paths) {
  const counts = new Map();
  for (const path of paths) {
    const language = languageForFile(path);
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  let best = null;
  for (const [language, count] of counts) {
    if (!best || count > best.count || (count === best.count && language < best.language)) {
      best = { language, count };
    }
  }
  return best?.language ?? null;
}

export class ClaudeSessions {
  constructor({
    root = null, env = process.env, ttl = CLAUDE_SESSION_TTL_MS, capacity = 128,
  } = {}) {
    this._root = root;
    this._env = env;
    this.ttl = ttl;
    this.capacity = capacity;
    // session -> { at, file, value }. value is only the derived context:
    // project, branch and language. No path, prompt, reply or tool output is
    // retained after the read.
    this.sessions = new Map();
  }

  get root() {
    if (this._root) return this._root;
    const config = this._env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    return join(config, "projects");
  }

  // Returns { project, branch?, language? } or null. Never throws: a missing,
  // unreadable, corrupt, oversized or non-Claude file is simply a miss.
  context(session, now = Date.now()) {
    if (typeof session !== "string" || !SESSION_ID.test(session)) return null;
    const cached = this.sessions.get(session);
    const age = cached ? now - cached.at : Infinity;
    if (cached && age < (cached.value ? this.ttl : Math.min(this.ttl, CLAUDE_SESSION_MISS_TTL_MS))) {
      return cached.value;
    }
    let file = cached?.file ?? null;
    if (!file || !this.isFile(file)) file = this.locate(session);
    const value = file ? this.read(file, session) : null;
    this.sessions.delete(session);
    this.sessions.set(session, { at: now, file, value });
    this.evict();
    return value;
  }

  isFile(file) {
    try { return statSync(file).isFile(); } catch { return false; }
  }

  // Claude Code stores each session under its encoded working directory:
  // <projects>/<encoded-cwd>/<sessionId>.jsonl. The lookup inspects only
  // directory entries and never recurses; the directory count is capped.
  locate(session) {
    let entries;
    try { entries = readdirSync(this.root, { withFileTypes: true }); } catch { return null; }
    let checked = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (checked++ >= MAX_DIRECTORIES) break;
      const file = join(this.root, entry.name, `${session}.jsonl`);
      if (this.isFile(file)) return file;
    }
    return null;
  }

  read(file, session) {
    let size;
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size <= 0 || info.size > CLAUDE_SESSION_MAX_BYTES) return null;
      size = info.size;
    } catch { return null; }

    let fd;
    try { fd = openSync(file, "r"); } catch { return null; }
    try {
      const headLength = Math.min(size, MAX_HEAD_BYTES);
      const head = completeLines(readAt(fd, 0, headLength).toString("utf8"),
        headLength >= size).slice(0, MAX_HEAD_LINES);
      const tailStart = Math.max(0, size - MAX_TAIL_BYTES);
      let tailText = readAt(fd, tailStart, size - tailStart).toString("utf8");
      if (tailStart > 0) {
        const newline = tailText.indexOf("\n");
        tailText = newline < 0 ? "" : tailText.slice(newline + 1);
      }
      const tail = completeLines(tailText, true).slice(-MAX_TAIL_LINES);
      return this.parse([...head, ...tail], session);
    } catch {
      return null;
    } finally {
      try { closeSync(fd); } catch { /* a failed close leaves the miss intact */ }
    }
  }

  parse(lines, session) {
    let cwd = null, branch = null, matched = false, sawSessionField = false, shape = false;
    const paths = new Set(), seen = new Set();
    for (const line of lines) {
      if (!line.trim()) continue;
      // Cheap shape signals let a drifted transcript without session ids still
      // pass, while a Codex rollout or an unrelated JSONL does not.
      if (line.includes('"parentUuid"') || line.includes('"isSidechain"')) shape = true;
      const id = field(line, "sessionId") ?? field(line, "session_id");
      if (typeof id === "string" && id) {
        sawSessionField = true;
        // A subagent line can belong to another session; its cwd and paths
        // must not decide this session's context.
        if (id !== session) continue;
        matched = true;
      }
      const nextCwd = field(line, "cwd");
      if (typeof nextCwd === "string" && isAbsolute(nextCwd)) cwd = nextCwd;
      const nextBranch = field(line, "gitBranch");
      if (typeof nextBranch === "string" && nextBranch && nextBranch !== "HEAD") branch = nextBranch;
      addToolPaths(line, paths, seen);
    }
    if (!matched && (sawSessionField || !shape)) return null;
    if (!cwd) return null;
    const project = basename(resolve(cwd));
    if (!project) return null;
    const value = { project };
    if (branch) value.branch = branch;
    const language = languageOf(paths);
    if (language) value.language = language;
    return value;
  }

  evict() {
    while (this.sessions.size > this.capacity) {
      let oldest = null;
      for (const [key, entry] of this.sessions) {
        if (!oldest || entry.at < oldest.at) oldest = { key, at: entry.at };
      }
      this.sessions.delete(oldest.key);
    }
  }
}
