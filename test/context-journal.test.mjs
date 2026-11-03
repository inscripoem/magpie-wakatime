import { expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContextJournal } from "../src/context-journal.mjs";
import { Contexts } from "../src/contexts.mjs";
import { tempDirectory } from "./helpers.mjs";

function withJournal(run, options) {
  const directory = tempDirectory();
  const file = join(directory, "contexts.log");
  try { return run(file, directory, new ContextJournal(file, options)); }
  finally { rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 }); }
}

const entry = (response, time, extra = {}) => ({
  agent: "codex", response, session: `session-${response}`, t: time,
  project: "repo", branch: "main", language: "TypeScript", ...extra,
});

test("appends compact lines and loads them oldest first", () => {
  withJournal((file, _directory, journal) => {
    expect(journal.append(entry("r1", 1000))).toBe(true);
    expect(journal.append({ agent: "codex", project: "repo", t: 1500 })).toBe(false);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      a: "codex", r: "r1", s: "session-r1", p: "repo", b: "main", l: "TypeScript", t: 1000,
    });
    expect(lines[0]).not.toContain("prompt");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(journal.load(3000, 600_000)).toEqual([{
      agent: "codex", response: "r1", session: "session-r1", t: 1000,
      project: "repo", branch: "main", language: "TypeScript",
    }]);
  });
});

test("skips malformed and torn last lines and resumes on a new line", () => {
  withJournal((file, _directory, journal) => {
    writeFileSync(file, [
      JSON.stringify({ a: "codex", r: "r1", p: "repo", t: 1000 }),
      "{not json",
      JSON.stringify({ a: "codex", r: "r2", p: "repo", t: 2000 }),
      "{\"a\":\"codex\",\"r\":\"tor",
    ].join("\n"));
    expect(journal.load(5000, 600_000).map((value) => value.response)).toEqual(["r1", "r2"]);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    journal.append(entry("r3", 3000));
    expect(journal.load(5000, 600_000).map((value) => value.response)).toEqual(["r1", "r2", "r3"]);
    expect(readFileSync(file, "utf8")).not.toContain("tor");
  });
});

test("torn-line truncation is byte-safe for non-ASCII entries", () => {
  withJournal((file, _directory, journal) => {
    const value = entry("r-nonascii", 1000, {
      project: "项目-日本語-🚀", branch: "功能/分支", language: "TypeScript",
    });
    journal.append(value);
    appendFileSync(file, "{\"a\":\"codex\",\"r\":\"torn");
    const entries = journal.load(5000, 600_000);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      response: "r-nonascii", project: "项目-日本語-🚀", branch: "功能/分支", language: "TypeScript",
    });
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    journal.append(entry("r-after", 2000));
    expect(journal.load(5000, 600_000).map((item) => item.response)).toEqual(["r-nonascii", "r-after"]);
  });
});

test("filters entries older than the ttl", () => {
  withJournal((_file, _directory, journal) => {
    journal.append(entry("old", 1000));
    journal.append(entry("fresh", 8000));
    expect(journal.load(9000, 5000).map((value) => value.response)).toEqual(["fresh"]);
  });
});

test("compaction keeps only unexpired entries and is triggered by line count", () => {
  withJournal((file, _directory, journal) => {
    journal.append(entry("expired", 1000));
    journal.append(entry("kept-a", 8000));
    journal.append(entry("kept-b", 8500));
    expect(journal.load(9000, Infinity)).toHaveLength(3);
    expect(journal.maybeCompact(9000, 5000)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(journal.load(9000, Infinity).map((value) => value.response)).toEqual(["kept-a", "kept-b"]);
  }, { maxLines: 2 });
});

test("record populates response and session lookups and journals one line", () => {
  const directory = tempDirectory();
  const file = join(directory, "contexts.log");
  try {
    const value = { project: "repo", branch: "main", language: "TypeScript" };
    const contexts = new Contexts({ ttl: 600_000, journal: file, now: 1000 });
    contexts.record("codex", { response: "r1", session: "s1" }, value, 1000);
    expect(contexts.get({ agent: "codex", response_id: "r1" }, 2000)).toEqual(value);
    expect(contexts.get({ agent: "codex", native_session: "s1" }, 2000)).toEqual(value);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);

    // A fresh instance recovers both lookups from the journal.
    const restarted = new Contexts({ ttl: 600_000, journal: file, now: 2000 });
    expect(restarted.get({ agent: "codex", response_id: "r1" }, 3000)).toEqual(value);
    expect(restarted.get({ agent: "codex", session: "s1" }, 3000)).toEqual(value);
  } finally { rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 }); }
});

test("a journal write failure never breaks the request path", () => {
  const directory = tempDirectory();
  const blocker = join(directory, "not-a-directory");
  writeFileSync(blocker, "");
  try {
    const contexts = new Contexts({ ttl: 600_000, journal: join(blocker, "contexts.log"), now: 1000 });
    contexts.record("codex", { response: "r1" }, { project: "repo" }, 1000);
    expect(contexts.get({ agent: "codex", response_id: "r1" }, 1000)).toEqual({ project: "repo" });
    expect(contexts.stats().journalErrors).toBeGreaterThan(0);
  } finally { rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 }); }
});
