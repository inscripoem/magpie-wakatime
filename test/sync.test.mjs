import { expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Sync } from "../src/sync.mjs";
import { readOptions } from "../src/config.mjs";
import { localDay, cursorId } from "../src/source.mjs";
import { sourceId } from "../src/map.mjs";
import { tempDirectory } from "./helpers.mjs";

const now = new Date(2026, 10, 3, 12, 0, 0).getTime();
const day = localDay(now);
const row = (id, extra = {}) => ({
  t: new Date(now - 60_000 + id * 1000).toISOString(),
  route_id: id, agent: "codex", provider: "mock", model: "gpt-5.4",
  in: 10, out: 2, cache_read: 0, cache_write: 0, ...extra,
});

function gateway(rows) {
  return async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    const total = rows.length;
    return Response.json({ rows: rows.slice(offset, offset + 500), total, offset: Math.min(offset, total) });
  };
}

function gatewayByDay(days) {
  return async (url) => {
    const parsed = new URL(url);
    const day = parsed.searchParams.get("period").split("..")[0];
    const offset = Number(parsed.searchParams.get("offset"));
    const rows = days[day] ?? [];
    return Response.json({ rows: rows.slice(offset, offset + 500), total: rows.length, offset: Math.min(offset, rows.length) });
  };
}

function waka(handler = null) {
  const calls = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (handler) return handler(calls.length, body, init);
    return Response.json({ responses: body.map(() => [{ data: {} }, 201]) }, { status: 201 });
  };
  fetcher.calls = calls;
  return fetcher;
}

function setup(rows, { activate = true, fetcher = waka(), sourceFetcher = gateway(rows), env = { WAKATIME_API_KEY: "test-key" } } = {}) {
  const directory = tempDirectory();
  const options = readOptions();
  const worker = new Sync(directory, options, { env: { WAKATIME_HOME: directory, ...env }, fetcher, sourceFetcher, now });
  if (activate) {
    worker.state.activate(options.gatewayUrl, now - 120_000);
    // The real activation and the first tick happen at the same instant.
    worker.state.lastFlush = now;
  }
  return { directory, options, worker, fetcher, rows };
}

function cleanup(directory, ...workers) {
  for (const worker of workers) { worker.stopped = true; }
  rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
}

test("sends once, commits the cursor and keeps only tiny JSON state", async () => {
  const rows = [row(3), row(2), row(1)];
  const { directory, worker, fetcher } = setup(rows);
  try {
    await worker.tick(now);
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]).toHaveLength(3);
    expect(worker.state.cursor(day)).toMatchObject({ offset: 3, total: 3 });
    expect(worker.state.cursor(day).head).toBe(cursorId(sourceId(rows[0], worker.state.salt)));
    expect(worker.state.flush(now + 300_000)).toBe(true);
    const stateDirectory = join(directory, "magpie-wakatime");
    expect(readdirSync(stateDirectory).sort()).toEqual(["identity.json", "owner.lock", "state.json"]);
    const raw = readFileSync(join(stateDirectory, "state.json"), "utf8");
    expect(raw.length).toBeLessThan(2_048);
    expect(raw).not.toContain("payload");
    expect(raw).not.toContain("queue");
    expect(worker.status().sent).toBe(3);
  } finally { cleanup(directory, worker); }
});

test("replays from an unflushed cursor and does not replay a flushed one", async () => {
  const rows = [row(2), row(1)];
  const first = setup(rows);
  try {
    await first.worker.tick(now);
    expect(first.fetcher.calls.flat()).toHaveLength(2);
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;

    const replay = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: first.fetcher, sourceFetcher: gateway(rows), now: now + 1000,
    });
    await replay.tick(now + 1000);
    expect(first.fetcher.calls.flat()).toHaveLength(4);
    replay.stopped = true;
  } finally { cleanup(first.directory, first.worker); }

  const second = setup(rows);
  try {
    await second.worker.tick(now);
    second.worker.state.flush(now + 60_000, true);
    second.worker.state.release(second.worker.owner);
    second.worker.stopped = true;

    const resumed = new Sync(second.directory, second.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: second.fetcher, sourceFetcher: gateway(rows), now: now + 61_000,
    });
    await resumed.tick(now + 61_000);
    expect(second.fetcher.calls.flat()).toHaveLength(2);
    expect(resumed.state.cursor(day).offset).toBe(2);
    resumed.stopped = true;
  } finally { cleanup(second.directory, second.worker); }
});

test("keeps the cursor when a batch fails and retries the original payload", async () => {
  const rows = [row(3), row(2), row(1)];
  let attempts = 0;
  const fetcher = waka(() => {
    attempts++;
    return attempts === 1 ? new Response(null, { status: 500 }) :
      Response.json({ responses: [[{}, 201], [{}, 201], [{}, 201]] }, { status: 201 });
  });
  const { directory, worker } = setup(rows, { fetcher });
  try {
    await worker.tick(now);
    expect(worker.state.cursor(day)).toBeNull();
    expect(worker.retry).toHaveLength(1);
    expect(fetcher.calls).toHaveLength(1);
    await worker.tick(now + 61_000);
    expect(fetcher.calls).toHaveLength(2);
    expect(fetcher.calls[1]).toEqual(fetcher.calls[0]);
    expect(worker.state.cursor(day)).toMatchObject({ offset: 3, total: 3 });
    expect(worker.stats.sent).toBe(3);
    expect(worker.retry).toHaveLength(0);
  } finally { cleanup(directory, worker); }
});

test("retries only the failed rows of a partially accepted batch", async () => {
  const rows = [row(2), row(1)];
  let attempts = 0;
  const fetcher = waka((count, body) => {
    attempts++;
    if (attempts === 1) return Response.json({ responses: [[{}, 201], [{}, 500]] }, { status: 201 });
    return Response.json({ responses: body.map(() => [{}, 201]) }, { status: 201 });
  });
  const { directory, worker } = setup(rows, { fetcher });
  try {
    await worker.tick(now);
    expect(worker.state.cursor(day)).toBeNull();
    expect(fetcher.calls[0]).toHaveLength(2);
    await worker.tick(now + 61_000);
    expect(fetcher.calls[1]).toHaveLength(1);
    expect(worker.state.cursor(day).offset).toBe(2);
    expect(worker.stats.sent).toBe(2);
    expect(worker.stats.rejected).toBe(0);
  } finally { cleanup(directory, worker); }
});

test("uses live contexts and falls back after a restart", async () => {
  const rows = [row(2, { response_id: "resp-2" }), row(1, { response_id: "resp-1" })];
  const first = setup(rows);
  try {
    first.worker.contexts.setResponse("codex", "resp-1", { project: "repo", branch: "main", language: "TypeScript" }, now);
    await first.worker.tick(now);
    const payloads = first.fetcher.calls[0];
    expect(payloads.find((payload) => payload.entity === "codex" && payload.project === "repo"))
      .toMatchObject({ project: "repo", branch: "main", language: "TypeScript" });
    expect(payloads.filter((payload) => payload.project === "Magpie")).toHaveLength(1);

    first.worker.state.flush(now + 60_000, true);
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    const late = row(99, { t: new Date(now + 5_000).toISOString(), response_id: "resp-1" });
    rows.unshift(late);
    const restarted = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: first.fetcher,
      sourceFetcher: gateway(rows), now: now + 61_000,
    });
    await restarted.tick(now + 61_000);
    const replay = first.fetcher.calls.at(-1);
    expect(replay).toHaveLength(1);
    expect(replay[0].project).toBe("Magpie");
    expect(replay[0].branch).toBeUndefined();
    restarted.stopped = true;
  } finally { cleanup(first.directory, first.worker); }
});

test("sends a late row appended after the cursor", async () => {
  const rows = [row(2), row(1)];
  const { directory, worker, fetcher } = setup(rows);
  try {
    await worker.tick(now);
    expect(fetcher.calls.flat()).toHaveLength(2);
    const late = row(0, { t: new Date(now - 90_000).toISOString() });
    rows.push(late);
    await worker.tick(now + 30_000);
    expect(fetcher.calls).toHaveLength(2);
    expect(fetcher.calls[1]).toHaveLength(1);
    expect(fetcher.calls[1][0].time).toBe(Date.parse(late.t) / 1000);
    expect(worker.state.cursor(day).offset).toBe(3);
  } finally { cleanup(directory, worker); }
});

test("reviews a completed previous day for a late row", async () => {
  const dayOne = new Date(2026, 10, 3, 23, 59, 0).getTime();
  const dayTwo = dayOne + 11 * 60_000;
  const make = (time, id) => ({
    t: new Date(time).toISOString(), route_id: id, agent: "codex", provider: "mock",
    model: "gpt-5.4", in: 10, out: 2, cache_read: 0, cache_write: 0,
  });
  const days = {
    [localDay(dayOne)]: [make(dayOne - 1000, 1)],
    [localDay(dayTwo)]: [make(dayTwo - 1000, 2)],
  };
  const fetcher = waka();
  const directory = tempDirectory();
  const options = readOptions();
  const worker = new Sync(directory, options, {
    env: { WAKATIME_HOME: directory, WAKATIME_API_KEY: "test-key" },
    fetcher, sourceFetcher: gatewayByDay(days), now: dayOne,
  });
  try {
    worker.state.activate(options.gatewayUrl, dayOne - 120_000);
    worker.state.lastFlush = dayOne;
    await worker.tick(dayOne);
    expect(fetcher.calls).toHaveLength(1);
    expect(worker.state.cursor(localDay(dayOne)).offset).toBe(1);

    // The next day's scan has already moved past the previous day.
    worker.state.set("backfillDay", localDay(dayTwo));
    days[localDay(dayOne)].push(make(dayOne - 2000, 3));
    await worker.tick(dayTwo);
    expect(fetcher.calls.map((call) => call.length)).toEqual([1, 1, 1]);
    expect(worker.state.cursor(localDay(dayOne)).offset).toBe(2);
    expect(fetcher.calls[2][0].time).toBe(Date.parse(new Date(dayOne - 2000).toISOString()) / 1000);
  } finally { cleanup(directory, worker); }
});

test("only the lock owner uploads", async () => {
  const rows = [row(1)];
  const fetcher = waka();
  const directory = tempDirectory();
  const options = readOptions();
  const env = { WAKATIME_API_KEY: "test-key" };
  const a = new Sync(directory, options, { env, fetcher, sourceFetcher: gateway(rows), now });
  const b = new Sync(directory, options, { env, fetcher, sourceFetcher: gateway(rows), now });
  a.state.activate(options.gatewayUrl, now - 120_000);
  try {
    await Promise.all([a.tick(now), b.tick(now)]);
    expect(fetcher.calls.flat()).toHaveLength(1);
    expect(a.state.owns(a.owner, now)).toBe(true);
    expect(b.state.owns(b.owner, now)).toBe(false);
  } finally { cleanup(directory, a, b); }
});

test("pauses on authentication failure until the key rotates", async () => {
  const rows = [row(1)];
  const fetcher = waka((_count, _body, init) => {
    const key = Buffer.from(init.headers.Authorization.slice(6), "base64").toString();
    return key === "rotated-key" ? Response.json({ responses: [[{}, 201]] }, { status: 201 }) :
      new Response(null, { status: 401 });
  });
  const env = { WAKATIME_API_KEY: "expired-key" };
  const { directory, worker } = setup(rows, { fetcher, env });
  try {
    await worker.tick(now);
    expect(worker.status().diagnostics.credentials).toBe("invalid-key");
    expect(worker.state.cursor(day)).toBeNull();
    expect(fetcher.calls).toHaveLength(1);
    await worker.tick(now + 1000);
    expect(fetcher.calls).toHaveLength(1);
    worker.env.WAKATIME_API_KEY = "rotated-key";
    await worker.tick(now + 31_000);
    expect(fetcher.calls).toHaveLength(2);
    expect(worker.state.cursor(day).offset).toBe(1);
  } finally { cleanup(directory, worker); }
});

test("missing credentials never activate or send, and source errors keep the cursor", async () => {
  const rows = [row(1)];
  const fetcher = waka();
  const missing = setup(rows, { activate: false, fetcher, env: {} });
  try {
    await missing.worker.tick(now);
    expect(missing.worker.state.get("enabledAt")).toBeNull();
    expect(missing.worker.status().diagnostics.credentials).toBe("missing-key");
    expect(fetcher.calls).toHaveLength(0);
  } finally { cleanup(missing.directory, missing.worker); }

  const broken = setup(rows, { fetcher, sourceFetcher: async () => { throw new Error("offline"); } });
  try {
    await broken.worker.tick(now);
    expect(broken.worker.status().diagnostics.sourceError).toBe("source-network");
    expect(broken.worker.state.cursor(day)).toBeNull();
    expect(fetcher.calls).toHaveLength(0);
  } finally { cleanup(broken.directory, broken.worker); }
});
