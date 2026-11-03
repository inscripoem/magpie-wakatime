# Implementation status

Source plan: PLAN.md. This file records the current state; the status paragraph at the end of PLAN.md section 10 describes the plan-time situation only.

## Delivered

0.1.5 runs from this directory with no build step and no dependencies: `package.json`, `index.mjs`, and the modules in `src/`, plus `README.md`, the plugin picture in `assets/` and behavior tests in `test/`. The plugin also returns an `auth` hook whose only method is an API key prompt, so the app's 插件 page and `magpie plugin login wakatime` can store the WakaTime key for it. Heartbeats name the agent (`entity`) instead of always reporting `magpie`; heartbeats sent before that change used the fixed value, and an existing host keeps the old mapping until it restarts. 0.1.2 splits cached input out of `ai_input_tokens`: heartbeats sent by 0.1.1 reported `in + cache_read + cache_write` as one uncached input total, and an existing host keeps that mapping until it restarts. The WakaTime mark shows on the plugin's 发现 card, its 已安装 row and the `wakatime` provider row: `package.json` inlines `assets/wakatime.png` as a `data:image/png;base64` URI in `magpie.icon`, since magpie takes an `https://` URL or a `data:image/` URI there and reads nothing from a path.

0.1.3 skips malformed source rows with a redacted diagnostic, counts only pending rows against queue capacity, and adds `authAccount` to bind a saved WakaTime sign-in. Multiple usable accounts require a binding. A missing bound account pauses synchronization; a changed key is read on the next tick.

0.1.5 reports the machine name, operating system and IANA timezone. Local gateway hooks capture project and branch names at request time and associate them with usage by client response ID. Missing context uses the configured project fallback. Explicit project mappings take priority, and raw working directories are not stored.

0.1.6 recognizes the canonical GitHub repository URL as an enabled installation, including `.git`, trailing-slash and ref-suffixed forms. This prevents the plugin from disabling itself after a URL-based install while retaining Magpie's explicit `off` behavior.

0.1.7 sends a `language` with each heartbeat instead of leaving WakaTime to file all AI usage under `Other`. The request hook reads the working directory's Git index, maps tracked extensions to WakaTime language names and stores the most common language with the project and branch. The scan reads file names only, skips vendored and generated trees, and is cached per directory in the plugin host; directories without a recognized language still send no `language` field.

## Verified

- `bun test`: 46 pass, 0 fail, exit 0. Language detection, Git-backed context, and language refresh of pending rows are covered.
- `git ls-files` on this checkout maps 22 tracked files to `JavaScript` in 27 ms. A hook-level run against this checkout stored `{"project":"magpie-wakatime","branch":"main","language":"JavaScript"}`.
- `npm pack --dry-run --json --ignore-scripts`: version 0.1.7, 13 expected files.
- `bun test`: 40 pass, 0 fail, exit 0. Bun still emits the existing `EBADFD` directory diagnostic.
- Cached input split: `in=100, cache_read=20, cache_write=10, out=30` maps to `ai_input_tokens: 110`, `ai_cached_input_tokens: 20`, `ai_output_tokens: 30`, which adds up to the row total; a row that read no cache omits the cached field, and a later revision that only moves cached tokens is still recorded as a change.
- `npm pack --dry-run --json --ignore-scripts`: version 0.1.5, 12 files, only the entry, `src`, `assets/wakatime.png`, `README.md`, `LICENSE` and package metadata.
- Sign-in in an isolated host: `magpie plugin add` reports `wakatime (wakatime, 0 models) not signed in · magpie plugin login wakatime`, `magpie plugin --json` lists the `api` method with its label and placeholder, and `magpie plugin login wakatime` writes `{"wakatime":{"type":"api","key":...}}` to that sandbox's `plugin-auth.json`. The plugin then reads that key (checked by resolving the directory and the key from the signed-in file) and reports `credentials: configured`. The real Magpie configuration stayed byte-identical throughout.
- Real host, isolated configuration: `magpie plugin add|list|options|off|rm` loads the plugin, starts the uploader, and leaves no process behind.
- Incident on 2026-10-15: one `magpie plugin add` ran without the sandbox environment and landed in the user's real Magpie configuration. That instance has been uploading heartbeats to the user's real WakaTime account since then, and the entry is still installed. Removing the entry, restoring the `@magpie-community/opencode-zed-auth@latest` row that dropped out of `plugins.json`, and deleting those heartbeats are the user's decisions.
- Real usage API contract: response envelope and row keys checked against the locally running gateway.
- End-to-end collection and send: a local mock usage API produced three mapped heartbeats, which were queued and posted to `heartbeats.bulk` with an invalid test key. The upload returned HTTP 401, recorded `wakatime-http-401` and `invalid-key`, kept the rows pending, and wrote nothing to WakaTime (`sent=0`, `lastConfirmedAt` null).
- Missing key: the host runs the plugin, records `missing-key`, and does not activate collection (`enabledAt` stays null).
- Real upload with a valid WakaTime key: the user ran their own end-to-end test on 2026-10-15 and confirmed the heartbeats arrive.
- Agent-named entities: an isolated run (mock usage API, mock `heartbeats.bulk`) queued one `codex` request, `preview` printed `"entity": "codex"`, and the captured request body carried the same `entity` with the mapped token counts and salted session.
- Plugin icon: `package.json` gives `magpie.icon` the `data:image/` prefix magpie requires and stays well under its size cap, and decoding it returns the exact bytes of `assets/wakatime.png`; the mark is painted in `#527da4`, so it reads on the light theme's white card and on the dark one's `#232327`. npm's `/latest` carries such a field through to the discovery card (checked on `@magpie-community/opencode-zen-free-auth`, whose reply lists `magpie.icon` and `magpie.maxConcurrency`).
- Live recovery on 2026-10-17: after switching the real Magpie installation to this checkout, synchronization returned to `runtime: running` with no upload or source error, sent 700 queued heartbeats, and a WakaTime API read confirmed today's heartbeats.

## Not verified

- Live Magpie loading of project context hooks and WakaTime dashboard recognition of machine and project metadata.
- npm publication and community listing, which stay outside the current scope.
- WakaTime accepting `ai_cached_input_tokens` in the POST body: the split follows the wakatime-cli payload and the published cost formula, but no heartbeat carrying the field has been sent to WakaTime from here.
- WakaTime displaying the inferred `language` for `app` heartbeats: the field follows the documented heartbeat schema, but no heartbeat carrying it has been sent to WakaTime from here.
- The icon as the app draws it: no running Magpie window has been looked at, and this package's published 0.1.1 has no `magpie` field for the npm 发现 card to read.

## Unreleased: high-water cursor refactor (2026-11-03, worktree `experiment/write-jsonl`)

- The SQLite queue (`state.sqlite`, `src/store.mjs`) is replaced by per-day high-water cursors. `state.json` holds each day's `offset/head/tail/total/time` plus copies of `salt/gateway/enabledAt`; `identity.json` holds salt, gateway and first activation; `owner.lock/` is an exclusive lock directory whose `owner.json` carries owner, pid, host and acquisition time.
- Cursor and identity writes are temp file + rename with no fsync on the cursor; identity is fsynced once per activation. Cursor flushes repeat salt/gateway/enabledAt so either state file can restore them. Flush cadence stays 5 minutes; a crash replays at most the unflushed tail (at-least-once).
- The lock replaces the 5-minute lease renewal: `mkdir` acquisition, same-host pid liveness for staleness, 10-minute TTL across hosts, no steady-state lock writes.
- `bun test`: 76 pass, 0 fail (was 70; the lease test became eight lock tests plus one identity-recovery test).
- Write volume (18,000 requests per simulated day, `bench/highwater.mjs`, `/proc/self/io` plus strace, btrfs): in-place baseline 176 KiB/day of forced physical writes; atomic rename without fsync 1.34 MiB/day; the per-flush fsync variant measured 33.8 MiB/day and was rejected. Micro-benchmark on this filesystem: one fsync pair costs about 132 KiB, one rename about 4 KiB.
- Legacy `state.sqlite` migration was dropped deliberately: no confirmed installed base on the SQLite-era versions, so an upgrade starts a fresh cursor and re-reads from the gateway.
- Not yet done: merged into the main checkout; the live runtime still runs the previous code; WakaTime read-side verification (summaries/stats/heartbeats with an OAuth bearer token) still pending.
