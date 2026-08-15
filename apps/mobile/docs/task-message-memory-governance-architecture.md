# 当前与新方案架构对比：Mobile 任务消息驻留

> 日期：2026-08-15
>
> 配套方案：[task-message-memory-governance-plan.md](./task-message-memory-governance-plan.md)（Mobile 任务消息内存治理方案）
>
> 图 1 基于当前代码基线（阶段 0 现状），图 2 为方案全部阶段（1–4）落地后的目标架构。
> 图 1 中红色节点是现状的问题点；图 2 中绿色节点是新增的治理能力。

## 图 1：当前基线

```mermaid
flowchart TB
  subgraph pages ["页面层"]
    home["首页 / 设备列表页<br>devices/index"]
    devdetail["设备详情页<br>devices/[deviceId]"]
    detail["会话详情页<br>sessions/[sessionId]"]
  end

  subgraph idx ["schedule 索引（晚半拍次要数据，30s TTL）"]
    sidx["schedule.list + N×listRuns(50)<br>buildSessionScheduleIndex<br>→ 徽标 / 未读 / 运行中"]
  end

  subgraph store ["remoteSessionStore（内存）"]
    msgs["每会话完整消息数组<br>打开过即常驻，无任何回收"]
    stream["流式状态 / 消息渲染投影<br>随消息一起常驻"]
    meta["会话元数据 / 未读 / 预览"]
  end

  subgraph cache ["AsyncStorage 本地缓存"]
    msgcache["每会话消息缓存<br>上限 80 条"]
  end

  subgraph device ["工作设备（Desktop）"]
    slist["sessions:list<br>limit=200 + 状态筛选"]
    mlist["messages:list<br>最新 80 条 + before 分页"]
    push["订阅推送（sessions 主题）"]
  end

  home -->|"拉列表"| slist
  devdetail -->|"拉列表（带筛选）"| slist
  home -.->|"徽标 / 未读"| sidx
  detail -->|"首开 + 加载更早"| mlist
  detail -->|"subscribe(session:id)"| push
  slist --> meta
  mlist --> msgs
  push -->|"事件全量写回消息"| msgs
  detail -->|"首次访问 hydrate"| msgcache
  msgcache -->|"乐观种入（仅空会话）"| msgs
  msgs -->|"去抖持久化"| msgcache
  msgs --- stream

  classDef hot fill:#fdd,stroke:#c33,color:#900
  class msgs,stream hot
```

### 现状要点

- **无任务分类**：schedule 任务与普通任务走完全相同的驻留策略。
- **内存只进不出**：任何会话被打开过一次，完整消息数组和渲染投影就常驻 Store，没有压缩、预算或 LRU。
- **推送全量写回**：订阅推送带来的消息内容直接进入消息 Store，不区分用户是否在看。
- **唯一的量约束在磁盘**：AsyncStorage 每会话缓存上限 80 条，内存不受它约束。
- 列表数据（200 条 + 筛选）与 schedule 索引只影响展示，不参与任何回收决策——本方案保持这一点不变。

## 图 2：新方案（阶段 1–4 全部落地）

```mermaid
flowchart TB
  subgraph pages ["页面层"]
    home["首页 / 设备列表页"]
    detail["会话详情页<br>focus 授予驻留权限<br>blur / 切任务 / App 后台 → 撤销"]
  end

  classify["统一分类函数<br>session.source === 'scheduler' → schedule<br>否则普通任务（含 bound 绑定）<br>legacy [Schedule] 标题兜底"]

  subgraph entry ["统一回收入口（新建：retentionKind + reason）"]
    sp["schedule 策略<br>失焦 → 完整消息回收到 0<br>定点清缓存"]
    rp["普通任务策略（阶段 4）<br>失焦 → 压回 80 条<br>全局 ~800 条 + LRU"]
    prot["保护：草稿 / outbox / 上传<br>乐观发送 / pending interaction"]
  end

  subgraph store ["remoteSessionStore"]
    sm["schedule 消息<br>仅当前详情驻留"]
    rm["普通任务消息<br>80 / 800 / LRU 治理"]
    summ["通知摘要 / 未读 / 运行状态<br>长期保留（轻量）"]
  end

  fence["generation / authority 围栏<br>迟到读取 · hydrate · 订阅回调 · 流式合批<br>不得让已回收正文复活<br>例外：在途发送确认 → 写回最小状态"]

  subgraph cache ["AsyncStorage 本地缓存"]
    sc["schedule：跳过 hydrate / 写入<br>识别或失焦时定点清除"]
    rc["普通任务：每会话 80 条"]
  end

  subgraph device ["工作设备（Desktop，不改）"]
    slist["sessions:list"]
    mlist["messages:list 80 条窗口"]
    push["订阅 / 全局推送"]
  end

  home --> slist
  detail --> classify
  classify -->|"schedule"| sp
  classify -->|"regular"| rp
  detail -->|"有驻留权限才加载 / 订阅"| mlist
  mlist --> fence
  push --> fence
  fence -->|"当前详情：写入"| sm
  fence -->|"非当前 schedule：只更新"| summ
  fence -->|"普通任务：写入"| rm
  sp --> sm
  rp --> rm
  sp --> sc
  rp --> rc
  prot -.-> sp
  prot -.-> rp

  classDef hot fill:#dfd,stroke:#3a3,color:#060
  class sm,rm,sc,rc hot
```

### 新方案要点

- **一个分类，两种策略**：统一分类函数读 `session.source`（不依赖 schedule 索引），决定 retentionKind；页面、Store、缓存层不各自判断。
- **统一回收入口**：新建（当前基线没有），页面只报告事实（失焦 / 切任务 / 后台），入口按分类和保护清单执行回收，不为 schedule 另起平行 Store。
- **写入围栏**：所有异步写入（读取、hydrate、推送、流式合批）过同一道 generation / authority 检查；唯一例外是失焦后在途的发送确认与交互回执，只允许写回最小状态。
- **工作设备不动**：数据源、协议、Desktop 行为全部保持不变；重新打开详情时从工作设备重读。
- **首页列表链路零改动**：`sessions:list`（200 条 + 筛选）与 schedule 索引的拉取方式、频率保持现状；分类复用列表返回里已有的 `session.source` 字段，零新增请求。该链路的目录额度与索引同步成本是已识别的后续优化方向，另行立项（方案 §17）。

## 关键差异对照

| 维度 | 当前基线 | 新方案 |
| --- | --- | --- |
| 任务分类 | 无 | source 主判据二分类，终身不变 |
| schedule 任务消息 | 打开过即常驻 | 仅当前详情驻留，失焦回收到 0 |
| 普通任务消息 | 常驻，无任何回收 | 压回 80 条 + 全局 ~800 条 LRU（阶段 4） |
| 本地缓存 | 所有任务都读写（每会话 80 条） | schedule 跳过并定点清除；普通任务不变 |
| 推送写入 | 全量写回消息 Store | 非当前 schedule 只更新摘要；写入过围栏 |
| 迟到异步结果 | 无防护，可随时写回 | generation 围栏拦截，在途发送确认例外 |
| 回收触发 | 无 | 统一入口：失焦 / 切任务 / App 后台，无定时器 |
| 数据安全 | 不适用（无回收） | 草稿 / outbox / 上传 / 乐观发送 / pending interaction 保护 |
| 工作设备与协议 | — | 完全不变（Mobile-only） |
