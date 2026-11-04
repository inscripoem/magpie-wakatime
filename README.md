# magpie-wakatime

把本机 Magpie 网关记录的 AI 请求用量同步成 WakaTime heartbeats。插件跑在 Magpie 自带的 Bun 插件宿主里，从本机用量接口读取统计，通过请求钩子识别项目和分支，不改写 agent 配置或请求内容。

## 安装

```
magpie plugin add <本目录路径>
```

安装、开关、更新插件都会让 Magpie 重启插件宿主，所以本地文件夹插件总是按当前代码加载。首次添加插件时 Magpie 会下载 Bun，之后所有插件共用它。

## 登录

在应用里打开 插件 → 添加插件，填入本目录路径，然后在 `wakatime` 那一行填入 WakaTime API key（在 [wakatime.com/settings/api-key](https://wakatime.com/settings/api-key) 生成）。终端里等价的做法：

```
magpie plugin login wakatime
```

key 由 Magpie 存到配置目录下的 `plugin-auth.json`，插件只读取这份文件。不登录时也可以改用下面的环境变量或 `.wakatime.cfg`。

这个供应商只用来接收 key，没有模型，不会出现在 agent 的模型列表里；插件也不通过它转发任何请求。

## 配置

用 `magpie plugin options <name> '<json>'` 设置，全部可选：

- `gatewayUrl`：默认 `http://127.0.0.1:3425`。只接受本机回环地址，端口可改。
- `authAccount`：绑定 `plugin-auth.json` 中的 WakaTime 账号 ID，例如 `wakatime` 或 `wakatime#xxxxxx`。默认仅在只有一个可用账号时自动选择。
- `apiKeyEnv`：默认 `WAKATIME_API_KEY`。插件读取这个环境变量的值作为 WakaTime 写入密钥。
- `project`：默认 `Magpie`。无法识别真实项目时使用的归档名。
- `projectByAgent`：按 agent id 强制覆盖项目标签，优先于自动识别，例如 `{"codex":"Work"}`。
- `excludeAgents`：排除某些 agent，用于避开已由其他 WakaTime 集成采集的部分。
- `sessionFallback`：默认 `true`。设为 `false` 时插件完全不读取本机会话文件：扫描阶段的 Claude/Codex 补充和请求钩子里的 Codex `FileChange` 读取都会关闭；请求钩子仍会用 `cwd` 做只读 Git 语言推断。
- `claudeProjectsRoot`：可选的 Claude Code 会话目录，默认 `$CLAUDE_CONFIG_DIR/projects`，未设置 `$CLAUDE_CONFIG_DIR` 时为 `~/.claude/projects`。
- `codexHome`：可选的 Codex 主目录，默认 `$CODEX_HOME`，未设置时为 `~/.codex`。

`claudeProjectsRoot` 与 `codexHome` 必须是绝对路径；目录不存在时回退结果为空，不会扫描其他位置或整个文件系统。

写入密钥按顺序取：登录时填写的 key、`apiKeyEnv` 指定的环境变量、`WAKATIME_HOME`（默认用户目录）下 `.wakatime.cfg` 的 `[settings] api_key`。插件只读这些来源，不修改它们。缺少密钥时只记录状态，不开始采集，也不确定首次启用时间。

[Magpie 的多账号机制](https://usemagpie.ai/docs/plugins#accounts)可能把更换后的密钥保存为新的 `wakatime#…` 账号。存在多个可用账号且未绑定时，`status.credentials` 显示 `key-account-ambiguous` 并暂停采集和上传；请用 `magpie plugin options magpie-wakatime '{"authAccount":"wakatime#xxxxxx"}'` 绑定新账号（替换为实际 ID，并保留已有选项）。绑定账号被删除或密钥为空时显示 `key-account-missing`，不会切换到其他账号或密钥来源。每次同步都会重新读取绑定账号的密钥，密钥更新后会恢复上传。

## 会发送什么

每条有实际 token 消耗的请求记录生成一个 heartbeat：

- `entity` 是发起这次请求的 agent 名（例如 `codex`，取不到时用 `magpie`），`type` 是 `app`，`category` 是 `ai coding`，`is_write` 为 `false`。WakaTime 的应用/实体维度因此会把各个 agent 分开。
- `time` 用请求发生时间。`project` 优先使用 `projectByAgent`，其次使用请求工作目录对应的 Git 仓库名，非 Git 目录使用目录名，最后回退到 `project`。Git worktree 使用原仓库名；`branch` 是请求发生时的分支名，无法识别或处于 detached HEAD 时省略。
- `language` 先看本次回复里工具调用（`tool_use` / `tool_calls`）实际编辑或读取的文件扩展名：写/编辑工具优先，读工具只在 Git 推断不出语言时补位；没有再回退到请求工作目录下 Git 跟踪文件的扩展名，取文件数最多的编程语言（例如 `TypeScript`）。同目录的 Git 推断结果在插件宿主进程内缓存；都无法推断时省略该字段，WakaTime 会把它归入 `Other`。
- 扩展名映射优先使用 WakaTime 的 `program_languages`；插件内置一份快照，启动后每 24 小时刷新，失败 1 小时重试。`Diff` 默认排除，补丁文件不参与语言归因。
- 对 Codex，还会读取 `$CODEX_HOME`（默认 `~/.codex`）下 `sessions/YYYY/MM/DD/*<会话ID>*.jsonl`：请求钩子读取 `item_completed` 的 `FileChange` 事件，只取 `changes` 的键（逗号分隔的绝对路径）和 `stdout` 的 `A/M/D` 行，跳过 message、reasoning 和提示词。扫描阶段在请求钩子没有 `cwd`、内存上下文与 `contexts.log` 都未命中时，按用量行的会话 ID 读取同一文件的 `session_meta`：若元数据带 `cwd`，项目取该目录名、分支取 `git.branch`，语言复用下面的只读 Git 检测；Git 检测为空（例如非 Git 目录）时回退到 `FileChange` 的路径语言。若没有 `cwd`，保留 `FileChange` 的路径语言。新的 `FileChange` 更新语言；新的 `FileChange` 识别不出时置空，不沿用旧语言；没有新 `FileChange` 的请求沿用最后一次文件结果。
- 对 Claude Code，当请求钩子没有 `cwd`、内存上下文与 `contexts.log` 都未命中时，扫描会按用量行的会话 ID 读取 `$CLAUDE_CONFIG_DIR/projects`（默认 `~/.claude/projects`）下的 `<会话ID>.jsonl`。只读取顶层 `cwd`、`gitBranch` 和 `sessionId`，据此推导项目（`cwd` 的目录名）与分支；语言不在会话文件里推断，而是对恢复出的 `cwd` 复用只读 Git 检测（`git ls-files -z` 后交给 `detectLanguage`）。`cwd` 不存在或不是 Git 仓库时省略语言。只读文件开头和末尾各最多 64 KB、各最多 20 行；单个文件超过 256 MB、缺失、损坏或不是 Claude 会话时直接忽略。结果按会话缓存 10 分钟（最多 128 个），未命中只缓存 5 秒，以便刚启动的会话尽快补上。`OpenAI` agent 不携带会话 ID，仍使用 `Magpie` 并省略语言。
- `ai_input_tokens` = `in + cache_write`（未命中缓存的输入加缓存写入），`ai_cached_input_tokens` = `cache_read`（为 0 时省略），`ai_output_tokens` = `out`。WakaTime 按未命中缓存的输入、缓存输入、输出三项分别计价，所以缓存读取单独上报。`reasoning` 是 `out` 的内部拆分，不重复相加。
- `ai_session` 是本机随机盐加 agent/session 的 HMAC 摘要，同一会话稳定、跨机器不可还原。
- `user_agent` 携带模型名称、版本和 `effort` 推理强度，优先使用实际响应模型 `served`，缺失时使用 `model`。格式沿用 [WakaTime CLI](https://github.com/wakatime/wakatime-cli/blob/develop/pkg/ai/ai.go)，例如 `gpt/5.4-high`；无法解析版本时只发送通用标识。同一批次的模型信息逐条保留，WakaTime 是否识别及如何展示取决于其服务端支持。
- 请求头 `X-Machine-Name` 携带经过 URL 编码的本机主机名，`Timezone` 携带系统 IANA 时区。User-Agent 同时包含系统名、内核版本和架构，Windows 使用 WakaTime CLI 的 `windows` 标识。

项目识别使用 [Magpie 异步请求钩子](https://usemagpie.ai/docs/plugins#asynchronous-gateway-hooks)提供的 `cwd`，通过客户端响应 `response_id` 精确关联用量，只处理宿主标记为 `local` 的请求。旧版宿主、缺少工作目录、通过命名网关密钥转发的请求，或未收到完成通知时，先尝试从本机 Claude/Codex 会话元数据恢复 `cwd` 或语言，仍无法识别时使用配置的项目标签并省略分支和语言。已有历史记录不会按当前工作目录、分支或语言补填。Git 命令只读且有超时；Git 不可用时使用工作目录名。语言推断先看本次回复里工具调用指向的文件路径，再回退到 Git 索引中的文件名；对 Codex 还读取其会话文件里 `FileChange` 事件行，不读取文件内容。`sessionFallback=false` 会关闭所有本机会话文件读取。

这些是后台 AI 请求的活动时间点，只能说明当时有请求，不能证明你在键盘前；时长由 WakaTime 按自己的规则计算。

## 不会发送什么

账号名、邮箱、密钥、提示词、对话正文、工具结果、完整文件路径、供应商配置名、上游地址、费用和错误正文都不会离开本机。项目名、分支名、语言名、机器名、系统信息、时区和 agent 名会发送给 WakaTime。本机状态保存归一化统计、摘要、扫描游标、待发送 heartbeat 的持久队列（完整映射后的 payload，含项目/分支/语言、token 数与加盐会话摘要；已确认记录保留为 ID 墓碑用于去重）和项目/分支/语言快照；为在重启后把重放的用量行重新匹配到请求上下文，`contexts.log` 还会在本机保存原始响应 ID 与会话 ID，这些条目 10 分钟后过期，并按大小或行数压缩。原始 ID 不上传，网络 payload 里的 `ai_session` 仍是加盐 HMAC；工作目录、提示词和对话内容不保存。语言识别只在内存中解析工具调用参数里的文件路径和扩展名，跳过文件正文与 shell 命令，不写日志、不入库、不上传。Codex 会话文件只读取 `session_meta` 的 `cwd` 和 `FileChange` 事件行；不保存、不上传路径或 stdout。Claude Code 会话文件只读取顶层 `cwd`、`gitBranch`、`sessionId`，不解析 message/tool_use，不读取文件正文；内存与缓存中只保留项目名、分支名和语言名。提示词、回复、工具结果、文件正文和路径都不写入日志或状态，也不上传。`sessionFallback=false` 时不会打开任何本机会话文件。刷新语言表只向 WakaTime 发送 API key，不发送文件路径或内容。

## 与现有 WakaTime 采集的重复

WakaTime CLI 自己会从 Claude、Codex、Cursor 等会话文件采集 AI 活动，和本插件有重叠，服务端不保证跨来源自动去重。两种用法：

1. 保留现有采集，用 `excludeAgents` 排除重叠的 agent；
2. 在既有 WakaTime 配置里设 `sync_ai_disabled=true`，把 AI 用量交给本插件，代价是失去既有集成的文件级 AI 信息。

插件不会自动改这个全局设置，人工编辑活动仍由原编辑器插件负责。

## 状态与预览

在插件目录下运行：

```
bun src/sync.mjs status  [--directory <Magpie 配置目录>]
bun src/sync.mjs preview [--directory <Magpie 配置目录>] [--limit 5]
```

也可以把 GitHub 仓库作为 spec 直接安装，不必发布到 npm：`magpie plugin add github:inscripoem/magpie-wakatime#<ref>`，`<ref>` 可以是分支或提交；固定到具体提交可保证行为可复现。

`status` 显示同步状态、扫描游标、最后确认时间、队列积压和错误类别；`contextStats.hook.noCwdAgents` 按 agent 统计请求钩子缺少 `cwd` 的次数，只列最多的 8 个（按次数降序，同次数按名称排序）；`contextStats.mapped` 统计已映射的 heartbeat：`total`、`noLanguage`，以及按 agent 的 `{total,noLanguage}`（最多 8 个，按总数降序）；`preview` 暂未显示持久队列内容。状态保存在 `<Magpie 配置目录>/magpie-wakatime/` 下：`state.json`（逐日扫描游标，并冗余 salt、网关与首次启用时间）、`identity.json`（salt、网关地址、首次启用时间）、`contexts.log`（追加写的项目/分支/语言上下文日志，保存匹配用的原始响应 ID 与会话 ID，10 分钟过期、按大小或行数压缩）、`queue.sqlite`（发送失败后的离线持久队列；其中已确认或永久拒绝的记录保留为去重墓碑，默认保留 3 天，补读积压未追平时延后清理）、`owner.lock/`（单实例上传锁）。扫描按窗口推进：每次 `collectDay` 最多映射 25 条并返回精确覆盖该前缀的游标（包括已跳过和已过滤的行），每轮最多处理 32 个窗口。payload 先进入内存缓冲区：满 25 条或从首条起满 60 秒后才直接发送，每批最多 25 条；缓冲区只会接收窗口中的空余名额，因此不会超过 25 条。2xx 或永久 4xx 后，该窗口的游标才推进并落盘，不写 `queue.sqlite`。发送遇到网络错误、429 或 5xx 时，把该缓冲区中所有未确认的 payload 在一个事务内写入队列（不受 60 秒入队窗口限制），随后推进游标，再按到期顺序从队列重试（等待退避的条目排在其他到期条目之后），每批 25 条，2xx 或永久 4xx 后持久确认；401/403 时先把缓冲区未确认的 payload 持久入队（队列已满则让游标停在缓冲区之前），再暂停发送。重启先尝试排空离线队列，再从游标继续扫描；不足 25 条的离线队列可能被 `AckGate` 再保留最多 60 秒。缓冲区本身不持久化：崩溃前尚未发送的行从游标重读；发送成功后、游标落盘前崩溃最多重放当前缓冲区，即不超过 25 条，payload 由来源行与上下文日志重建，在日志 10 分钟有效期内与首次发送内容一致。如果新行插在列表头部，整个前插段处理完之前旧游标保持落盘；中途崩溃只会重读新插入的行，重复量以已发送的前插行为限，不会重发已验证的旧前缀；前插段完成后才提交合并游标，之后尾窗按同样不超过 25 条的边界推进。只有窗口所在列表稳定（首页不变、总数不下降，且旧游标与候选游标的尾行都仍在原位）时才推进游标；尾部追加不会阻止提交，中间插入或删除会让尾行移位而不提交，下一次从旧游标重读。上述判断假定网关对已完成的用量记录只追加、不改写（本机用量存储是追加写的 `usage.jsonl`）；如果网关在同一总数下替换或删除中间行，游标无法察觉，需要清空该日游标后重扫。这些文件只属于本机，不要手工编辑，也不要跨机器同步。

单条记录的时间或 token 数据无效时跳过该条，继续采集。`status.lastInvalidRow` 保留最近一次异常的日期、分页偏移、加盐摘要 ID 和错误类别，不保存原始内容；记录修正后可在后续复查中重新采集。整页响应格式错误仍会停止并保留游标，等待接口恢复。

## 采集范围与限制

- 只读本机网关的 `through` 记录，不采集直连（direct）、其他机器或导入（reported）的记录。
- 首次启用时间之后才开始采集，不自动回灌安装前的历史；停机后逐日补读，并每 10 分钟复查前两天，更早的补录不保证。
- 待发送队列上限 100,000 条（只计未确认条目），达到上限停止推进扫描进度并显示积压。已确认和永久拒绝的记录作为去重墓碑默认保留 3 天，不计入此上限；仍有较早的补读日未追平时延后清理。
- 上传走 WakaTime 的 `heartbeats.bulk`，每批 25 条；网络错误、429、5xx 按 5 秒到 5 分钟退避，`401/403` 停止发送等你修密钥。
- 被 WakaTime 永久拒绝（4xx）的条目进入隔离状态，不阻塞后续记录；条目入队后 payload 即固定，同一 source id 的重复扫描会被忽略，不会更新或重发；源行内容变化（如模型字段变化）会产生新的 source id 和新心跳。
- 仅适用于本机个人网关。多人共用同一个网关时不能直接当多人统计使用。

## 卸载

```
magpie plugin rm <name>
```

卸载或禁用后上传任务退出，本地队列保留，重新启用会继续处理。已经上传到 WakaTime 的 heartbeat 不会随卸载删除。

## 开发

```
bun test
```
