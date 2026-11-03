// Shared batching policy for the durable queue. Both the enqueue buffer and
// the acknowledgement gate use the same row count and time window, so a later
// variant that combines their commits can keep these rules unchanged.
export const BATCH_ROWS = 25;
export const BATCH_WINDOW_MS = 60_000;
export const ENQUEUE_BUFFER_CAPACITY = 1_000;

// Holds mapped heartbeats until one of the commit thresholds is reached.
// Rows stay in memory, and the caller must leave the scan cursor behind them,
// until Queue.enqueue commits the whole buffer in one transaction.
export class EnqueueBuffer {
  constructor({
    rows = BATCH_ROWS, windowMs = BATCH_WINDOW_MS, capacity = ENQUEUE_BUFFER_CAPACITY,
  } = {}) {
    this.rows = rows;
    this.windowMs = windowMs;
    this.capacity = capacity;
    this.items = [];
    this.firstAt = null;
  }

  get length() { return this.items.length; }

  get full() { return this.items.length >= this.capacity; }

  get firstBufferedAt() { return this.firstAt; }

  // Accept the prefix of items that fits, so the caller can stop scanning and
  // leave the rest to be re-read from the unchanged cursor.
  add(items, now) {
    const accepted = items.slice(0, Math.max(0, this.capacity - this.items.length));
    if (accepted.length && this.firstAt === null) this.firstAt = now;
    this.items.push(...accepted);
    return accepted;
  }

  // A full row batch commits at once; a smaller trickle commits once the
  // window measured from its first row has elapsed.
  ready(now) {
    return this.items.length > 0 &&
      (this.items.length >= this.rows || now - this.firstAt >= this.windowMs);
  }

  clear() {
    this.items = [];
    this.firstAt = null;
  }
}

// Decides when pending queue rows may be sent. Stats come from
// Queue.pendingDue: how many rows are due and the enqueue time of the oldest.
export class AckGate {
  constructor({ rows = BATCH_ROWS, windowMs = BATCH_WINDOW_MS } = {}) {
    this.rows = rows;
    this.windowMs = windowMs;
  }

  open({ count, oldest }, now) {
    return count > 0 && (count >= this.rows || now - oldest >= this.windowMs);
  }
}
