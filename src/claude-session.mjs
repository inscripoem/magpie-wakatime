import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { completeLines, stringField } from "./transcript-fields.mjs";
import { languageForCwd } from "./git-language.mjs";

export const CLAUDE_SESSION_TTL_MS = 10 * 60_000;
// A miss is retried soon: a session that starts just after a heartbeat should
// not lose project and language for a full positive-cache lifetime.
export const CLAUDE_SESSION_MISS_TTL_MS = 5_000;
// A transcript is only head/tail-read. This cap rejects a file that is so
// large it is unlikely to be one session at all instead of scanning it.
export const CLAUDE_SESSION_MAX_BYTES = 256 * 1024 * 1024;

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 64 * 1024;
const MAX_HEAD_LINES = 20;
const MAX_TAIL_LINES = 20;
const MAX_DIRECTORIES = 256;
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

export class ClaudeSessions {
  constructor({
    root = null, env = process.env, ttl = CLAUDE_SESSION_TTL_MS, capacity = 128,
  } = {}) {
    this._root = root;
    this._env = env;
    this.ttl = ttl;
    this.capacity = capacity;
    // session -> { at, file, value }. value is only the derived context:
    // project, branch and a language inferred from the recovered cwd. No path,
    // prompt, reply, transcript line or tool output is retained.
    this.sessions = new Map();
  }

  get root() {
    if (this._root) return this._root;
    const config = this._env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    return join(config, "projects");
  }

  // Returns { project, branch?, language? } or null. Never throws: a missing,
  // unreadable, corrupt, oversized or non-Claude file is simply a miss.
  async context(session, now = Date.now(), { signal } = {}) {
    if (typeof session !== "string" || !SESSION_ID.test(session)) return null;
    const cached = this.sessions.get(session);
    const age = cached ? now - cached.at : Infinity;
    if (cached && age < (cached.value ? this.ttl : Math.min(this.ttl, CLAUDE_SESSION_MISS_TTL_MS))) {
      return cached.value;
    }
    let file = cached?.file ?? null;
    if (!file || !this.isFile(file)) file = this.locate(session);
    const value = file ? await this.read(file, session, { signal }) : null;
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

  async read(file, session, { signal }) {
    let size;
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size <= 0 || info.size > CLAUDE_SESSION_MAX_BYTES) return null;
      size = info.size;
    } catch { return null; }

    let fd;
    try { fd = openSync(file, "r"); } catch { return null; }
    let metadata;
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
      metadata = this.parse([...head, ...tail], session);
    } catch {
      return null;
    } finally {
      try { closeSync(fd); } catch { /* a failed close leaves the miss intact */ }
    }
    if (!metadata) return null;
    const value = { project: metadata.project };
    if (metadata.branch) value.branch = metadata.branch;
    // The transcript is not a source of language. Reuse the request hook's
    // Git-based detection on the recovered cwd instead.
    const language = await languageForCwd(metadata.cwd, { signal });
    if (language) value.language = language;
    return value;
  }

  // Metadata-only: cwd, gitBranch and the session id are extracted from their
  // string literals. No message or tool-use line is ever JSON-parsed.
  parse(lines, session) {
    let cwd = null, branch = null, matched = false, sawSessionField = false, shape = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      // Top-level metadata is serialized before the message object. Never look
      // past that boundary, so a nested tool input cannot supply a cwd or
      // branch and message content is never inspected.
      const message = line.indexOf('"message"');
      const metadata = message < 0 ? line : line.slice(0, message);
      // Cheap shape signals let a drifted transcript without session ids still
      // pass, while a Codex rollout or an unrelated JSONL does not.
      if (metadata.includes('"parentUuid"') || metadata.includes('"isSidechain"')) shape = true;
      const id = stringField(metadata, "sessionId") ?? stringField(metadata, "session_id");
      if (typeof id === "string" && id) {
        sawSessionField = true;
        // A subagent line can belong to another session; its cwd must not
        // decide this session's context.
        if (id !== session) continue;
        matched = true;
      }
      const nextCwd = stringField(metadata, "cwd");
      if (typeof nextCwd === "string" && isAbsolute(nextCwd)) cwd = nextCwd;
      const nextBranch = stringField(metadata, "gitBranch");
      if (typeof nextBranch === "string" && nextBranch && nextBranch !== "HEAD") branch = nextBranch;
    }
    if (!matched && (sawSessionField || !shape)) return null;
    if (!cwd) return null;
    const project = basename(resolve(cwd));
    if (!project) return null;
    return { cwd, project, branch };
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
