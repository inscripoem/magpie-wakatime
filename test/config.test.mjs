import { expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDirectory } from "./helpers.mjs";
import { readOptions, readApiKey, pluginEnabled } from "../src/config.mjs";

test("accepts only loopback gateway origins", () => {
  expect(readOptions({}).gatewayUrl).toBe("http://127.0.0.1:3425");
  expect(readOptions({ gatewayUrl: "http://[::1]:4567/" }).gatewayUrl).toBe("http://[::1]:4567");
  for (const gatewayUrl of ["https://example.com", "http://127.0.0.1.evil", "http://user:secret@localhost", "http://localhost/path", "ftp://localhost"]) {
    expect(() => readOptions({ gatewayUrl })).toThrow("invalid-config");
  }
  expect(() => readOptions({ projectByAgent: [] })).toThrow("invalid-config");
  expect(() => readOptions({ excludeAgents: "codex" })).toThrow("invalid-config");
});

test("reads only the selected key source without modifying the standard config", () => {
  const dir = tempDirectory();
  try {
    const file = join(dir, ".wakatime.cfg");
    writeFileSync(file, "[other]\napi_key=wrong\n[settings]\napi_key = test-file-key\n");
    const env = { WAKATIME_HOME: dir, CUSTOM_KEY: "test-env-key" };
    expect(readApiKey(dir, "CUSTOM_KEY", env)).toBe("test-env-key");
    expect(readApiKey(dir, "MISSING", env)).toBe("test-file-key");
    writeFileSync(file, "[settings]\napi_key=\n");
    expect(readApiKey(dir, "MISSING", env)).toBeNull();
  } finally { rmSync(dir, { recursive: true }); }
});

test("prefers the key entered in the app sign-in over environment and file keys", () => {
  const dir = tempDirectory();
  try {
    writeFileSync(join(dir, ".wakatime.cfg"), "[settings]\napi_key = file-key\n");
    const env = { WAKATIME_HOME: dir, WAKATIME_API_KEY: "env-key" };
    writeFileSync(join(dir, "plugin-auth.json"), "{broken");
    expect(readApiKey(dir, "WAKATIME_API_KEY", env)).toBe("env-key");
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ zcode: { type: "oauth", access: "token" } }));
    expect(readApiKey(dir, "WAKATIME_API_KEY", env)).toBe("env-key");
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({
      wakatime: { type: "api", key: "" },
      "wakatime#2": { type: "api", key: "second-account" },
    }));
    expect(readApiKey(dir, "WAKATIME_API_KEY", env)).toBe("second-account");
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ wakatime: { type: "api", key: " signed-in-key " } }));
    expect(readApiKey(dir, "WAKATIME_API_KEY", env)).toBe("signed-in-key");
    rmSync(join(dir, ".wakatime.cfg"));
    rmSync(join(dir, "plugin-auth.json"));
    expect(readApiKey(dir, "MISSING_KEY", { WAKATIME_HOME: dir })).toBeNull();
  } finally { rmSync(dir, { recursive: true }); }
});

test("requires an explicit binding when multiple WakaTime accounts exist", () => {
  const dir = tempDirectory();
  const file = join(dir, "plugin-auth.json");
  const env = { WAKATIME_HOME: dir, WAKATIME_API_KEY: "env-key" };
  try {
    expect(readOptions({ authAccount: "wakatime#new" }).authAccount).toBe("wakatime#new");
    for (const authAccount of ["other", "wakatime#", "wakatime#two accounts", 42]) {
      expect(() => readOptions({ authAccount })).toThrow("invalid-config");
    }
    const accounts = {
      wakatime: { type: "api", key: "old-key" },
      "wakatime#new": { type: "api", key: "new-key" },
    };
    for (const entries of [Object.entries(accounts), Object.entries(accounts).reverse()]) {
      writeFileSync(file, JSON.stringify(Object.fromEntries(entries)));
      expect(() => readApiKey(dir, "WAKATIME_API_KEY", env)).toThrow("key-account-ambiguous");
      expect(readApiKey(dir, "WAKATIME_API_KEY", env, "wakatime#new")).toBe("new-key");
      expect(readApiKey(dir, "WAKATIME_API_KEY", env, "wakatime")).toBe("old-key");
    }
    accounts["wakatime#new"].key = "rotated-key";
    writeFileSync(file, JSON.stringify(accounts));
    expect(readApiKey(dir, "WAKATIME_API_KEY", env, "wakatime#new")).toBe("rotated-key");
    delete accounts["wakatime#new"];
    writeFileSync(file, JSON.stringify(accounts));
    expect(() => readApiKey(dir, "WAKATIME_API_KEY", env, "wakatime#new")).toThrow("key-account-missing");
    rmSync(file);
    expect(() => readApiKey(dir, "WAKATIME_API_KEY", env, "wakatime#new")).toThrow("key-account-missing");
  } finally { rmSync(dir, { recursive: true }); }
});

test("stops when its local or npm entry is disabled or removed", () => {
  const dir = tempDirectory();
  try {
    const file = join(dir, "plugins.json");
    writeFileSync(file, JSON.stringify({ plugins: [{ spec: "F:/plugin", off: false }] }));
    expect(pluginEnabled(dir, "F:/plugin")).toBe(true);
    writeFileSync(file, JSON.stringify({ plugins: [{ spec: "magpie-wakatime@0.1.0", off: true }] }));
    expect(pluginEnabled(dir, "F:/plugin")).toBe(false);
    writeFileSync(file, JSON.stringify({ plugins: [{ spec: "magpie-wakatime@0.1.0" }] }));
    expect(pluginEnabled(dir, "F:/plugin")).toBe(true);
    writeFileSync(file, "{broken");
    expect(pluginEnabled(dir, "F:/plugin")).toBe(false);
  } finally { rmSync(dir, { recursive: true }); }
});

test("recognizes GitHub installations and still honors their disabled state", () => {
  const dir = tempDirectory();
  try {
    const file = join(dir, "plugins.json");
    for (const spec of [
      "https://github.com/Dreaminko/magpie-wakatime",
      "https://github.com/Dreaminko/magpie-wakatime.git",
      "https://github.com/Dreaminko/magpie-wakatime/",
      "https://github.com/Dreaminko/magpie-wakatime#v0.1.6",
      "git+https://github.com/Dreaminko/magpie-wakatime.git#main",
      "https://github.com/dreaminko/MAGPIE-WAKATIME.git",
      "https://github.com/inscripoem/magpie-wakatime.git",
      "github:inscripoem/magpie-wakatime",
      "github:inscripoem/magpie-wakatime#feat/reply-language-tool-calls",
      "inscripoem/magpie-wakatime#main",
    ]) {
      writeFileSync(file, JSON.stringify({ plugins: [{ spec }] }));
      expect(pluginEnabled(dir, "F:/installed-plugin")).toBe(true);
      writeFileSync(file, JSON.stringify({ plugins: [{ spec, off: true }] }));
      expect(pluginEnabled(dir, "F:/installed-plugin")).toBe(false);
    }
    writeFileSync(file, JSON.stringify({ plugins: [] }));
    expect(pluginEnabled(dir, "F:/installed-plugin")).toBe(false);
  } finally { rmSync(dir, { recursive: true }); }
});

test("does not enable the plugin for unrelated GitHub repositories or hosts", () => {
  const dir = tempDirectory();
  try {
    const file = join(dir, "plugins.json");
    for (const spec of [
      "https://github.com/other/magpie-wakatime",
      "github:other/magpie-wakatime",
      "other/magpie-wakatime",
      "https://github.com/Dreaminko/magpie-wakatime-other",
      "https://github.com/Dreaminko/magpie-wakatime/tree/main",
      "https://github.com.evil/Dreaminko/magpie-wakatime",
      "https://example.com/Dreaminko/magpie-wakatime",
      "https://example.com/#https://github.com/Dreaminko/magpie-wakatime",
    ]) {
      writeFileSync(file, JSON.stringify({ plugins: [{ spec }] }));
      expect(pluginEnabled(dir, "F:/installed-plugin")).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true }); }
});
