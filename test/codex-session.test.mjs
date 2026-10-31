import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexSessions } from "../src/codex-session.mjs";
import { tempDirectory } from "./helpers.mjs";

const session = "01a19120-9803-7c13-b8e5-90e8df2fb80d";

function day(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function writeSession(home, lines) {
  const dir = join(home, "sessions", day());
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-test-${session}.jsonl`);
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return file;
}

const meta = { type: "session_meta", payload: { id: session } };
const fileChange = (changes, stdout = "") => ({
  type: "event_msg",
  payload: { type: "item_completed", thread_id: session, item: { type: "FileChange", changes, stdout } },
});

test("reads the latest FileChange language from a session transcript", () => {
  const home = tempDirectory();
  try {
    writeSession(home, [
      meta,
      fileChange({ "/repo/notes.md": {} }, "Success. Updated the following files:\nM notes.md\n"),
      fileChange({ "/repo/app.py": {} }, "Success. Updated the following files:\nM app.py\n"),
    ]);
    expect(new CodexSessions({ home }).language(session)).toBe("Python");
  } finally { rmSync(home, { recursive: true }); }
});

test("uses comma-separated changes keys and skips unrelated events", () => {
  const home = tempDirectory();
  try {
    writeSession(home, [
      meta,
      { type: "event_msg", payload: { type: "agent_message", message: "FileChange but not the event" } },
      fileChange({ "/repo/a.md,/repo/b.md": {} }),
    ]);
    expect(new CodexSessions({ home }).language(session)).toBe("Markdown");
  } finally { rmSync(home, { recursive: true }); }
});

test("picks up a FileChange appended after the first read", () => {
  const home = tempDirectory();
  try {
    const file = writeSession(home, [meta, fileChange({ "/repo/notes.md": {} })]);
    const sessions = new CodexSessions({ home });
    expect(sessions.language(session)).toBe("Markdown");
    appendFileSync(file, `${JSON.stringify(fileChange({ "/repo/main.rs": {} }))}\n`);
    expect(sessions.language(session)).toBe("Rust");
  } finally { rmSync(home, { recursive: true }); }
});

test("returns nothing for a missing session or an unknown extension", () => {
  const home = tempDirectory();
  try {
    expect(new CodexSessions({ home }).language(session)).toBeNull();
    writeSession(home, [meta, fileChange({ "/repo/data.bin": {} })]);
    expect(new CodexSessions({ home }).language(session)).toBeNull();
  } finally { rmSync(home, { recursive: true }); }
});

test("does not parse a partial trailing line until it is complete", () => {
  const home = tempDirectory();
  try {
    const dir = join(home, "sessions", day());
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-test-${session}.jsonl`);
    const line = JSON.stringify(fileChange({ "/repo/late.ts": {} }));
    writeFileSync(file, line.slice(0, 20));
    const sessions = new CodexSessions({ home });
    expect(sessions.language(session)).toBeNull();
    appendFileSync(file, line.slice(20) + "\n");
    expect(sessions.language(session)).toBe("TypeScript");
  } finally { rmSync(home, { recursive: true }); }
});

test("keeps the last language when a change has only unmapped extensions", () => {
  const home = tempDirectory();
  try {
    writeSession(home, [
      meta,
      fileChange({ "/repo/notes.md": {} }),
      fileChange({ "/repo/run.log": {} }),
      fileChange({ "/repo/change.patch": {} }),
    ]);
    expect(new CodexSessions({ home }).language(session)).toBe("Markdown");
  } finally { rmSync(home, { recursive: true }); }
});
