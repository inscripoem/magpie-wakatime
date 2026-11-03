// Synthetic one-day write-volume benchmark for the high-water-mark sender.
//   bun bench/highwater.mjs
//   REQUESTS=18000 bun bench/highwater.mjs
// Each run uses the real State, Contexts, Seen, collectDay and sendItems paths;
// only the two HTTP boundaries are replaced by in-process responses so that
// /proc/self/io reflects this worker's file writes, not socket traffic.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sync } from "../src/sync.mjs";
import { readOptions } from "../src/config.mjs";
import { localDay, cursorId } from "../src/source.mjs";
import { sourceId } from "../src/map.mjs";

const REQUESTS = Number(process.env.REQUESTS ?? 18_000);
const CONTEXTS = process.env.CONTEXTS !== "0";
const IDLE = process.env.IDLE === "1";
const TICK_MS = 30_000;
const DAY_START = new Date(2026, 10, 3, 0, 0, 0).getTime();
const ROOT = new URL("../.work/bench/", import.meta.url).pathname;
const DIRECTORY = join(ROOT, `highwater-${process.pid}`);
const STATE_DIRECTORY = join(DIRECTORY, "magpie-wakatime");

function ioCounters() {
  const result = {};
  try {
    for (const line of readFileSync("/proc/self/io", "utf8").split("\n")) {
      const index = line.indexOf(":");
      if (index > 0) result[line.slice(0, index)] = Number(line.slice(index + 1));
    }
  } catch { /* non-Linux: the JSON fields stay absent */ }
  return result;
}

function directoryBytes(directory) {
  let total = 0;
  const files = {};
  try {
    for (const name of readdirSync(directory)) {
      try {
        const size = statSync(join(directory, name)).size;
        files[name] = size;
        total += size;
      } catch { /* raced */ }
    }
  } catch { /* missing */ }
  return { total, files };
}

function generate() {
  let seed = 0x5eed1234;
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const rows = [];
  for (let index = 0; index < REQUESTS; index++) {
    // Spread the day's requests over 1440 minutes; the final minute is below
    // the last simulated tick so every row is visible during the run.
    const minute = Math.floor(index * 1439 / REQUESTS);
    const second = minute * 60 + Math.floor(next() * 60);
    rows.push({
      t: new Date(DAY_START + second * 1000).toISOString(),
      route_id: index, agent: index % 5 === 0 ? "claude" : "codex", provider: "mock",
      model: index % 5 === 0 ? "claude-sonnet-4-6" : "gpt-5.4", effort: "high",
      in: 40 + Math.floor(next() * 200), out: 10 + Math.floor(next() * 80),
      cache_read: Math.floor(next() * 100), cache_write: Math.floor(next() * 40),
      session: `${index % 8}`, response_id: `resp-${index}`,
    });
  }
  return rows;
}

const rows = IDLE ? [] : generate();
const visible = [];
let nextRow = 0;
let heartbeats = 0;

// The two days before the measured day are already complete. Their cursors
// make the ten-minute review read two pages per day and write nothing.
const priorDays = [];
for (let offset = 1; offset <= 2; offset++) {
  const start = DAY_START - offset * 86_400_000;
  const priorRows = [{
    t: new Date(start + 3_600_000).toISOString(), route_id: -offset, agent: "codex",
    provider: "mock", model: "gpt-5.4", in: 10, out: 2, cache_read: 0, cache_write: 0,
  }];
  priorDays.push({ day: localDay(start), rows: priorRows, time: Date.parse(priorRows[0].t) });
}
const priorByDay = Object.fromEntries(priorDays.map((entry) => [entry.day, entry.rows]));
const today = localDay(DAY_START);

const options = readOptions({ project: "Magpie" });
mkdirSync(DIRECTORY, { recursive: true });
// SEED_IDENTITY=1 simulates a restarted install: identity already exists, so
// activation writes nothing and the run measures the steady state.
if (process.env.SEED_IDENTITY === "1") {
  mkdirSync(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  writeFileSync(join(STATE_DIRECTORY, "identity.json"), JSON.stringify({
    v: 1, salt: "9".repeat(32), gateway: options.gatewayUrl, enabledAt: DAY_START,
  }), { mode: 0o600 });
}
const before = ioCounters();
const started = Date.now();
const worker = new Sync(DIRECTORY, options, {
  env: { WAKATIME_HOME: DIRECTORY, WAKATIME_API_KEY: "bench-key" },
  now: DAY_START,
  sourceFetcher: async (url) => {
    const parsed = new URL(url);
    const day = parsed.searchParams.get("period").split("..")[0];
    const offset = Number(parsed.searchParams.get("offset"));
    const source = day === today ? visible : priorByDay[day] ?? [];
    const total = source.length;
    return Response.json({ rows: source.slice(offset, offset + 500), total, offset: Math.min(offset, total) });
  },
  fetcher: async (_url, init) => {
    const body = JSON.parse(init.body);
    heartbeats += body.length;
    return Response.json({ responses: body.map(() => [{ data: {} }, 201]) }, { status: 201 });
  },
});
worker.state.activate(options.gatewayUrl, DAY_START);
// Live steady state keeps one cursor per replay day. Seed the two older days
// so the measured file size is not the first-day minimum.
const seeded = [];
if (process.env.SEED_CURSORS !== "0") {
  for (const entry of priorDays) {
    const first = entry.rows[0], last = entry.rows.at(-1);
    worker.state.setCursor(entry.day, {
      offset: entry.rows.length,
      head: cursorId(sourceId(first, worker.state.salt)),
      tail: cursorId(sourceId(last, worker.state.salt)),
      total: entry.rows.length,
      time: Date.parse(last.t),
    });
    seeded.push(entry.day);
  }
  worker.state.set("backfillDay", today);
  worker.state.flush(DAY_START, true);
}
worker.state.lastFlush = DAY_START;

let ticks = 0;
for (; ticks < 2_880; ticks++) {
  const now = DAY_START + ticks * TICK_MS;
  const batch = [];
  while (nextRow < rows.length && Date.parse(rows[nextRow].t) <= now) batch.push(rows[nextRow++]);
  if (batch.length) visible.unshift(...batch.reverse());
  if (CONTEXTS) {
    for (const row of batch) {
      worker.contexts.setResponse(row.agent, row.response_id,
        { project: "repo", branch: "main", language: "TypeScript" }, now);
    }
  }
  await worker.tick(now);
}
if (nextRow < rows.length) {
  const now = DAY_START + 86_400_000 - 1;
  const batch = rows.slice(nextRow);
  if (batch.length) visible.unshift(...batch.reverse());
  if (CONTEXTS) {
    for (const row of batch) {
      worker.contexts.setResponse(row.agent, row.response_id,
        { project: "repo", branch: "main", language: "TypeScript" }, now);
    }
  }
  await worker.tick(now);
  ticks++;
}
await worker.stop();
const elapsed = Date.now() - started;
const after = ioCounters();
const state = directoryBytes(STATE_DIRECTORY);
const cursor = worker.state.cursor(localDay(DAY_START + 86_400_000 - 1));

const result = {
  mode: IDLE ? "highwater-idle" : "highwater",
  requests: rows.length,
  heartbeats,
  ticks,
  contexts: CONTEXTS,
  elapsed_ms: elapsed,
  write_bytes: (after.write_bytes ?? 0) - (before.write_bytes ?? 0),
  wchar: (after.wchar ?? 0) - (before.wchar ?? 0),
  syscw: (after.syscw ?? 0) - (before.syscw ?? 0),
  syscr: (after.syscr ?? 0) - (before.syscr ?? 0),
  rchar: (after.rchar ?? 0) - (before.rchar ?? 0),
  state_writes: worker.state.stateWrites,
  lease_writes: worker.state.leaseWrites,
  state_files: state.files,
  state_bytes: state.total,
  seeded_cursors: seeded.length,
  cursor,
  sent: worker.stats.sent,
  rejected: worker.stats.rejected,
};
console.log(JSON.stringify(result, null, 2));
rmSync(DIRECTORY, { recursive: true, maxRetries: 5, retryDelay: 50 });
