import { expect, test } from "bun:test";
import { AckGate, BATCH_ROWS, BATCH_WINDOW_MS, EnqueueBuffer } from "../src/batching.mjs";

test("the enqueue buffer commits at 25 rows or one window since its first row", () => {
  const buffer = new EnqueueBuffer();
  const items = (count, prefix = "row") => Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`, payload: { time: index },
  }));

  expect(buffer.add(items(24), 1_000)).toHaveLength(24);
  expect(buffer.ready(1_000 + BATCH_WINDOW_MS - 1)).toBe(false);
  expect(buffer.ready(1_000 + BATCH_WINDOW_MS)).toBe(true);

  expect(buffer.add(items(1, "extra"), 2_000)).toHaveLength(1);
  expect(buffer.length).toBe(BATCH_ROWS);
  expect(buffer.ready(2_000)).toBe(true);

  buffer.clear();
  expect(buffer.length).toBe(0);
  expect(buffer.firstBufferedAt).toBeNull();
  expect(buffer.ready(1_000 + BATCH_WINDOW_MS)).toBe(false);
});

test("the enqueue buffer accepts only its capacity prefix", () => {
  const buffer = new EnqueueBuffer({ capacity: 3 });
  const items = [
    { id: "a", payload: {} }, { id: "b", payload: {} },
    { id: "c", payload: {} }, { id: "d", payload: {} },
  ];
  expect(buffer.add(items, 10)).toEqual(items.slice(0, 3));
  expect(buffer.full).toBe(true);
  expect(buffer.add([{ id: "e", payload: {} }], 20)).toHaveLength(0);
  expect(buffer.length).toBe(3);
});

test("the acknowledgement gate opens at 25 due rows or one window", () => {
  const gate = new AckGate();
  const stats = (count, oldest) => ({ count, oldest });
  expect(gate.open(stats(0, null), 100_000)).toBe(false);
  expect(gate.open(stats(24, 1_000), 1_000 + BATCH_WINDOW_MS - 1)).toBe(false);
  expect(gate.open(stats(24, 1_000), 1_000 + BATCH_WINDOW_MS)).toBe(true);
  expect(gate.open(stats(BATCH_ROWS, 1_000), 1_001)).toBe(true);
});
