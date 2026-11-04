import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CLAUDE_SESSION_MAX_BYTES, CLAUDE_SESSION_TTL_MS, ClaudeSessions,
} from "../src/claude-session.mjs";
import { tempDirectory } from "./helpers.mjs";

const session = "9b2c7f10-4a6d-4e21-9f3a-1c2d3e4f5a6b";
const other = "1f0e9d8c-7b6a-4958-8473-62514039a2b1";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

function repo(root, name, files, branch = "main") {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-q", "--initial-branch", branch);
  for (const file of files) {
    const path = join(cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  git(cwd, "add", ".");
  return cwd;
}

function writeTranscript(root, { id = session, dir = "-work-real-repo", lines }) {
  const directory = join(root, dir);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${id}.jsonl`);
  writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  return file;
}

function user(cwd, branch = "main", text = "private-prompt", id = session) {
  return {
    type: "user", sessionId: id, cwd, gitBranch: branch, parentUuid: "p1", uuid: "u1",
    message: { role: "user", content: text },
  };
}

// Tool-use content is deliberately present. It must not influence the result
// or be retained in the cache.
function assistant(cwd, branch = "main", id = session) {
  return {
    type: "assistant", sessionId: id, cwd, gitBranch: branch, parentUuid: "p2", uuid: "u2",
    message: { role: "assistant", content: [
      { type: "text", text: "private-answer" },
      { type: "tool_use", id: "t1", name: "Write", input: {
        file_path: "/sentinel/private.rs", content: "private-body",
      } },
    ] },
  };
}

test("derives metadata only and takes language from the recovered cwd's Git index", async () => {
  const root = tempDirectory();
  try {
    const cwd = repo(root, "real-repo", ["src/app.ts", "src/lib.ts", "src/util.js", "notes.md"]);
    writeTranscript(root, { lines: [user(cwd), assistant(cwd)] });
    const sessions = new ClaudeSessions({ root });
    expect(await sessions.context(session)).toEqual({
      project: "real-repo", branch: "main", language: "TypeScript",
    });
    const cached = JSON.stringify(sessions.sessions);
    for (const secret of ["private-prompt", "private-answer", "private-body",
      "/sentinel/private.rs", "private.rs"]) {
      expect(cached).not.toContain(secret);
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("uses the latest cwd and gitBranch and tolerates a missing session field", async () => {
  const root = tempDirectory();
  try {
    const first = repo(root, "old-name", ["main.rs"]);
    const second = repo(root, "new-name", ["main.py"]);
    writeTranscript(root, { lines: [
      { ...user(first, "old-branch"), sessionId: undefined },
      // Format drift: no session id, but the Claude-specific shape remains.
      { type: "attachment", cwd: first, gitBranch: "old-branch", parentUuid: "p3" },
      { type: "assistant", cwd: second, gitBranch: "new-branch", parentUuid: "p4",
        message: { role: "assistant", content: [
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/sentinel/private.rs" } },
        ] } },
    ] });
    expect(await new ClaudeSessions({ root }).context(session)).toEqual({
      project: "new-name", branch: "new-branch", language: "Python",
    });
  } finally { rmSync(root, { recursive: true }); }
});

test("omits language when the recovered cwd is gone or is not a Git repository", async () => {
  const root = tempDirectory();
  try {
    const missing = join(root, "missing-repo");
    writeTranscript(root, { id: session, dir: "-missing",
      lines: [user(missing, "main")] });
    expect(await new ClaudeSessions({ root }).context(session)).toEqual({
      project: "missing-repo", branch: "main",
    });

    const plain = join(root, "plain-repo");
    mkdirSync(plain);
    writeFileSync(join(plain, "app.py"), "");
    writeTranscript(root, { id: other, dir: "-plain",
      lines: [user(plain, "main", "private-prompt", other)] });
    expect(await new ClaudeSessions({ root }).context(other)).toEqual({
      project: "plain-repo", branch: "main",
    });
  } finally { rmSync(root, { recursive: true }); }
});

test("returns null for missing, corrupt, oversized and non-Claude transcripts", async () => {
  const root = tempDirectory();
  try {
    const sessions = new ClaudeSessions({ root });
    expect(await sessions.context(session)).toBeNull();
    expect(await sessions.context("../../etc/passwd")).toBeNull();

    writeTranscript(root, { id: session, dir: "-corrupt", lines: ['{"cwd":"/work/real-repo"'] });
    expect(await new ClaudeSessions({ root }).context(session)).toBeNull();

    const oversized = writeTranscript(root, { id: session, dir: "-oversized",
      lines: [user("/work/oversized", "main")] });
    truncateSync(oversized, CLAUDE_SESSION_MAX_BYTES + 1);
    expect(await new ClaudeSessions({ root }).context(session)).toBeNull();

    writeTranscript(root, { id: session, dir: "-codex", lines: [
      { type: "session_meta", payload: { id: session } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange" } } },
    ] });
    expect(await new ClaudeSessions({ root }).context(session)).toBeNull();
  } finally { rmSync(root, { recursive: true }); }
});

test("caches a miss only briefly so a just-started session is retried", async () => {
  const root = tempDirectory();
  try {
    const sessions = new ClaudeSessions({ root });
    expect(await sessions.context(session, 0)).toBeNull();
    const cwd = repo(root, "late", ["app.py"]);
    writeTranscript(root, { lines: [user(cwd)] });
    expect(await sessions.context(session, 4_999)).toBeNull();
    expect(await sessions.context(session, 5_000)).toEqual({
      project: "late", branch: "main", language: "Python",
    });
  } finally { rmSync(root, { recursive: true }); }
});

test("caches the derived context for its TTL and then re-reads the transcript", async () => {
  const root = tempDirectory();
  try {
    const first = repo(root, "first", ["a.ts"]);
    writeTranscript(root, { lines: [user(first), assistant(first)] });
    const sessions = new ClaudeSessions({ root, ttl: 1000 });
    expect(await sessions.context(session, 0)).toEqual({
      project: "first", branch: "main", language: "TypeScript",
    });
    const second = repo(root, "second", ["b.py"]);
    writeTranscript(root, { lines: [user(second, "dev"), assistant(second, "dev")] });
    expect(await sessions.context(session, 999)).toEqual({
      project: "first", branch: "main", language: "TypeScript",
    });
    expect(await sessions.context(session, 1000)).toEqual({
      project: "second", branch: "dev", language: "Python",
    });
    expect(CLAUDE_SESSION_TTL_MS).toBe(10 * 60_000);
  } finally { rmSync(root, { recursive: true }); }
});

test("bounds the session cache and picks up an appended branch after expiry", async () => {
  const root = tempDirectory();
  try {
    const cwdA = repo(root, "work-one", ["a.ts"]);
    const cwdB = repo(root, "work-two", ["b.rs"]);
    const first = writeTranscript(root, { id: session, dir: "-work-one",
      lines: [user(cwdA), assistant(cwdA)] });
    writeTranscript(root, { id: other, dir: "-work-two",
      lines: [user(cwdB, "main", "private-prompt", other)] });
    const sessions = new ClaudeSessions({ root, ttl: 1000, capacity: 1 });
    expect((await sessions.context(session, 0)).language).toBe("TypeScript");
    expect((await sessions.context(other, 0)).language).toBe("Rust");
    expect(sessions.sessions.size).toBe(1);
    appendFileSync(first, `${JSON.stringify(user(cwdA, "next-branch"))}\n`);
    expect(await sessions.context(session, 1000)).toEqual({
      project: "work-one", branch: "next-branch", language: "TypeScript",
    });
    expect(sessions.sessions.size).toBe(1);
  } finally { rmSync(root, { recursive: true }); }
});
