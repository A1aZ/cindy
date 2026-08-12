/**
 * PrRefsContext — sidebar 会话列表的 PR 引用 / 状态共享缓存(session-git-pr-context)。
 *
 * 设计对标 WorktreeContext:provider 挂 App 顶层,mount 时一次 listAllPrRefs
 * 拉全表建 sessionId → refs 映射(只有出现过 PR 链接的会话才有行,体量小),
 * 之后靠 git-context:pr-refs-changed 推送对单个 session 增量刷新。
 * SessionItem 据此零 IPC 判断"这行有没有 PR"——没有的行不挂任何浮层。
 *
 * **刻意拆成两个 context**:refs(每个 SessionItem 都订阅)与 statuses
 * (只有打开中的 tooltip 订阅)。状态在每次 tip 打开时按需拉取并 setState,
 * 若合在一个 value 里,每次 hover 拉到状态都会让整个侧边栏的所有行重渲染;
 * 拆开后状态更新只触达正在显示的 tip(code-review 性能反馈)。
 *
 * PR 状态(open/merged/...)是远端易变数据,不在启动期预取;main 侧本就有
 * 60s TTL + in-flight 去重,这里只做轻量去重,不再加 TTL。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { PrStatusResult, SessionPrRef } from '@/lib/gitContext.types';
import { prStatusKey, MAX_STATUS_QUERIES, PR_STATUS_REFRESH_INTERVAL_MS } from '@/lib/prStatus';
import { useAuth } from '@/contexts/AuthContext';
import { isRemoteDeviceMarkedDisconnected } from '@/features/device-link/remoteProjectsStore';
import { createLogger } from '@/lib/logger';

const log = createLogger('PrRefsContext');

/** sessionId → PR 引用(lastSeenAt 降序)。无 PR 的会话不在 map 里。 */
const PrRefsMapContext = createContext<Map<string, SessionPrRef[]>>(new Map());

interface PrStatusesContextValue {
  /** prStatusKey(ref) → 状态查询结果。 */
  statuses: Map<string, PrStatusResult>;
  /** tip 打开时按需拉该会话前几条 PR 的状态(共享缓存,重复调用便宜)。 */
  fetchStatusesForSession: (sessionId: string) => void;
}

const PrStatusesContext = createContext<PrStatusesContextValue>({
  statuses: new Map(),
  fetchStatusesForSession: () => undefined,
});

/**
 * 行级动作 context——value 恒定(回调身份稳定,无状态字段),SessionItem /
 * SessionCard 可以安全订阅而不被 statuses 更新连带重渲染(文件头性能边界)。
 * device-link 远程会话的 PR 引用不在本地 db(listAllPrRefs 看不见它们),
 * 由渲染中的行按需经远程通道补拉,落进同一张 refsBySession 映射。
 */
interface PrActionsContextValue {
  /**
   * 行级注册:声明「这一行正在展示 PR 信息」(SessionItem / SessionCard 在
   * 勾选 pr 且行渲染时调用,返回注销函数挂 effect cleanup)。注册即触发一次
   * 拉取,此后 Provider 以与聊天顶栏同一节拍(PR_STATUS_REFRESH_INTERVAL_MS)
   * + 窗口聚焦统一刷新全部已注册会话——首查失败(device-link 慢/断、gh 限流、
   * token 未就绪)由下个周期自愈,对齐顶栏行为,不再"拉一次定终身"。
   *
   * 远程(device-link)会话:引用经白名单通道 git-context:pr-refs:list 补拉
   * (成功后不重复;失败随周期重试),并登记 sessionId→deviceId,状态查询自动
   * 走 git-context:pr-status 远程路由。注册数被列表 collapse 上限约束,main /
   * 被控端各有 60s TTL,周期刷新的实际开销有界。
   */
  registerPrConsumer: (sessionId: string, deviceId?: string) => () => void;
}

const PrActionsContext = createContext<PrActionsContextValue>({
  registerPrConsumer: () => () => undefined,
});

function groupBySession(rows: SessionPrRef[]): Map<string, SessionPrRef[]> {
  const map = new Map<string, SessionPrRef[]>();
  for (const row of rows) {
    const list = map.get(row.sessionId);
    if (list) list.push(row);
    else map.set(row.sessionId, [row]);
  }
  return map; // listAllPrRefs 已按 lastSeenAt 降序,组内顺序天然正确
}

export function PrRefsProvider({ children }: { children: ReactNode }) {
  // 同进程切换 data owner → 另一份本地 db。云账号和本地模式都以 owner id
  // 为 key 重跑，先清旧缓存，再从新 owner 的库重新全量加载。
  const { dataOwnerId } = useAuth();
  const [refsBySession, setRefsBySession] = useState<Map<string, SessionPrRef[]>>(new Map());
  const [statuses, setStatuses] = useState<Map<string, PrStatusResult>>(new Map());
  // fetchStatusesForSession 经 ref 读最新 refs,保持回调身份稳定
  // (依赖 refsBySession 会让每次 refs 更新都重建回调、连带 tooltip 重渲染)。
  const refsRef = useRef(refsBySession);
  refsRef.current = refsBySession;
  // tip 快速划过多行时防止同一会话重复在飞;main 侧有 60s 缓存,这里不做 TTL。
  const inFlightSessions = useRef(new Set<string>());
  // 远程会话引用拉取:在飞去重 + 上次**成功**时间戳(TTL 门)。空结果不是终态——
  // 远端没有 pr-refs-changed 推送,被控端后来新增的 PR 只能靠周期重查发现;失败
  // 不写时间戳,下一次触发(interval / 聚焦 / 行重挂载)立即重试。
  // (2026-08-12 实机教训:此前用"已拉取过"永久集合兼任在飞守卫,一次空结果或
  // 时序竞态就让该会话永远静默,置顶重挂载也救不回来。)
  const remoteRefsInFlight = useRef(new Set<string>());
  const remoteRefsFetchedAt = useRef(new Map<string, number>());
  const remoteDeviceBySession = useRef(new Map<string, string>());
  // 正在展示 PR 信息的会话(sessionId → {deviceId?, count})。顶栏(打开的会话)
  // 与侧栏行(勾选 pr)都注册到这里;引用计数支持同一会话多处并存。refs 异步
  // 到位(全量加载 / 远程补拉 / 引用变化推送)后,对注册中的会话立即补状态查询。
  const prConsumers = useRef(new Map<string, { deviceId?: string; count: number }>());

  // owner 边界判定:首挂载**不清**——React 子 effect 先于父 effect 运行,行组件的
  // 注册与远程簿记(remoteDeviceBySession 等)此时已写入,首挂载清空会把它们连同
  // 全量加载的合并保护一起打掉(实测:状态查询错落到本地路径)。只有 owner 真正
  // 切换(上一个值存在且不同)才需要丢弃上一账号的缓存。
  const prevOwnerRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const prevOwner = prevOwnerRef.current;
    prevOwnerRef.current = dataOwnerId;
    if (prevOwner !== undefined && prevOwner !== dataOwnerId) {
      // owner 切换边界:清掉上一 owner 的缓存与远程簿记(prConsumers 保留——
      // 行组件仍挂着,新 owner 下由周期刷新按注册表重建缓存)。
      setRefsBySession(new Map());
      setStatuses(new Map());
      remoteRefsInFlight.current.clear();
      remoteRefsFetchedAt.current.clear();
      remoteDeviceBySession.current.clear();
    }
    if (dataOwnerId === null) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Provider 挂 App 顶层,首次加载通常早于登录后的 db ensureReady——
    // main 返回 null(未就绪)或抛错时定时重试,直到拿到数据为止。
    const RETRY_MS = 2_000;
    const scheduleRetry = () => {
      if (cancelled) return;
      retryTimer = setTimeout(() => void load(), RETRY_MS);
    };
    const load = async () => {
      try {
        const rows = await window.electronAPI.gitContext.listAllPrRefs();
        if (cancelled) return;
        if (rows === null) {
          scheduleRetry();
          return;
        }
        // 合并而非整体替换:listAllPrRefs 只覆盖本地会话;远程(device-link)会话
        // 的条目可能已先一步拉到,整体替换会把它们冲掉(启动时序竞态)。
        const grouped = groupBySession(rows);
        setRefsBySession((prev) => {
          const next = new Map(grouped);
          for (const [sid, refs] of prev) {
            if (remoteDeviceBySession.current.has(sid) && !next.has(sid)) next.set(sid, refs);
          }
          return next;
        });
        // 已注册消费者(顶栏/侧栏正在展示的会话)拿到引用后立即补状态,
        // 不等 90s 周期——覆盖「先注册、后加载完成」的启动时序。
        for (const [sid] of prConsumers.current) {
          const refs = grouped.get(sid);
          if (refs) fetchStatusesForRefs(sid, refs);
        }
      } catch (err) {
        log.warn('pr refs load failed, will retry', String(err));
        scheduleRetry();
      }
    };
    void load();

    const unsubscribe = window.electronAPI.gitContext.onPrRefsChanged((data) => {
      void (async () => {
        try {
          const refs = await window.electronAPI.gitContext.listPrRefs(data.sessionId);
          if (cancelled) return;
          setRefsBySession((prev) => {
            const next = new Map(prev);
            if (refs.length > 0) next.set(data.sessionId, refs);
            else next.delete(data.sessionId);
            return next;
          });
          // 该会话有消费者在展示(顶栏/侧栏徽标)→ 引用变化后立即刷状态,
          // 不等 90s 周期(对齐顶栏旧行为:引用变化即时补状态)。
          if (refs.length > 0 && prConsumers.current.has(data.sessionId)) {
            fetchStatusesForRefs(data.sessionId, refs);
          }
        } catch (err) {
          log.warn('pr refs refresh failed', String(err));
        }
      })();
    });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [dataOwnerId]);

  // 回调身份稳定(空闭包依赖):refs 显式传入或经 refsRef 读,statuses 经函数式
  // setState 写。远程会话(remoteDeviceBySession 命中)状态改走 device-link 通道
  // ——被控端持有 gh token,且 main 侧按该会话已提取的引用过滤查询
  // (git-context/ipc.ts 的 fail-closed 逻辑),与聊天顶栏同一条安全路径。
  const fetchStatusesForRefs = useRef((sessionId: string, refsInput: readonly SessionPrRef[]) => {
    const refs = refsInput.slice(0, MAX_STATUS_QUERIES);
    if (refs.length === 0) return;
    if (inFlightSessions.current.has(sessionId)) return;
    inFlightSessions.current.add(sessionId);
    void (async () => {
      try {
        const queries = refs.map((r) => ({ owner: r.owner, repo: r.repo, prNumber: r.prNumber }));
        // 远程路由的 deviceId 兜底顺序:簿记表 → 消费者注册表(owner 切换清簿记后,
        // 注册表仍保有 deviceId,避免远程会话错落到本机查询)。
        const deviceId =
          remoteDeviceBySession.current.get(sessionId) ??
          prConsumers.current.get(sessionId)?.deviceId;
        // 设备明确断线时不发注定失败的隧道调用(fail-open:shard 缺失照常尝试)。
        // 不写任何状态,重连后的下一个触发点(周期 / 聚焦 / 引用到位)自然恢复。
        if (deviceId && isRemoteDeviceMarkedDisconnected(deviceId)) return;
        const results = deviceId
          ? ((await window.electronAPI.deviceLink.invoke(deviceId, 'git-context:pr-status', [
              { sessionId, queries },
            ])) as PrStatusResult[])
          : await window.electronAPI.gitContext.getPrStatuses(queries);
        if (!Array.isArray(results)) return;
        setStatuses((prev) => {
          const next = new Map(prev);
          for (const r of results) next.set(prStatusKey(r), r);
          return next;
        });
      } catch (err) {
        log.warn('pr statuses fetch failed', String(err));
      } finally {
        inFlightSessions.current.delete(sessionId);
      }
    })();
  }).current;

  const fetchStatusesForSession = useRef((sessionId: string) => {
    fetchStatusesForRefs(sessionId, refsRef.current.get(sessionId) ?? []);
  }).current;

  // 远程会话 PR 引用按需拉取(回调身份稳定)。结果进共享 refs 映射,渲染路径
  // (usePrRefsForSession)对本地/远程一视同仁。空结果同样写入 TTL 时间戳,
  // 但**不是终态**:下个周期重查(远端新增 PR / 短暂竞态都靠这条自愈)。
  const fetchRefsForRemoteSession = useRef((sessionId: string, deviceId: string) => {
    remoteDeviceBySession.current.set(sessionId, deviceId);
    // 设备明确断线 → 跳过(簿记保留,供状态查询路由)。此前失败路径刻意不写时间戳
    // 以便瞬断立即重试,但长离线下就成了每个周期一轮注定失败的隧道调用 + 告警日志;
    // 断线判定本地同步可得,先看一眼再发(2026-08-13 用户裁决)。fail-open:
    // shard 缺失(尚未建立 / 设备已移除)照常尝试,语义见 isRemoteDeviceMarkedDisconnected。
    if (isRemoteDeviceMarkedDisconnected(deviceId)) return;
    if (remoteRefsInFlight.current.has(sessionId)) return;
    // TTL 门:距上次成功不足一个刷新周期就跳过(interval / 聚焦 / 行重挂载都会
    // 频繁触发,靠它避免风暴);失败路径不写时间戳,天然立即可重试。
    const fetchedAt = remoteRefsFetchedAt.current.get(sessionId);
    if (fetchedAt !== undefined && Date.now() - fetchedAt < PR_STATUS_REFRESH_INTERVAL_MS - 5_000)
      return;
    remoteRefsInFlight.current.add(sessionId);
    void (async () => {
      try {
        const refs = (await window.electronAPI.deviceLink.invoke(
          deviceId,
          'git-context:pr-refs:list',
          [sessionId],
        )) as SessionPrRef[];
        remoteRefsFetchedAt.current.set(sessionId, Date.now());
        log.debug('remote pr refs fetched', { sessionId, count: refs.length });
        setRefsBySession((prev) => {
          const next = new Map(prev);
          if (refs.length > 0) next.set(sessionId, refs);
          else next.delete(sessionId);
          return next;
        });
        // 该会话仍有消费者在展示 → 引用到位后立即补状态,不等 90s 周期
        // (顶栏没有徽标挂载 effect,只读缓存,必须由这里主动触发)。
        if (refs.length > 0 && prConsumers.current.has(sessionId)) {
          fetchStatusesForRefs(sessionId, refs);
        }
      } catch (err) {
        // 断链/超时:不写时间戳,下个刷新周期(或行重挂载)立即重试。
        log.warn('remote pr refs fetch failed', String(err));
      } finally {
        remoteRefsInFlight.current.delete(sessionId);
      }
    })();
  }).current;

  const refreshConsumer = useRef((sessionId: string, deviceId?: string) => {
    // 远程行:引用可能还没拉到(或上次失败)——先补引用,再查状态。
    // fetchRefsForRemoteSession 成功后幂等,fetchStatusesForSession 无引用时早退。
    if (deviceId) fetchRefsForRemoteSession(sessionId, deviceId);
    fetchStatusesForSession(sessionId);
  }).current;

  const registerPrConsumer = useRef((sessionId: string, deviceId?: string) => {
    const map = prConsumers.current;
    const entry = map.get(sessionId);
    if (entry) {
      entry.count += 1;
      if (deviceId) entry.deviceId = deviceId;
    } else {
      map.set(sessionId, { deviceId, count: 1 });
    }
    refreshConsumer(sessionId, deviceId);
    return () => {
      const cur = map.get(sessionId);
      if (!cur) return;
      if (cur.count <= 1) map.delete(sessionId);
      else cur.count -= 1;
    };
  }).current;

  // 与聊天顶栏同一节拍的兜底刷新:周期 + 窗口聚焦。首查失败自愈;merged/closed
  // 等远端状态变化也随节拍收敛(main / 被控端各有 60s TTL,重复查询便宜)。
  useEffect(() => {
    const refreshAll = () => {
      // 失焦/隐藏时跳过周期刷新:没人在看,后台空转的查询(GitHub 配额 +
      // device-link 隧道)纯属浪费;下面的 focus 监听会在回到前台的瞬间全量补一次,
      // 数据不会停留在过期态(2026-08-13 用户裁决)。focus 事件触发的调用天然
      // 通过本判断(事件发生时已聚焦)。
      if (typeof document !== 'undefined' && (document.hidden || !document.hasFocus())) return;
      for (const [sessionId, entry] of prConsumers.current) {
        refreshConsumer(sessionId, entry.deviceId);
      }
    };
    const interval = setInterval(refreshAll, PR_STATUS_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshAll);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refreshAll);
    };
  }, [refreshConsumer]);

  const actionsValue = useMemo(() => ({ registerPrConsumer }), [registerPrConsumer]);

  const statusesValue = useMemo(
    () => ({ statuses, fetchStatusesForSession }),
    [statuses, fetchStatusesForSession],
  );

  return (
    <PrRefsMapContext.Provider value={refsBySession}>
      <PrActionsContext.Provider value={actionsValue}>
        <PrStatusesContext.Provider value={statusesValue}>{children}</PrStatusesContext.Provider>
      </PrActionsContext.Provider>
    </PrRefsMapContext.Provider>
  );
}

/** 某会话的 PR 引用(无则空数组,引用稳定避免重渲染)。状态更新不触发本 hook。 */
const EMPTY_REFS: SessionPrRef[] = [];
export function usePrRefsForSession(sessionId: string): SessionPrRef[] {
  const refsBySession = useContext(PrRefsMapContext);
  return refsBySession.get(sessionId) ?? EMPTY_REFS;
}

/** tooltip 内容消费:状态缓存 + 按需拉取。仅打开中的 tip 因状态更新而重渲染。 */
export function usePrStatuses(): PrStatusesContextValue {
  return useContext(PrStatusesContext);
}

/** 行级动作(value 恒定,订阅不会因 statuses 更新而重渲染)。 */
export function usePrActions(): PrActionsContextValue {
  return useContext(PrActionsContext);
}
