import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Sync } from "../src/sync.mjs";
import { CodexSessions } from "../src/codex-session.mjs";
import { ClaudeSessions } from "../src/claude-session.mjs";
import { collectDay, localDay } from "../src/source.mjs";
import { readOptions } from "../src/config.mjs";
import { bindWorker, onRequest } from "../src/context.hooks.mjs";
import { tempDirectory } from "./helpers.mjs";

const codexSession = "01a19120-9803-7c13-b8e5-90e8df2fb80d";
const claudeSession = "9b2c7f10-4a6d-4e21-9f3a-1c2d3e4f5a6b";
const now = Date.now();
const day = localDay(now);

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

function repo(root, name, files) {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-q", "--initial-branch=main");
  for (const file of files) {
    const path = join(cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  git(cwd, "add", ".");
  return cwd;
}

function sessionDirectory(home) {
  const date = new Date();
  return join(home, "sessions", String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
}

function writeCodexSession(home, {
  session = codexSession, cwd = null, files = [], sentinel = true,
} = {}) {
  const directory = sessionDirectory(home);
  mkdirSync(directory, { recursive: true });
  const lines = [{
    timestamp: new Date().toISOString(), type: "session_meta",
    payload: {
      session_id: session, id: session, timestamp: new Date().toISOString(),
      cwd, git: { branch: "main" },
      base_instructions: sentinel ? { text: "private-instructions" } : {},
    },
  }];
  for (const file of files) {
    lines.push({
      type: "event_msg",
      payload: { type: "item_completed", thread_id: session,
        item: { type: "FileChange", changes: { [file]: {} }, stdout: "private-output" } },
    });
  }
  const target = join(directory, `rollout-test-${session}.jsonl`);
  writeFileSync(target, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return target;
}

function writeClaudeSession(root, cwd, session = claudeSession) {
  const directory = join(root, "-work-claude-repo");
  mkdirSync(directory, { recursive: true });
  const lines = [
    { type: "user", sessionId: session, cwd, gitBranch: "claude-branch",
      parentUuid: "p1", uuid: "u1", message: { role: "user", content: "private-prompt" } },
    { type: "assistant", sessionId: session, cwd, gitBranch: "claude-branch",
      parentUuid: "p2", uuid: "u2", message: { role: "assistant", content: "private-answer" } },
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

function codexRow(extra = {}) {
  return {
    t: new Date(now).toISOString(), agent: "codex", model: "gpt-5.4",
    in: 10, out: 2, session: codexSession, rid: "codex-row", ...extra,
  };
}

async function collect({
  home, rows, claudeRoot = null, optionsOverrides = {}, setup = null, inject = true,
}) {
  const directory = tempDirectory();
  const options = readOptions(optionsOverrides);
  const extra = inject ? {
    codexSessions: new CodexSessions({ home }),
    claudeSessions: new ClaudeSessions({ root: claudeRoot ?? join(directory, "no-claude") }),
  } : {};
  const worker = new Sync(directory, options, extra);
  try {
    worker.state.activate(options.gatewayUrl, now - 1);
    setup?.(worker);
    const result = await collectDay(worker.state, options, day, {
      ...worker.collectOptions(now), fetcher: gateway(rows),
    });
    return { payloads: result.items.map((item) => item.payload), worker };
  } finally {
    await worker.stop();
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("uses the rollout session_meta cwd and the Git index for Codex language", async () => {
  const home = tempDirectory(), work = tempDirectory();
  try {
    const cwd = repo(work, "codex-repo", ["main.rs", "lib.rs"]);
    // The FileChange names a Python file; the recovered cwd must win instead.
    writeCodexSession(home, { cwd, files: ["/sentinel/private.py"] });
    const { payloads, worker } = await collect({ home, rows: [codexRow()] });
    expect(payloads[0]).toMatchObject({
      project: "codex-repo", language: "Rust",
    });
    expect(payloads[0].branch).toBeUndefined();
    const cached = JSON.stringify(worker.codexSessions.sessions);
    for (const secret of ["private-instructions", "private-output", "/sentinel/private.py"]) {
      expect(cached).not.toContain(secret);
    }
    expect(JSON.stringify(worker.state.diagnostics)).not.toContain("private-");
  } finally {
    rmSync(home, { recursive: true });
    rmSync(work, { recursive: true });
  }
});

test("uses FileChange language when the rollout has no cwd", async () => {
  const home = tempDirectory();
  try {
    writeCodexSession(home, { cwd: null, files: ["/repo/app.py", "/repo/lib.py"] });
    const { payloads } = await collect({ home, rows: [codexRow()] });
    expect(payloads[0]).toMatchObject({ project: "Magpie", language: "Python" });
  } finally { rmSync(home, { recursive: true }); }
});

test("keeps explicit project and branch and fills only the language", async () => {
  const home = tempDirectory(), work = tempDirectory();
  try {
    const cwd = repo(work, "codex-repo", ["app.ts"]);
    writeCodexSession(home, { cwd });
    const { payloads, worker } = await collect({
      home,
      rows: [codexRow()],
      setup: (worker) => worker.contexts.setSession("codex", codexSession,
        { project: "explicit", branch: "explicit-branch" }, now),
    });
    expect(payloads[0]).toMatchObject({
      project: "explicit", branch: "explicit-branch", language: "TypeScript",
    });
    // The merge must not write the derived fields into the cached context.
    expect(worker.contexts.get({ agent: "codex", session: codexSession }, now))
      .toEqual({ project: "explicit", branch: "explicit-branch" });
  } finally {
    rmSync(home, { recursive: true });
    rmSync(work, { recursive: true });
  }
});

test("keeps an explicit language over the Git-derived language", async () => {
  const home = tempDirectory(), work = tempDirectory();
  try {
    const cwd = repo(work, "codex-repo", ["app.ts"]);
    writeCodexSession(home, { cwd });
    const { payloads } = await collect({
      home,
      rows: [codexRow()],
      setup: (worker) => worker.contexts.setSession("codex", codexSession,
        { language: "Rust" }, now),
    });
    expect(payloads[0]).toMatchObject({ project: "codex-repo", language: "Rust" });
  } finally {
    rmSync(home, { recursive: true });
    rmSync(work, { recursive: true });
  }
});

test("treats a missing or corrupt Codex session as a no-op", async () => {
  const home = tempDirectory();
  try {
    const missing = await collect({ home, rows: [codexRow({ rid: "missing" })] });
    expect(missing.payloads[0].project).toBe("Magpie");
    expect(missing.payloads[0].language).toBeUndefined();

    const directory = sessionDirectory(home);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `rollout-test-${codexSession}.jsonl`), "not json\n");
    const corrupt = await collect({ home, rows: [codexRow({ rid: "corrupt" })] });
    expect(corrupt.payloads[0].project).toBe("Magpie");
    expect(corrupt.payloads[0].language).toBeUndefined();
  } finally { rmSync(home, { recursive: true }); }
});

test("honors custom Claude and Codex roots from options", async () => {
  const home = tempDirectory(), claudeRoot = tempDirectory(), work = tempDirectory();
  try {
    const codexCwd = repo(work, "codex-repo", ["app.ts"]);
    const claudeCwd = repo(work, "claude-repo", ["main.py"]);
    writeCodexSession(home, { cwd: codexCwd });
    writeClaudeSession(claudeRoot, claudeCwd);
    const { payloads } = await collect({
      home, claudeRoot, inject: false,
      optionsOverrides: { codexHome: home, claudeProjectsRoot: claudeRoot },
      rows: [
        codexRow({ rid: "codex" }),
        { ...codexRow({ rid: "claude" }), agent: "claude", session: claudeSession },
      ],
    });
    expect(payloads[0]).toMatchObject({ project: "codex-repo", language: "TypeScript" });
    expect(payloads[1]).toMatchObject({
      project: "claude-repo", branch: "claude-branch", language: "Python",
    });
  } finally {
    rmSync(home, { recursive: true });
    rmSync(claudeRoot, { recursive: true });
    rmSync(work, { recursive: true });
  }
});

test("sessionFallback=false disables both scan-time session reads", async () => {
  const home = tempDirectory(), claudeRoot = tempDirectory(), work = tempDirectory();
  try {
    const codexCwd = repo(work, "codex-repo", ["app.ts"]);
    const claudeCwd = repo(work, "claude-repo", ["main.py"]);
    writeCodexSession(home, { cwd: codexCwd });
    writeClaudeSession(claudeRoot, claudeCwd);
    const { payloads } = await collect({
      home, claudeRoot,
      optionsOverrides: { sessionFallback: false },
      rows: [
        codexRow({ rid: "codex" }),
        { ...codexRow({ rid: "claude" }), agent: "claude", session: claudeSession },
      ],
    });
    for (const payload of payloads) {
      expect(payload.project).toBe("Magpie");
      expect(payload.language).toBeUndefined();
    }
  } finally {
    rmSync(home, { recursive: true });
    rmSync(claudeRoot, { recursive: true });
    rmSync(work, { recursive: true });
  }
});

test("sessionFallback=false also disables the request hook's Codex file read", async () => {
  const home = tempDirectory(), directory = tempDirectory(), work = tempDirectory();
  try {
    const cwd = repo(work, "hook-repo", ["app.ts"]);
    writeCodexSession(home, { cwd: null, files: ["/sentinel/private.md"] });
    const options = readOptions({ sessionFallback: false });
    const worker = new Sync(directory, options, { codexSessions: new CodexSessions({ home }) });
    try {
      worker.state.activate(options.gatewayUrl, Date.now());
      bindWorker(worker);
      const ctx = { origin: "local", agent: "codex", cwd, session: codexSession,
        state: {}, signal: new AbortController().signal };
      await onRequest({}, ctx);
      // Git detection from ctx.cwd stays; the FileChange Markdown does not.
      expect(ctx.state.wakatime).toMatchObject({ project: "hook-repo", language: "TypeScript" });
    } finally {
      await worker.stop();
    }
  } finally {
    rmSync(home, { recursive: true });
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
    rmSync(work, { recursive: true });
  }
});

test("a full Sync scan supplies the language when the hook context is absent", async () => {
  const home = tempDirectory(), work = tempDirectory(), directory = tempDirectory();
  try {
    const cwd = repo(work, "scan-repo", ["main.rs"]);
    writeCodexSession(home, { cwd });
    const options = readOptions();
    const rows = Array.from({ length: 25 }, (_, index) => codexRow({
      rid: `scan-${index}`,
      t: new Date(now - 60_000 + index).toISOString(),
    }));
    const calls = [];
    const fetcher = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return Response.json({ responses: body.map(() => [{ data: {} }, 201]) }, { status: 201 });
    };
    const worker = new Sync(directory, options, {
      env: { WAKATIME_HOME: directory, WAKATIME_API_KEY: "test-key" },
      fetcher, sourceFetcher: gateway(rows),
      codexSessions: new CodexSessions({ home }),
    });
    try {
      worker.state.activate(options.gatewayUrl, now - 120_000);
      worker.state.lastFlush = now;
      await worker.tick(now);
      const sent = calls.flat();
      expect(sent).toHaveLength(25);
      expect(sent.every((payload) => payload.language === "Rust")).toBe(true);
      expect(sent.every((payload) => payload.project === "scan-repo")).toBe(true);
    } finally {
      await worker.stop();
    }
  } finally {
    rmSync(home, { recursive: true });
    rmSync(work, { recursive: true });
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});
