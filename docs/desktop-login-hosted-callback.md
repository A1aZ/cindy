# Desktop 登录托管回调（跨仓契约）

> **状态**：客户端已实现并默认关闭，等待服务端实现后开启
> **读取时机**：实现 / 评审 auth-server 侧托管回调路由，或调整 desktop 系统浏览器
> 登录链路之前

本文是客户端仓与 auth-server 仓之间的接口契约。客户端侧代码已随本文一起合入且
**默认走旧链路**，服务端实现完成后改一行端点清单即可开启。

## 1. 要解决的问题

Desktop 今天走 RFC 8252 loopback 登录：本机起随机端口 HTTP server，把
`http://127.0.0.1:<port>/auth/callback` 作为 `redirect_uri`。用户因此会看到两处裸 IP：

1. 浏览器地址栏 `127.0.0.1:52871/auth/callback?code=...`——**授权码同时暴露在地址栏
   和浏览历史里**；
2. 点「回到 Cindy」唤起 `cindy://focus/desktop-login` 时，系统弹框写着
   「http://127.0.0.1:52871 想打开此应用」——这里的来源就是回调页自己的 origin。

托管回调把 `redirect_uri` 换成 auth-server 自有域名下的固定地址，浏览器全程停在
自有域名上，授权码不再进入地址栏与浏览历史。

### 为什么不是「回调页 fetch 投递回本地端口」

一个自然的想法是：回调页留在自有域名，用 `fetch('http://127.0.0.1:PORT/...')` 把授权码
静默投递回本地 loopback server。**这条路在 Safari 上必然失效**——WebKit 至今不把
loopback 视为 potentially trustworthy origin（[WebKit #171934](https://bugs.webkit.org/show_bug.cgi?id=171934)
长期未修），https 页面 fetch `http://127.0.0.1` 被当作 mixed content 拦掉。Chrome /
Firefox 早已按规范放行，只有 Safari 没跟，而 Safari 是 macOS 默认浏览器。

所以方向翻转成**客户端主动轮询取回**：不需要本地端口、不需要 CORS、不受浏览器差异
影响。

## 2. 目标链路

```
① 客户端生成 codeVerifier(PKCE) 与 client_state(256 bit 随机，仅存在于进程内存)
② 打开系统浏览器 → GET <auth>/api/auth/social/<provider>/authorize
     ?redirect_uri=<托管回调地址>&code_challenge=...&client_state=...&ui_locale=...
③ 用户在 provider 处授权
④ provider → auth-server 托管回调：auth-server 按 client_state 暂存授权码
⑤ auth-server 302 到结果展示页（URL 不含 code）
⑥ 客户端自②起持续轮询 poll 接口，取到 code 后照常 POST /api/auth/token 完成 PKCE 兑换
⑦ 用户在展示页点「回到 Cindy」→ cindy://focus/desktop-login
```

`redirect_uri` 与 `client_state` 参数客户端**现在就已经在传**（`buildAuthorizeUrl`），
authorize 接口本身不需要改。

## 3. 服务端需要实现的部分

### 3.1 redirect_uri allowlist

新增一条**精确字符串**：

```
https://auth.cindy.com.cn/api/auth/desktop/callback      # cn
https://auth.cindy.app/api/auth/desktop/callback         # global
```

必须是逐字符全等匹配，不要用前缀或通配匹配——那会退化成 open redirect 面。客户端
把端点清单里的值原样发出，不做任何拼接。

### 3.2 `GET /api/auth/desktop/callback`

接住 provider 回调：

- 校验 `state`（防 CSRF，语义与今天一致）；
- 按 `client_state` 暂存授权码，**TTL ≤ 5 分钟、一次性消费**（客户端的整体预算就是
  5 分钟）；
- 302 到结果展示页，**URL 里不得带 code**，例如
  `/desktop/login-callback?status=ok&locale=zh-CN`；
- provider 返回错误时同样按 `client_state` 暂存错误码，再 302 到 `status=error`。

### 3.3 `POST /api/auth/desktop/callback/poll`

请求体：

```jsonc
{ "clientState": "<客户端生成的随机值>", "deviceId": "<设备 id>" }
```

响应体（HTTP 200）：

```jsonc
{ "status": "pending" }                       // 尚未完成，客户端继续轮询
{ "status": "ok", "code": "<一次性授权码>" }   // 返回后必须立即失效
{ "status": "error", "error": "<错误码>" }     // provider / 服务端侧失败
{ "status": "expired" }                       // 暂存已过 TTL 或已被取走
```

**关键约束：未知 `clientState` 必须返回 `pending`，不能返回 `expired` 或 4xx。**
客户端从打开浏览器的那一刻就开始轮询，此时用户还没授权完，服务端多半还没有这条记录；
这时若返回终态，第一次轮询就会把登录判死。

（可选优化：若服务端在 authorize 阶段就为 `client_state` 落一条 pending 记录，则可以在
TTL 过后如实返回 `expired`，让客户端提前失败而不必干等满 5 分钟。）

其它约定：

- 非 2xx 响应按现有错误格式返回（`{ "error": { "code", "message" } }` 或
  `{ "code", "message" }`），客户端会把 `code` 直接用作可展示的错误码；
- 建议按 `clientState` 与 `deviceId` 限流；
- 客户端单次请求超时 30s，**允许长轮询**（hold 住请求直到有结果或 ~20s 返回
  `pending`）。短轮询实现同样可用：客户端间隔 1s，30s 后退避到 2s。

### 3.4 结果展示页

页面模板由客户端仓导出，**不要在服务端手写一份**：

```bash
pnpm --filter desktop run export:login-callback-template
# → apps/desktop/dist/login-callback-template/{zh,en,ja,ko}/{success,error}.html + manifest.json
```

- 每份 HTML 自带 light / dark（`prefers-color-scheme`），不要按主题拆分；
- 失败页含 `{{ERROR_DETAIL}}` 一个占位符，替换错误码前需按 HTML 文本节点转义；无错误
  码时连同它所在的 `<p class="detail">` 一并删除；
- 语言按 authorize 请求带上的 `ui_locale` 选，缺省回落 `en`；
- 页面自包含（立绘已是 data URI），无外链依赖；
- 客户端改文案后需重新导出同步，**不要在服务端侧手改 HTML**。

## 4. 安全说明（供评审）

- **服务端暂存授权码不构成新增信任面**：这个 code 本来就由 auth-server 自己签发、
  自己持有，短期暂存自己签发的凭据没有引入新的信任方。
- **PKCE 仍是兑换的唯一凭证**：`code_verifier` 只存在于 Desktop main 进程内存中，
  从不出网。单独拿到 code 换不到 token。
- **相比现状更安全**：授权码不再出现在浏览器地址栏与浏览历史里。
- **`client_state` 兼作取回凭据**：客户端仍用 `randomUUID()`（v4，122 bit 随机量），
  配合服务端限流不可爆破，且只存在于进程内存。刻意没有改成更长的随机串——`client_state`
  是两条链路共用的参数，改格式（36 → 43 字符）会同时作用于 loopback 路径，一旦服务端
  对它有长度或 UUID 格式约束就会打断现网登录。**若服务端确认 `client_state` 没有格式
  约束，可以另开一个小改动把它提到 256 bit。** 服务端侧请勿把它写进可被检索的日志。
- **仍然只有一条 wire 变化面**：token 兑换、账号选择、SSO 等其余链路完全未动。

## 5. 上线与回滚

开关是端点清单字段 `authDesktopCallbackUrl`（`config/endpoint.json` /
`config/endpoint.global.json`，人肉上传各自 region 的 CDN）：

- **空串或缺失** → 客户端走 RFC 8252 loopback，行为与今天完全一致（当前即此状态）；
- **填入托管回调地址** → 客户端走本文链路。

清单在应用启动第一步解析，改动**重启客户端后生效**。服务端侧出任何问题，把该字段清空
即可回退到 loopback，**客户端不需要发版**。

## 6. 验收清单

- [ ] Safari 与 Chrome 各跑一次完整登录：地址栏全程 `https://auth.<域名>/...`，URL 里
      没有 code，唤起弹框显示的是域名而非 IP
- [ ] 展示页 light / dark 双模式目检（`docs/design-rules/DESIGN.md` 双模式交付门槛）
- [ ] 四种语言各看一次（zh / en / ja / ko）
- [ ] 授权码一次性：同一 `clientState` 第二次 poll 返回 `expired`
- [ ] 未知 `clientState` 返回 `pending`（见 3.3 关键约束）
- [ ] 用户中途关闭浏览器：客户端 5 分钟后按取消收场，不报错
- [ ] 清空清单字段后回退 loopback 仍正常
