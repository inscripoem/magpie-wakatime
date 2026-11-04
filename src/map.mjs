import { createHmac } from "node:crypto";
import { userAgent } from "./user-agent.mjs";

function digest(value, salt) {
  return createHmac("sha256", salt).update(JSON.stringify(value)).digest("hex");
}

export function sourceId(row, salt) {
  return digest([row.t, row.route_id ?? "", row.agent ?? "", row.provider ?? "",
    row.host ?? "", row.model ?? "", row.rid || row.response_id || ""], salt);
}

// Durable replay key. The gateway assigns route_id once per request and keeps
// it while finalizing the other fields, so it stays stable even when rid or the
// served model is filled in later. The salted digest keeps the raw route id on
// this machine. Rows without a route id fall back to the source id.
export function sourceKey(row, salt) {
  const route = typeof row?.route_id === "string" ? row.route_id : "";
  return route ? digest(["route", row.agent ?? "", route], salt) : sourceId(row ?? {}, salt);
}

export function contextKey(agent, response, salt) {
  return typeof response === "string" && response ? `context:${digest([agent ?? "", response], salt)}` : null;
}

export function mapRow(row, options, salt, context) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid-row");
  const caller = typeof row.callerKeyName === "string" && row.callerKeyName
    ? row.callerKeyName
    : typeof row.callerKeyLabel === "string" ? row.callerKeyLabel : "";
  if (row.computer || row.rejected || (row.source && row.source !== "through") ||
      (row.via && row.via !== "through") || options.excludeAgents.includes(row.agent) ||
      (caller && options.excludeCallerKeys?.includes(caller))) return null;
  const time = typeof row.t === "string" ? Date.parse(row.t) / 1000 : NaN;
  const values = [row.in, row.out, row.cache_read ?? 0, row.cache_write ?? 0];
  if (!Number.isFinite(time) || time <= 0 || values.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error("invalid-row");
  }
  const total = values[0] + values[1] + values[2] + values[3];
  if (!Number.isSafeInteger(total)) throw new Error("invalid-row");
  if (total === 0) return null;
  const agent = typeof row.agent === "string" && row.agent.trim().length <= 255 ? row.agent.trim() : "";
  // WakaTime bills uncached input, cached input and output apart. Cache writes
  // bill at the input rate, so they stay in ai_input_tokens; cached reads go in
  // ai_cached_input_tokens, which wakatime-cli omits when zero.
  const cacheRead = values[2];
  const payload = {
    entity: agent || "magpie", type: "app", category: "ai coding", time,
    project: Object.hasOwn(options.projectByAgent, row.agent) ? options.projectByAgent[row.agent] : context?.project || options.project,
    ai_input_tokens: values[0] + values[3], ai_output_tokens: values[1], is_write: false,
    user_agent: userAgent(row.served || row.model, row.effort),
  };
  if (context?.branch) payload.branch = context.branch;
  if (context?.language) payload.language = context.language;
  if (cacheRead > 0) payload.ai_cached_input_tokens = cacheRead;
  const session = row.native_session || row.session;
  if (session) payload.ai_session = digest([row.agent ?? "", session], salt);
  return payload;
}
