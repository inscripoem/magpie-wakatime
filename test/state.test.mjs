import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { State } from "../src/state.mjs";
import { tempDirectory } from "./helpers.mjs";

function withState(run) {
  const directory = tempDirectory();
  const file = join(directory, "state.json");
  try { return run(file, directory); }
  finally { rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 }); }
}

test("persists the replay boundary without storing per-request rows", () => {
  withState((file) => {
    let state = new State(file, { now: 1000 });
    const salt = state.salt;
    state.activate("http://127.0.0.1:3425", 2000);
    state.setCursor("2026-11-03", {
      offset: 120, head: "a".repeat(16), tail: "b".repeat(16), total: 120, time: 1792026000000,
    });
    expect(state.flush(1000 + 301_000)).toBe(true);
    state = new State(file, { now: 1000 + 301_000 });
    expect(state.salt).toBe(salt);
    expect(state.get("enabledAt")).toBe(2000);
    expect(state.cursor("2026-11-03")).toEqual({
      offset: 120, head: "a".repeat(16), tail: "b".repeat(16), total: 120, time: 1792026000000,
    });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.cursors["2026-11-03"]).toEqual([120, "a".repeat(16), "b".repeat(16), 120, 1792026000000]);
    expect(JSON.stringify(raw)).not.toContain("payload");
    expect(JSON.stringify(raw)).not.toContain("queue");
  });
});

test("does not rewrite state until the flush interval when only diagnostics change", () => {
  withState((file) => {
    const state = new State(file, { now: 1000 });
    expect(state.stateWrites).toBe(0);
    state.setDiagnostic("sourceError", "source-http-500");
    expect(state.flush(30_000)).toBe(false);
    expect(state.stateWrites).toBe(0);
    state.setCursor("2026-11-03", { offset: 1, head: "h", tail: "t", total: 1, time: 1 });
    expect(state.flush(299_999)).toBe(false);
    expect(state.flush(301_000)).toBe(true);
    expect(state.stateWrites).toBe(1);
    expect(state.status().diagnostics.sourceError).toBe("source-http-500");
  });
});

test("prunes cursors outside the replay window", () => {
  withState((file) => {
    const state = new State(file, { now: 1000 });
    state.setCursor("2026-11-01", { offset: 0, head: null, tail: null, total: 0, time: 0 });
    state.setCursor("2026-11-02", { offset: 0, head: null, tail: null, total: 0, time: 0 });
    expect(state.pruneCursors("2026-11-02")).toBe(true);
    expect(state.cursor("2026-11-01")).toBeNull();
    expect(state.cursor("2026-11-02")).not.toBeNull();
  });
});

function lockState(file, options) {
  return new State(file, { now: 0, host: "test-host", ...options });
}

test("blocks a second writer while the first holds the lock", () => {
  withState((file) => {
    const a = lockState(file, { pid: 100, alive: (pid) => pid === 100 });
    const b = lockState(file, { pid: 200, alive: (pid) => pid === 100 || pid === 200 });
    expect(a.acquire("a", 1000)).toBe(true);
    expect(b.acquire("b", 1001)).toBe(false);
    expect(a.owns("a", 1001)).toBe(true);
    expect(b.owns("b", 1001)).toBe(false);
    const owner = JSON.parse(readFileSync(join(dirname(file), "owner.lock", "owner.json"), "utf8"));
    expect(owner).toEqual({ owner: "a", pid: 100, host: "test-host", at: 1000 });
  });
});

test("steals a same-host lock whose process is dead", () => {
  withState((file) => {
    const a = lockState(file, { pid: 100, alive: (pid) => pid === 100 });
    const b = lockState(file, { pid: 200, alive: () => false });
    expect(a.acquire("a", 1000)).toBe(true);
    expect(b.acquire("b", 2000)).toBe(true);
    expect(b.owns("b", 2000)).toBe(true);
    expect(a.owns("a", 2000 + 61_000)).toBe(false);
  });
});

test("never steals a same-host lock whose process is alive", () => {
  withState((file) => {
    const a = lockState(file, { pid: 100, alive: () => true });
    const b = lockState(file, { pid: 200, alive: () => true });
    expect(a.acquire("a", 1000)).toBe(true);
    expect(b.acquire("b", 10 * 60_000)).toBe(false);
    expect(a.owns("a", 10 * 60_000)).toBe(true);
  });
});

test("releases the lock only for its owner", () => {
  withState((file) => {
    const a = lockState(file, { pid: 100, alive: () => true });
    const b = lockState(file, { pid: 200, alive: () => true });
    expect(a.acquire("a", 1000)).toBe(true);
    expect(b.release("b")).toBe(false);
    expect(a.owns("a", 2000)).toBe(true);
    expect(a.release("a")).toBe(true);
    expect(a.owns("a", 3000)).toBe(false);
    expect(existsSync(join(dirname(file), "owner.lock"))).toBe(false);
  });
});

test("falls back to the ttl for a lock from another host", () => {
  withState((file) => {
    const a = lockState(file, { pid: 100, alive: () => true, host: "other-host" });
    const b = lockState(file, { pid: 200, alive: () => true });
    expect(a.acquire("a", 1000)).toBe(true);
    expect(b.acquire("b", 1000 + 10 * 60_000)).toBe(false);
    expect(b.acquire("b", 1000 + 10 * 60_000 + 1)).toBe(true);
    expect(b.owns("b", 1000 + 10 * 60_000 + 1)).toBe(true);
  });
});

test("steals an unparseable lock directory only after its mtime ages", () => {
  withState((file) => {
    const lockDirectory = join(dirname(file), "owner.lock");
    mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockDirectory, "owner.json"), "{not json");
    const state = lockState(file, { pid: 200, alive: () => false });
    expect(state.acquire("a", 1000)).toBe(false);
    const aged = (Date.now() - 61_000) / 1000;
    utimesSync(lockDirectory, aged, aged);
    expect(state.acquire("a", Date.now())).toBe(true);
  });
});

test("repeated ownership checks cause no lock writes", () => {
  withState((file) => {
    const state = lockState(file, { pid: 100, alive: () => true });
    expect(state.acquire("a", 1000)).toBe(true);
    const writes = state.leaseWrites;
    for (let index = 0; index < 100; index++) {
      expect(state.owns("a", 1000 + index)).toBe(true);
    }
    expect(state.owns("a", 1000 + 300_000)).toBe(true);
    expect(state.leaseWrites).toBe(writes);
  });
});

test("carries identity fields in cursor flushes so either state file restores them", () => {
  withState((file, directory) => {
    const state = new State(file, { now: 1000 });
    state.activate("http://127.0.0.1:3425", 2000);
    state.setCursor("2026-11-03", { offset: 5, head: "h", tail: "t", total: 5, time: 1 });
    expect(state.flush(400_000, true)).toBe(true);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.salt).toBe(state.salt);
    expect(raw.gateway).toBe("http://127.0.0.1:3425");
    expect(raw.enabledAt).toBe(2000);
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    rmSync(file.replace("state.json", "identity.json"), { force: true });
    const restored = new State(file, { now: 500_000 });
    expect(restored.salt).toBe(raw.salt);
    expect(restored.get("gateway")).toBe("http://127.0.0.1:3425");
    expect(restored.get("enabledAt")).toBe(2000);
  });
});
