// 阻断屏的"回前台重新核对" —— 纯逻辑(依赖可注入,便于单测)。
//
// 为什么需要:进入强更阻断态后业务树整体不挂载,useResumeUpdateCheck 随之卸载,
// 于是本进程再也不会拉 /latest。服务端撤回误下发的 minVersion 后,用户只能杀进程
// 冷启动才能恢复 —— 普通用户不会想到这一步。所以阻断屏自己补一次检查。
//
// 方向不对称,这是刻意的:
// - **进入**阻断态要求成功拉到 /latest 且判定强更(拉不到就 fail-open 放行,更新服务
//   故障不该锁死用户);
// - **解除**阻断态同样要求成功拉到 /latest 且判定不再强更 —— 拉取失败一律维持阻断,
//   否则断网(飞行模式)就能绕过强更。
//
// 节流比 resume 通道(5 分钟)短得多:用户此刻正被挡在门外,恢复延迟直接可感;
// 但仍要节流,避免在阻断屏上反复切前后台把 /latest 打成高频请求。

import { evaluateBundleUpdate, parseLatestRelease } from './bundleUpdate';
import { withTimeout } from './startupOtaUpdate';

export type ForcedUpdateRecheckOutcome = 'still-forced' | 'cleared' | 'error';

export interface ForcedUpdateRecheckDeps {
  /** 拉 /latest(平台与 channel 已由调用方绑定);返回原始 JSON。 */
  fetchLatest: () => Promise<unknown>;
  getCurrentRuntimeVersion: () => string | null | undefined;
  getCurrentVersion: () => string | null | undefined;
  /** 判定不再强更时调用(实参为 clearForcedUpdate),之后业务树重新挂载。 */
  onCleared: () => void;
  now: () => number;
  /** 阻断屏卸载后使迟到结果失效。 */
  isCurrent?: () => boolean;
}

export interface ForcedUpdateRecheckOptions {
  /** 两次核对的最小间隔(默认 30s)。 */
  minIntervalMs?: number;
  /** /latest 拉取超时(默认 10s,与 resume 通道同口径)。 */
  latestTimeoutMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_LATEST_TIMEOUT_MS = 10_000;

export interface ForcedUpdateRechecker {
  /**
   * AppState 'change' 入口。命中「从后台回到前台 + 间隔满足 + 无在途」才发起;
   * 未触发时返回 null(便于测试断言),触发时返回本次核对的 Promise(永不 reject)。
   */
  handleAppStateChange: (next: string) => Promise<ForcedUpdateRecheckOutcome> | null;
}

/** 创建阻断屏核对器(持有节流/在途状态;阻断屏挂载期间一个实例)。 */
export function createForcedUpdateRechecker(
  deps: ForcedUpdateRecheckDeps,
  {
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    latestTimeoutMs = DEFAULT_LATEST_TIMEOUT_MS,
  }: ForcedUpdateRecheckOptions = {},
): ForcedUpdateRechecker {
  // 与 resume 通道不同:阻断屏刚挂载时那次检查刚跑完,所以创建时刻同样视为"刚查过"。
  let lastRunAt = deps.now();
  let wasBackground = false;
  let inFlight = false;

  async function run(): Promise<ForcedUpdateRecheckOutcome> {
    inFlight = true;
    try {
      const latest = await withTimeout(deps.fetchLatest(), latestTimeoutMs);
      if (deps.isCurrent && !deps.isCurrent()) return 'still-forced';
      // 解除必须建立在"真的比出来了不再低于门槛"之上。record 解析不出(指针损坏 /
      // 被中间层改坏)或拿不到本机 version 时,evaluateBundleUpdate 会 fail-open 报
      // 无更新 —— 那是**进入**方向的正确取向,拿到解除方向就成了漏洞:一条坏记录
      // 就能放行所有被强更的装机。这里显式挡掉,按拉取失败处理。
      const record = parseLatestRelease(latest);
      const currentVersion = String(deps.getCurrentVersion() ?? '').trim();
      if (!record || !currentVersion) return 'error';
      const evaluation = evaluateBundleUpdate({
        currentRuntimeVersion: deps.getCurrentRuntimeVersion(),
        currentVersion,
        latest,
      });
      // 仍然强更(门槛还在,或换了更高的目标)→ 维持阻断,不动 store:
      // 目标信息的刷新交给下次冷启动,阻断屏本身不需要热更文案。
      if (evaluation.forced) return 'still-forced';
      deps.onCleared();
      return 'cleared';
    } catch {
      return 'error'; // 拉不到就维持阻断(见文件头:解除方向 fail-closed)
    } finally {
      inFlight = false;
    }
  }

  return {
    handleAppStateChange(next: string): Promise<ForcedUpdateRecheckOutcome> | null {
      if (next === 'background') {
        wasBackground = true;
        return null;
      }
      if (next !== 'active' || !wasBackground) return null;
      wasBackground = false;
      if (inFlight || deps.now() - lastRunAt < minIntervalMs) return null;
      lastRunAt = deps.now();
      return run();
    },
  };
}
