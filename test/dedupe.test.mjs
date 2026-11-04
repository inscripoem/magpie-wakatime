import { expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Sync } from "../src/sync.mjs";
import { readOptions } from "../src/config.mjs";
import { localDay, cursorId } from "../src/source.mjs";
import { sourceId, sourceKey } from "../src/map.mjs";
import { SentLog } from "../src/sent-log.mjs";
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

function waka() {
  const calls = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return Response.json({ responses: body.map(() => [{}, 201]) }, { status: 201 });
  };
  fetcher.calls = calls;
  return fetcher;
}

function setup(rows, options = readOptions(), sourceFetcher = gateway(rows)) {
  const directory = tempDirectory();
  const fetcher = waka();
  const worker = new Sync(directory, options, {
    env: { WAKATIME_HOME: directory, WAKATIME_API_KEY: "test-key" },
    fetcher, sourceFetcher, now,
  });
  worker.state.activate(options.gatewayUrl, now - 120_000);
  worker.state.lastFlush = now;
  return { directory, worker, fetcher, options };
}

function cleanup(directory, worker) {
  worker.stopped = true;
  worker.close();
  rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
}

test("the replay key ignores fields finalized after the request", () => {
  const salt = "local-salt";
  const base = {
    t: "2026-11-04T12:00:00.000Z", route_id: "route-1", agent: "claude",
    provider: "magpie", host: "local", model: "gpt-6.1-terra", in: 10, out: 2,
  };
  expect(sourceKey(base, salt)).toBe(sourceKey({ ...base, response_id: "resp-9", served: "gpt-6.1-terra" }, salt));
  expect(sourceKey(base, salt)).not.toBe(sourceKey({ ...base, route_id: "route-2" }, salt));
  expect(sourceKey({ ...base, route_id: undefined }, salt)).toBe(sourceId({ ...base, route_id: undefined }, salt));
});

test("a sent log survives a restart, ignores malformed lines, and expires", () => {
  const directory = tempDirectory();
  const file = join(directory, "sent.log");
  const key = "a".repeat(64), other = "b".repeat(64);
  try {
    const log = new SentLog(file, { now });
    log.add([key, key, "not-a-key"], now);
    expect(log.has(key)).toBe(true);
    expect(log.has("not-a-key")).toBe(false);
    expect(log.add([key], now)).toBe(0);
    expect(new SentLog(file, { now }).has(key)).toBe(true);
    appendFileSync(file, `broken line\n${now - 4 * 86_400_000}\t${other}\n`);
    const later = new SentLog(file, { now });
    expect(later.has(other)).toBe(false);
    expect(later.has(key)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain(key);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("excludeCallerKeys drops a remote gateway caller but keeps the local agent", async () => {
  const options = readOptions({ excludeCallerKeys: ["friend"] });
  const rows = [
    row(3, { callerKeyName: "friend", callerKeyLabel: "friend" }),
    row(2, { callerKeyName: "mine", callerKeyLabel: "mine" }),
    row(1),
  ];
  const { directory, worker, fetcher } = setup(rows, options);
  try {
    await worker.tick(now);
    await worker.tick(now + 61_000);
    const sent = fetcher.calls.flat();
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((payload) => payload.time))).toEqual(new Set([
      Date.parse(rows[1].t) / 1000, Date.parse(rows[2].t) / 1000,
    ]));
    expect(worker.state.cursor(day)?.offset).toBe(3);
  } finally { cleanup(directory, worker); }
});

test("a fresh sent log is seeded from a committed cursor without sending", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => row(index + 1));
  const { directory, worker, fetcher } = setup(rows);
  try {
    const salt = worker.state.salt;
    worker.state.setCursor(day, {
      offset: 100,
      head: cursorId(sourceId(rows[0], salt)),
      tail: cursorId(sourceId(rows[99], salt)),
      total: 100,
      time: Date.parse(rows[99].t),
    });
    worker.state.flush(now, true);
    worker.state.lastFlush = now;

    await worker.tick(now);
    expect(worker.state.get("sentSeed")).toBe("ok");
    expect(worker.sent.size).toBe(100);
    expect(fetcher.calls).toHaveLength(0);
    expect(worker.state.cursor(day)?.offset).toBe(100);

    // A new row at the front is sent once; the seeded prefix is not replayed.
    rows.unshift(row(1000));
    await worker.tick(now + 31_000);
    await worker.tick(now + 92_000);
    const sent = fetcher.calls.flat();
    expect(sent).toHaveLength(1);
    expect(sent[0].time).toBe(Date.parse(rows[0].t) / 1000);
    expect(worker.state.cursor(day)?.offset).toBe(101);
  } finally { cleanup(directory, worker); }
});

test("a row inserted during a pass still advances the durable cursor", async () => {
  const rows = Array.from({ length: 25 }, (_, index) => row(index + 1));
  let zeroReads = 0, mutated = false;
  const sourceFetcher = async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    const source = mutated ? rows : rows.slice();
    const body = {
      rows: source.slice(offset, offset + 500),
      total: source.length,
      offset: Math.min(offset, source.length),
    };
    // The head snapshot and the window read both see the original list; the
    // new request lands before the pass's final stability check.
    if (!mutated && offset === 0) {
      zeroReads++;
      if (zeroReads === 2) { mutated = true; rows.unshift(row(1000)); }
    }
    return Response.json(body);
  };
  const { directory, worker, fetcher } = setup(rows, readOptions(), sourceFetcher);
  try {
    await worker.tick(now);
    // The extra front row is not in this pass, but the cursor still commits.
    expect(worker.state.cursor(day)?.offset).toBe(25);
    await worker.tick(now + 31_000);
    // The next pass maps only the new front row; the buffer waits for its
    // one-minute window before the cursor can commit.
    expect(worker.state.cursor(day)?.offset).toBe(25);
    await worker.tick(now + 92_000);
    expect(worker.state.cursor(day)?.offset).toBe(26);
    const sent = fetcher.calls.flat();
    const times = sent.map((payload) => payload.time);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toHaveLength(26);
    expect(times).toContain(Date.parse(rows[0].t) / 1000);
  } finally { cleanup(directory, worker); }
});

test("excludeCallerKeys must be an array of labels", () => {
  expect(() => readOptions({ excludeCallerKeys: "friend" })).toThrow("invalid-config");
  expect(() => readOptions({ excludeCallerKeys: [""] })).toThrow("invalid-config");
  expect(readOptions({ excludeCallerKeys: ["friend"] }).excludeCallerKeys).toEqual(["friend"]);
});
