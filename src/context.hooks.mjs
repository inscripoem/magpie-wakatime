import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { detectLanguage } from "./language.mjs";
import { languageFromReply } from "./reply-language.mjs";
import { CodexSessions } from "./codex-session.mjs";

const exec = promisify(execFile);
let worker;
const languages = new Map();
const codexSessions = new CodexSessions();
const LANGUAGE_CACHE_LIMIT = 100;

async function trackedFiles(cwd, signal) {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "ls-files", "-z"], {
      encoding: "utf8", timeout: 600, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal,
    });
    return stdout;
  } catch { return ""; }
}

export function bindWorker(value) { worker = value; }

function label(value) {
  return typeof value === "string" && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : "";
}

// Snapshot before routing; delayed usage scans must not read a newer HEAD.
export async function onRequest(_body, ctx) {
  const current = worker;
  if (!current) return;
  if (current.stopped) { current.countHook?.("stopped"); return; }
  if (!current.enabled()) { current.countHook?.("disabled"); return; }
  if (current.state.get("enabledAt") === null) { current.countHook?.("notActivated"); return; }
  if (ctx.origin !== "local") { current.countHook?.("origin"); return; }
  if (current.options.excludeAgents.includes(ctx.agent)) { current.countHook?.("excludedAgent"); return; }
  if (typeof ctx.cwd !== "string" || !isAbsolute(ctx.cwd)) { current.countHook?.("noCwd", ctx.agent); return; }
  if (ctx.signal?.aborted) { current.countHook?.("aborted"); return; }
  try {
    if (!(await stat(ctx.cwd)).isDirectory()) { current.countHook?.("notDirectory"); return; }
    const git = async (...args) => {
      try {
        const { stdout } = await exec("git", ["-C", ctx.cwd, ...args], {
          encoding: "utf8", timeout: 400, maxBuffer: 4096, windowsHide: true, signal: ctx.signal,
        });
        return stdout.trim();
      } catch { return ""; }
    };
    const key = resolve(ctx.cwd);
    const [location, branch, files] = await Promise.all([
      git("rev-parse", "--show-toplevel", "--git-common-dir"), git("symbolic-ref", "--quiet", "--short", "HEAD"),
      languages.has(key) ? "" : trackedFiles(ctx.cwd, ctx.signal),
    ]);
    const [root, common] = location.split(/\r?\n/);
    const projectRoot = common && basename(common) === ".git" ? dirname(resolve(ctx.cwd, common)) : root;
    const project = label(basename(projectRoot || ctx.cwd));
    if (!project) { current.countHook?.("projectEmpty"); return; }
    if (ctx.signal?.aborted || current !== worker || current.stopped) { current.countHook?.("discarded"); return; }
    let language = languages.get(key);
    if (language === undefined) {
      language = detectLanguage(files);
      if (languages.size >= LANGUAGE_CACHE_LIMIT) languages.delete(languages.keys().next().value);
      languages.set(key, language);
    }
    ctx.state.wakatime = { project };
    if (root && label(branch)) ctx.state.wakatime.branch = label(branch);
    if (language) ctx.state.wakatime.language = language;
    // Codex records the files it changed after the tool runs. Its session file
    // names the same UUID the gateway reports as ctx.session, so a finished
    // apply_patch becomes the language of the following requests.
    if (ctx.agent === "codex" && typeof ctx.session === "string") {
      const fromSession = codexSessions.language(ctx.session);
      if (fromSession) ctx.state.wakatime.language = fromSession;
    }
    current.countHook?.("ok");
  } catch { current.countHook?.("error"); /* Context is optional; leave the agent request unchanged. */ }
}

export async function onResponse(reply, ctx) {
  if (!worker || worker.stopped || !worker.enabled() || ctx.signal?.aborted || !ctx.state.wakatime) return;
  let picked = null;
  try { picked = languageFromReply(reply, ctx.protocol ?? ctx.request?.protocol); }
  catch { /* Language is optional; a parser failure leaves the Git guess. */ }
  if (picked?.language && (picked.write || !ctx.state.wakatime.language)) {
    ctx.state.wakatime.language = picked.language;
  }
  const response = reply?.id || reply?.responseId;
  try {
    worker.contexts.record(ctx.agent, { response, session: ctx.session }, ctx.state.wakatime);
  } catch { /* Usage polling continues when a best-effort notification is lost. */ }
}
