import { expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
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

// Serve offset 0 twice from the pre-mutation listing, then mutate the source
// before the offset-500 page. This reproduces a gateway insert/delete between
// pages while a scan is in progress.
function shiftingGateway(rows, mutate) {
  let zeroReads = 0, mutated = false;
  return async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    const source = mutated ? rows : rows.slice();
    const body = {
      rows: source.slice(offset, offset + 500),
      total: source.length,
      offset: Math.min(offset, source.length),
    };
    if (offset === 0 && !mutated) {
      zeroReads++;
      if (zeroReads === 2) { mutate(); mutated = true; }
    }
    return Response.json(body);
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

function setup(rows, {
  activate = true, fetcher = waka(), sourceFetcher = gateway(rows),
  env = { WAKATIME_API_KEY: "test-key" }, queueCapacity,
} = {}) {
  const directory = tempDirectory();
  const options = readOptions();
  const worker = new Sync(directory, options, {
    env: { WAKATIME_HOME: directory, ...env }, fetcher, sourceFetcher, now, queueCapacity,
  });
  if (activate) {
    worker.state.activate(options.gatewayUrl, now - 120_000);
    // The real activation and the first tick happen at the same instant.
    worker.state.lastFlush = now;
  }
  return { directory, options, worker, fetcher, rows };
}

function cleanup(directory, ...workers) {
  for (const worker of workers) { worker.stopped = true; worker.close?.(); }
  rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
}

// Insert or delete one row between the first and second source pages, tick
// until the cursor covers the resulting list, and require every final row to
// reach WakaTime exactly once.
async function sweep({ count = 600, insertAt, deleteAt, ticks = 4 } = {}) {
  const rows = Array.from({ length: count }, (_, index) => row(index + 1));
  const inserted = row(count + 10_000);
  const sourceFetcher = shiftingGateway(rows, () => {
    if (deleteAt === undefined) rows.splice(insertAt, 0, inserted);
    else rows.splice(deleteAt, 1);
  });
  const { directory, worker, fetcher } = setup(rows, { sourceFetcher });
  try {
    for (let index = 0; index < ticks; index++) {
      await worker.tick(now + index * 31_000);
      // A shifted pass may commit the stable prefix before the shift; the
      // final delivery check below is authoritative for no loss/no duplicate.
      if (index === 0) {
        expect(worker.queue.status().pending).toBe(0);
      }
      if (index > 0 && (worker.state.cursor(day)?.offset ?? 0) >= rows.length) break;
    }
    const final = rows.slice();
    const delivered = new Map();
    for (const payload of fetcher.calls.flat()) {
      delivered.set(payload.time, (delivered.get(payload.time) ?? 0) + 1);
    }
    for (const value of final) {
      expect(delivered.get(Date.parse(value.t) / 1000)).toBe(1);
    }
    expect(worker.state.cursor(day)?.offset).toBe(final.length);
    expect(worker.queue.status().pending).toBe(0);
    return { final, delivered };
  } finally { cleanup(directory, worker); }
}

test("buffers below 25 rows, sends directly at one window, and writes no queue row", async () => {
  const rows = [row(3), row(2), row(1)];
  const { directory, worker, fetcher } = setup(rows);
  const enqueue = worker.queue.enqueue.bind(worker.queue);
  let inserts = 0;
  worker.queue.enqueue = (items, at) => { inserts++; return enqueue(items, at); };
  try {
    await worker.tick(now);
    expect(fetcher.calls).toHaveLength(0);
    expect(worker.buffer.length).toBe(3);
    expect(worker.state.cursor(day)).toBeNull();
    const stateDirectory = join(directory, "magpie-wakatime");
    const before = JSON.parse(readFileSync(join(stateDirectory, "state.json"), "utf8"));
    expect(before.cursors?.[day]).toBeUndefined();

    // The first buffered row started a 60-second window.
    await worker.tick(now + 59_000);
    expect(fetcher.calls).toHaveLength(0);
    expect(worker.buffer.length).toBe(3);
    await worker.tick(now + 60_000);
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]).toHaveLength(3);
    expect(inserts).toBe(0);
    expect(worker.state.cursor(day)).toMatchObject({ offset: 3, total: 3 });
    expect(worker.state.cursor(day).head).toBe(cursorId(sourceId(rows[0], worker.state.salt)));
    const files = readdirSync(stateDirectory);
    for (const name of ["identity.json", "owner.lock", "state.json", "queue.sqlite"]) {
      expect(files).toContain(name);
    }
    const raw = readFileSync(join(stateDirectory, "state.json"), "utf8");
    expect(raw.length).toBeLessThan(2_048);
    expect(raw).not.toContain("payload");
    expect(raw).not.toContain("queue");
    // The cursor reaches disk only after the buffer was sent.
    expect(JSON.parse(raw).cursors[day][0]).toBe(3);
    expect(worker.state.flush(now + 300_000)).toBe(false);
    expect(worker.status().sent).toBe(3);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 0 });
  } finally { cleanup(directory, worker); }
});

test("buffers rows across scans and sends one 25-row direct batch", async () => {
  const rows = Array.from({ length: 10 }, (_, index) => row(index + 1));
  const { directory, worker, fetcher } = setup(rows);
  const enqueue = worker.queue.enqueue.bind(worker.queue);
  let inserts = 0;
  worker.queue.enqueue = (items, at) => { inserts++; return enqueue(items, at); };
  try {
    await worker.tick(now);
    expect(fetcher.calls).toHaveLength(0);
    expect(worker.buffer.length).toBe(10);
    expect(worker.state.cursor(day)).toBeNull();
    for (let index = 10; index < 25; index++) rows.push(row(index + 1));
    await worker.tick(now + 30_000);
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]).toHaveLength(25);
    expect(inserts).toBe(0);
    expect(worker.buffer.length).toBe(0);
    expect(worker.state.cursor(day).offset).toBe(25);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 0 });
    expect(worker.status().sent).toBe(25);
  } finally { cleanup(directory, worker); }
});

test("enqueues durably before advancing the cursor and resumes after a restart", async () => {
  const rows = [row(3), row(2), row(1)];
  const first = setup(rows, { fetcher: waka(() => new Response(null, { status: 500 })) });
  let restarted;
  try {
    await first.worker.tick(now);
    await first.worker.tick(now + 61_000);
    expect(first.worker.state.cursor(day).offset).toBe(3);
    expect(first.worker.queue.status()).toMatchObject({ pending: 3, acked: 0 });
    // Both the queue entries and the advanced cursor are already on disk.
    const resilient = JSON.parse(readFileSync(join(first.directory, "magpie-wakatime", "state.json"), "utf8"));
    expect(resilient.cursors[day][0]).toBe(3);
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();

    const healthy = waka();
    restarted = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: healthy,
      sourceFetcher: gateway(rows), now: now + 122_000,
    });
    await restarted.tick(now + 122_000);
    expect(healthy.calls.flat()).toHaveLength(3);
    expect(restarted.queue.status()).toMatchObject({ pending: 0, acked: 3 });
    expect(restarted.state.cursor(day).offset).toBe(3);
  } finally {
    if (restarted) { restarted.state.release(restarted.owner); restarted.stopped = true; restarted.close(); }
    cleanup(first.directory, first.worker);
  }
});

test("delivered entries are never re-sent after a restart", async () => {
  const rows = [row(2), row(1)];
  const first = setup(rows);
  let restarted;
  try {
    await first.worker.tick(now);
    await first.worker.tick(now + 61_000);
    expect(first.fetcher.calls.flat()).toHaveLength(2);
    expect(first.worker.queue.status()).toMatchObject({ pending: 0, acked: 0 });
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();

    restarted = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: first.fetcher,
      sourceFetcher: gateway(rows), now: now + 122_000,
    });
    await restarted.tick(now + 122_000);
    expect(first.fetcher.calls.flat()).toHaveLength(2);
    expect(restarted.queue.status().pending).toBe(0);
  } finally {
    if (restarted) { restarted.state.release(restarted.owner); restarted.stopped = true; restarted.close(); }
    cleanup(first.directory, first.worker);
  }
});

test("queued payloads keep journal contexts across a restart", async () => {
  const rows = [row(2, { response_id: "resp-2" }), row(1, { response_id: "resp-1" })];
  const first = setup(rows, { fetcher: waka(() => new Response(null, { status: 500 })) });
  let restarted;
  try {
    first.worker.contexts.record("codex", { response: "resp-2" },
      { project: "repo", branch: "dev", language: "Python" }, now);
    first.worker.contexts.record("codex", { response: "resp-1" },
      { project: "repo", branch: "main", language: "TypeScript" }, now);
    await first.worker.tick(now);
    await first.worker.tick(now + 61_000);
    expect(first.worker.queue.status().pending).toBe(2);
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();

    // Restart past the journal TTL: the mapped payload is already durable.
    const healthy = waka();
    restarted = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: healthy,
      sourceFetcher: gateway(rows), now: now + 11 * 60_000,
    });
    await restarted.tick(now + 11 * 60_000);
    const sent = healthy.calls.flat();
    expect(sent).toHaveLength(2);
    expect(sent.some((payload) => payload.project === "Magpie")).toBe(false);
    const byBranch = Object.fromEntries(sent.map((payload) => [payload.branch, payload]));
    expect(byBranch.dev).toMatchObject({ project: "repo", language: "Python" });
    expect(byBranch.main).toMatchObject({ project: "repo", language: "TypeScript" });
  } finally {
    if (restarted) { restarted.state.release(restarted.owner); restarted.stopped = true; restarted.close(); }
    cleanup(first.directory, first.worker);
  }
});

test("a restarted worker maps new rows from the durable journal", async () => {
  const rows = [row(1, { response_id: "resp-restart" })];
  const first = setup(rows);
  let restarted;
  try {
    first.worker.contexts.record("codex", { response: "resp-restart" },
      { project: "repo", branch: "main", language: "Go" }, now);
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();

    const healthy = waka();
    restarted = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: healthy,
      sourceFetcher: gateway(rows), now: now + 1000,
    });
    await restarted.tick(now + 1000);
    await restarted.tick(now + 62_000);
    expect(healthy.calls.flat()[0]).toMatchObject({ project: "repo", branch: "main", language: "Go" });
  } finally {
    if (restarted) { restarted.state.release(restarted.owner); restarted.stopped = true; restarted.close(); }
    cleanup(first.directory, first.worker);
  }
});

test("a crash mid-send replays only the unacknowledged batch", async () => {
  const rows = Array.from({ length: 175 }, (_, index) => row(index + 1));
  // Six direct batches succeed; the seventh meets an outage and every later
  // request fails until the worker restarts.
  const fetcher = waka((count, body) => count >= 7
    ? new Response(null, { status: 500 })
    : Response.json({ responses: body.map(() => [{}, 201]) }, { status: 201 }));
  const { directory, options, worker } = setup(rows, { fetcher });
  let restarted;
  try {
    await worker.tick(now);
    expect(worker.stats.sent).toBe(150);
    expect(worker.queue.status()).toMatchObject({ pending: 25, acked: 0 });
    expect(worker.state.cursor(day).offset).toBe(175);
    worker.state.release(worker.owner);
    worker.stopped = true;
    worker.close();

    const healthy = waka();
    restarted = new Sync(directory, options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: healthy,
      sourceFetcher: gateway(rows), now: now + 61_000,
    });
    await restarted.tick(now + 61_000);
    const replay = healthy.calls.flat();
    expect(replay).toHaveLength(25);
    expect(replay.map((payload) => payload.time))
      .toEqual(rows.slice(150).map((value) => Date.parse(value.t) / 1000));
    expect(restarted.queue.status()).toMatchObject({ pending: 0, acked: 25 });
    expect(restarted.state.cursor(day).offset).toBe(175);
  } finally {
    if (restarted) { restarted.state.release(restarted.owner); restarted.stopped = true; restarted.close(); }
    cleanup(directory, worker);
  }
});

test("a transient failure durably queues the rows, advances, and retries the original payload", async () => {
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
    expect(worker.buffer.length).toBe(3);
    expect(worker.state.cursor(day)).toBeNull();
    expect(fetcher.calls).toHaveLength(0);
    // The buffered rows flush at one window, then the failed rows wait for
    // the acknowledgement window before their first queue retry.
    await worker.tick(now + 61_000);
    expect(worker.state.cursor(day).offset).toBe(3);
    expect(worker.queue.status()).toMatchObject({ pending: 3, acked: 0 });
    expect(fetcher.calls).toHaveLength(1);
    await worker.tick(now + 122_000);
    expect(fetcher.calls).toHaveLength(2);
    expect(fetcher.calls[1]).toEqual(fetcher.calls[0]);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 3 });
    expect(worker.stats.sent).toBe(3);
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
    expect(worker.buffer.length).toBe(2);
    await worker.tick(now + 61_000);
    expect(worker.state.cursor(day).offset).toBe(2);
    expect(worker.queue.status()).toMatchObject({ pending: 1, acked: 0 });
    await worker.tick(now + 122_000);
    expect(fetcher.calls[1]).toHaveLength(1);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 1 });
    expect(worker.stats.sent).toBe(2);
    expect(worker.stats.rejected).toBe(0);
  } finally { cleanup(directory, worker); }
});

test("a permanent rejection is not queued and never retried", async () => {
  const rows = [row(1)];
  const fetcher = waka((count, body) => count === 1
    ? Response.json({ responses: body.map(() => [{}, 400]) }, { status: 201 })
    : Response.json({ responses: body.map(() => [{}, 201]) }, { status: 201 }));
  const { directory, worker } = setup(rows, { fetcher });
  try {
    await worker.tick(now);
    expect(worker.buffer.length).toBe(1);
    expect(fetcher.calls).toHaveLength(0);
    await worker.tick(now + 61_000);
    expect(worker.stats.rejected).toBe(1);
    expect(worker.state.cursor(day).offset).toBe(1);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 0 });
    await worker.tick(now + 122_000);
    expect(fetcher.calls).toHaveLength(1);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 0 });
  } finally { cleanup(directory, worker); }
});

test("uses live contexts and keeps the mapped fallback across a restart", async () => {
  const rows = [row(2, { response_id: "resp-2" }), row(1, { response_id: "resp-1" })];
  const first = setup(rows);
  let restarted;
  try {
    first.worker.contexts.setResponse("codex", "resp-1", { project: "repo", branch: "main", language: "TypeScript" }, now);
    await first.worker.tick(now);
    await first.worker.tick(now + 61_000);
    const payloads = first.fetcher.calls[0];
    expect(payloads.find((payload) => payload.entity === "codex" && payload.project === "repo"))
      .toMatchObject({ project: "repo", branch: "main", language: "TypeScript" });
    expect(payloads.filter((payload) => payload.project === "Magpie")).toHaveLength(1);

    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();
    const late = row(99, { t: new Date(now + 5_000).toISOString(), response_id: "resp-1" });
    rows.unshift(late);
    restarted = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: first.fetcher,
      sourceFetcher: gateway(rows), now: now + 122_000,
    });
    await restarted.tick(now + 122_000);
    await restarted.tick(now + 183_000);
    const replay = first.fetcher.calls.at(-1);
    expect(replay).toHaveLength(1);
    expect(replay[0].project).toBe("Magpie");
    expect(replay[0].branch).toBeUndefined();
  } finally {
    if (restarted) { restarted.state.release(restarted.owner); restarted.stopped = true; restarted.close(); }
    cleanup(first.directory, first.worker);
  }
});

test("sends a late row appended after the cursor", async () => {
  const rows = [row(2), row(1)];
  const { directory, worker, fetcher } = setup(rows);
  try {
    await worker.tick(now);
    expect(fetcher.calls).toHaveLength(0);
    await worker.tick(now + 61_000);
    expect(fetcher.calls.flat()).toHaveLength(2);
    const late = row(0, { t: new Date(now - 90_000).toISOString() });
    rows.push(late);
    await worker.tick(now + 91_000);
    // The late row is buffered, so the cursor must wait for its window.
    expect(fetcher.calls).toHaveLength(1);
    expect(worker.buffer.length).toBe(1);
    expect(worker.state.cursor(day).offset).toBe(2);
    await worker.tick(now + 152_000);
    expect(fetcher.calls).toHaveLength(2);
    expect(fetcher.calls[1]).toHaveLength(1);
    expect(fetcher.calls[1][0].time).toBe(Date.parse(late.t) / 1000);
    expect(worker.state.cursor(day).offset).toBe(3);
  } finally { cleanup(directory, worker); }
});

test("reviews a completed previous day for a late row", async () => {
  const dayOne = new Date(2026, 10, 3, 23, 50, 0).getTime();
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
    // The one-row batch waits for its 60-second window before the cursor moves.
    expect(fetcher.calls).toHaveLength(0);
    await worker.tick(dayOne + 61_000);
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]).toHaveLength(1);
    expect(worker.state.cursor(localDay(dayOne)).offset).toBe(1);

    // The next day's scan has already moved past the previous day.
    worker.state.set("backfillDay", localDay(dayTwo));
    days[localDay(dayOne)].push(make(dayOne - 2000, 3));
    await worker.tick(dayTwo);
    // Today's row and the reviewed late row share the next buffer window.
    expect(fetcher.calls).toHaveLength(1);
    expect(worker.buffer.length).toBe(2);
    await worker.tick(dayTwo + 61_000);
    expect(fetcher.calls).toHaveLength(2);
    expect(fetcher.calls[1]).toHaveLength(2);
    expect(worker.state.cursor(localDay(dayOne)).offset).toBe(2);
    expect(fetcher.calls[1].map((payload) => payload.time))
      .toContain(Date.parse(new Date(dayOne - 2000).toISOString()) / 1000);
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
    expect(fetcher.calls).toHaveLength(0);
    expect(a.state.owns(a.owner, now)).toBe(true);
    expect(b.state.owns(b.owner, now)).toBe(false);
    await Promise.all([a.tick(now + 61_000), b.tick(now + 61_000)]);
    expect(fetcher.calls.flat()).toHaveLength(1);
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
    expect(worker.buffer.length).toBe(1);
    expect(worker.status().diagnostics.credentials).toBe("configured");
    await worker.tick(now + 61_000);
    expect(worker.status().diagnostics.credentials).toBe("invalid-key");
    // The buffered send was rejected, so the row is durably queued and the
    // cursor advanced over it before the worker pauses.
    expect(worker.state.cursor(day).offset).toBe(1);
    expect(worker.queue.status().pending).toBe(1);
    expect(fetcher.calls).toHaveLength(1);
    await worker.tick(now + 122_000);
    expect(fetcher.calls).toHaveLength(1);
    worker.env.WAKATIME_API_KEY = "rotated-key";
    await worker.tick(now + 152_000);
    expect(fetcher.calls).toHaveLength(2);
    expect(worker.state.cursor(day).offset).toBe(1);
    expect(worker.queue.status().pending).toBe(0);
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
    expect(missing.worker.queue.status().pending).toBe(0);
  } finally { cleanup(missing.directory, missing.worker); }

  const broken = setup(rows, { fetcher, sourceFetcher: async () => { throw new Error("offline"); } });
  try {
    await broken.worker.tick(now);
    expect(broken.worker.status().diagnostics.sourceError).toBe("source-network");
    expect(broken.worker.state.cursor(day)).toBeNull();
    expect(broken.worker.queue.status().pending).toBe(0);
    expect(fetcher.calls).toHaveLength(0);
  } finally { cleanup(broken.directory, broken.worker); }
});

test("a mid-scan listing shift never skips or duplicates a row", async () => {
  for (const insertAt of [1, 100, 250, 499, 500]) {
    const { final } = await sweep({ insertAt });
    expect(final).toHaveLength(601);
  }
  const deleted = await sweep({ deleteAt: 250 });
  expect(deleted.final).toHaveLength(599);
}, 30_000);

test("a budget-limited scan with a mid-scan insertion loses nothing", async () => {
  const { final } = await sweep({ count: 11_000, insertAt: 250, ticks: 18 });
  expect(final).toHaveLength(11_001);
}, 30_000);

test("acknowledgement tombstones survive an old backfill backlog", async () => {
  const rows = [row(1)];
  let attempts = 0;
  const fetcher = waka(() => {
    attempts++;
    return attempts === 1 ? new Response(null, { status: 500 }) :
      Response.json({ responses: [[{}, 201]] }, { status: 201 });
  });
  const { directory, worker } = setup(rows, { fetcher });
  try {
    await worker.tick(now);
    expect(worker.buffer.length).toBe(1);
    await worker.tick(now + 61_000);
    expect(worker.queue.status().pending).toBe(1);
    await worker.tick(now + 122_000);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 1 });
    worker.queue.db.query("UPDATE queue SET at=? WHERE state='acked'").run(now - 10 * 86_400_000);
    worker.state.set("backfillDay", localDay(now, -10));
    worker.nextPrune = 0;
    await worker.tick(now + 123_000);
    expect(worker.queue.status().acked).toBe(1);

    worker.state.set("backfillDay", localDay(now));
    worker.nextPrune = 0;
    await worker.tick(now + 124_000);
    expect(worker.queue.status().acked).toBe(0);
  } finally { cleanup(directory, worker); }
});

test("a full queue stops cursor advancement and resumes after the backlog drains", async () => {
  const rows = Array.from({ length: 25 }, (_, index) => row(index + 1));
  // The prefill rows (small times) are accepted; every real row fails until
  // the queue has room for a single enqueue transaction.
  const failing = waka((_count, body) => body.some((payload) => payload.time > 1_000)
    ? new Response(null, { status: 500 })
    : Response.json({ responses: body.map(() => [{}, 201]) }, { status: 201 }));
  const { directory, worker } = setup(rows, { fetcher: failing, queueCapacity: 30 });
  try {
    worker.queue.enqueue(Array.from({ length: 20 }, (_, index) => ({
      id: `prefill-${index + 1}`, payload: { entity: "magpie", time: index + 1 },
    })), now);
    await worker.tick(now);
    // The 25-row buffer cannot enter the 30-row queue, so no cursor moves.
    expect(worker.state.cursor(day)).toBeNull();
    expect(worker.buffer.length).toBe(25);
    expect(worker.status().diagnostics.queueError).toBe("queue-full");
    expect(worker.status().diagnostics.runtime).toBe("backlog");
    expect(worker.queue.status()).toMatchObject({ pending: 20, acked: 0 });
    expect(failing.calls).toHaveLength(1);

    // Draining the prefill frees the room the buffer needs.
    await worker.tick(now + 61_000);
    expect(worker.state.cursor(day)).toBeNull();
    expect(worker.buffer.length).toBe(25);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 20 });

    await worker.tick(now + 122_000);
    expect(worker.state.cursor(day).offset).toBe(25);
    expect(worker.buffer.length).toBe(0);
    expect(worker.queue.status()).toMatchObject({ pending: 25, acked: 20 });

    const healthy = waka();
    worker.fetcher = healthy;
    await worker.tick(now + 183_000);
    expect(worker.state.cursor(day).offset).toBe(25);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 45 });
    expect(healthy.calls.flat()).toHaveLength(25);
  } finally { cleanup(directory, worker); }
});

test("a full row batch goes directly in one request with no queue transaction", async () => {
  const rows = Array.from({ length: 25 }, (_, index) => row(index + 1));
  const { directory, worker, fetcher } = setup(rows);
  const enqueue = worker.queue.enqueue.bind(worker.queue);
  const ack = worker.queue.ack.bind(worker.queue);
  let enqueues = 0, acks = 0;
  worker.queue.enqueue = (items, at) => { enqueues++; return enqueue(items, at); };
  worker.queue.ack = (ids, at) => { acks++; return ack(ids, at); };
  try {
    await worker.tick(now);
    expect(enqueues).toBe(0);
    expect(acks).toBe(0);
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]).toHaveLength(25);
    expect(worker.state.cursor(day).offset).toBe(25);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 0 });
  } finally { cleanup(directory, worker); }
});

test("a trickle of offline rows waits for the 60-second acknowledgement window", async () => {
  const rows = [row(3), row(2), row(1)];
  let attempts = 0;
  const fetcher = waka(() => {
    attempts++;
    return attempts === 1 ? new Response(null, { status: 500 }) :
      Response.json({ responses: [[{}, 201], [{}, 201], [{}, 201]] }, { status: 201 });
  });
  const { directory, worker } = setup(rows, { fetcher });
  const enqueue = worker.queue.enqueue.bind(worker.queue);
  let transactions = 0;
  worker.queue.enqueue = (items, at) => { transactions++; return enqueue(items, at); };
  try {
    await worker.tick(now);
    expect(transactions).toBe(0);
    expect(worker.buffer.length).toBe(3);
    expect(fetcher.calls).toHaveLength(0);
    await worker.tick(now + 59_000);
    expect(fetcher.calls).toHaveLength(0);
    await worker.tick(now + 60_000);
    // The buffered rows flush at the 60-second window and are enqueued in one
    // transaction; that offline batch then waits out its own ack window.
    expect(transactions).toBe(1);
    expect(worker.state.cursor(day).offset).toBe(3);
    expect(worker.queue.status().pending).toBe(3);
    expect(fetcher.calls).toHaveLength(1);
    await worker.tick(now + 119_000);
    expect(fetcher.calls).toHaveLength(1);
    await worker.tick(now + 120_000);
    expect(fetcher.calls).toHaveLength(2);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 3 });
  } finally { cleanup(directory, worker); }
});

test("a crash before a send leaves the buffer and cursor behind and re-reads without loss", async () => {
  const rows = [row(3), row(2), row(1)];
  const first = setup(rows);
  let restarted;
  try {
    // The rows were mapped and buffered, then the process died before the
    // first request and before any cursor write.
    await first.worker.tick(now);
    expect(first.worker.buffer.length).toBe(3);
    expect(first.worker.queue.status().pending).toBe(0);
    expect(first.worker.state.cursor(day)).toBeNull();
    const durable = JSON.parse(readFileSync(join(first.directory, "magpie-wakatime", "state.json"), "utf8"));
    expect(durable.cursors?.[day]).toBeUndefined();

    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();

    const healthy = waka();
    restarted = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: healthy,
      sourceFetcher: gateway(rows), now: now + 1000,
    });
    await restarted.tick(now + 1000);
    expect(restarted.state.cursor(day)).toBeNull();
    await restarted.tick(now + 62_000);
    const delivered = healthy.calls.flat();
    expect(delivered).toHaveLength(3);
    expect(new Set(delivered.map((payload) => payload.time)).size).toBe(3);
    expect(restarted.queue.status()).toMatchObject({ pending: 0, acked: 0 });
    expect(restarted.state.cursor(day).offset).toBe(3);
  } finally {
    if (restarted) { restarted.state.release(restarted.owner); restarted.stopped = true; restarted.close(); }
    cleanup(first.directory, first.worker);
  }
});

test("the acknowledgement gate waits for a full batch or one window", async () => {
  const { directory, worker, fetcher } = setup([]);
  try {
    const items = (prefix, count, time) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`, payload: { entity: "magpie", time: time + index },
    }));
    worker.queue.enqueue(items("tiny", 3, 1), now);
    expect(await worker.drain("test-key", now)).toMatchObject({ gated: true });
    expect(await worker.drain("test-key", now + 59_999)).toMatchObject({ gated: true });
    expect(fetcher.calls).toHaveLength(0);
    await worker.drain("test-key", now + 60_000);
    expect(fetcher.calls.flat()).toHaveLength(3);

    worker.queue.enqueue(items("batch", 25, 100), now + 61_000);
    await worker.drain("test-key", now + 61_001);
    expect(fetcher.calls.flat()).toHaveLength(28);
  } finally { cleanup(directory, worker); }
});

test("restart drains the offline queue before scanning new rows", async () => {
  const rows = Array.from({ length: 25 }, (_, index) => row(index + 1));
  const failing = waka(() => new Response(null, { status: 500 }));
  const first = setup(rows, { fetcher: failing });
  let restarted;
  try {
    await first.worker.tick(now);
    expect(first.worker.state.cursor(day).offset).toBe(25);
    expect(first.worker.queue.status().pending).toBe(25);
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();

    const late = row(99, { t: new Date(now - 30_000).toISOString() });
    rows.push(late);
    const healthy = waka();
    restarted = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: healthy,
      sourceFetcher: gateway(rows), now: now + 61_000,
    });
    await restarted.tick(now + 61_000);
    // The durable queue goes out before the cursor's new tail row is scanned.
    expect(healthy.calls).toHaveLength(1);
    expect(healthy.calls[0]).toHaveLength(25);
    expect(healthy.calls[0].map((payload) => payload.time))
      .toEqual(rows.slice(0, 25).map((value) => Date.parse(value.t) / 1000));
    expect(restarted.buffer.length).toBe(1);
    await restarted.tick(now + 122_000);
    expect(healthy.calls).toHaveLength(2);
    expect(healthy.calls[1]).toHaveLength(1);
    expect(healthy.calls[1][0].time).toBe(Date.parse(late.t) / 1000);
    expect(restarted.queue.status()).toMatchObject({ pending: 0, acked: 25 });
    expect(restarted.state.cursor(day).offset).toBe(26);
  } finally {
    if (restarted) { restarted.state.release(restarted.owner); restarted.stopped = true; restarted.close(); }
    cleanup(first.directory, first.worker);
  }
});

test("an enqueue failure keeps the cursor behind for the next attempt", async () => {
  const rows = [row(3), row(2), row(1)];
  let attempts = 0;
  const fetcher = waka(() => {
    attempts++;
    return attempts <= 3 ? new Response(null, { status: 500 }) :
      Response.json({ responses: [[{}, 201], [{}, 201], [{}, 201]] }, { status: 201 });
  });
  const { directory, worker } = setup(rows, { fetcher });
  const enqueue = worker.queue.enqueue.bind(worker.queue);
  let failures = 2;
  worker.queue.enqueue = (items, at) => {
    if (failures-- > 0) throw new Error("disk-error");
    return enqueue(items, at);
  };
  try {
    await worker.tick(now);
    expect(worker.buffer.length).toBe(3);
    expect(worker.state.cursor(day)).toBeNull();
    await worker.tick(now + 30_000);
    expect(worker.buffer.length).toBe(3);
    await worker.tick(now + 61_000);
    // The window flush failed to enqueue, so the buffer and cursor stay.
    expect(worker.state.cursor(day)).toBeNull();
    expect(worker.buffer.length).toBe(3);
    expect(worker.status().diagnostics.queueError).toBe("enqueue-failed");
    expect(worker.queue.status().pending).toBe(0);
    await worker.tick(now + 91_000);
    expect(worker.buffer.length).toBe(3);
    expect(worker.state.cursor(day)).toBeNull();
    await worker.tick(now + 121_000);
    expect(worker.state.cursor(day).offset).toBe(3);
    expect(worker.buffer.length).toBe(0);
    expect(worker.queue.status().pending).toBe(3);
    await worker.tick(now + 182_000);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 3 });
    expect(worker.stats.sent).toBe(3);
  } finally { cleanup(directory, worker); }
});

test("a failed window is enqueued in one transaction and commits its cursor", async () => {
  const rows = Array.from({ length: 1_100 }, (_, index) => row(index + 1));
  const fetcher = waka(() => new Response(null, { status: 500 }));
  const { directory, worker } = setup(rows, { fetcher });
  const enqueue = worker.queue.enqueue.bind(worker.queue);
  let transactions = 0;
  worker.queue.enqueue = (items, at) => { transactions++; return enqueue(items, at); };
  try {
    await worker.tick(now);
    // Only the first 25-row window failed; its rows are durable and its
    // cursor is committed, while the rest of the 1,100-row result waits.
    expect(transactions).toBe(1);
    expect(worker.queue.status().pending).toBe(25);
    expect(worker.buffer.length).toBe(0);
    expect(worker.state.cursor(day).offset).toBe(25);
  } finally { cleanup(directory, worker); }
}, 30_000);

test("a later window's failure enqueues only that window's rows", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => row(index + 1));
  const fetcher = waka((count, body) => count === 2
    ? new Response(null, { status: 500 })
    : Response.json({ responses: body.map(() => [{}, 201]) }, { status: 201 }));
  const { directory, worker } = setup(rows, { fetcher });
  const enqueue = worker.queue.enqueue.bind(worker.queue);
  const batches = [];
  worker.queue.enqueue = (items, at) => {
    batches.push(items.map((item) => item.id));
    return enqueue(items, at);
  };
  try {
    await worker.tick(now);
    // Window one (25 rows) is direct; window two fails and alone enters the
    // offline queue in one transaction. The cursor covers both windows.
    expect(fetcher.calls.map((call) => call.length)).toEqual([25, 25, 25]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(25);
    expect(worker.state.cursor(day).offset).toBe(50);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 25 });
    expect(worker.stats.sent).toBe(50);
  } finally { cleanup(directory, worker); }
});

test("a crash after a 2xx but before the cursor flush replays at most the buffer", async () => {
  const rows = [row(3, { response_id: "resp-3" }), row(2, { response_id: "resp-2" }),
    row(1, { response_id: "resp-1" })];
  const first = setup(rows);
  let restarted;
  try {
    for (const value of rows) {
      first.worker.contexts.record(value.agent, { response: value.response_id },
        { project: "repo", branch: "main", language: "TypeScript" }, now);
    }
    // The process dies after the 2xx responses but before state.json moves.
    first.worker.state.flush = () => false;
    await first.worker.tick(now);
    expect(first.fetcher.calls).toHaveLength(0);
    await first.worker.tick(now + 60_000);
    const original = first.fetcher.calls.flat();
    expect(original).toHaveLength(3);
    expect(first.worker.state.cursor(day).offset).toBe(3);
    const durable = JSON.parse(readFileSync(join(first.directory, "magpie-wakatime", "state.json"), "utf8"));
    expect(durable.cursors?.[day]).toBeUndefined();
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();

    const healthy = waka();
    restarted = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: healthy,
      sourceFetcher: gateway(rows), now: now + 90_000,
    });
    await restarted.tick(now + 90_000);
    expect(healthy.calls).toHaveLength(0);
    await restarted.tick(now + 150_000);
    const replay = healthy.calls.flat();
    expect(replay).toEqual(original);
    expect(replay.every((payload) => payload.project === "repo")).toBe(true);
    expect(restarted.queue.status()).toMatchObject({ pending: 0, acked: 0 });
    expect(restarted.state.cursor(day).offset).toBe(3);
  } finally {
    if (restarted) { restarted.state.release(restarted.owner); restarted.stopped = true; restarted.close(); }
    cleanup(first.directory, first.worker);
  }
});

test("a 1,500-row result is processed in 25-row windows", async () => {
  const rows = Array.from({ length: 1_500 }, (_, index) => row(index + 1));
  const { directory, worker, fetcher } = setup(rows);
  const enqueue = worker.queue.enqueue.bind(worker.queue);
  let inserts = 0;
  worker.queue.enqueue = (items, at) => { inserts++; return enqueue(items, at); };
  try {
    await worker.tick(now);
    // The tick budget is 32 windows, each exactly 25 rows.
    expect(fetcher.calls).toHaveLength(32);
    expect(fetcher.calls.every((call) => call.length === 25)).toBe(true);
    expect(worker.state.cursor(day).offset).toBe(800);
    await worker.tick(now + 30_000);
    expect(fetcher.calls).toHaveLength(60);
    expect(worker.state.cursor(day).offset).toBe(1_500);
    expect(worker.buffer.length).toBe(0);
    expect(inserts).toBe(0);
    expect(worker.queue.status()).toMatchObject({ pending: 0, acked: 0 });
    expect(worker.status().sent).toBe(1_500);
  } finally { cleanup(directory, worker); }
}, 30_000);

test("a crash after one window's 2xx re-sends at most 25 rows, not the result", async () => {
  const rows = Array.from({ length: 1_500 }, (_, index) => row(index + 1));
  let crashing;
  const fetcher = waka((count, body) => {
    if (count === 1) {
      return Response.json({ responses: body.map(() => [{}, 201]) }, { status: 201 });
    }
    crashing.abort.abort();
    throw new Error("crash");
  });
  const first = setup(rows, { fetcher });
  crashing = first.worker;
  let restarted;
  try {
    // The first window's 2xx is in memory but never reaches state.json.
    first.worker.state.flush = () => false;
    await first.worker.tick(now);
    const sent = first.fetcher.calls[0];
    expect(sent).toHaveLength(25);
    expect(first.worker.state.cursor(day).offset).toBe(25);
    const durable = JSON.parse(readFileSync(join(first.directory, "magpie-wakatime", "state.json"), "utf8"));
    expect(durable.cursors?.[day]).toBeUndefined();
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();

    const healthy = waka();
    restarted = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: healthy,
      sourceFetcher: gateway(rows), now: now + 1000,
    });
    await restarted.tick(now + 1000);
    await restarted.tick(now + 31_000);
    const replay = healthy.calls.flat();
    expect(replay).toHaveLength(1_500);
    const before = new Set(sent.map((payload) => payload.time));
    const duplicates = replay.filter((payload) => before.has(payload.time));
    expect(duplicates.length).toBe(25);
    expect(restarted.state.cursor(day).offset).toBe(1_500);
  } finally {
    if (restarted) { restarted.state.release(restarted.owner); restarted.stopped = true; restarted.close(); }
    cleanup(first.directory, first.worker);
  }
}, 30_000);

test("a head-insertion crash holds the old cursor and never re-sends the old prefix", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => row(index + 1));
  const first = setup(rows);
  let second, third;
  try {
    await first.worker.tick(now);
    expect(first.worker.state.cursor(day).offset).toBe(100);
    expect(first.fetcher.calls.flat()).toHaveLength(100);
    const oldTimes = new Set(first.fetcher.calls.flat().map((payload) => payload.time));
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();

    const frontRows = Array.from({ length: 100 }, (_, index) => row(1000 + index));
    rows.unshift(...frontRows);

    let crashing;
    const crasher = waka((count, body) => {
      if (count <= 3) return Response.json({ responses: body.map(() => [{}, 201]) }, { status: 201 });
      crashing.abort.abort();
      throw new Error("crash");
    });
    second = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: crasher,
      sourceFetcher: gateway(rows), now: now + 1000,
    });
    crashing = second;
    await second.tick(now + 1000);
    // Three front windows were sent; the fourth was buffered and the process
    // died. The cursor on disk is still the pre-insertion one.
    expect(crasher.calls.slice(0, 3).flat()).toHaveLength(75);
    const mid = JSON.parse(readFileSync(join(first.directory, "magpie-wakatime", "state.json"), "utf8"));
    expect(mid.cursors[day][0]).toBe(100);
    expect(mid.cursors[day][3]).toBe(100);
    second.state.release(second.owner);
    second.stopped = true;
    second.close();

    const healthy = waka();
    third = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: healthy,
      sourceFetcher: gateway(rows), now: now + 2000,
    });
    await third.tick(now + 2000);
    // The front completes and the merged cursor names both parts.
    expect(third.state.cursor(day).offset).toBe(200);
    const replay = healthy.calls.flat();
    expect(replay).toHaveLength(100);
    const replayTimes = new Set(replay.map((payload) => payload.time));
    expect([...oldTimes].some((time) => replayTimes.has(time))).toBe(false);
    for (const value of frontRows) {
      expect(replayTimes.has(Date.parse(value.t) / 1000)).toBe(true);
    }
    // Only the three already-sent front windows are duplicates.
    const sentFront = new Set(crasher.calls.slice(0, 3).flat().map((payload) => payload.time));
    expect(replay.filter((payload) => sentFront.has(payload.time))).toHaveLength(75);

    // Tail windows advance normally after the merged cursor lands.
    rows.push(row(2000));
    await third.tick(now + 32_000);
    expect(third.state.cursor(day).offset).toBe(200);
    await third.tick(now + 92_000);
    expect(third.state.cursor(day).offset).toBe(201);
    expect(third.fetcher.calls.at(-1)).toHaveLength(1);
    expect(third.fetcher.calls.at(-1)[0].time).toBe(Date.parse(row(2000).t) / 1000);
  } finally {
    for (const worker of [first.worker, second, third]) {
      if (!worker) continue;
      try { worker.state.release(worker.owner); } catch { /* already released */ }
      worker.stopped = true;
      worker.close();
    }
    cleanup(first.directory);
  }
}, 30_000);

test("a one-row head insertion crash re-sends only that row", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => row(index + 1));
  const first = setup(rows);
  let second, third;
  try {
    await first.worker.tick(now);
    expect(first.worker.state.cursor(day).offset).toBe(50);
    const oldTimes = new Set(first.fetcher.calls.flat().map((payload) => payload.time));
    first.worker.state.release(first.worker.owner);
    first.worker.stopped = true;
    first.worker.close();

    const front = row(1000);
    rows.unshift(front);
    const healthy = waka();
    second = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: healthy,
      sourceFetcher: gateway(rows), now: now + 1000,
    });
    // The merged cursor never reaches disk.
    second.state.flush = () => false;
    await second.tick(now + 1000);
    expect(second.buffer.length).toBe(1);
    await second.tick(now + 61_000);
    const sent = healthy.calls.flat();
    expect(sent).toHaveLength(1);
    expect(sent[0].time).toBe(Date.parse(front.t) / 1000);
    const disk = JSON.parse(readFileSync(join(first.directory, "magpie-wakatime", "state.json"), "utf8"));
    expect(disk.cursors[day][0]).toBe(50);
    expect(disk.cursors[day][3]).toBe(50);
    second.state.release(second.owner);
    second.stopped = true;
    second.close();

    const replay = waka();
    third = new Sync(first.directory, first.options, {
      env: { WAKATIME_API_KEY: "test-key" }, fetcher: replay,
      sourceFetcher: gateway(rows), now: now + 62_000,
    });
    await third.tick(now + 62_000);
    expect(third.buffer.length).toBe(1);
    await third.tick(now + 122_000);
    const again = replay.calls.flat();
    expect(again).toHaveLength(1);
    expect(again[0].time).toBe(Date.parse(front.t) / 1000);
    expect([...oldTimes].some((time) => again.some((payload) => payload.time === time))).toBe(false);
    expect(third.state.cursor(day).offset).toBe(51);
  } finally {
    for (const worker of [first.worker, second, third]) {
      if (!worker) continue;
      try { worker.state.release(worker.owner); } catch { /* already released */ }
      worker.stopped = true;
      worker.close();
    }
    cleanup(first.directory);
  }
}, 30_000);

test("recovers a middle insertion behind a committed cursor", async () => {
  const rows = Array.from({ length: 600 }, (_, index) => row(index + 1));
  let mutated = false;
  const sourceFetcher = async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    const source = mutated ? rows : rows.slice();
    const body = {
      rows: source.slice(offset, offset + 500),
      total: source.length,
      offset: Math.min(offset, source.length),
    };
    if (!mutated && offset === 0) {
      mutated = true;
      rows.splice(250, 0, row(10_600));
    }
    return Response.json(body);
  };
  const { directory, worker, fetcher } = setup(rows, { sourceFetcher });
  try {
    const salt = worker.state.salt;
    worker.state.setCursor(day, {
      offset: 500,
      head: cursorId(sourceId(rows[0], salt)),
      tail: cursorId(sourceId(rows[499], salt)),
      total: rows.length,
      time: Date.parse(rows[499].t),
    });
    worker.state.flush(now, true);
    worker.state.lastFlush = now;
    for (let index = 0; index < 8; index++) {
      await worker.tick(now + index * 31_000);
      if ((worker.state.cursor(day)?.offset ?? 0) >= rows.length) break;
    }
    expect(worker.state.cursor(day)?.offset).toBe(601);
    const delivered = new Map();
    for (const payload of fetcher.calls.flat()) {
      delivered.set(payload.time, (delivered.get(payload.time) ?? 0) + 1);
    }
    for (const value of rows) {
      expect(delivered.get(Date.parse(value.t) / 1000)).toBe(1);
    }
    expect(worker.queue.status().pending).toBe(0);
  } finally { cleanup(directory, worker); }
}, 30_000);
