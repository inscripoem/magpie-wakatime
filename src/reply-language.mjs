import { languageForFile } from "./language.mjs";

// Tool names that change a file. Reads are a fallback only when Git could not
// name a language: an explicit edit is the stronger signal.
const WRITE_TOOL = /(?:^|[^a-z])(?:edit|write|create|replace|apply[_-]?patch|patch|str[_-]?replace|multi[_-]?edit|notebook[_-]?edit|insert|append|delete|move|rename)(?:[^a-z]|$)/i;

const PATH_KEYS = new Set([
  "file_path", "filepath", "path", "notebook_path", "notebookpath",
  "target_file", "targetfile", "relative_path", "relativepath",
  "abs_path", "abspath", "filename", "file_name",
]);

// File bodies and shell text are never read: only a path or a patch marker can
// name a file, and the heartbeat only ever carries the language.
const SKIP_KEYS = new Set([
  "content", "old_string", "new_string", "old_str", "new_str", "file_text", "command", "cmd", "stdin",
]);

// apply_patch writes its paths inside the patch text, not in a JSON key.
const PATCH_PATH = /\*\*\* (?:Update|Add|Delete) File: *([^\r\n]+)|\*\*\* Move to: *([^\r\n]+)|\+\+\+ b\/([^\r\n]+)|diff --git a\/[^ \n]+ b\/([^\r\n]+)/g;

const MAX_DEPTH = 8;

function parseArgs(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try { return JSON.parse(value); } catch { return { input: value }; }
}

function pathsIn(value, out, depth = 0) {
  if (depth > MAX_DEPTH || value == null) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(PATCH_PATH)) {
      const path = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (path) out.push(path.trim());
    }
    // A bare path argument, not a command line: no whitespace, known extension.
    if (!out.length && !/[\s\r\n]/.test(value) && languageForFile(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pathsIn(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  // Direct path keys win over patch-like text inside the other values.
  for (const [key, item] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (!SKIP_KEYS.has(name) && typeof item === "string" && PATH_KEYS.has(name)) out.push(item);
  }
  for (const [key, item] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (!SKIP_KEYS.has(name) && !(typeof item === "string" && PATH_KEYS.has(name))) pathsIn(item, out, depth + 1);
  }
}

function callsFor(reply, protocol) {
  const calls = [];
  const add = (name, args) => {
    if (typeof name === "string" && name.trim()) calls.push({ name, args });
  };
  if (protocol === "responses") {
    const body = reply.response && Array.isArray(reply.response.output) ? reply.response : reply;
    for (const item of Array.isArray(body.output) ? body.output : []) {
      if (item?.type === "function_call" || item?.type === "custom_tool_call") {
        add(item.name, item.arguments ?? item.input);
      }
    }
  } else if (protocol === "gemini") {
    const parts = reply.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part?.functionCall) add(part.functionCall.name, part.functionCall.args);
    }
  } else if (protocol === "chat") {
    const message = reply.choices?.[0]?.message ?? {};
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      add(call?.function?.name, call?.function?.arguments);
    }
    if (message.function_call) add(message.function_call.name, message.function_call.arguments);
  } else if (protocol === "anthropic") {
    for (const block of Array.isArray(reply.content) ? reply.content : []) {
      if (block?.type === "tool_use" || block?.type === "server_tool_use") add(block.name, block.input);
    }
  }
  return calls;
}

function toolCalls(reply, protocol) {
  if (!reply || typeof reply !== "object") return [];
  const protocols = protocol ? [protocol] : ["chat", "responses", "anthropic", "gemini"];
  for (const value of protocols) {
    const calls = callsFor(reply, value);
    if (calls.length) return calls;
  }
  return [];
}

function pick(list, write) {
  for (let i = list.length - 1; i >= 0; i--) {
    const paths = [];
    pathsIn(parseArgs(list[i].args), paths);
    for (const path of paths) {
      const language = languageForFile(path);
      if (language) return { language, write };
    }
  }
  return null;
}

// The language of the file this reply edited or read. A write tool wins over a
// read tool; multiple writes are considered newest first. Returns null language
// when no tool call names a file whose extension WakaTime knows.
export function languageFromReply(reply, protocol) {
  const calls = toolCalls(reply, protocol);
  const writes = calls.filter((call) => WRITE_TOOL.test(call.name));
  return pick(writes, true) ?? pick(calls, false) ?? { language: null, write: false };
}
