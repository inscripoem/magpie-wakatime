import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { languageForFile } from "./language.mjs";
import { completeLines, stringField } from "./transcript-fields.mjs";
import { languageForCwd } from "./git-language.mjs";

const MAX_CHUNK = 1 << 20;
const MAX_TAIL = 1 << 19;
const MAX_REMAINDER = 1 << 19;
const MAX_META_BYTES = 64 * 1024;
const MAX_META_LINES = 20;
const MAX_SESSIONS = 64;
const MAX_DAYS = 14;
// The quick filter runs before JSON.parse, so message, reasoning and prompt
// lines are never decoded. Only a completed file change is read.
const FILE_CHANGE = /"type"\s*:\s*"FileChange"/;
const SESSION_ID = /^[0-9a-f][0-9a-f-]{15,63}$/i;

function dominant(paths) {
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

// Codex records a FileChange item as { changes: { "<path>[,<path>]": ... },
// stdout: "Success. Updated the following files:\nM <path>\n" }. Both carry
// only paths; the stdout body is not kept.
function pathsOf(item) {
  const paths = [];
  const changes = item?.changes;
  if (changes && typeof changes === "object") {
    for (const key of Object.keys(changes)) {
      for (const path of String(key).split(",")) if (path.trim()) paths.push(path.trim());
    }
  }
  const stdout = typeof item?.stdout === "string" ? item.stdout : "";
  for (const match of stdout.matchAll(/^[AMD] (.+)$/gm)) paths.push(match[1].trim());
  return paths;
}

export class CodexSessions {
  constructor({ home = null, env = process.env } = {}) {
    this._home = home;
    this._env = env;
    this.sessions = new Map();
  }

  get home() {
    return this._home || this._env.CODEX_HOME || join(homedir(), ".codex");
  }

  find(session) {
    if (typeof session !== "string" || !SESSION_ID.test(session)) return null;
    const cached = this.sessions.get(session);
    if (cached?.file) return cached.file;
    if (cached && Date.now() - cached.checked < 5000) return null;
    const root = join(this.home, "sessions");
    const now = new Date();
    for (let offset = 0; offset < MAX_DAYS; offset++) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
      const dir = join(root, String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
      let names;
      try { names = readdirSync(dir); } catch { continue; }
      const name = names.find((value) => value.endsWith(".jsonl") && value.includes(session));
      if (!name) continue;
      const file = join(dir, name);
      this.sessions.set(session, {
        file, offset: 0, remainder: "", language: null, checked: Date.now(),
        cwd: null, cwdChecked: false,
      });
      this.evict();
      return file;
    }
    this.sessions.set(session, {
      file: null, offset: 0, remainder: "", language: null, checked: Date.now(),
      cwd: null, cwdChecked: true,
    });
    this.evict();
    return null;
  }

  evict() {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const oldest = [...this.sessions.entries()]
      .sort((a, b) => (a[1].checked ?? 0) - (b[1].checked ?? 0))
      .slice(0, this.sessions.size - MAX_SESSIONS);
    for (const [session] of oldest) this.sessions.delete(session);
  }

  // The first rollout line is session_meta. Only its `cwd` string is decoded;
  // the rest of the line (instructions, prompts) is left unparsed and is never
  // cached. The head read and line count are bounded.
  metadata(session) {
    const file = this.find(session);
    if (!file) return null;
    const state = this.sessions.get(session);
    if (state.cwdChecked) return state.cwd;
    state.cwdChecked = true;
    let fileSize, length;
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size <= 0) return null;
      fileSize = info.size;
      length = Math.min(fileSize, MAX_META_BYTES);
    } catch { return null; }
    const buffer = Buffer.allocUnsafe(length);
    let read = 0, fd;
    try {
      fd = openSync(file, "r");
      read = readSync(fd, buffer, 0, length, 0);
    } catch {
      return state.cwd;
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* remain a miss */ }
    }
    const lines = completeLines(buffer.subarray(0, read).toString("utf8"), length >= fileSize)
      .slice(0, MAX_META_LINES);
    for (const line of lines) {
      if (!line.includes('"session_meta"')) continue;
      // session_meta serializes cwd before base_instructions. Stop at that
      // boundary so instructions can never supply a cwd.
      const instructions = line.indexOf('"base_instructions"');
      const metadata = instructions < 0 ? line : line.slice(0, instructions);
      const cwd = stringField(metadata, "cwd");
      if (typeof cwd === "string" && isAbsolute(cwd)) {
        state.cwd = cwd;
        return cwd;
      }
    }
    return state.cwd;
  }

  // Scan-time context. When the rollout names a cwd, the language comes from
  // the same read-only Git detection the request hook uses. A rollout without
  // cwd keeps the FileChange path-based language.
  async context(session, { signal, now = Date.now() } = {}) {
    const file = this.find(session);
    if (!file) return null;
    const cwd = this.metadata(session);
    if (cwd) {
      const language = await languageForCwd(cwd, { signal, now });
      const project = basename(resolve(cwd));
      const value = {};
      if (project) value.project = project;
      if (language) value.language = language;
      return Object.keys(value).length ? value : null;
    }
    const language = this.language(session);
    return language ? { language } : null;
  }

  language(session) {
    const file = this.find(session);
    if (!file) return this.sessions.get(session)?.language ?? null;
    const state = this.sessions.get(session);
    let size;
    try { size = statSync(file).size; } catch { return state.language; }
    if (size < state.offset) { state.offset = 0; state.remainder = ""; }
    if (size === state.offset) return state.language;
    let start = state.offset;
    if (!start) start = Math.max(0, size - MAX_TAIL);
    if (size - start > MAX_CHUNK) start = Math.max(0, size - MAX_CHUNK);
    const length = Math.min(size - start, MAX_CHUNK);
    if (length <= 0) return state.language;
    const buffer = Buffer.allocUnsafe(length);
    let fd;
    try {
      fd = openSync(file, "r");
      readSync(fd, buffer, 0, length, start);
    } catch {
      return state.language;
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* keep the last language */ }
    }
    state.offset = start + length;
    const text = state.remainder + buffer.toString("utf8");
    const lines = text.split("\n");
    state.remainder = lines.pop() ?? "";
    if (state.remainder.length > MAX_REMAINDER) state.remainder = "";
    let language = state.language;
    for (const line of lines) {
      if (!FILE_CHANGE.test(line)) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type !== "event_msg" || event?.payload?.type !== "item_completed") continue;
      const item = event.payload.item;
      if (!item || item.type !== "FileChange") continue;
      // A new file change replaces the last result even when its extension is
      // unmapped. A request with no new change keeps the last result, which is
      // the same session-pulse behavior the WakaTime CLI applies to app
      // heartbeats.
      language = dominant(pathsOf(item));
    }
    state.language = language;
    state.checked = Date.now();
    return language;
  }
}
