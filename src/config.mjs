import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function readOptions(options = {}) {
  const invalid = () => { throw new Error("invalid-config"); };
  if (!options || typeof options !== "object" || Array.isArray(options)) invalid();
  let url;
  try { url = new URL(options.gatewayUrl ?? "http://127.0.0.1:3425"); } catch { invalid(); }
  if (!["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) invalid();
  const result = {
    gatewayUrl: url.origin, apiKeyEnv: options.apiKeyEnv ?? "WAKATIME_API_KEY",
    authAccount: options.authAccount ?? null,
    project: options.project ?? "Magpie", projectByAgent: options.projectByAgent ?? {},
    excludeAgents: options.excludeAgents ?? [],
    excludeCallerKeys: options.excludeCallerKeys ?? [],
    sessionFallback: options.sessionFallback ?? true,
    claudeProjectsRoot: options.claudeProjectsRoot ?? null,
    codexHome: options.codexHome ?? null,
  };
  const label = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 255;
  const root = (v) => v === null ||
    (typeof v === "string" && v.length > 0 && v.length <= 4096 && isAbsolute(v) && !v.includes("\0"));
  if (!label(result.project) || !/^[a-z_][a-z0-9_]*$/i.test(result.apiKeyEnv) ||
      (result.authAccount !== null && (!label(result.authAccount) || !/^wakatime(?:#[^\s#]+)?$/.test(result.authAccount))) ||
      !result.projectByAgent || typeof result.projectByAgent !== "object" || Array.isArray(result.projectByAgent) ||
      !Object.entries(result.projectByAgent).every(([k, v]) => label(k) && label(v)) ||
      !Array.isArray(result.excludeAgents) || !result.excludeAgents.every(label) ||
      !Array.isArray(result.excludeCallerKeys) || !result.excludeCallerKeys.every(label) ||
      typeof result.sessionFallback !== "boolean" || !root(result.claudeProjectsRoot) || !root(result.codexHome)) invalid();
  return result;
}

// The app stores keys entered in its sign-in prompt in plugin-auth.json.
function signInKey(directory, account) {
  let list = {};
  try { list = JSON.parse(readFileSync(join(directory, "plugin-auth.json"), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw new Error("key-config-unreadable");
  }
  if (!list || typeof list !== "object" || Array.isArray(list)) list = {};
  const ids = Object.keys(list).filter((id) => {
    const entry = list[id];
    return (id === "wakatime" || id.startsWith("wakatime#")) &&
      entry?.type === "api" && typeof entry.key === "string" && entry.key.trim();
  });
  if (account && !ids.includes(account)) throw new Error("key-account-missing");
  if (!account && ids.length > 1) throw new Error("key-account-ambiguous");
  const selected = account ?? ids[0];
  return selected ? list[selected].key.trim() : null;
}

export function readApiKey(directory, variable, env = process.env, account = null) {
  const signedIn = signInKey(directory, account);
  if (signedIn) return signedIn;
  if (env[variable]?.trim()) return env[variable].trim();
  const base = env.WAKATIME_HOME || env.USERPROFILE || env.HOME || homedir();
  if (!base) return null;
  let text;
  try { text = readFileSync(join(base, ".wakatime.cfg"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("key-config-unreadable"); }
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) section = header[1].toLowerCase();
    const entry = line.match(/^\s*api_key\s*=\s*(.*?)\s*$/i);
    if (section === "settings" && entry) return entry[1] || null;
  }
  return null;
}

export function pluginEnabled(directory, root) {
  try {
    const list = JSON.parse(readFileSync(join(directory, "plugins.json"), "utf8"));
    const normal = (s) => resolve(s.replace(/^file:\/\//, "")).replace(/\\/g, "/").toLowerCase();
    return list.plugins.some((p) => typeof p.spec === "string" && !p.off &&
      (/^magpie-wakatime(?:@[^/]+)?$/.test(p.spec) ||
       /^(?:git\+)?(?:https?:\/\/github\.com\/|github:)?(?:Dreaminko|inscripoem)\/magpie-wakatime(?:\.git)?\/?(?:#[^\s]+)?$/i.test(p.spec) ||
       normal(p.spec) === normal(root)));
  } catch { return false; }
}

export function defaultDirectory(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(env.USERPROFILE || env.HOME || homedir(), ".config"), "magpie");
}
