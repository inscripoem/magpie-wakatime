import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readOptions, readApiKey, pluginEnabled } from "./src/config.mjs";
import { Sync } from "./src/sync.mjs";
import { bindWorker } from "./src/context.hooks.mjs";
import { refresh, refreshDue } from "./src/remote-languages.mjs";

export default async function MagpieWakaTime({ directory }, options) {
  const root = dirname(fileURLToPath(import.meta.url));
  const worker = new Sync(directory, readOptions(options), { enabled: () => pluginEnabled(directory, root) });
  bindWorker(worker);
  worker.start();
  // The plugin ships a WakaTime language snapshot. Refresh it in the
  // background; a failed fetch keeps the snapshot and retries in an hour.
  const refreshLanguages = () => {
    try {
      if (worker.stopped || !refreshDue()) return;
      const key = readApiKey(directory, worker.options.apiKeyEnv, process.env, worker.options.authAccount);
      if (key) void refresh(key).catch(() => {});
    } catch { /* the worker reports credential problems */ }
  };
  refreshLanguages();
  const timer = setInterval(refreshLanguages, 60_000);
  timer.unref?.();
  return {
    // The sign-in row in the app is the intended way to hand over a WakaTime key.
    // It has no models; the provider exists only so magpie stores the key in
    // plugin-auth.json.
    auth: {
      provider: "wakatime",
      methods: [{ type: "api", label: "WakaTime API key", placeholder: "waka_..." }],
      loader: async () => ({}),
    },
  };
}
