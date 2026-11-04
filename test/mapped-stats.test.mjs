import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Sync } from "../src/sync.mjs";
import { collectDay, localDay } from "../src/source.mjs";
import { readOptions } from "../src/config.mjs";
import { tempDirectory } from "./helpers.mjs";

const now = Date.now();
const day = localDay(now);

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

function twoAgents() {
  const stamp = new Date(now).toISOString();
  return [
    { t: stamp, agent: "claude", in: 10, out: 2, session: "claude-session", rid: "claude-1" },
    { t: stamp, agent: "codex", in: 10, out: 2, session: "codex-session", rid: "codex-1" },
  ];
}

test("counts mapped heartbeats per agent and how many lack a language", async () => {
  const directory = tempDirectory();
  const options = readOptions(), worker = new Sync(directory, options);
  try {
    worker.state.activate(options.gatewayUrl, now - 1);
    worker.contexts.setSession("claude", "claude-session",
      { project: "repo", language: "TypeScript" }, now);
    const result = await collectDay(worker.state, options, day, {
      ...worker.collectOptions(now), fetcher: gateway(twoAgents()),
    });
    expect(result.items.map((item) => item.payload.language))
      .toEqual(["TypeScript", undefined]);

    const mapped = {
      total: 2,
      noLanguage: 1,
      agents: {
        claude: { total: 1, noLanguage: 0 },
        codex: { total: 1, noLanguage: 1 },
      },
    };
    expect(worker.mappedSnapshot()).toEqual(mapped);

    worker.persistContextStats();
    expect(worker.state.get("contextStats").mapped).toEqual(mapped);
    expect(worker.status().contextStats.mapped).toEqual(mapped);
  } finally {
    await worker.stop();
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("reports only the top eight agents, sorted, from bounded per-agent counts", () => {
  const directory = tempDirectory();
  const worker = new Sync(directory, readOptions());
  try {
    for (let index = 0; index < 12; index++) {
      worker.countMapped(`agent-${String(index).padStart(2, "0")}`, true);
    }
    worker.countMapped("agent-01", false);
    worker.countMapped("agent-00", true);
    const snapshot = worker.mappedSnapshot();
    expect(snapshot.total).toBe(14);
    expect(snapshot.noLanguage).toBe(1);
    expect(Object.keys(snapshot.agents)).toHaveLength(8);
    expect(Object.keys(snapshot.agents).slice(0, 2)).toEqual(["agent-01", "agent-00"]);
    expect(snapshot.agents["agent-01"]).toEqual({ total: 2, noLanguage: 1 });
    expect(snapshot.agents["agent-00"]).toEqual({ total: 2, noLanguage: 0 });
    expect(snapshot.agents["agent-07"]).toBeDefined();
    expect(snapshot.agents["agent-08"]).toBeUndefined();

    // A returned snapshot is detached from later counters.
    snapshot.agents["agent-00"].total = 99;
    expect(worker.mappedSnapshot().agents["agent-00"].total).toBe(2);
  } finally {
    worker.stopped = true;
    worker.close();
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("mapping is unchanged when no counter callback is supplied", async () => {
  const directory = tempDirectory();
  const options = readOptions(), worker = new Sync(directory, options);
  try {
    worker.state.activate(options.gatewayUrl, now - 1);
    worker.contexts.setSession("claude", "claude-session",
      { project: "repo", language: "TypeScript" }, now);
    const deps = { ...worker.collectOptions(now), fetcher: gateway(twoAgents()) };
    delete deps.onMapped;
    const result = await collectDay(worker.state, options, day, deps);
    expect(result.items.map((item) => item.payload.project)).toEqual(["repo", "Magpie"]);
    expect(worker.mappedSnapshot()).toEqual({ total: 0, noLanguage: 0, agents: {} });
  } finally {
    await worker.stop();
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});
