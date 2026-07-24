=== PR #493 by @kafeifei: fix(mobile): 串行化排队消息编辑锁生命周期 ===
## 这次改了什么

### 摘要

修复移动端排队消息编辑锁的竞态。加锁、更新内容和解锁现在按顺序执行；加锁失败不会继续更新，保存失败或被旧端拒绝时继续持有原锁，快速取消、切换消息或离开会话时会等待加锁落定后再补偿解锁。

根因是原实现直接并发调用 `setEditLock`、`updateContent` 和解锁：弱网或快速操作时可能出现更新早于加锁、解锁早于更新，甚至旧消息残留编辑锁。

### 功能基线核对

基线的 `beginQueueEdit` 与 `setQueueEditLock` 只发起 fire-and-forget 加锁请求，`send` 随后直接调用 `updateContent` / `updateText`；加锁失败也不会阻止更新。因此问题是实际调用时序缺陷，不是仅缺少一个生命周期抽象。

### 变更类型

- [ ] `feat` 新功能
- [x] `fix` 缺陷修复
- [ ] `refactor` / `perf` 重构或性能优化
- [ ] `docs` / `test` / `chore` 文档、测试或工程维护
- [ ] 其他：

### 范围

- 关联 Issue / 需求：移动端排队消息编辑锁在弱网、重复编辑和快速切换时的竞态
- 本 PR 包含：锁生命周期串行化、失败保锁与补偿解锁、11 个生命周期单测（含保存中取消、切会话与解锁失败重试）、重复编辑 Maestro 流程
- 明确不包含：桌面端队列实现、Device Link 协议变更、发布流程
- 用户可见变化：重复编辑排队消息、快速取消/切换和保存失败后的行为更稳定，不再无锁更新或留下孤儿锁
- 是否存在 breaking change：无

### UI 变化

不涉及。

## 怎么验证的

### 自动验证

```text
pnpm --filter mobile typecheck
结果：通过

pnpm --filter mobile exec vitest run src/__tests__/queueEditLifecycle.test.ts
结果：1 个测试文件、11 个测试通过

pnpm --filter mobile test
结果：235 个测试文件、2225 个测试通过

pnpm --filter mobile test:scope
结果：mobile-scope-guard passed

git diff --check
结果：通过
```

### 手工验证

未执行模拟器手工验证。worktree 为 `/Users/kafeifei/Codes/vibe/cindy-moved`，branch 为 `agent/mobile-queue-edit-lock`；`pnpm mobile:sim:whoami` 因缺少受保护的 `apps/mobile/scripts/self-host-regions.json` 在启动 Metro 前退出，未产生 `__DEV__` build label 或 Metro 归属证据。

### 未执行的验证

- 未执行 Maestro 真机/模拟器流程；已补充重复编辑步骤到 `queue.yaml`。
- 未执行模拟器手工验证，原因是本 worktree 缺少受保护的 region 配置；不复制其他 worktree 的配置，也不把凭证写入仓库。
- 仓库当前 `main` 的 `maestro-flow-smoke.mjs` 会因既有 `login.debugButton` 源码锚点缺失失败，与本 PR 无关。

## 风险

### 风险分类

- [x] 无已知风险
- [ ] SQLite / migration
- [ ] system prompt
- [ ] 协议兼容
- [ ] 权限 / 安全 / 用户数据
- [ ] 原生层 / fingerprint / OTA
- [ ] 跨平台差异
- [ ] 其他：

### 影响与回滚

- 影响范围：仅移动端排队消息编辑时已有 Device Link RPC 的调用时序；不改变协议字段。
- 回滚 / 降级方式：回滚本 PR 后恢复原有并发锁调用行为。

### 提交前检查

- [x] 已 review 完整 diff
- [x] 未提交凭证、令牌或授权文件
- [x] 已补充必要文档（本修复无需额外文档）
- [x] 已确认测试结果或说明未执行原因


