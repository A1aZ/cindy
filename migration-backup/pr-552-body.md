=== PR #552 by @horizon554: feat(provider): bridge Codex Responses to Chat Completions ===
## 这次改了什么

### 摘要

为 Codex 增加显式的 per-runtime upstream wire protocol，并实现 Responses → OpenAI Chat Completions 的本地协议桥，使只提供 Chat Completions 的供应商可以作为 Codex provider 使用。桥与现有 `anthropic-responses-bridge` 并列，不改写现有 Anthropic / 原生 Responses 路径。

### 变更类型

- [x] `feat` 新功能
- [ ] `fix` 缺陷修复
- [ ] `refactor` / `perf` 重构或性能优化
- [ ] `docs` / `test` / `chore` 文档、测试或工程维护
- [ ] 其他：

### 范围

- 关联 Issue / 需求：#251；maker-core 正文流式渲染独立问题见 #519；模型发现增强 backlog 见 #540。
- 本 PR 包含：`ProviderWireProtocol` 建模、Codex Chat bridge、请求/响应 SSE 转换、工具/reasoning/usage/error 适配、provider diagnostics 协议探测、自定义供应商 UI 与 4 语言文案、DeepSeek/GLM/Kimi/百炼 Coding Plan/Kimi Code 等 Codex preset runtime。
- 明确不包含：模型发现 P1（独立 `modelsUrl` UI、候选 URL fallback、缓存/stale fallback）见 #540；maker-core 的 `item/agentMessage/delta` 订阅修复见 #519；capability fallback。
- 用户可见变化：Codex 自定义供应商可选择 `OpenAI Responses（原生）` 或 `Chat Completions（Cindy 桥接）`；新建/编辑 Codex provider 时协议、Base URL、API Key、模型按 runtime 保存。
- 是否存在 breaking change：无。老配置缺省协议保持 Claude=Anthropic Messages、Codex=OpenAI Responses。

### UI 变化

新增 Codex 上游协议选择和对应说明；涉及 Desktop renderer，已在 macOS dev 实例手工验证。

## 怎么验证的

### 自动验证

```text
pnpm test:unit
结果：通过。所有 required unit workspaces PASS；model-providers 116 tests、responses-chat-bridge 21 tests；无失败。

pnpm --filter desktop typecheck
结果：通过。

pnpm --filter @lizi/model-providers test
结果：116 passed。

pnpm --filter @lizi/responses-chat-bridge test
结果：21 passed。

定向 desktop tests（providerDiagnostics / custom-provider-store / codexProxyHost / providerListProjection）
结果：77 passed。
```

### 手工验证

macOS（Apple Silicon）Cindy remote dev，使用实际 provider API keys；凭证未进入仓库、commit 或日志。

- DeepSeek：Codex Chat bridge 文本、reasoning、工具链路验证通过。
- GLM CN / Global：Codex Chat bridge 验证通过。
- Kimi CN：Claude Code 多次 200/SSE；Codex 在一次上游 429（engine overloaded）后重新发送成功，桥记录 405 text deltas / 453 reasoning deltas，验证通过。
- MiniMax CN：原生 Responses，`https://api.minimaxi.com/v1` 多次 HTTP 200，验证通过。
- MiniMax Global：请求到达 `https://api.minimax.io/v1`，返回结构化 HTTP 402 `insufficient balance`；端点和鉴权可达，真实生成受账户余额阻断。
- 阿里云百炼普通 API：自定义 Claude Code / Codex 验证通过。
- 阿里云百炼 Coding Plan：国内 preset 的 endpoint 已按官方文档配置；错误 key 返回官方 `invalid_api_key`，确认是凭证/计费方案匹配问题而非 bridge。
- 另发现 Codex 正文一口气渲染是 maker-core 既有订阅问题，独立记录在 #519；本 PR 未修改 maker-core。

### 未执行的验证

- 未在 Windows 实机执行；代码路径使用现有跨平台 URL/path/IPC 抽象，待 Windows CI/维护者环境确认。
- 未对 Kimi Global 做真实请求（当前没有对应可用凭证）。
- 未对 MiniMax Global 做真实生成（账户余额不足，见手工验证）。

## 风险

### 风险分类

- [ ] 无已知风险
- [ ] SQLite / migration
- [ ] system prompt
- [x] 协议兼容
- [x] 权限 / 安全 / 用户数据
- [ ] 原生层 / fingerprint / OTA
- [x] 跨平台差异
- [ ] 其他：

### 影响与回滚

- 影响范围：仅 `wireProtocol: openai-chat` 的 Codex provider 使用新 sibling bridge；原生 Responses、Claude Code、默认 Codex 路径保持原有行为。桥只向上游发送 host 构造的鉴权 headers，不透传 Codex/ChatGPT 账号元数据。
- 回滚 / 降级方式：删除/禁用 Chat runtime 的 `wireProtocol: openai-chat` 配置即可回退到原生 Responses；代码回滚为移除新 package 与 provider routing 分支。模型发现增强不在本 PR 内。
- 远程连接 / 手机版：本 PR 的 provider routing 已同步 device-link display projection 的 wire protocol 标记；没有新增需要手机版独立 UI 的 IPC channel，手机/远程控制复用现有 provider projection，后续端到端设备验证可继续跟踪。
- System prompt：未修改系统提示词。

### 提交前检查

- [x] 已 review 完整 diff
- [x] 未提交凭证、令牌或授权文件
- [x] 已补充必要文档
- [x] 已确认测试结果或说明未执行原因

🤖 Generated with [Claude Code](https://claude.com/claude-code)
