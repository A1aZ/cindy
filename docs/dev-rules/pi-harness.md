# PI harness 集成规则与上线清单

> 修改 `packages/maker-core/src/agents/pi/**`、`apps/desktop/src/main/maker-host/pi-host.ts`、
> `apps/desktop/src/main/mcp-integrations/piEnvironment.ts`,或任何 PI 会话行为、权限、
> 配置、system prompt 之前必读本文件。PI(github.com/earendil-works/pi)被定位为 Cindy
> 未来的基座 harness,集成原则与其余 harness 有别 —— 详见「设计原则」。

## 1. 架构总览

Cindy 以 `pi --mode rpc` spawn pi 二进制(JSONL/stdio),`translator.ts` 把 pi 事件映射进
统一 `AgentEvent`。关键装配点:

- **provider/model**:`index.ts writeModelsJson` 把 host 注入的模型清单挂在单一自建
  provider `cindy` 下,写进 `<agentHome>/models.json`。`baseUrl = runtimeConfig.endpoint`
  —— desktop 侧是本地 anthropic-compat proxy(loopback);proxy 未起时 fail-open 直连真上游
  (`anthropic-compat-proxy-host.ts`)。凭证走 `$CINDY_PI_API_KEY` env 插值,不落盘。
- **system prompt**:`--append-system-prompt` 追加 host 产品段 + 用户段,**保留 pi 默认
  prompt**(不用 `--system-prompt` 整体替换 —— 那会丢掉 pi 自己调好的工具用法/工程约定)。
- **权限执行**:pi 原生无工具审批(security.md 明确:非沙箱、不限制工具)。Cindy 用注入的
  `cindy-bridge.ts` 扩展在 pi 进程内 `pi.on('tool_call')` 拦截,经 `extension_ui_request`
  子协议冒泡到 `index.ts handleExtensionUiRequest`,映射成 `InteractionRequest` 交 Cindy
  审批 UI。档位写 `<agentHome>/runtime/perm-<sessionId>.json`,bridge 每次 tool_call 现读
  (热切换)。
- **MCP 桥**:`piEnvironment.ts` 把 in-process MCP providers 暴露成 localhost streamable-HTTP,
  bridge 用极简 client `tools/list` + `registerTool` 成 `mcp__<server>__<tool>`。
- **plan 模式**:挂 pi 自带 plan-mode 扩展,`/plan` toggle 驱动;Cindy 维护镜像态并在 resume
  时从 `get_entries` 校正。

## 2. 配置面:Cindy 显式设置 vs 放任 pi 默认

Cindy 显式设置:models.json、`--append-system-prompt`、`--session-dir`、启动时 RPC
`set_auto_compaction{enabled:true}` / `set_thinking_level`。env:`CINDY_PI_API_KEY`、
`CINDY_PI_SESSION_ID`、`PI_CODING_AGENT_DIR`、`CINDY_PI_PERMISSION_FILE`、`CINDY_PI_MCP_BRIDGE`、
`PI_OFFLINE=1`(关启动期联网)、`NO_PROXY` 兜底 loopback(防全局代理打穿本地 proxy 与 MCP bridge)。

放任 pi 默认(未写 settings.json):`retry.*`(agent 级 3 次退避、provider 级 0)、
`httpIdleTimeoutMs=300000`、`websocketConnectTimeoutMs`、`compaction.reserveTokens/keepRecentTokens`、
`defaultProjectTrust`。这些默认目前合理;**若未来发现某默认值需钉死防 pi 二进制升级漂移,
在 `index.ts` 加 `writeSettingsJson` 显式写入**(与 models.json 同机制,每次 startSession 覆写)。

## 3. 设计原则(Chris 2026-07-30 裁决)

- PI 是 Cindy 未来的基座 harness。
- **桥接/模型接入必须充分利用 pi 自身兼容层**(models.json 四种 api 形态 + per-model compat
  开关),**禁止「先转成 Claude 格式再转 pi 兼容」的双重转义**。BYOM 用户自定义/本地模型直接
  写 models.json 走 pi 原生 provider,不过 anthropic-compat 代理。

## 4. 维护不变量(改动时不得破坏)

1. **权限档从严到宽**:`capabilities.permissionModes` 必须 `[ask, auto, bypassPermissions]`
   顺序,`[0]` 是最严档 —— 无人值守链路(`hook-control/defaults.ts`)在「显式档不被支持」时
   回落 `[0]`,顺序错了会把更严选择静默放宽成完全访问。由 `pi-capabilities.test.ts` 守。
2. **凭证路径判定三处同步**:`shared/auto-review.ts CREDENTIAL_PATH_PATTERNS`、
   `cindy-bridge-source.ts touchesCredentialPath`、`auto-review-policy.ts` 只读分支全字段扫描
   必须同口径。bridge 自包含不能 import,改一处记得改三处。
3. **斜杠命令转义**:`escapeLeadingSlashCommand` 对 `/` 开头用户输入前置空格转字面(仅放行
   `/skill:`)—— pi RPC prompt 会执行扩展命令(`/plan` 被 plan-mode 吃掉且不留痕),不转义会让
   Cindy 状态镜像脱同步并暴露未来扩展命令攻击面。
4. **auto 档 dispatcher fail-closed**:分类抛错 / 无 resolver 一律不放行。
5. **成本计量**:models.json 的 cost 来自 host 模型目录(`ModelDescriptor.cost`),缺省按 0;
   派生链 `catalog-to-descriptors.ts` → `capabilities.availableModels` → `writeModelsJson`。
6. **权限弹窗正文**:`PermissionPrompt.formatToolInput` 必须 harness 无关(pi 小写工具名 +
   path/command 字段,CC 大写 + file_path),由 `formatToolInput.test.ts` 守。

## 5. 已交付(2026-07 里程碑)

- redacted thinking 不再显示为空卡片;PI 会话图标(π);Auto-review 核心 + pi adapter + auto 档;
  PI_OFFLINE / NO_PROXY;`--append-system-prompt`;斜杠转义 + 只读工具凭证收口;成本计量真值;
  权限档四语 i18n + 弹窗正文归一化 + 能力契约测试。
- 自动化安全网:maker-core PI 定向 + 端到端集成(真 pi 二进制 + 真 bridge + 假模型工具调用)
  覆盖安全命令静默执行 / 危险命令升级并 deny 拦截 / 区内写落盘 / 凭证读升级 / 普通读直通 /
  斜杠转义 / models.json 计费透传。

## 6. 上线前手工清单(需真凭证/额度,自动化测不了)

- [ ] **平台覆盖**:`apps/pi-bin/` 目前仅 `darwin-arm64`。Windows / Linux / Intel Mac 二进制
      分发 + 路径/shell 差异(bridge 路径判定、NO_PROXY、权限文件)逐平台过。
- [ ] **模型兼容矩阵**:每个经网关的真实模型(chatgpt/、xai/、glm、deepseek、kimi…)在
      anthropic-compat 下至少跑一轮**带工具调用**的回合,逐个确认 thinking 格式 / tool
      streaming / redacted thinking 正确(redacted 的坑就是这类 per-model 差异)。测完据此定
      「默认开哪些 / 全开 + 不支持自动退档」。
- [ ] **长会话 compaction**:逼近上下文窗口触发自动压缩,核对 UI / usage / 会话状态。
- [ ] **无人值守**:定时任务选 pi(默认 `bypassPermissions`)完整跑一轮;auto 档无 resolver 时
      安全动作执行、其余 fail-closed deny 的体验确认。
- [ ] **resume 边界**:pi 二进制升级后旧 session JSONL 兼容、invalid resume 回退、fork 后再 resume。
- [ ] **prompt cache**:模型矩阵测完后评估 `PI_CACHE_RETENTION=long`(网关支持则默认开 + 不支持退档)。

## 7. 上线后路线图(已与 Chris 对齐)

> 续做指南(每项怎么接着做 + file:line 锚点 + 坑)见 `docs/dev-rules/pi-remaining-work.md`。

- ✅ **HTML 导出**(已交付):`export_html` RPC 全链路,会话头部菜单「导出为 HTML」,
  仅当前打开的本地 pi 会话可见。见 `Capabilities.sessionHtmlExport` /
  `Session.exportSessionHtml` / `MAKER_INVOKE.EXPORT_SESSION_HTML`。
- ✅ **手动压缩**(已交付):`compact` RPC 全链路,会话头部菜单「压缩上下文」,gate 同
  HTML 导出、回合运行中禁用。良性「nothing to compact / too small」→ `noop`(不报失败)。
  见 `Capabilities.manualCompact` / `Session.compactSession` / `MAKER_INVOKE.COMPACT_SESSION`。
  注:pi 斜杠转义后用户无法手输 `/compact`,此菜单是 pi 会话手动压缩的唯一入口。
- ✅ **subagent 接 pi 轻量引擎**(已交付):Orca worker 可选 `pi` 引擎。核心链路(MCP
  schema / worker 创建服务 / 默认模型 claude-sonnet-4-6 / PiAgent 注册)本已按 AgentKind
  接通;本次补齐 UI(CreateWorkerPopover / CollaborationModeToggle / draft 映射)、两个
  main IPC coercion(WORKER_CREATE / SESSION_ENABLE_ORCA)、worker 展示(π 而非 Claude 脸)。
  注:pi 二进制缺失时 buildPiAgent 返回 null,pi 不进 agents map,建 pi worker 会抛错。
- ✅ **压缩即记忆**(已交付):新增 `digest` 记忆类型(与 curated 解耦)。pi `compaction_end`
  带 `result.summary` 时经 `deps.makerMemory.write` 写 digest —— 进 FTS 可 `memory_search`,
  但排除出 MEMORY.md / system prompt / LLM 的 memory_write 工具,**不污染 curated 记忆**。
  gate 同 CC(makerMemoryEnabled + manager),fire-and-forget。见 `memory/types.ts`
  (MEMORY_TYPES / CURATED_MEMORY_TYPES)、`memory/storage.ts rebuildIndex`、`pi/index.ts`
  writeCompactionDigest。
- **BYOM / 本地模型**:走 pi 原生 provider(见设计原则),设置页开自定义/本地模型入口,仅对 pi 生效。
- **会话树**:按现有 fork/分支功能的树状升级迭代(pi 原生 append-only entry 树 + 分支摘要),
  不引入新概念。
