import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_SESSION_MAX_BYTES, CLAUDE_SESSION_TTL_MS, ClaudeSessions,
} from "../src/claude-session.mjs";
import { tempDirectory } from "./helpers.mjs";

const session = "9b2c7f10-4a6d-4e21-9f3a-1c2d3e4f5a6b";
const other = "1f0e9d8c-7b6a-4958-8473-62514039a2b1";

function writeTranscript(root, { id = session, dir = "-work-real-repo", lines }) {
  const directory = join(root, dir);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${id}.jsonl`);
  writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  return file;
}

function user(cwd = "/work/real-repo", branch = "main", text = "private-prompt", id = session) {
  return {
    type: "user", sessionId: id, cwd, gitBranch: branch, parentUuid: "p1", uuid: "u1",
    message: { role: "user", content: text },
  };
}

function assistant(tools, cwd = "/work/real-repo", branch = "main", id = session) {
  return {
    type: "assistant", sessionId: id, cwd, gitBranch: branch, parentUuid: "p2", uuid: "u2",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "private-answer" },
        ...tools.map((file_path, index) => ({
          type: "tool_use", id: `t${index}`, name: "Edit",
          input: { file_path, old_string: "private-old", new_string: "private-new" },
        })),
      ],
    },
  };
}

test("derives project, branch and dominant language from metadata and tool-use paths", () => {
  const root = tempDirectory();
  try {
    writeTranscript(root, { lines: [
      user(),
      assistant([
        "/work/real-repo/src/app.ts",
        "/work/real-repo/src/lib.ts",
        "/work/real-repo/src/util.js",
        "/work/real-repo/notes.md",
      ]),
    ] });
    const sessions = new ClaudeSessions({ root });
    expect(sessions.context(session)).toEqual({
      project: "real-repo", branch: "main", language: "TypeScript",
    });
    const cached = JSON.stringify(sessions.sessions);
    for (const secret of ["private-prompt", "private-answer", "private-old", "private-new",
      "/work/real-repo/src/app.ts", "notes.md"]) {
      expect(cached).not.toContain(secret);
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("uses the latest cwd and gitBranch and tolerates a missing session field", () => {
  const root = tempDirectory();
  try {
    writeTranscript(root, { lines: [
      { ...user("/work/old-name", "old-branch"), sessionId: undefined },
      { type: "attachment", cwd: "/work/old-name", gitBranch: "old-branch", parentUuid: "p3" },
      // Format drift: no sessionId, but the Claude-specific shape remains.
      { type: "assistant", cwd: "/work/new-name", gitBranch: "new-branch", parentUuid: "p4",
        message: { role: "assistant", content: [
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/work/new-name/main.py" } },
        ] } },
    ] });
    expect(new ClaudeSessions({ root }).context(session)).toEqual({
      project: "new-name", branch: "new-branch", language: "Python",
    });
  } finally { rmSync(root, { recursive: true }); }
});

test("still tail-reads a transcript larger than the head and tail windows", () => {
  const root = tempDirectory();
  try {
    const filler = "+".repeat(64 * 1024);
    writeTranscript(root, {
      id: session, dir: "-work-real-repo", lines: [
        user("/work/real-repo", "main"),
        JSON.stringify({ type: "system", sessionId: session, cwd: "/work/real-repo",
          gitBranch: "main", content: filler }),
        JSON.stringify({ type: "system", sessionId: session, cwd: "/work/real-repo",
          gitBranch: "feature/tail", content: filler }),
        assistant(["/work/real-repo/tool.py", "/work/real-repo/tool.py"], "/work/real-repo", "feature/tail"),
      ],
    });
    expect(new ClaudeSessions({ root }).context(session)).toEqual({
      project: "real-repo", branch: "feature/tail", language: "Python",
    });
  } finally { rmSync(root, { recursive: true }); }
});

test("returns null for missing, corrupt, oversized and non-Claude transcripts", () => {
  const root = tempDirectory();
  try {
    const sessions = new ClaudeSessions({ root });
    expect(sessions.context(session)).toBeNull();
    expect(sessions.context("../../etc/passwd")).toBeNull();

    writeTranscript(root, { id: session, dir: "-corrupt", lines: ['{"cwd":"/work/real-repo"'] });
    expect(new ClaudeSessions({ root }).context(session)).toBeNull();

    const oversized = writeTranscript(root, { id: session, dir: "-oversized",
      lines: [user("/work/oversized", "main")] });
    truncateSync(oversized, CLAUDE_SESSION_MAX_BYTES + 1);
    expect(new ClaudeSessions({ root }).context(session)).toBeNull();

    writeTranscript(root, { id: session, dir: "-codex", lines: [
      { type: "session_meta", payload: { id: session } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange" } } },
    ] });
    expect(new ClaudeSessions({ root }).context(session)).toBeNull();
  } finally { rmSync(root, { recursive: true }); }
});

test("caches a miss only briefly so a just-started session is retried", () => {
  const root = tempDirectory();
  try {
    const sessions = new ClaudeSessions({ root });
    expect(sessions.context(session, 0)).toBeNull();
    writeTranscript(root, { lines: [user("/work/late", "main"), assistant(["/work/late/a.py"], "/work/late")] });
    expect(sessions.context(session, 4_999)).toBeNull();
    expect(sessions.context(session, 5_000)).toEqual({
      project: "late", branch: "main", language: "Python",
    });
  } finally { rmSync(root, { recursive: true }); }
});

test("caches the derived context for its TTL and then re-reads the transcript", () => {
  const root = tempDirectory();
  try {
    writeTranscript(root, { lines: [user("/work/first", "main"), assistant(["/work/first/a.ts"], "/work/first")] });
    const sessions = new ClaudeSessions({ root, ttl: 1000 });
    expect(sessions.context(session, 0)).toEqual({
      project: "first", branch: "main", language: "TypeScript",
    });
    writeTranscript(root, { lines: [user("/work/second", "dev"), assistant(["/work/second/b.py"], "/work/second", "dev")] });
    expect(sessions.context(session, 999)).toEqual({
      project: "first", branch: "main", language: "TypeScript",
    });
    expect(sessions.context(session, 1000)).toEqual({
      project: "second", branch: "dev", language: "Python",
    });
    expect(CLAUDE_SESSION_TTL_MS).toBe(10 * 60_000);
  } finally { rmSync(root, { recursive: true }); }
});

test("bounds the session cache and picks up an appended tool use after expiry", () => {
  const root = tempDirectory();
  try {
    const first = writeTranscript(root, { id: session, dir: "-work-one",
      lines: [user("/work/one", "main"), assistant(["/work/one/a.md"], "/work/one")] });
    writeTranscript(root, { id: other, dir: "-work-two",
      lines: [user("/work/two", "main", "private-prompt", other),
        assistant(["/work/two/b.rs"], "/work/two", "main", other)] });
    const sessions = new ClaudeSessions({ root, ttl: 1000, capacity: 1 });
    expect(sessions.context(session, 0).language).toBe("Markdown");
    expect(sessions.context(other, 0).language).toBe("Rust");
    expect(sessions.sessions.size).toBe(1);
    appendFileSync(first, `${JSON.stringify(assistant(["/work/one/main.py", "/work/one/lib.py"], "/work/one"))}\n`);
    expect(sessions.context(session, 1000).language).toBe("Python");
    expect(sessions.sessions.size).toBe(1);
  } finally { rmSync(root, { recursive: true }); }
});
