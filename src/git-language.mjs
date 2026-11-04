import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { detectLanguage } from "./language.mjs";

const exec = promisify(execFile);
export const CWD_LANGUAGE_TTL_MS = 10 * 60_000;
const CWD_LANGUAGE_CAPACITY = 100;

// Bounded, shared cache: a recovered cwd is inspected at most once per TTL.
// The key is the resolved directory, never a transcript or a file path.
const cache = new Map();

export function resetCwdLanguageCache() {
  cache.clear();
}

// Language of a recovered working directory, using the same read-only
// `git ls-files -z` plus `detectLanguage` path as the request hook. A missing
// directory, a non-Git directory, or a Git error yields null. Never throws.
export async function languageForCwd(cwd, {
  signal, now = Date.now(), ttl = CWD_LANGUAGE_TTL_MS, capacity = CWD_LANGUAGE_CAPACITY,
} = {}) {
  if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd)) return null;
  let key;
  try { key = resolve(cwd); } catch { return null; }
  const cached = cache.get(key);
  if (cached && now - cached.at < ttl) return cached.language;
  let files = "";
  try {
    const { stdout } = await exec("git", ["-C", key, "ls-files", "-z"], {
      encoding: "utf8", timeout: 600, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal,
    });
    files = stdout;
  } catch { files = ""; }
  let language = null;
  try { language = detectLanguage(files); } catch { language = null; }
  cache.delete(key);
  cache.set(key, { at: now, language });
  while (cache.size > capacity) cache.delete(cache.keys().next().value);
  return language;
}
