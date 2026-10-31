import { expect, test } from "bun:test";
import { languageForFile, remoteLanguages, setRemoteLanguages } from "../src/language.mjs";
import { extensionsFrom, refresh, resetRefreshForTests } from "../src/remote-languages.mjs";

test("builds lowercase extension keys from the WakaTime list", () => {
  expect(extensionsFrom([
    { name: "Diff", extensions: [".diff", ".patch"] },
    { name: "JSON", extensions: [".json", ".jsonl"] },
    { name: "No extensions" },
    { name: "", extensions: [".bad"] },
  ])).toEqual({ diff: "Diff", patch: "Diff", json: "JSON", jsonl: "JSON" });
});

test("uses the refreshed map before the bundled fallback", () => {
  const original = remoteLanguages();
  try {
    setRemoteLanguages({ foo: "Foo" });
    expect(languageForFile("src/x.foo")).toBe("Foo");
    expect(languageForFile("src/x.ts")).toBe("TypeScript");
  } finally {
    setRemoteLanguages(original);
  }
});

test("refreshes the map from the API response", async () => {
  resetRefreshForTests();
  const original = remoteLanguages();
  try {
    const ok = await refresh("test-key", {
      now: 1,
      fetcher: async () => ({
        ok: true,
        json: async () => ({ data: [{ name: "Foo", extensions: [".foo"] }] }),
      }),
    });
    expect(ok).toBe(true);
    expect(languageForFile("notes/x.foo")).toBe("Foo");
  } finally {
    setRemoteLanguages(original);
    resetRefreshForTests();
  }
});
