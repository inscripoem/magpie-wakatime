import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sync } from "../src/sync.mjs";
import { ClaudeSessions } from "../src/claude-session.mjs";
import { collectDay, localDay } from "../src/source.mjs";
import { readOptions } from "../src/config.mjs";
import { tempDirectory } from "./helpers.mjs";

const session = "9b2c7f10-4a6d-4e21-9f3a-1c2d3e4f5a6b";
const now = Date.now();
const day = localDay(now);

function writeTranscript(root) {
  const directory = join(root, "-work-real-repo");
  mkdirSync(directory, { recursive: true });
  const lines = [
    { type: "user", sessionId: session, cwd: "/work/real-repo", gitBranch: "feature/ctx",
      parentUuid: "p1", uuid: "u1", message: { role: "user", content: "private-prompt" } },
    { type: "assistant", sessionId: session, cwd: "/work/real-repo", gitBranch: "feature/ctx",
      parentUuid: "p2", uuid: "u2", message: { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "Write", input: {
          file_path: "/work/real-repo/src/app.ts", content: "private-body",
        } },
        { type: "tool_use", id: "t2", name: "Edit", input: {
          file_path: "/work/real-repo/src/lib.ts", old_string: "a", new_string: "b",
        } },
        { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/work/real-repo/README.md" } },
      ] } },
  ];
  writeFileSync(join(directory, `${session}.jsonl`),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

function gateway(rows) {
  return async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    return Response.json({
      rows: rows.slice(offset, offset + 500),
      total: rows.length,
      offset: Math.min(offset, rows.length),
    });
  };
}

function rows() {
  const stamp = new Date(now).toISOString();
  return [
    { t: stamp, agent: "claude", in: 10, out: 2, session, rid: "fallback-row" },
    { t: stamp, agent: "codex", in: 10, out: 2, session, rid: "codex-row" },
    { t: stamp, agent: "claude", in: 10, out: 2, rid: "no-session-row" },
    { t: stamp, agent: "openai", in: 10, out: 2, session, rid: "openai-row" },
  ];
}

async function collect({ root, projectByAgent = {}, setup = null }) {
  const directory = tempDirectory();
  const options = readOptions({ projectByAgent });
  const worker = new Sync(directory, options, {
    claudeSessions: new ClaudeSessions({ root }),
  });
  try {
    worker.state.activate(options.gatewayUrl, now - 1);
    setup?.(worker);
    const result = await collectDay(worker.state, options, day, {
      ...worker.collectOptions(now), fetcher: gateway(rows()),
    });
    return result.items.map((item) => item.payload);
  } finally {
    await worker.stop();
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("fills only a missing Claude context from the local transcript", async () => {
  const root = tempDirectory();
  try {
    writeTranscript(root);
    const payloads = await collect({ root });
    expect(payloads).toHaveLength(4);
    expect(payloads[0]).toMatchObject({
      project: "real-repo", branch: "feature/ctx", language: "TypeScript",
    });
    // Only agent "claude" is consulted; OpenAI has no session id anyway.
    for (const payload of payloads.slice(1)) {
      expect(payload.project).toBe("Magpie");
      expect(payload.branch).toBeUndefined();
      expect(payload.language).toBeUndefined();
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("never overrides an explicit memory context", async () => {
  const root = tempDirectory();
  try {
    writeTranscript(root);
    const payloads = await collect({
      root,
      setup: (worker) => worker.contexts.setSession("claude", session,
        { project: "explicit", branch: "explicit-branch", language: "Rust" }, now),
    });
    expect(payloads[0]).toMatchObject({
      project: "explicit", branch: "explicit-branch", language: "Rust",
    });
  } finally { rmSync(root, { recursive: true }); }
});

test("keeps a projectByAgent mapping while the transcript supplies branch and language", async () => {
  const root = tempDirectory();
  try {
    writeTranscript(root);
    const payloads = await collect({ root, projectByAgent: { claude: "Forced" } });
    expect(payloads[0]).toMatchObject({
      project: "Forced", branch: "feature/ctx", language: "TypeScript",
    });
  } finally { rmSync(root, { recursive: true }); }
});

test("never overrides a context recovered from the journal", async () => {
  const root = tempDirectory(), directory = tempDirectory();
  const options = readOptions();
  let first = null, second = null;
  try {
    writeTranscript(root);
    first = new Sync(directory, options, { claudeSessions: new ClaudeSessions({ root }) });
    first.state.activate(options.gatewayUrl, now - 1);
    first.contexts.record("claude", { session },
      { project: "journal", branch: "journal-branch", language: "Rust" }, now);
    await first.stop();

    // A fresh worker has no memory of the request; only contexts.log remains.
    second = new Sync(directory, options, { claudeSessions: new ClaudeSessions({ root }) });
    const result = await collectDay(second.state, options, day, {
      ...second.collectOptions(now), fetcher: gateway(rows()),
    });
    expect(result.items[0].payload).toMatchObject({
      project: "journal", branch: "journal-branch", language: "Rust",
    });
  } finally {
    if (second) await second.stop();
    if (first && !first.stopped) await first.stop();
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
    rmSync(root, { recursive: true });
  }
});

test("keeps the configured fallback when the transcript is missing", async () => {
  const root = tempDirectory();
  try {
    const payloads = await collect({ root });
    expect(payloads[0].project).toBe("Magpie");
    expect(payloads[0].language).toBeUndefined();
  } finally { rmSync(root, { recursive: true }); }
});
