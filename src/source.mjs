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
// sends the offers; only then may the returned cursor be committed. `limit`
// caps the mapped offers per call: the returned cursor names exactly the
// processed prefix, including rows skipped as already seen or filtered, so a
// window can commit without waiting for the rest of the listing.
// A gateway row only names the client session. Claude Code and Codex write
// local transcripts beside the same id, so a row whose request hook had no cwd
// can still recover a language (and for Claude, project and branch) locally.
// Only the matching agent is consulted; others keep the configured fallback.
async function fallbackContext(row, claudeSessions, codexSessions, now, signal) {
  if (typeof row?.agent !== "string") return null;
  const agent = row.agent.trim();
  const session = row.native_session || row.session;
  try {
    if (agent === "claude") return (await claudeSessions?.context(session, now, { signal })) ?? null;
    if (agent === "codex") return (await codexSessions?.context(session, { signal, now })) ?? null;
  } catch { return null; }
  return null;
}

const CONTEXT_FIELDS = ["project", "branch", "language"];

// The explicit memory/journal context wins field by field; the derived context
// fills only what it left empty. Both inputs can be cached and read-only, so a
// merged result is always a fresh object.
function mergeContext(explicit, derived) {
  if (!explicit) return derived;
  if (!derived) return explicit;
  const merged = { ...derived };
  for (const name of CONTEXT_FIELDS) {
    const value = explicit[name];
    if (value !== undefined && value !== null && value !== "") merged[name] = value;
  }
  return merged;
}

async function readRange(state, options, day, start, end, {
  now, fetcher, signal, contexts, claudeSessions, codexSessions, seen, budget, pass, limit = Infinity,
}) {
  const salt = state.get("salt");
  const enabledAt = state.get("enabledAt");
  let offset = start, pages = 0, items = [], lastId = null, lastTime = 0;
  while (offset < end && pages < budget) {
    const pageStart = offset;
    const body = await sourcePage(options, day, pageStart, { fetcher, signal });
    // A lower total means rows were removed between pages. A higher total is
    // a tail append and does not move the prefix; the post-read tail checks
    // catch a middle insertion.
    if (body.total < pass.total) pass.unstable = true;
    if (!body.rows.length) break;
    const stop = Math.min(body.rows.length, end - pageStart);
    let consumed = 0, full = false;
    for (let index = 0; index < stop; index++) {
      const row = body.rows[index];
      const id = sourceId(row ?? {}, salt);
      lastId = cursorId(id);
      const time = timestamp(row);
      if (time !== null) lastTime = time;
      consumed = index + 1;
      // Rows already known from an earlier pass are not newly processed here;
      // tracking them would mark every later pass unstable forever.
      if (seen?.has(id)) continue;
      // A row repeated across pages means the listing shifted under the scan.
      // The set is per pass; the global seen set cannot detect this because a
      // repeat can still be new to this pass.
      if (pass.ids.has(id)) pass.unstable = true;
      else pass.ids.add(id);
      let payload;
      try {
        // Explicit context wins field by field; a session transcript only
        // fills the fields it left empty. mapRow still lets projectByAgent
        // override the project.
        const explicit = contexts?.get(row, now) ?? null;
        const derived = await fallbackContext(row, claudeSessions, codexSessions, now, signal);
        payload = mapRow(row, options, salt, mergeContext(explicit, derived));
      } catch (error) {
        if (error.message !== "invalid-row") throw error;
        state.setDiagnostic("lastInvalidRow", { day, offset: pageStart + index, id, error: "invalid-row" });
        seen?.add(id, now);
        continue;
      }
      if (!payload || payload.time * 1000 < enabledAt) {
        seen?.add(id, now);
        continue;
      }
      items.push({ id, payload });
      if (items.length >= limit) { full = true; break; }
    }
    offset = pageStart + consumed;
    pages++;
    if (full) break;
  }
  return { items, offset, complete: offset >= end, lastId, lastTime };
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
  return check.total >= total && (check.rows.length ? cursorId(sourceId(check.rows[0], salt)) : null) === head;
}

export async function collectDay(state, options, day, {
  now = Date.now(), fetcher = fetch, signal, contexts = null, claudeSessions = null,
  codexSessions = null, seen = null, budget = 20, limit = Infinity,
} = {}) {
  const enabledAt = state.get("enabledAt");
  if (enabledAt === null) return { items: [], cursor: null, complete: true, stable: true };
  const salt = state.get("salt");
  const cursor = state.cursor(day);
  const first = await sourcePage(options, day, 0, { fetcher, signal });
  const head = first.rows.length ? cursorId(sourceId(first.rows[0], salt)) : null;
  const total = first.total;
  // Shared by every range read in this pass so cross-page repeats and total
  // changes invalidate the pass for the whole day.
  const pass = { total, ids: new Set(), unstable: false };
  const context = { now, fetcher, signal, contexts, claudeSessions, codexSessions, seen, budget, total, pass, limit };

  let result;
  if (!cursor) {
    const range = await readRange(state, options, day, 0, total, context);
    result = {
      items: range.items,
      cursor: makeCursor(head, total, range, null, range.complete),
      complete: range.complete,
      stable: true,
      reset: true,
    };
  } else if (total === 0) {
    result = {
      items: [], cursor: { offset: 0, head: null, tail: null, total: 0, time: 0 }, complete: true, stable: true,
    };
  } else if (head === cursor.head && total === cursor.total && cursor.offset >= total) {
    result = { items: [], cursor, complete: true, stable: true };
  } else if (head === cursor.head) {
    if (await verifyTail(state, options, day, cursor, context)) {
      const range = await readRange(state, options, day, cursor.offset, total, context);
      result = {
        items: range.items,
        cursor: makeCursor(head, total, range, cursor, range.complete),
        complete: range.complete,
        stable: true,
      };
    } else {
      const range = await readRange(state, options, day, 0, total, context);
      result = {
        items: range.items,
        cursor: makeCursor(head, total, range, null, range.complete),
        complete: range.complete,
        stable: true,
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
        stable: true,
        reset: true,
      };
    } else {
      // Rows inserted before the old head have to be processed before the
      // already-processed prefix can be named again. Keep the old cursor on
      // disk for the whole front: an intermediate front-only cursor would
      // forget the verified old prefix, so a crash mid-front would restart by
      // re-reading (and re-sending) that old prefix. Only once the entire
      // front is processed does the merged cursor name the old prefix at its
      // new position. A crash mid-front re-reads just the inserted rows.
      const front = await readRange(state, options, day, 0, oldHeadIndex, context);
      if (front.offset >= oldHeadIndex) {
        const combinedOffset = oldHeadIndex + cursor.offset;
        result = {
          items: front.items,
          cursor: { offset: combinedOffset, head, tail: cursor.tail, total, time: cursor.time },
          complete: combinedOffset >= total,
          stable: true,
        };
      } else {
        result = {
          items: front.items,
          cursor,
          complete: false,
          stable: true,
        };
      }
    }
  }

  // A page total change or a repeated id means the listing moved while it was
  // read. Any cursor from this pass could skip the inserted row, so let the
  // next pass re-read from the old cursor. The gateway's usage store is
  // append-only; a same-total rewrite of the middle of a completed day is
  // outside this detection and the cursor's contract.
  if (pass.unstable) {
    return { ...result, cursor, complete: false, stable: false };
  }
  // A tail append changes the total but not the processed prefix, so requiring
  // an exact total would stall a busy gateway. Re-check the old cursor after
  // the read instead: an insertion before the window moves its tail row, while
  // a tail append leaves it in place. A reset result has already decided to
  // re-read from zero, so the moved old tail must not reject the reset itself;
  // the candidate-tail check below governs that path. Then verify the
  // candidate's own tail so a shift inside the window cannot be committed.
  if (!result.reset && cursor && head === cursor.head &&
      !(await verifyTail(state, options, day, cursor, context))) {
    return { ...result, cursor, complete: false, stable: false };
  }
  // The head id must be unchanged; the total may grow from tail appends.
  if (!(await stableHead(options, day, head, total, salt, context))) {
    return { ...result, cursor, complete: false, stable: false };
  }
  if (result.cursor && (!cursor || result.cursor.offset !== cursor.offset ||
      result.cursor.tail !== cursor.tail) &&
      !(await verifyTail(state, options, day, result.cursor, context))) {
    return { ...result, cursor, complete: false, stable: false };
  }
  return result;
}
