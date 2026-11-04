# Magpie → WakaTime 插件开发计划

日期：2026-10-15  
目标版本：0.1.0  
状态：设计与开发计划；尚未实现或向 WakaTime 写入数据。

## 1. 目标与结论

开发一个可通过 `magpie plugin add` 安装的 Bun 插件，将本机经过 Magpie 网关的 AI 请求用量转换成 WakaTime heartbeats。首版以输入、输出 token 和活动时间点为主要数据，使用 WakaTime 的 `ai coding` 分类。

推荐采用 **Bun 插件后台读取 Magpie 用量 API，再异步发送 WakaTime Heartbeats API**。无需替换供应商、改写 agent 配置或介入流式回复，也不增加独立常驻服务。

实现采用 JavaScript ESM、Bun 内置 HTTP、测试和 SQLite 能力，不引入第三方运行时依赖。

## 2. 已核实的能力和边界

| 项目 | 已确认事实 | 对方案的影响 |
| --- | --- | --- |
| Magpie Bun 插件 | 入口函数在插件宿主初始化时执行；能访问文件和网络，接收插件 options | 可以创建独立于模型请求的同步任务 |
| 网关中间件 | 覆盖供应商请求，但没有 fetch、定时器和 Node API；各请求拥有独立运行时 | 不用中间件承担持久队列和外部上报 |
| 普通插件事件 | `event`、`tool`、`chat.params` 等 OpenCode 钩子不会被调用 | 不设计虚构的全局 usage/event 钩子 |
| `auth.usage` | 用来查询供应商套餐额度 | 不用它监听全局请求用量 |
| 用量入口 | `GET /v1/magpie/usage/requests` 返回逐请求记录，支持分页和来源过滤 | 读取已经归一化的 token，无需自行解析四种流协议 |
| 本机验证 | 2026-10-15，本机 `127.0.0.1:3425` 对上述接口返回 HTTP 200 | 已验证数据入口可访问，但未验证插件加载与后台任务生命周期 |
| WakaTime | Heartbeats 写入文档支持 `ai_input_tokens`、`ai_output_tokens`、`ai_session` 和 `ai coding` | AI 用量可以直接映射，不必伪装成代码行数 |
| 项目与文件 | Magpie PluginInput 的 directory 是 Magpie 配置目录；逐请求接口没有保证提供工作项目路径 | 不能把插件 directory 当用户项目，也不从提示词中猜路径 |
| 模型与费用 | 已核实的公开 heartbeat 写入字段没有直接的模型名、费用字段 | 首版不承诺 WakaTime 原生模型榜单或精确费用同步 |

上游源码核对基线：Magpie `95e7c6bcc07629897f6703c31eaef477fcee4a13`。安装包的兼容性以实际接口和加载测试为准，不能把该源码提交号当作已安装版本。

## 3. 首版范围

- 默认只读取 `via=through&computer=this`：本机 Magpie 网关记录，不混入从 agent 会话文件导入的 direct 记录、其他机器同步记录或外部 reported 记录。
- 默认从首次启用时开始；不自动上传安装前历史。重启后补发启用以来尚未同步的记录。
- 同步真实 token 消耗，包括失败或取消请求中已经记录的消耗；本地拒绝和零 token 记录不生成 heartbeat。每条供应商尝试的实际消耗各计一次，不能仅按 `route_id` 把不同尝试合并丢弃。
- 记录 AI 活动时间点。它表示后台 AI 请求活动，不能证明用户当时在键盘前；WakaTime 根据自己的规则计算时长，不把模型延迟直接当作工作时长。
- 支持断网恢复、持久化队列、单实例写入、状态查看及停止同步。
- 不读取对话正文、工具结果、请求归档或账号凭据来推导项目；不上报供应商账号名、邮箱、上游地址和错误正文。
- 首版不提供远程 Magpie、多用户共享网关归属、自动历史回灌、真实项目自动发现、代码行数统计或单独的 Web UI。

## 4. 结构与运行方式

```text
Magpie 已完成的请求记录
        │ GET /v1/magpie/usage/requests
        ▼
Bun 插件：分页读取 → 字段校验与转换
        │ 同一 SQLite 事务：来源去重 + heartbeat 入队
        ▼
插件私有 SQLite：扫描进度、待发送项、确认结果
        │ 单发送器，HTTPS，每批最多 25 条
        ▼
WakaTime Heartbeats API
```

插件只导出一个初始化函数，包入口使用 `index.mjs`，不注册虚构供应商或模型。初始化完成后立即返回 hooks；远程网络操作不放在初始化的等待链上。后台循环默认每 30 秒执行一次，不允许同进程任务重叠。

Magpie 会为不同 CLI 调用和应用创建不同宿主，更新时旧宿主也可能短暂存活。以状态数据库中的租约保证只有一个同步器工作：租约 60 秒、每 10 秒续约，发送前检查所有权；过期所有者停止并取消在途任务。网络超时短于租约期限。每轮读取插件启用状态，禁用后不再开始新的上传；已发送的网络请求无法撤回。

**关键兼容性条件：** Magpie 没有公开的后台服务插件生命周期合同。本设计依赖其现有 Bun 入口运行能力；须在真实应用中验证“仅安装此插件、仅使用内置供应商”时宿主仍会启动，以及关闭、禁用、更新时任务能退出。若不成立，不能把手动启动 sidecar 当作已经完成的插件交付；需要单独决定上游生命周期扩展或独立工具方案。

## 5. 数据读取、去重与恢复

1. 数据源固定为本机回环地址，默认 `http://127.0.0.1:3425`；允许显式配置其他本机端口。拒绝重定向到其他主机。不自动开启局域网共享或读取网关密钥文件。
2. 使用 `GET /v1/magpie/usage/requests`，指定 `via=through`、`computer=this`、`offset`、`limit=500`。按明确的日期范围读取，避免仅查询 today 时跨午夜漏数。
3. 新安装先持久化启用时间，过滤更早的请求。持久化扫描日进度；停机恢复后逐日补读到当前日。正常运行每轮重扫当前日，每 10 分钟复查前两日，以接纳延迟完成的请求。
4. 接口使用 offset 而不是稳定游标。分页中新增记录可能使记录重复出现，因此只依靠来源去重，不依赖 offset 作为永久断点。每日扫描结束后复查首页；尾部新增记录不会阻止当前窗口提交（首页不变、总数不下降、旧游标与候选游标的尾行仍在原位即视为稳定），只有首页变化或已处理前缀的尾行移位时才回退重读；单轮设工作预算，未完成则下轮继续，不宣称完成。
5. 去重键优先组合本机实例标识、请求时间、`route_id`、供应商、`rid`/`response_id` 等稳定身份。不同重试不能互相吞并。token、费用和展示名称不进入身份键，避免统计或价格修正变成新请求。缺少标识时使用固定身份字段的规范化指纹，并记录这种降级的碰撞风险。
6. 将来源身份与转换后的 heartbeat 在同一事务内保存，再推进扫描状态。发送器不持有扫描事务；WakaTime 故障不阻止采集。
7. 已发送记录后来出现 token 修正时，首版只记录差异并显示异常数，不以新请求重发整条统计，也不自动发送负数。接口没有公开可依赖的 revision/upsert 合同。
8. 本地持久化能防止重复采集，但不能保证远端 exactly-once。若请求已被服务端接收而客户端没有收到确认，重试可能重复。重试必须复用原始 payload 和时间戳；正式验收单独测试 WakaTime 的实际重复处理行为，不虚构 Idempotency-Key 支持。

前两日复查是有界折中：超过该范围才出现的旧请求或后期导入数据不保证自动补齐。状态页必须显示最后完成扫描日、积压数量和已知差异，而不能把“最近轮询成功”显示为“全部同步完成”。

## 6. WakaTime 字段映射

首版直接写入 `https://api.wakatime.com/api/v1/users/current/heartbeats.bulk`，鉴权使用写入专用 API key 的 Authorization header。选择直接 HTTP，是因为数据已经由 Magpie 归一化，且首版只需 app 类型 heartbeat；省去额外 CLI 二进制的下载、升级和进程管理。代价是本插件必须自行实现持久队列及逐项响应处理。

| WakaTime 字段 | 首版取值与规则 |
| --- | --- |
| `entity` | 固定 `magpie`，避免把模型名或文件路径误用为实体 |
| `type` | `app` |
| `category` | `ai coding` |
| `time` | Magpie `t` 转为 Unix 秒，保留小数；使用原始活动时间，不用同步时间 |
| `project` | 用户配置的项目名；可按 agent 指定映射，未配置时为 `Magpie`。该名称是归档标签，不代表自动识别到了真实仓库 |
| `ai_input_tokens` | `in + cache_write`。Magpie 源码明确说明两个缓存字段不包含在 `in` 内；`cache_write` 是 Anthropic 的 cache creation，官方 CLI 把它计入 input tokens |
| `ai_cached_input_tokens` | `cache_read`；为 0 时省略该字段。WakaTime 把缓存读取单独按缓存价计算，`ai_input_tokens` 只记未命中缓存的输入，两者相加才是总输入 |
| `ai_output_tokens` | `out`；不再叠加 `reasoning`，避免重复计算输出子项 |
| `ai_session` | 有 session 时，使用本地持久化随机盐和 agent/session 生成稳定摘要；没有则省略，不伪造真实会话 |
| `is_write` | `false`，网关请求不能证明写过文件 |
| User-Agent | 标识 Magpie 与 magpie-wakatime 插件版本、操作系统；版本未知时使用明确的 unknown 值，不冒用其他编辑器 |

首版不发送 `language`、`branch`、`ai_line_changes`、`ai_prompt_length`、`ai_subscription_plan`，因为当前数据入口不足以可靠得到它们。后续版本已通过请求钩子提供 `branch`，并从工作目录的 Git 索引推断 `language`；其余字段仍不发送。当前行为见 README 与 PROGRESS。

`ai_cached_input_tokens` 未出现在公开 POST 文档中，但 wakatime-cli 会发送它，官方 FAQ 的费用公式也按未命中缓存的输入、缓存输入、输出三项分别计价，因此首版按同一口径拆分输入 token 并发送该字段。模型、供应商和费用可用于本地诊断，但不塞进语言、分支等无关字段。原生模型/费用显示应在后续得到明确写入合同后再扩展。

## 7. 配置与故障处理

只增加以下用户配置：

| 配置 | 默认与用途 |
| --- | --- |
| `gatewayUrl` | `http://127.0.0.1:3425`；仅允许本机回环地址 |
| `apiKeyEnv` | `WAKATIME_API_KEY`；读取指定环境变量的值，不把密钥写入插件 options |
| `project` | `Magpie`；缺少真实项目信息时的固定归档标签 |
| `projectByAgent` | 空映射；按 agent id 覆盖项目标签 |
| `excludeAgents` | 空数组；排除已由其他 WakaTime 集成采集的 agent |
| `excludeCallerKeys` | 空数组；按网关调用方 key 名称排除远端请求，保留本机无 key 的同名 agent |

密钥解析优先使用 `apiKeyEnv` 指定的环境变量；未设置时，只读取 WakaTime 标准配置文件 `[settings].api_key`。按 `WAKATIME_HOME` 或用户目录定位配置，不读取和打印整份配置，不修改原有 WakaTime 配置。缺少密钥时显示明确状态，暂不开始采集；配置完成后才确定首次启用时间。

插件状态保存在传入 directory 下的 `magpie-wakatime/`：`state.json` 保存逐日扫描游标并冗余 `salt/gateway/enabledAt`，`identity.json` 保存 salt、网关与首次启用时间，`contexts.log` 追加保存项目/分支/语言以及匹配用的原始响应 ID 与会话 ID（仅本机、10 分钟 TTL、按阈值压缩、不上传），`sent.log` 保存已发送或已入队行的加盐 `route_id` 摘要（仅本机、3 天、按天或大小压缩、不上传），`queue.sqlite` 保存待发送 heartbeat 的完整映射 payload 与已确认 ID 墓碑，`owner.lock/` 保存单实例上传锁。只保存归一化统计、不可逆身份摘要、扫描状态、待发送数据及本机上下文匹配所需的最小标识，不保存 API key、工作目录、账号名、提示词或对话正文。网络 payload 的 `ai_session` 仍是加盐 HMAC。

- 每批最多 25 条；到期批次连续发送，遇 429/5xx 按退避等待。单请求超时 10 秒；网络错误、429、5xx 采用带抖动的指数退避，范围 5 秒至 5 分钟，并尊重有效的 Retry-After。
- 批量响应逐项处理；只有对应条目成功才标记已发送。HTTP 请求成功不等于整批成功。
- 400 或逐项永久校验失败进入隔离状态，保留原因类别，不让坏数据无限阻塞后续记录。401/403 暂停发送，等待配置修正。
- Magpie API 404、结构不匹配或不可访问时进入兼容性/连接错误状态，不尝试抓取网页或解析原始会话文件作为隐藏回退。
- 待发送队列上限 100,000 条（只计未确认条目）；达到上限停止推进采集进度并报告积压，不静默丢弃。已确认和永久拒绝的 ID 作为去重墓碑默认保留 3 天，之后清理；如果仍有较早的补读日未追平，则延后清理。墓碑不占队列上限。
- 提供本地 `status` 命令和 `preview --limit 5` 命令；preview 当前返回空列表（持久队列预览待接入），不访问 WakaTime。状态包括扫描进度、队列数、最后确认时间及错误类别。

## 8. 与现有 WakaTime 的重复问题

WakaTime CLI 已有从 Claude、Codex、Cursor 等会话日志自动采集 AI 活动的能力，因此不能假设“这份数据只有本插件上传”。来源时间、实体和身份可能不同，不能承诺服务器自动跨插件去重。

安装说明必须提供两种明确用法：保留现有 AI 采集并在本插件 `excludeAgents` 排除重叠 agent；或由用户自行将既有 WakaTime 配置的 `sync_ai_disabled=true`，让本插件负责 AI 请求用量。后者会失去既有集成提供的文件级 AI 修改信息。插件不自动修改这个全局设置。人工编辑活动仍由原编辑器插件负责。

默认适用于个人本机网关。`computer=this` 指记录来源机器，不等于已认证的人类用户；多人使用同一个网关时，必须先增加并验证调用方筛选，不能直接发布为多人统计方案。

## 9. 实现顺序与文件

作为一个完整的 0.1.0 交付，以下是同一版本的工作步骤，不把未打通的中间步骤当作可用版本：

1. **包入口和宿主兼容性。** 建立包与单一插件入口，验证只使用内置供应商时的加载、任务启动、关闭、禁用和更新行为；让状态和预览可运行，且不发送真实数据。
2. **读取与数据映射。** 实现来源过滤、分页扫描、稳定身份、字段校验和 token 映射；从脱敏样本构造固定测试数据，核对缓存与重试口径。
3. **持久化和发送。** 实现 SQLite 事务、扫描恢复、租约、WakaTime 批量发送、逐项确认和错误分类；用本地 HTTP mock 验证故障路径。
4. **真实应用验收与打包。** 在隔离 Magpie 配置中测试插件安装及内置/插件供应商；用专用 WakaTime 测试账号执行小规模真实上传验收，再打包。

预计生产代码 7 个文件：`package.json`、`index.mjs`、`src/config.mjs`、`src/source.mjs`、`src/map.mjs`、`src/store.mjs`、`src/sync.mjs`。其中 status/preview 的命令入口放在 `src/sync.mjs`，通过 package 的 bin 声明暴露。另交付 README、行为测试和脱敏固定样本。

预计 3–5 个工程日，包含宿主验证、故障测试和跨平台打包；这是工程估计。若后台生命周期验证失败，需要重新确定宿主集成边界，不能沿用此工期保证。

## 10. 验证与验收

自动验证使用 `bun test`；包内容检查使用 `npm pack --dry-run`。实现时将以下测试做成稳定的行为测试，不依赖函数或文件的具体排版：

| 风险 | 验收标准 |
| --- | --- |
| 基础映射 | `in=100, cache_read=20, cache_write=10, out=30` 生成输入 110、缓存输入 20、输出 30；三项相加等于行总量，reasoning 不重复加入 |
| 统计完整性 | 流式/非流式、成功/有消耗的失败/取消、供应商重试均按 Magpie 已记录用量入队一次 |
| 伪造指标 | 不产生不存在的文件、代码行数、语言、项目路径、费用和空闲心跳 |
| 分页 | 超过 500 条、并发插入、相同时间戳、同 route 多尝试、跨午夜均不因分页而静默漏数或重复入队 |
| 恢复 | 在入队、发送、确认写盘各阶段终止宿主，重启后恢复；远端接收但确认丢失的残余重复风险单独记录 |
| 并发与生命周期 | 两个 CLI 宿主和应用同时加载时只有一个发送器；热更新、租约失效、禁用和退出不留下持续上传任务 |
| 网络与凭据 | 429、5xx、超时能退避恢复；401/403 停止发送；批量部分失败不重发已确认项 |
| 数据边界 | direct/reported/其他机器记录被过滤；账号名、邮箱、密钥、提示词不会出现在网络 payload 或日志；原始响应/会话 ID 只写入本机 `contexts.log`（10 分钟 TTL，不上传），完整 heartbeat payload 只写入本机 `queue.sqlite`（含加盐 `ai_session`，上传后保留 ID 墓碑 3 天），网络 payload 的 `ai_session` 为加盐 HMAC |
| 容量 | 模拟常规负载十倍和队列上限；内存有界，积压可见，源进度不越过未入队的数据 |
| 重复来源 | 开启既有 WakaTime AI 统计时，排除配置实际生效；不能把单插件去重说成跨插件去重 |

真实 WakaTime 验收需要专用测试账号的写入 API key，验证 app 类型、AI 分类、token 和会话字段是否被实际保留，且界面呈现符合预期。若自动读回，需要额外具有 `read_heartbeats` 权限的 OAuth token；写入 key 不用于读取统计。也可以由用户直接在测试账号界面核验。

本次已完成的验证仅包括文档、源码和本机只读 API 探测。未安装插件、未验证宿主后台生命周期、未发送 WakaTime heartbeat，也未执行上述未来代码测试。

## 11. 发布与回退

包名暂定 `magpie-wakatime`；正式发布前确认 npm 名称可用。发布包包含可直接运行的源码，不依赖 postinstall 构建。README 说明统计口径、密钥配置、重复采集风险、状态命令及兼容性要求。

本地安装命令为 `magpie plugin add <插件目录>`；完成隔离验收后才考虑 npm 发布和社区上架。发布不属于本次计划编写的执行范围。

回退使用 Magpie 的禁用或卸载操作；已保存的队列保留，重新启用后可继续处理。已上传到 WakaTime 的记录不会随卸载删除。首版不提供自动远端清理；误上传修复需另行授权并使用 WakaTime 的删除工具或具备删除权限的 OAuth 接口。

## 12. 资料

- [Magpie 插件开发文档](https://usemagpie.ai/docs/zh/plugins)：插件运行环境、支持钩子、目录、安装与中间件限制。
- [Magpie 快速上手](https://usemagpie.ai/docs/zh/start)：默认本机网关地址。
- [Magpie 用量 API](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/gateway/usage_api.go)：读取接口与访问边界。
- [Magpie 用量接口结构](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/usageapi/usageapi.go)：分页、过滤和返回结构。
- [Magpie Record 定义](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/usage/usage.go)：token、缓存、会话和供应商尝试语义。
- [Magpie 插件宿主](https://github.com/yetone/magpie/blob/95e7c6bcc07629897f6703c31eaef477fcee4a13/internal/plugin/host.js)：插件入口执行和生命周期实现。
- [WakaTime Heartbeats API](https://wakatime.com/developers#heartbeats)：AI 字段、批量上限和鉴权。
- [WakaTime 插件开发指南](https://wakatime.com/help/creating-plugin)：官方 CLI 方案与活动采集方法。
- [WakaTime CLI heartbeat 实现](https://github.com/wakatime/wakatime-cli/blob/develop/pkg/heartbeat/heartbeat.go)：缓存字段及 AI token 差量。
- [WakaTime CLI 批量发送实现](https://github.com/wakatime/wakatime-cli/blob/develop/pkg/api/heartbeat.go)：逐项响应解析。
- [WakaTime CLI 配置说明](https://github.com/wakatime/wakatime-cli/blob/develop/USAGE.md)：内置 AI 会话采集与 sync_ai_disabled。
