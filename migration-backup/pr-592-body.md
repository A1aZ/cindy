=== PR #592 by @DavidShenXD: feat(content-moderation): 完善审核流程与个人模型授权 ===
## 这次改了什么

### 摘要

为个人登录用户接入端到端内容审核：release 仅国服生效，dev 通过显式开关启用；企业用户及其他登录方式不受影响。用户文字和图片在进入模型前审核，模型流式输出在展示前审核，头像、昵称和个性化提示词修改也纳入同一规则。

同时修复两项个人模型供应商问题：OpenAI 授权弹窗不再因重复状态监听瞬间关闭；CindyAI 的失效 Key 由服务端明确识别后重新签发，客户端不再表现为“模型可见但实际不可用”。

### 变更类型

- [x] `feat` 新功能
- [x] `fix` 缺陷修复
- [ ] `refactor` / `perf` 重构或性能优化
- [x] `docs` / `test` / `chore` 文档、测试或工程维护
- [ ] 其他：

### 范围

- 关联 Issue / 需求：内容审核接入方案与本地联调反馈
- 本 PR 包含：个人用户资格判断；文本/图片输入审核；流式模型输出审核；头像、昵称、自定义提示词审核；1 秒一次、最多 3 次的 query；Desktop/Mobile 阻断通知；本地 dev 启动覆盖；共享协议消费；OpenAI 授权弹窗修复。
- 明确不包含：生产审核网关地址和平台凭据；服务端部署；企业用户或其他登录方式的审核；审核平台运营配置。
- 用户可见变化：违规内容提示改为“抱歉，当前问题暂时无法为您解答，请调整提问表述。”；OpenAI 授权弹窗保持打开直至流程完成。
- 是否存在 breaking change：无；新增能力按用户类型、Region 和 dev 开关显式启用，旧服务端不可用时 fail closed/降级逻辑保持受控。

### UI 变化

Desktop 和 Mobile 的审核阻断文案更新；OpenAI 授权弹窗不再瞬间消失。没有新增布局、视觉组件或动画。Desktop 文案已同步 zh-CN/en/ja/ko；Mobile 当前通知沿用现有原生 Alert 入口。

## 怎么验证的

### 自动验证

```text
pnpm test:unit
结果：通过

pnpm --filter desktop run --if-present typecheck
结果：通过

pnpm --filter mobile run --if-present typecheck
结果：通过

pnpm check:i18n
结果：通过；zh-CN/en/ja/ko 共 5059 个 key 一致，存量警告不阻塞
```

共享协议另在 [makecindy/cindy-protocol#4](https://github.com/makecindy/cindy-protocol/pull/4) 通过 `pnpm test` 与 `pnpm typecheck`。

### 手工验证

Windows 本地 dev 沙盒同时启动客户端和本地 auth/model-access/moderation-sign 服务，使用个人登录账号验证文字与图片消息均经过审核；需求方确认测试通过。验证结束后已关闭 dev client 和 server。

### 未执行的验证

- 未在 macOS 实机复测；相关实现使用跨平台 fetch、path 和既有 Electron/React Native 通知边界。
- 未执行 Mobile 模拟器完整 E2E；Mobile 改动为既有远端审核通知的文案展示。
- 生产网关与生产凭据尚未配置，不在本 PR 验证范围。

## 风险

### 风险分类

- [ ] 无已知风险
- [ ] SQLite / migration
- [ ] system prompt
- [x] 协议兼容
- [x] 权限 / 安全 / 用户数据
- [ ] 原生层 / fingerprint / OTA
- [x] 跨平台差异
- [x] 其他：外部审核网关可用性和超时边界

### 影响与回滚

- 影响范围：仅个人登录用户；release 仅国服，dev 仅显式开关开启时生效。企业用户和其他登录方式不进入审核链路。
- 回滚 / 降级方式：先关闭 dev 开关或回滚客户端；release 可回滚到上一版本。共享协议为 append-only 新包，不改变既有 wire contract。服务端消费 PR 见 xindong/cindy-server 对应依赖 PR。

### 提交前检查

- [x] 已 review 完整 diff
- [x] 未提交凭证、令牌或授权文件
- [x] 已补充必要文档
- [x] 已确认测试结果或说明未执行原因
