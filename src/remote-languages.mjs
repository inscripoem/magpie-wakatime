import { setRemoteLanguages } from "./language.mjs";

const SOURCE = "https://wakatime.com/api/v1/program_languages";
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
let next = 0;

export function extensionsFrom(list) {
  const extensions = {};
  if (!Array.isArray(list)) return extensions;
  for (const language of list) {
    if (!language || typeof language.name !== "string" || !language.name) continue;
    for (const extension of Array.isArray(language.extensions) ? language.extensions : []) {
      if (typeof extension !== "string" || !extension) continue;
      const key = extension.replace(/^\./, "").toLowerCase();
      if (key && !(key in extensions)) extensions[key] = language.name;
    }
  }
  return extensions;
}

export function refreshDue(now = Date.now()) {
  return now >= next;
}

export async function refresh(apiKey, { fetcher = fetch, now = Date.now() } = {}) {
  if (!apiKey || !refreshDue(now)) return false;
  next = now + REFRESH_MS;
  try {
    const response = await fetcher(SOURCE, {
      headers: {
        Authorization: `Basic ${Buffer.from(apiKey).toString("base64")}`,
        "User-Agent": "magpie-wakatime",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      next = now + RETRY_MS;
      return false;
    }
    const body = await response.json();
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
    const extensions = extensionsFrom(list);
    if (!Object.keys(extensions).length) {
      next = now + RETRY_MS;
      return false;
    }
    setRemoteLanguages(extensions);
    return true;
  } catch {
    next = now + RETRY_MS;
    return false;
  }
}

export function resetRefreshForTests() {
  next = 0;
}
