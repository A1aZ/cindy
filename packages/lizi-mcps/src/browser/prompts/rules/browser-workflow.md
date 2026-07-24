### 浏览器操作工作流

只要浏览器操作超出"打开一个页面看一眼",就按下面这个环来做,避免盲点、空转和把上下文撑爆。

#### 核心操作环

1. **先探测状态,别盲目开始**
   - `action: "status"` —— 浏览器是否可用、是否已启动;不可用先看下面的「环境」。
   - `action: "tabs"` —— 列已有标签页,**复用**已开的页而不是无脑开新页(否则一屏堆满窗口)。
   - `action: "profiles"` —— 看当前 profile 及其登录态(见「登录与 profile」)。
   - 怀疑环境异常时 `action: "doctor"` 自检。

2. **用稳定的标签页句柄**
   - 打开重要页面用 `action: "open"` 时带上 `label`(如 `label: "checkout"`),后续靠 label 复用。
   - `targetId` 优先用 `tabs` / `open` 返回的 `suggestedTargetId` / `tabId` / `label`,**不要**把裸序号(`"2"`)当 `targetId` 传。
   - 开新页前先 `tabs`;按 label 或 URL 命中已有页就复用,不重复开。

3. **先读后点(snapshot → ref)**
   - 点击 / 输入前先 `action: "snapshot"`(同一个 `targetId`,`refs: "aria"`)拿到页面结构和元素 `ref`。
   - **永远用 snapshot 返回的 `ref` 去操作,绝不猜 CSS selector。**
   - 页面长 / 噪声多时用 `interactive: true`、`compact: true` 收窄;只关心某区域时用 `selector` / `frame` 限定。

4. **窄操作,操作后重新观察**
   - 用 `action: "act"` + `request: { kind, ref, ... }` 执行动作:
     - 点击:`{ kind: "click", ref }`
     - 输入:`{ kind: "type", ref, text }`(边输入边回车加 `submit: true`)
     - 按键:`{ kind: "press", key: "Enter" }`
     - 下拉:`{ kind: "select", ref, values: [...] }`
     - 悬停 / 拖拽:`{ kind: "hover", ref }` / `{ kind: "drag", startRef, endRef }`
   - `ref` 必须取自**最近一次** snapshot。导航 / 弹窗 / 提交后页面变了,**先重新 snapshot 再继续**,别用旧 ref。
   - 别盲等。需要等待用 `{ kind: "wait", ... }`(等 `loadState` / `textGone` / `timeoutMs`),不要靠反复重试空转。

5. **遇阻塞停下来报告**
   - 撞到登录墙 / 验证码 / 2FA / 需要人工授权时:**停下来如实告诉用户**当前页面状态 + 需要他做什么,不要反复尝试或假装能绕过。

#### Token 效率(按"最省 → 兜底"的顺序选路)
1. **先查有没有现成配方**:操作某个站之前,**先 `action: "siteguide"`**——带 `site`(站点 host)看该站内置指南 / 配方;**不确定有哪些站时,`siteguide` 不带 `site` 会列出全部内置站点 + 可用配方目录**(`sites:[{site,recipes,auth}]`)。命中配方就 `action: "recipe"`(`recipeId`+`inputs`)一步跑完(最省最稳),优先于手动 snapshot/extract。注意 `siteguide` 是我们内置的站点指南,**不是去抓网站自己的 `/sitemap.xml`**——不要为此去 navigate / curl `sitemap.xml`。
2. **数据型页面优先读接口,别扒 DOM**:很多列表 / 详情背后是 JSON API,读接口比扒渲染后的 DOM 又稳又省。
   - ① `action: "requests"`(带**具体** `filter`,如 `/api/quotes`;别用太宽的 `api`,会撞 `fonts.googleapis.com` 之类)看页面发了哪些 XHR/fetch、拿到接口 URL。这是读**已发生**请求的清单。
   - ② 读 body:**GET 接口最稳的姿势是直接 `navigate` 到该 URL**,再用 `extract`(`fields:{ data:"body" }`)或 snapshot 读返回的 JSON。
   - ③ `action: "responseBody"` + `url` 是**等待下一个匹配的响应**(默认 20s 超时,**不是读历史**)——必须先发起它、再触发请求,适合轮询 / 滚动 / 点击触发的 XHR;顺序工具调用下不好配合,能用 ② 就用 ②。
3. **要可点击元素 / 探索结构,用 scoped snapshot**:`snapshot` 用来理解页面、拿交互元素的 `ref`,也是**写 `extract` 选择器前确认真实结构**的手段;输出过大时用 `selector` 限定区域 + `compact: true` / `interactive: true` / `limit` / `maxChars` 收窄(scoped snapshot 已经把 role/name/value/ref 结构化带出,很多场景够用)。
4. **要精确字段 / 干净 JSON 才用 `extract`**:snapshot 不够精准(要取某属性、按子选择器拆字段)时,用 `action: "extract"` 一次性提结构化记录(`from` + `multiple` 提列表)。**关键:`fields` 的简写 string 是纯 CSS 选择器(取 textContent);取属性用 `{selector,attr}`,取链接用 `{selector,type:"href"}`——别把属性拼进选择器(`"h3 a@title"` 非法)、别写自然语言。** 不确定选择器就先 scoped snapshot 看结构再写。
5. **慎用 screenshot**:只有需要视觉确认(布局 / 图像内容)时才 `action: "screenshot"`;链接要看真实 URL 时 snapshot 带 `urls: true`,元素位置重要时才 `labels: true`。

#### 登录与 profile
- 只有一个**专属持久自动化浏览器**(窗口里显示为名为 "Cindy" 的 profile),登录态长期保留。**不要传 `profile`**,直接走默认即可。
- 操作需要登录态的站点前,导航后 `action: "snapshot"`(必要时配 `action: "profiles"`)判断是否已登录。
- **撞到登录墙 / "请重新登录" 时:这个自动化浏览器此刻已经开着、就停在该页面上**,不需要让用户再去别处打开浏览器。先用 `action: "focus"`(带该 tab 的 `targetId`)把它的窗口拉到前台,再**停下来如实告诉用户**:请直接在这个已经打开的浏览器窗口里登录(扫码 / 输账号 / 过验证码),登录态会长期保留;登录完成后回来告诉你,你再 `snapshot` 继续。**不要**自己硬试或假装能绕过,也**不要**把用户支去设置页或别的地方开浏览器。
- 不要试图接管用户日常使用的 Chrome——只用这个独立的自动化浏览器。

#### 失败与 stale ref 恢复
- `ref` 失效(页面变了 / 元素消失):对**同一个 targetId** 重新 `snapshot`,在新结构里找当前可见的控件,**重试一次**。
- 重试后仍失败,或 UI 已变成登录 / 错误 / 验证码等阻塞态:停下来报告,不要无限循环。
- 工具返回 `ok: false` 时读 `message` / `errorCode`,区分是"页面问题"还是"浏览器不可用"(后者见「环境」),分别处理。

#### 环境
- `status` 显示浏览器不可用,多半是本地浏览器运行时未就绪。提示用户到**设置 → 自动操作**检查浏览器状态 / 完成首次准备,不要在工具层反复重试。

#### action 速查
| action | 用途 |
|---|---|
| `status` / `doctor` | 可用性 / 自检 |
| `start` / `stop` | 启停浏览器 |
| `profiles` | 看 profile 与登录态 |
| `tabs` / `open` / `focus` / `close` | 标签页:列 / 开(带 label)/ 切 / 关 |
| `navigate` | 当前或指定 tab 导航到 URL |
| `snapshot` | 读页面结构 + 拿 ref(交互前定位元素用) |
| `act` | 执行 click/type/fill/press/select/hover/drag/wait/evaluate(见 `request.kind`) |
| `extract` | 按字段 schema 从 DOM 提结构化数据(列表/详情,优于全页 snapshot) |
| `requests` / `responseBody` | 看页面已发生的 XHR/fetch 列表(可 `filter`) / 等待并读下一个匹配响应的 body(先发起再触发;读 GET JSON 优先直接 navigate 到该 URL) |
| `recipe` / `siteguide` | 跑某站现成配方(`recipeId`+`inputs`) / 取某站内置指南(`site`,含入口/关键页/可用配方;非 sitemap.xml) |
| `screenshot` | 仅在需要视觉确认时用 |
| `console` / `pdf` / `upload` / `dialog` | 控制台日志 / 导出 PDF / 上传文件 / 处理原生弹窗 |
