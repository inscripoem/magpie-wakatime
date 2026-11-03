import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { collectDay, cursorId } from "../src/source.mjs";
import { Contexts } from "../src/contexts.mjs";
import { State } from "../src/state.mjs";
import { Seen } from "../src/sync.mjs";
import { readOptions } from "../src/config.mjs";
import { sourceId } from "../src/map.mjs";
import { tempDirectory } from "./helpers.mjs";

const day = "2026-10-15";
const at = (hour = 10, minute = 0, second = 0) =>
  new Date(Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+08:00`)).toISOString();
const row = (id, extra = {}) => ({
  t: at(10, 0, id % 60), route_id: id, agent: "codex", provider: "mock", model: "mock",
  in: 10, out: 5, cache_read: 0, cache_write: 0, ...extra,
});

function gateway(rows) {
  return async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    const total = rows.length;
    return Response.json({ rows: rows.slice(offset, offset + 500), total, offset: Math.min(offset, total) });
  };
}

function setup(enabledAt = Date.parse(`${day}T00:00:00+08:00`)) {
  const directory = tempDirectory();
  const state = new State(join(directory, "state.json"), { now: Date.parse(`${day}T00:00:00+08:00`) });
  state.activate("http://127.0.0.1:3425", enabledAt);
  return { directory, state, options: readOptions({ gatewayUrl: "http://127.0.0.1:3425" }) };
}

test("offers only mapped rows and leaves cursor commitment to the sender", async () => {
  const { directory, state, options } = setup(Date.parse(`${day}T09:30:00+08:00`));
  const rows = [
    row(0),
    { t: "bad", route_id: 1, in: 10, out: 2, prompt: "private prompt", key: "private key" },
    row(2, { in: 0, out: 0 }),
    row(3, { t: at(9, 0, 0) }),
    row(4),
  ];
  const contexts = new Contexts(), seen = new Seen();
  try {
    const result = await collectDay(state, options, day, {
      now: Date.parse(`${day}T12:00:00+08:00`), fetcher: gateway(rows), contexts, seen,
    });
    expect(result.complete).toBe(true);
    expect(result.items.map((item) => item.id)).toEqual([
      sourceId(rows[0], state.salt), sourceId(rows[4], state.salt),
    ]);
    expect(result.cursor).toMatchObject({
      offset: 5, head: cursorId(sourceId(rows[0], state.salt)), tail: cursorId(sourceId(rows[4], state.salt)), total: 5,
    });
    expect(result.cursor.time).toBe(Date.parse(rows[4].t));
    expect(state.cursor(day)).toBeNull();
    expect(state.get("lastInvalidRow")).toMatchObject({ day, offset: 1, error: "invalid-row" });
    expect(JSON.stringify(state.status())).not.toContain("private");
    expect(seen.has(sourceId(rows[3], state.salt))).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a partial page scan resumes from its committed offset", async () => {
  const { directory, state, options } = setup();
  const rows = Array.from({ length: 501 }, (_, index) => row(index));
  const contexts = new Contexts(), seen = new Seen();
  try {
    const first = await collectDay(state, options, day, {
      now: Date.parse(`${day}T12:00:00+08:00`), fetcher: gateway(rows), contexts, seen, budget: 1,
    });
    expect(first.complete).toBe(false);
    expect(first.cursor.offset).toBe(500);
    for (const item of first.items) seen.add(item.id, 1);
    state.setCursor(day, first.cursor);
    const second = await collectDay(state, options, day, {
      now: Date.parse(`${day}T12:01:00+08:00`), fetcher: gateway(rows), contexts, seen, budget: 1,
    });
    expect(second.complete).toBe(true);
    expect(second.items).toHaveLength(1);
    expect(second.cursor.offset).toBe(501);
  } finally {
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("picks up front insertions, tail appends and middle late rows without resending", async () => {
  const { directory, state, options } = setup();
  const rows = [row(10), row(9), row(8)];
  const contexts = new Contexts(), seen = new Seen();
  const now = Date.parse(`${day}T12:00:00+08:00`);
  try {
    const first = await collectDay(state, options, day, { now, fetcher: gateway(rows), contexts, seen });
    expect(first.stable).toBe(true);
    for (const item of first.items) seen.add(item.id, now);
    state.setCursor(day, first.cursor);

    rows.unshift(row(11)); // new front row
    let next = await collectDay(state, options, day, { now, fetcher: gateway(rows), contexts, seen });
    expect(next.items.map((item) => item.id)).toEqual([sourceId(rows[0], state.salt)]);
    expect(next.stable).toBe(true);
    for (const item of next.items) seen.add(item.id, now);
    state.setCursor(day, next.cursor);

    rows.push(row(7)); // late row appended at the tail
    next = await collectDay(state, options, day, { now, fetcher: gateway(rows), contexts, seen });
    expect(next.items.map((item) => item.id)).toEqual([sourceId(rows.at(-1), state.salt)]);
    expect(next.stable).toBe(true);
    for (const item of next.items) seen.add(item.id, now);
    state.setCursor(day, next.cursor);

    rows.splice(3, 0, row(99, { t: at(10, 0, 8) })); // older late row inserted inside the processed prefix
    next = await collectDay(state, options, day, { now, fetcher: gateway(rows), contexts, seen });
    expect(next.items.map((item) => item.id)).toEqual([sourceId(rows[3], state.salt)]);
    expect(next.items).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("reports incompatible sources without advancing", async () => {
  const { directory, state, options } = setup(Date.parse(`${day}T09:00:00+08:00`));
  try {
    await expect(collectDay(state, options, day, { fetcher: async () => Response.json({ data: [] }) }))
      .rejects.toThrow("source-schema");
    await expect(collectDay(state, options, day, { fetcher: async () => new Response(null, { status: 500 }) }))
      .rejects.toThrow("source-http-500");
    await expect(collectDay(state, options, day, { fetcher: async () => { throw new Error("offline"); } }))
      .rejects.toThrow("source-network");
    const result = await collectDay(state, options, day, {
      fetcher: gateway([row(1, { t: at(8, 0, 0) })]),
    });
    expect(result.items).toHaveLength(0);
    expect(state.cursor(day)).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});
