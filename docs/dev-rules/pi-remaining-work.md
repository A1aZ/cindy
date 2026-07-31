# PI harness 剩余工作 / 续做指南

> 本文件是 `sandbox/pi-live` 分支的交接记录:已交付什么、还差什么、每一项**怎么接着做**
> (含具体 file:line 锚点与坑)。配合 `docs/dev-rules/pi-harness.md`(架构、维护不变量、
> 上线清单)一起看。最后更新:2026-07-30。

## 分支与运行

- 工作分支:`sandbox/pi-live`(基于 `pi-agent-research`)。
- 本机联调沙盒:独立 checkout `cindy-pi-latest-sandbox`,独立 userData
  `Cindy-dev-pi-latest`,以 `--isolated=pi-latest` 命名。
- 启动(保留其它 dev 实例,被动模式,不抢定时任务):
  ```bash
  XDT_USER_DATA_DIR='~/Library/Application Support/Cindy-dev-pi-latest' \
  XDT_ISOLATED=1 XDT_ISOLATED_NAME=pi-latest \
  pnpm restart:desktop:remote --preserve-running
  ```
  **只重启 pi 沙盒**:先 `pnpm desktop:whoami --all` 找到 pi-latest 的 PID,`kill <pid>`,
  再跑上面的命令。**绝不用会全局关实例的默认 restart**(会误杀其它 checkout 的 dev)。
- 验证口径:maker-core `pnpm --filter @cindy/maker-core test`;desktop
  `pnpm --filter desktop run typecheck`;mcps `pnpm --filter @cindy/mcps run build && ... test`;
  i18n `pnpm check:i18n` + `pnpm check:i18n-glossary`。pi 真二进制集成测试在
  `packages/maker-core/src/agents/pi/__tests__/pi-agent.integration.test.ts`(二进制缺失自动 skip)。

## 已交付(sandbox/pi-live 上,均已测试)

- redacted thinking 修复;PI 会话图标(π);Auto-review 核心 + pi adapter + auto 档;
  PI_OFFLINE / NO_PROXY;`--append-system-prompt`(保留 pi 默认 prompt);斜杠命令转义 +
  只读工具凭证路径收口;成本计量真值;权限档四语 i18n + 弹窗正文归一化 + 能力契约测试。
- **HTML 导出**(`export_html`)、**手动压缩**(`compact`)、**subagent 接 pi**(Orca worker 可选 pi)。

维护不变量见 `pi-harness.md §4`(权限档从严到宽、凭证 regex 三处同步、斜杠转义、
auto fail-closed、成本派生链、弹窗正文 harness 无关)。

---

## ✅ 已交付:压缩即记忆(2026-07-30,Option 1)

新增 `digest` 记忆类型:pi `compaction_end.result.summary` → `deps.makerMemory.write` 写 digest,
进 FTS 可 `memory_search`,但排除出 MEMORY.md / system prompt / LLM memory_write 工具。见
`memory/types.ts`、`memory/storage.ts rebuildIndex`、`pi/index.ts` writeCompactionDigest +
onEvent 钩子。下方原设计说明保留作背景。

### (原调研)压缩即记忆的设计取舍

**目标**:pi 压缩上下文时,把被丢弃内容的要点沉淀进 Cindy 记忆,新会话可召回。

**关键约束(调研结论)**:
- CC 的 auto-memory / auto-dream 是 **CC 二进制内部能力**,pi 触达不到,不能复用。
- `cindy_memory` 是 per-workdir 文件式(MEMORY.md + 分片),只有 4 类
  `user/feedback/project/reference`,**没有 session/auto 命名空间**。写进去的任何东西都会被
  `rebuildIndex` 列进 MEMORY.md,而 MEMORY.md 会内联进系统提示 —— **裸转存压缩摘要 = 直接
  污染 curated 记忆 + 撑大系统提示**。
- pi translator 的 `compact_boundary` 目前**只带 token 数,不带摘要正文**
  (`packages/maker-core/src/agents/pi/translator.ts` 的 `compaction_end`)。摘要文本留在 pi
  自己的 session JSONL 里,主进程看不到。
- pi bridge(`cindy-bridge-source.ts`)能经已桥接的 `mcp__cindy_memory__memory_write` 调
  cindy_memory(仅 Maker memory 模式开时),也能挂 pi 的 `session_before_compact` 钩子拿到
  `preparation.messagesToSummarize`(可 `serializeConversation` 成文本)。

**推荐设计(不污染 curated memory)—— 二选一,动手前与 Chris 确认**:
1. **新增记忆 type(如 `digest`)并改 `storage.rebuildIndex` 把它排除出 MEMORY.md**:只进
   FTS(可被 `memory_search` 检索)、不进 curated 索引/系统提示。改
   `packages/maker-core/src/types/memory.ts:15`(MEMORY_TYPES)+ `memory/storage.ts` 的
   `rebuildIndex`(~312-338)。
2. **灌进 `session_search` 底层的 `messages_fts`(原始对话历史库),而非 curated 分片** ——
   语义上压缩摘要更接近「原始历史」而非「提炼后的偏好/决策」,天然不碰 MEMORY.md。见
   `packages/lizi-mcps/src/memory/sessionSearch.ts`。

**落地路径**:在 `cindy-bridge-source.ts` 挂 `session_before_compact` → 取
`preparation.messagesToSummarize` 序列化 → 经 MCP 通道写入上面选定的目标。注意:
(a) 仅 Maker memory 模式开时通;(b) 复用 flush-controller 脚手架
(`packages/maker-core/src/memory/flush-controller.ts`,当前只在 CC/Codex 接线,pi 未接);
(c) pi 的钩子是否真给摘要正文属 pi 二进制内部,需实测。

**验收**:pi 会话跑到触发压缩,确认要点进了选定存储、`memory_search` 能查到、MEMORY.md
**没有**被污染、系统提示未膨胀。

---

## 还差 2:BYOM 本地/自定义模型(走 pi 原生 provider)

**目标**:用户配自定义/本地模型(Ollama / vLLM / 自建端点),pi 直连,**不过 anthropic-compat
代理**(设计原则:禁止「先转 Claude 再转 pi」双重转义)。

**现状(可复用的基建)**:Cindy 已有完整自定义 provider 体系 ——
`apps/desktop/src/main/maker-host/custom-provider-store.ts`(CRUD + DB schema)、
`buildUserProvider`、`createDesktopProviderService.ts:384 setCustomProviders`、
`active-catalog.ts`(base + custom 合并进目录,下游选择器/路由统一消费)。用户能配
baseUrl/api/key 的本机 provider,已流进 catalog。

**缺口 = pi 特有**:
1. **`writeModelsJson`(`packages/maker-core/src/agents/pi/index.ts:203`)现在只写单一
   `cindy` provider,baseUrl 全指向 compat 代理。** 要让它对「自定义/本地 provider」额外写出
   **原生 pi provider 块**:`{ name, baseUrl:<用户端点>, api:'openai-completions'|'anthropic-messages'|'google-generative-ai', apiKey:<env 插值或占位>, models:[...] }`,
   baseUrl 直连用户端点。需要 host 把自定义 provider 的元数据(端点/api 类型/key 来源)透传给
   PiAgent(目前只透传 `availableModels: ModelDescriptor[]`,信息不够 —— 要扩 deps 或
   capabilityAdditions 带 provider 维度)。
2. **`setModel`(`pi/index.ts` handle.setModel)现在硬编码 `provider: PI_PROVIDER_ID`**。
   BYOM 模型属于别的 provider,要改成 provider-aware(从 model → 其所属 provider 解析)。
3. 模型选择器让自定义模型出现在 pi tab(custom provider 的 `agents` 字段需含 `pi`;确认
   `buildUserProvider` / 目录 union 是否已给 pi tab)。
4. keyless 本地服务器(Ollama)要留 dummy apiKey,否则 pi `/model` 不显示(见
   `apps/pi-bin/darwin-arm64/docs/models.md`)。

**验收**:配一个本地 Ollama,pi 会话能选到它、直连本机端点跑通(抓包确认没走 compat 代理),
成本按目录/0 计,thinking/工具调用正常。

---

## 还差 3:会话树(fork/分支树状升级)

**目标**:pi 原生是 append-only entry 树,支持分支、树导航、分支摘要。现在 Cindy 只用了最粗的
fork(散落成平级会话)。升级成「同一会话内可切换的分支树」,**不引入新概念**,按现有 fork/分支
迭代。

**pi 侧能力**:`get_tree`(rpc.md:724)返回树结构;`fork`/`clone`/`get_fork_messages`
已在 `PiAgent.forkSdkSession` 用;`get_entries` 可读分支条目;`branchSummary` 设置控制分支
摘要。

**落地路径(大特性,需 UI 设计,建议先出 2-3 个方向让 Chris 选)**:
- maker-core:给 PiAgent 加 `getSessionTree()`(调 `get_tree`)+ 分支切换/摘要 handle 方法 +
  capability flag。
- IPC + preload + renderer:会话树可视化 UI(分支切换、分支摘要展示)。参考现有 fork 入口
  (`apps/desktop/src/main/maker-orchestration/fork.ts`、会话头部/侧栏 fork 动作)。
- 这是四个里 UI 最重的,单独排期。

---

## 还差 4:上线前手工 QA(需真凭证/额度/构建基建 —— 非 agent 可自动完成)

见 `pi-harness.md §6`。要点:
1. **平台二进制**:`apps/pi-bin/` 现仅 `darwin-arm64`。Windows / Linux / Intel Mac 的 pi
   二进制分发 + 逐平台过(bridge 路径判定、NO_PROXY、权限文件、shell 差异)。**全量上线最硬门槛。**
2. **模型兼容矩阵**:每个网关模型(chatgpt/ / xai/ / glm / deepseek / kimi …)在
   anthropic-compat 下跑一轮**带工具调用**,逐个确认 thinking 格式 / tool streaming / redacted。
   测完据此定 prompt cache「默认开 + 不支持自动退档」(`PI_CACHE_RETENTION=long`)。
3. **实机联调**:长会话自动压缩、无人值守(定时任务跑 pi)、resume 边界(pi 二进制升级后旧
   session JSONL 兼容 / invalid resume 回退 / fork 后再 resume)。

## 顺手可做的小项

- **minimal effort 档**:pi 支持 `minimal` thinking,当前 PiAgent effortLevels 未暴露;需 per-model
  `thinkingLevelMap`(与模型矩阵一起做,否则部分网关模型不支持会报错)。
- **settings.json 钉值**:目前没写 pi settings.json,retry/超时全 pi 默认;若发现某默认值需防
  二进制升级漂移,在 `pi/index.ts` 加 `writeSettingsJson`(与 models.json 同机制)。
