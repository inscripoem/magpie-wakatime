import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Queue, QueueFullError } from "../src/queue.mjs";
import { tempDirectory } from "./helpers.mjs";

function withQueue(run, options) {
  const directory = tempDirectory();
  const file = join(directory, "queue.sqlite");
  const queue = new Queue(file, options);
  try { return run(queue, file); }
  finally {
    try { queue.close(); } catch { /* the test may have closed it */ }
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("enqueue dedupes pending and acked ids and preserves enqueue order", () => {
  withQueue((queue) => {
    expect(queue.enqueue([
      { id: "a", payload: { n: 1 } },
      { id: "b", payload: { n: 2 } },
      { id: "a", payload: { n: 3 } },
    ], 10)).toMatchObject({ added: 2, pending: 2 });
    expect(queue.pending(10, 25).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(queue.pending(10, 25)[0].payload).toEqual({ n: 1 });

    queue.ack(["a"], 20);
    expect(queue.pending(10, 25).map((entry) => entry.id)).toEqual(["b"]);
    expect(queue.enqueue([{ id: "a", payload: { n: 9 } }, { id: "c", payload: { n: 3 } }], 30))
      .toMatchObject({ added: 1, pending: 2 });
    expect(queue.pending(10, 25).map((entry) => entry.id)).toEqual(["b", "c"]);
  });
});

test("defer keeps entries pending until due and counts attempts", () => {
  withQueue((queue) => {
    queue.enqueue([{ id: "a", payload: {} }], 10);
    const [entry] = queue.pending(10, 25);
    queue.defer([entry], 5000);
    expect(queue.pending(4999, 25)).toHaveLength(0);
    expect(queue.pending(5000, 25)).toMatchObject([{ id: "a", attempts: 1 }]);
  });
});

test("a full queue rejects the whole batch and acked tombstones do not count", () => {
  withQueue((queue) => {
    queue.enqueue([{ id: "a", payload: {} }, { id: "b", payload: {} }], 10);
    expect(() => queue.enqueue([{ id: "c", payload: {} }], 20)).toThrow(QueueFullError);
    expect(queue.pendingCount()).toBe(2);

    queue.ack(["a"], 30);
    expect(queue.enqueue([{ id: "c", payload: {} }], 40)).toMatchObject({ added: 1, pending: 2 });
  }, { capacity: 2 });
});

test("pruning removes old acked tombstones but keeps pending entries", () => {
  withQueue((queue) => {
    queue.enqueue([{ id: "a", payload: {} }, { id: "b", payload: {} }], 10);
    queue.ack(["a"], 20);
    expect(queue.pruneAcked(20)).toBe(0);
    expect(queue.pruneAcked(21)).toBe(1);
    expect(queue.pendingCount()).toBe(1);
    expect(queue.pending(100, 25).map((entry) => entry.id)).toEqual(["b"]);
    expect(queue.status()).toMatchObject({ pending: 1, acked: 0 });
  });
});

test("pending entries survive close and reopen while acked entries never return", () => {
  withQueue((queue, file) => {
    queue.enqueue([{ id: "a", payload: { n: 1 } }, { id: "b", payload: { n: 2 } }], 10);
    queue.ack(["a"], 20);
    queue.close();

    const reopened = new Queue(file);
    try {
      expect(reopened.pending(30, 25)).toMatchObject([{ id: "b", payload: { n: 2 } }]);
      expect(reopened.enqueue([{ id: "a", payload: { n: 9 } }], 40))
        .toMatchObject({ added: 0, pending: 1 });
    } finally { reopened.close(); }
  });
});
