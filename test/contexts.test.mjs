import { expect, test } from "bun:test";
import { Contexts } from "../src/contexts.mjs";

test("counts response, session, miss, no-key and expired lookups", () => {
  const contexts = new Contexts({ ttl: 1000 });
  contexts.setResponse("claude", "r1", { project: "repo", language: "TypeScript" }, 0);
  contexts.setSession("claude", "s1", { project: "session-repo" }, 0);
  expect(contexts.get({ agent: "claude", response_id: "r1" }, 10))
    .toEqual({ project: "repo", language: "TypeScript" });
  expect(contexts.get({ agent: "claude", response_id: "missing", session: "s1" }, 10))
    .toEqual({ project: "session-repo" });
  expect(contexts.get({ agent: "claude", response_id: "missing", session: "missing" }, 10)).toBeNull();
  expect(contexts.get({ agent: "claude" }, 10)).toBeNull();
  expect(contexts.get({ agent: "claude", response_id: "r1" }, 2000)).toBeNull();
  expect(contexts.stats()).toEqual({
    responseHit: 1, sessionHit: 1, miss: 2, pruned: 0, expired: 1, noKey: 1,
  });
  contexts.prune(3000);
  expect(contexts.stats().pruned).toBe(1);
});
