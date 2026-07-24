# Mobile 开发、模拟器与验证

> **读取时机**：开发、启动、调试或验证 `apps/mobile` 及其共享能力时

本文是 Mobile 日常开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/mobile/package.json` 为代码事实源。

## 日常模拟器入口

普通开发使用根脚本维护 Metro、区域配置和 worktree 归属：

```bash
pnpm mobile:sim:start
pnpm mobile:sim:whoami
```

修改原生依赖、Expo 原生配置，或切换到尚未安装对应开发包的区域时，重新构建：

```bash
pnpm mobile:sim:rebuild
pnpm mobile:sim:rebuild -- --region=global
pnpm mobile:sim:start -- --region=global
```

不要用临时 Metro、端口探测或手工修改 `.env` 代替这些脚本。多 worktree、原生构建、
登录态和日志排查见 `apps/mobile/docs/simulator-debugging.md`。

## 分层验证

```bash
pnpm --filter mobile typecheck
pnpm --filter mobile exec vitest run <测试文件路径>
pnpm --filter mobile test
pnpm --filter mobile test:scope
pnpm --filter mobile test:smoke
```

- TypeScript 改动至少运行 typecheck 和相关定向测试。
- 修改跨端协议、Device Link、导航主流程或原生边界时，追加 scope、smoke 或相应 E2E。
- 视觉改动同时遵守 [Cindy 设计规范](../design-rules/cindy-design-system.md) 与
  [Mobile 设计规范](../../apps/mobile/docs/mobile-design-guide.md)。
- 记录实际执行和结果；未执行的高相关检查必须说明原因。

## 专项入口

- 模拟器与真机排错：
  [`simulator-debugging.md`](../../apps/mobile/docs/simulator-debugging.md)。

## 原生配置与 runtime fingerprint(冷更边界)

Mobile 用 `runtimeVersion.policy: "fingerprint"`:OTA 热更只在**指纹一致**的装机上生效,
指纹一旦变化就必须**冷更出包**(新商店包 / 自建重装),存量装机拿不到该次热更。

- 改 `app.json` / `app.config.js` 前先判断是否会动指纹。被哈希的是**解析后的
  ExpoConfig**(app.config.js 的输出),不是源文件本身:凡进入 resolved config 的字段,
  改了值就会变指纹;只有被 app.config.js **覆写 / 剥离、传不到 resolved config** 的值才指纹
  中性(如自建线的 `updates.url` 被占位覆盖)。改动前后可用仓内 `@expo/fingerprint` 比对
  (见 `scripts/ci-fingerprint.mjs`;PR 有 fingerprint guard 自动比对)。
- **EAS 账号绑定与凭据不入仓**:`owner` / `extra.eas.projectId` / `updates.url` 及 provider
  凭证由**构建期环境变量**注入(`EAS_OWNER` / `EAS_PROJECT_ID`,provider secrets 走 EAS
  environment / 自建区域配置),仓库留空,外部使用者用自己的 Expo 项目(`eas init`)填 env。
  因为哈希的是 resolved config,发布环境注回**相同值**时逐字节不变 → 指纹不变、不冷更;缺省
  (dev / fork)则不带账号绑定、不配 OTA。变量清单见 `apps/mobile/.env.example`。

## 边界

本文只覆盖本地开发、调试和验证。商业发布、版本分发、签名与渠道运维属于维护者内部
流程，不在公开仓库文档或 Agent 手册中维护。
