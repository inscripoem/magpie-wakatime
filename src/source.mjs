import { mapRow, sourceId } from "./map.mjs";

export function localDay(value = Date.now(), offset = 0) {
  const date = new Date(value);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function sourcePage(options, day, offset, { fetcher = fetch, signal } = {}) {
  const url = new URL("/v1/magpie/usage/requests", options.gatewayUrl);
  url.search = new URLSearchParams({ period: `${day}..${day}`, via: "through", computer: "this", offset, limit: 500 });
  let response;
  try {
    response = await fetcher(url, {
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(signal?.aborted ? "stopped" : "source-network");
  }
  if (!response.ok) throw new Error(`source-http-${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error("source-schema"); }
  if (!Array.isArray(body?.rows) || body.rows.length > 500 || !Number.isSafeInteger(body.total) ||
      body.total < body.rows.length || body.offset !== Math.min(offset, body.total)) throw new Error("source-schema");
  if (body.rows.length === 0 && offset < body.total) throw new Error("source-schema");
  return body;
}

// The cursor only needs to notice that the row at a position changed. The
// full salted HMAC stays in the in-memory seen set; 64 bits are ample for a
// day's cursor and keep the JSON small.
export function cursorId(value) {
  return typeof value === "string" ? value.slice(0, 16) : null;
}

function timestamp(row) {
  const value = row && typeof row === "object" && typeof row.t === "string" ? Date.parse(row.t) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

// A contiguous scan of [start, end). Every row seen in the range is offered
// unless it is already known, filtered out, or predates activation. The caller
// sends the offers; only then may the returned cursor be committed.
async function readRange(state, options, day, start, end, {
  now, fetcher, signal, contexts, seen, retryIds, budget,
}) {
  const salt = state.get("salt");
  const enabledAt = state.get("enabledAt");
  let offset = start, pages = 0, items = [], lastId = null, lastTime = 0, pendingRetry = false;
  while (offset < end && pages < budget) {
    const body = await sourcePage(options, day, offset, { fetcher, signal });
    if (!body.rows.length) break;
    const stop = Math.min(body.rows.length, end - offset);
    for (let index = 0; index < stop; index++) {
      const row = body.rows[index];
      const id = sourceId(row ?? {}, salt);
      lastId = cursorId(id);
      const time = timestamp(row);
      if (time !== null) lastTime = time;
      if (seen?.has(id)) continue;
      if (retryIds?.has(id)) { pendingRetry = true; continue; }
      let payload;
      try {
        payload = mapRow(row, options, salt, contexts?.get(row, now) ?? null);
      } catch (error) {
        if (error.message !== "invalid-row") throw error;
        state.setDiagnostic("lastInvalidRow", { day, offset: offset + index, id, error: "invalid-row" });
        seen?.add(id, now);
        continue;
      }
      if (!payload || payload.time * 1000 < enabledAt) {
        seen?.add(id, now);
        continue;
      }
      items.push({ id, payload });
    }
    offset += stop;
    pages++;
  }
  return { items, offset, complete: offset >= end, lastId, lastTime, pendingRetry };
}

function makeCursor(head, total, range, previous, complete) {
  const tail = range.lastId ?? previous?.tail ?? null;
  const time = range.lastTime || previous?.time || 0;
  return {
    offset: complete ? total : range.offset,
    head,
    tail,
    total,
    time,
  };
}

async function rowAt(options, day, index, { fetcher, signal }) {
  if (index < 0) return null;
  const body = await sourcePage(options, day, index, { fetcher, signal });
  return body.rows[0] ?? null;
}

// The cursor names the last row of the processed prefix. If the row at that
// position is still the same row, the prefix is unchanged and only the tail
// after it is new. A mismatch means an insertion or removal inside the prefix,
// so the day has to be re-read; the in-memory seen set keeps that safe.
async function verifyTail(state, options, day, cursor, { fetcher, signal, total }) {
  if (cursor.offset <= 0) return true;
  if (cursor.offset > (total ?? cursor.total)) return false;
  const row = await rowAt(options, day, cursor.offset - 1, { fetcher, signal });
  return !!row && cursorId(sourceId(row, state.get("salt"))) === cursor.tail;
}

async function findHead(state, options, day, first, target, { fetcher, signal, budget }) {
  const salt = state.get("salt");
  let offset = 0, body = first, pages = 0;
  while (offset < body.total && pages < budget) {
    for (let index = 0; index < body.rows.length; index++) {
      if (cursorId(sourceId(body.rows[index], salt)) === target) return offset + index;
    }
    offset += body.rows.length;
    if (!body.rows.length || offset >= body.total) return -1;
    body = await sourcePage(options, day, offset, { fetcher, signal });
    pages++;
  }
  return -1;
}

// The final probe uses the same salt the pass used, so it can compare the head
// it started from without another parameter.
async function stableHead(options, day, head, total, salt, { fetcher, signal }) {
  const check = await sourcePage(options, day, 0, { fetcher, signal });
  return check.total === total && (check.rows.length ? cursorId(sourceId(check.rows[0], salt)) : null) === head;
}

export async function collectDay(state, options, day, {
  now = Date.now(), fetcher = fetch, signal, contexts = null, seen = null,
  retryIds = null, budget = 20,
} = {}) {
  const enabledAt = state.get("enabledAt");
  if (enabledAt === null) return { items: [], cursor: null, complete: true };
  const salt = state.get("salt");
  const cursor = state.cursor(day);
  const first = await sourcePage(options, day, 0, { fetcher, signal });
  const head = first.rows.length ? cursorId(sourceId(first.rows[0], salt)) : null;
  const total = first.total;
  const context = { now, fetcher, signal, contexts, seen, retryIds, budget, total };

  let result;
  if (!cursor) {
    const range = await readRange(state, options, day, 0, total, context);
    result = {
      items: range.items,
      cursor: makeCursor(head, total, range, null, range.complete),
      complete: range.complete,
      pendingRetry: range.pendingRetry,
      reset: true,
    };
  } else if (total === 0) {
    result = { items: [], cursor: { offset: 0, head: null, tail: null, total: 0, time: 0 }, complete: true };
  } else if (head === cursor.head && total === cursor.total && cursor.offset >= total) {
    result = { items: [], cursor, complete: true };
  } else if (head === cursor.head) {
    if (await verifyTail(state, options, day, cursor, context)) {
      const range = await readRange(state, options, day, cursor.offset, total, context);
      result = {
        items: range.items,
        cursor: makeCursor(head, total, range, cursor, range.complete),
        complete: range.complete,
        pendingRetry: range.pendingRetry,
      };
    } else {
      const range = await readRange(state, options, day, 0, total, context);
      result = {
        items: range.items,
        cursor: makeCursor(head, total, range, null, range.complete),
        complete: range.complete,
        pendingRetry: range.pendingRetry,
        reset: true,
      };
    }
  } else {
    const oldHeadIndex = await findHead(state, options, day, first, cursor.head, context);
    const tailIndex = oldHeadIndex + cursor.offset - 1;
    const prefixStable = oldHeadIndex >= 0 && tailIndex < total &&
      (await verifyTail(state, options, day, {
        ...cursor, offset: oldHeadIndex + cursor.offset,
      }, context));
    if (!prefixStable) {
      const range = await readRange(state, options, day, 0, total, context);
      result = {
        items: range.items,
        cursor: makeCursor(head, total, range, null, range.complete),
        complete: range.complete,
        pendingRetry: range.pendingRetry,
        reset: true,
      };
    } else {
      const front = await readRange(state, options, day, 0, oldHeadIndex, context);
      const tailStart = oldHeadIndex + cursor.offset;
      const tail = tailStart < total
        ? await readRange(state, options, day, tailStart, total, context)
        : { items: [], offset: tailStart, complete: true, lastId: null, lastTime: 0 };
      const complete = front.complete && tail.complete;
      const previous = tail.lastId ? null : cursor;
      const combinedRange = {
        offset: tail.lastId ? tail.offset : tailStart,
        lastId: tail.lastId ?? cursor.tail,
        lastTime: tail.lastTime || cursor.time,
      };
      result = {
        items: [...front.items, ...tail.items],
        cursor: complete ? makeCursor(head, total, combinedRange, previous, true) : cursor,
        complete,
        pendingRetry: front.pendingRetry || tail.pendingRetry,
      };
    }
  }

  if (!result.complete) return result;
  // Pages shift when another request completes while they are read. A changed
  // head or total means this pass may have skipped or repeated a row; leave the
  // cursor alone and let the next pass use the seen set.
  if (!(await stableHead(options, day, head, total, salt, context))) {
    return { ...result, cursor, complete: false };
  }
  return result;
}
