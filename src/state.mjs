import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

export const FLUSH_MS = 5 * 60_000;
export const LOCK_TTL_MS = 10 * 60_000;
const LOCK_CACHE_MS = 60_000;
const LOCK_STALE_MS = 60_000;
const OWNER_FILE = "owner.json";
const DURABLE_DIAGNOSTICS = new Set(["credentials", "sendError", "queueError"]);

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function tempPath(file) {
  return `${file}.${process.pid}.tmp`;
}

function syncDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    // Windows and some filesystems reject opening or fsyncing a directory.
    // The rename stays atomic there; only its durability is weaker.
    if (!["EINVAL", "EPERM", "EISDIR"].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function publish(temp, file) {
  try {
    renameSync(temp, file);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* keep the original error */ }
    throw error;
  }
}

// Write beside the target and rename over it. A process crash never leaves a
// torn live file: readers see either the previous complete file or the new
// one. A power cut can still lose the newest publish, so nothing that must
// survive it lives only here. The cursor flush repeats salt/gateway/enabledAt
// so either state file can restore them, and identity.json is fsynced below.
// The live file is never deleted, and the temp name carries the pid so a stale
// temp from a dead process can never be published.
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = tempPath(file);
  try {
    writeFileSync(temp, text, { mode: 0o600 });
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* keep the original error */ }
    throw error;
  }
  publish(temp, file);
}

// Identity is written once per activation, so it pays for fsync; the cursor
// never does, because a bounded replay is already the accepted failure rule.
function writeDurable(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = tempPath(file);
  let fd;
  try {
    fd = openSync(temp, "w", 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* keep the original error */ }
    throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
  publish(temp, file);
  syncDirectory(dirname(file));
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function cursorFromArray(value) {
  if (!Array.isArray(value) || value.length !== 5) return null;
  return { offset: value[0], head: value[1], tail: value[2], total: value[3], time: value[4] };
}

function cursorToArray(cursor) {
  return [cursor.offset, cursor.head, cursor.tail, cursor.total, cursor.time];
}

// Everything the worker needs between restarts, kept in small JSON files.
// The cursor is the scan boundary; heartbeat payloads and acknowledgement
// tombstones live in the durable queue database. Request contexts live in
// their own append-only journal, not here.
export class State {
  constructor(file, {
    lockDirectory = file.replace(/state\.json$/, "owner.lock"),
    identityFile = file.replace(/state\.json$/, "identity.json"),
    now = Date.now(),
    pid = process.pid,
    host = hostname(),
    alive = processAlive,
    lockTtl = LOCK_TTL_MS,
  } = {}) {
    this.file = file;
    this.lockDirectory = lockDirectory;
    this.identityFile = identityFile;
    this.pid = pid;
    this.host = host;
    this.alive = alive;
    this.lockTtl = lockTtl;
    const identity = readJson(identityFile);
    const disk = readJson(file) ?? {};
    this.salt = typeof identity?.salt === "string" && identity.salt ? identity.salt :
      typeof disk.salt === "string" && disk.salt ? disk.salt : randomBytes(16).toString("hex");
    this.gateway = typeof identity?.gateway === "string" ? identity.gateway :
      typeof disk.gateway === "string" ? disk.gateway : null;
    this.enabledAt = Number.isSafeInteger(identity?.enabledAt) ? identity.enabledAt :
      Number.isSafeInteger(disk.enabledAt) ? disk.enabledAt : null;
    this.backfillDay = typeof disk.backfillDay === "string" ? disk.backfillDay : null;
    this.lastCompleteDay = typeof disk.lastCompleteDay === "string" ? disk.lastCompleteDay : null;
    this.cursors = {};
    if (disk.cursors && typeof disk.cursors === "object") {
      for (const [day, value] of Object.entries(disk.cursors)) {
        const cursor = cursorFromArray(value);
        if (cursor) this.cursors[day] = cursor;
      }
    }
    // Diagnostics are included in the next cursor flush but do not make the
    // file dirty on their own, so an idle worker performs no state writes.
    this.diagnostics = disk.diagnostics && typeof disk.diagnostics === "object" ? { ...disk.diagnostics } : {};
    this.dirty = false;
    this.diagnosticsDirty = false;
    this.lastFlush = now;
    this.stateWrites = 0;
    this.leaseWrites = 0;
    this.lockAcquisitions = 0;
    this.lockCache = null;
    this.lockOwner = null;
    this.identityReady = !!identity;
    if (this.enabledAt !== null && !identity) this.writeIdentity();
  }

  get(key) {
    switch (key) {
      case "salt": return this.salt;
      case "gateway": return this.gateway;
      case "enabledAt": return this.enabledAt;
      case "backfillDay": return this.backfillDay;
      case "lastCompleteDay": return this.lastCompleteDay;
      default: return Object.hasOwn(this.diagnostics, key) ? this.diagnostics[key] : null;
    }
  }

  set(key, value) {
    switch (key) {
      case "salt":
        if (value === this.salt) return;
        this.salt = value;
        this.writeIdentity();
        return;
      case "gateway":
        if (value === this.gateway) return;
        this.gateway = value;
        this.writeIdentity();
        return;
      case "enabledAt":
        if (value === this.enabledAt) return;
        this.enabledAt = value;
        this.writeIdentity();
        return;
      case "backfillDay":
        if (value === this.backfillDay) return;
        this.backfillDay = value;
        this.dirty = true;
        return;
      case "lastCompleteDay":
        if (value === this.lastCompleteDay) return;
        this.lastCompleteDay = value;
        this.dirty = true;
        return;
      default:
        this.diagnostics[key] = value;
    }
  }

  setDiagnostic(key, value) {
    const previous = this.diagnostics[key];
    if (JSON.stringify(previous ?? null) === JSON.stringify(value ?? null)) return false;
    if (value === null || value === undefined) delete this.diagnostics[key];
    else this.diagnostics[key] = value;
    if (DURABLE_DIAGNOSTICS.has(key)) this.diagnosticsDirty = true;
    return true;
  }

  cursor(day) { return this.cursors[day] ? { ...this.cursors[day] } : null; }

  setCursor(day, cursor) {
    const previous = this.cursors[day];
    if (!cursor) {
      if (!previous) return false;
      delete this.cursors[day];
    } else if (previous && previous.offset === cursor.offset && previous.head === cursor.head &&
      previous.tail === cursor.tail && previous.total === cursor.total && previous.time === cursor.time) {
      return false;
    } else {
      this.cursors[day] = { ...cursor };
    }
    this.dirty = true;
    return true;
  }

  pruneCursors(cutoffDay) {
    let changed = false;
    for (const day of Object.keys(this.cursors)) {
      if (day < cutoffDay) { delete this.cursors[day]; changed = true; }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  writeIdentity() {
    const identity = { v: 1, salt: this.salt };
    if (this.gateway) identity.gateway = this.gateway;
    if (this.enabledAt !== null) identity.enabledAt = this.enabledAt;
    writeDurable(this.identityFile, JSON.stringify(identity));
    this.identityReady = true;
  }

  activate(gateway, now) {
    if (this.gateway && this.gateway !== gateway) throw new Error("source-changed");
    if (this.enabledAt !== null) {
      if (!this.identityReady) this.writeIdentity();
      return false;
    }
    this.gateway = gateway;
    this.enabledAt = now;
    this.writeIdentity();
    this.dirty = true;
    this.flush(now, true);
    return true;
  }

  flush(now = Date.now(), force = false) {
    if (!this.dirty && !this.diagnosticsDirty) return false;
    if (!force && now - this.lastFlush < FLUSH_MS && !this.diagnosticsDirty) return false;
    const cursors = {};
    for (const [day, cursor] of Object.entries(this.cursors)) cursors[day] = cursorToArray(cursor);
    // salt/gateway/enabledAt are repeated here so a lost identity.json is
    // recoverable from the newest cursor flush; the loader already prefers the
    // identity file and falls back to these copies.
    const data = { v: 1, salt: this.salt, cursors };
    if (this.gateway) data.gateway = this.gateway;
    if (this.enabledAt !== null) data.enabledAt = this.enabledAt;
    if (this.backfillDay) data.backfillDay = this.backfillDay;
    if (this.lastCompleteDay) data.lastCompleteDay = this.lastCompleteDay;
    if (Object.keys(this.diagnostics).length) data.diagnostics = this.diagnostics;
    writeAtomic(this.file, JSON.stringify(data));
    this.dirty = false;
    this.diagnosticsDirty = false;
    this.lastFlush = now;
    this.stateWrites++;
    return true;
  }

  readLock() {
    return readJson(join(this.lockDirectory, OWNER_FILE));
  }

  // A lock directory is used instead of flock(2): the plugin has no native
  // dependencies, mkdir is atomic under Bun across platforms, and EEXIST is a
  // clear contention signal. A same-host lock whose pid no longer exists is
  // stolen immediately, which fixes the old hung-alive lease failure. A live
  // pid is never stolen even if it stops renewing. Cross-host writers cannot
  // inspect each other's process table and fall back to the TTL.
  acquire(owner, now = Date.now()) {
    if (this.createLock(owner, now)) {
      this.lockAcquisitions++;
      this.remember(owner, now, true);
      return true;
    }
    const current = this.readLock();
    if (current?.owner === owner) {
      this.remember(owner, now, true);
      return true;
    }
    if (!this.lockIsStale(now)) return false;
    rmSync(this.lockDirectory, { recursive: true, force: true });
    if (!this.createLock(owner, now)) return false;
    this.lockAcquisitions++;
    this.remember(owner, now, true);
    return true;
  }

  createLock(owner, now) {
    mkdirSync(dirname(this.lockDirectory), { recursive: true, mode: 0o700 });
    try {
      mkdirSync(this.lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    try {
      writeFileSync(join(this.lockDirectory, OWNER_FILE),
        JSON.stringify({ owner, pid: this.pid, host: this.host, at: now }), { mode: 0o600 });
      this.leaseWrites++;
    } catch (error) {
      try { rmSync(this.lockDirectory, { recursive: true, force: true }); } catch { /* keep the original error */ }
      throw error;
    }
    return true;
  }

  lockIsStale(now) {
    const data = this.readLock();
    const complete = data && typeof data === "object" && !Array.isArray(data) &&
      typeof data.owner === "string" && data.owner.length > 0 &&
      typeof data.host === "string" && Number.isSafeInteger(data.pid) && Number.isFinite(data.at);
    if (!complete) {
      try { return now - statSync(this.lockDirectory).mtimeMs > LOCK_STALE_MS; }
      catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
    }
    if (data.host === this.host) return !this.alive(data.pid);
    return now - data.at > this.lockTtl;
  }

  remember(owner, now, value) {
    this.lockOwner = owner;
    this.lockCache = { owner, at: now, value };
  }

  owns(owner, now = Date.now()) {
    if (this.lockCache && this.lockCache.owner === owner && now - this.lockCache.at < LOCK_CACHE_MS) {
      return this.lockCache.value;
    }
    const data = this.readLock();
    const value = !!data && data.owner === owner;
    this.lockCache = { owner, at: now, value };
    return value;
  }

  release(owner) {
    this.lockCache = null;
    const data = this.readLock();
    if (data?.owner !== owner) return false;
    rmSync(this.lockDirectory, { recursive: true, force: true });
    this.leaseWrites++;
    if (this.lockOwner === owner) this.lockOwner = null;
    return true;
  }

  status(now = Date.now()) {
    const cursors = {};
    for (const [day, cursor] of Object.entries(this.cursors)) cursors[day] = { ...cursor };
    return {
      enabledAt: this.enabledAt,
      gateway: this.gateway,
      backfillDay: this.backfillDay,
      lastCompleteDay: this.lastCompleteDay,
      cursors,
      diagnostics: { ...this.diagnostics },
      active: this.lockOwner ? this.owns(this.lockOwner, now) : false,
    };
  }
}
