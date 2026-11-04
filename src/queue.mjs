import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export const QUEUE_CAPACITY = 100_000;
// Acked rows are tombstones so a cursor reset that re-reads an older day
// cannot send the same source id again. Cursors older than three days are
// pruned, so the tombstones can expire on the same horizon.
export const ACK_RETENTION_MS = 3 * 86_400_000;

export class QueueFullError extends Error {
  constructor() {
    super("queue-full");
    this.name = "QueueFullError";
  }
}

// Explicit transactions: Bun's transaction() wrapper keeps WAL files locked
// after close(), which breaks tests and plugin reloads.
function transaction(db, work) {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.run("COMMIT");
    return result;
  } catch (error) {
    try { db.run("ROLLBACK"); } catch { /* keep the original error */ }
    throw error;
  }
}

// Durable heartbeat queue. A source id is the primary key, so a row that is
// pending or already acked is never inserted twice. Commits use WAL with
// synchronous=FULL: an acknowledged heartbeat cannot reappear after a crash.
export class Queue {
  constructor(file, { capacity = QUEUE_CAPACITY } = {}) {
    this.file = file;
    this.capacity = capacity;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS queue (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        due INTEGER NOT NULL DEFAULT 0,
        at INTEGER NOT NULL,
        key TEXT
      );
      CREATE INDEX IF NOT EXISTS queue_pending ON queue(state, due);
    `);
    // Existing databases predate the stable replay key.
    const columns = this.db.query("SELECT name FROM pragma_table_info('queue')").all().map((row) => row.name);
    if (!columns.includes("key")) this.db.exec("ALTER TABLE queue ADD COLUMN key TEXT");
    this.pendingCountQuery = this.db.query("SELECT count(*) AS n FROM queue WHERE state='pending'");
    this.ackedCountQuery = this.db.query("SELECT count(*) AS n FROM queue WHERE state='acked'");
    this.findQuery = this.db.query("SELECT state FROM queue WHERE id=?");
    this.insertQuery = this.db.query(
      "INSERT INTO queue(id, payload, state, attempts, due, at, key) VALUES (?, ?, 'pending', 0, 0, ?, ?)",
    );
    this.pendingQuery = this.db.query(
      "SELECT id, payload, attempts, key FROM queue WHERE state='pending' AND due<=? ORDER BY rowid LIMIT ?",
    );
    this.pendingKeysQuery = this.db.query(
      "SELECT key FROM queue WHERE state='pending' AND key IS NOT NULL",
    );
    this.dueQuery = this.db.query(
      "SELECT count(*) AS n, min(at) AS oldest FROM queue WHERE state='pending' AND due<=?",
    );
    this.ackQuery = this.db.query("UPDATE queue SET state='acked', at=? WHERE id=? AND state='pending'");
    this.deferQuery = this.db.query(
      "UPDATE queue SET attempts=attempts+1, due=? WHERE id=? AND state='pending'",
    );
    this.pruneQuery = this.db.query("DELETE FROM queue WHERE state='acked' AND at<?");
  }

  // Writes every not-yet-known item in one transaction. A duplicate id, queued
  // or acked, is ignored. QueueFullError rolls the whole batch back, so the
  // caller must not advance its cursor.
  enqueue(items, now = Date.now()) {
    return transaction(this.db, () => {
      let pending = this.pendingCountQuery.get().n;
      let added = 0;
      for (const { id, payload, key } of items) {
        if (this.findQuery.get(id)) continue;
        if (pending >= this.capacity) throw new QueueFullError();
        this.insertQuery.run(id, JSON.stringify(payload), now, key ?? id);
        pending++;
        added++;
      }
      return { added, pending };
    });
  }

  pending(now = Date.now(), limit = 25) {
    return this.pendingQuery.all(now, limit).map((row) => ({
      id: row.id, payload: JSON.parse(row.payload), attempts: row.attempts, key: row.key,
    }));
  }

  pendingKeys() {
    return this.pendingKeysQuery.all().map((row) => row.key);
  }

  pendingCount() { return this.pendingCountQuery.get().n; }

  // Due pending rows and the enqueue time of the oldest one. The ack gate
  // uses both: a full batch sends immediately, a trickle waits for the window.
  pendingDue(now = Date.now()) {
    const row = this.dueQuery.get(now);
    return { count: row.n, oldest: row.oldest };
  }

  ack(ids, now = Date.now()) {
    if (!ids.length) return 0;
    return transaction(this.db, () => {
      let changed = 0;
      for (const id of ids) changed += this.ackQuery.run(now, id).changes;
      return changed;
    });
  }

  defer(entries, due) {
    if (!entries.length) return 0;
    return transaction(this.db, () => {
      let changed = 0;
      for (const entry of entries) changed += this.deferQuery.run(due, entry.id).changes;
      return changed;
    });
  }

  pruneAcked(cutoff) {
    return transaction(this.db, () => this.pruneQuery.run(cutoff).changes);
  }

  status() {
    const pending = this.pendingCount();
    return {
      pending,
      acked: this.ackedCountQuery.get().n,
      capacity: this.capacity,
      full: pending >= this.capacity,
    };
  }

  close() { this.db.close(); }
}

// Read-only summary for the CLI. A WAL reader can fail if the shm file is not
// available, so a missing or unreadable database simply yields null.
export function queueStatus(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout=1000");
    return {
      pending: db.query("SELECT count(*) AS n FROM queue WHERE state='pending'").get().n,
      acked: db.query("SELECT count(*) AS n FROM queue WHERE state='acked'").get().n,
    };
  } catch { return null; }
  finally { try { db?.close(); } catch { /* best effort */ } }
}
