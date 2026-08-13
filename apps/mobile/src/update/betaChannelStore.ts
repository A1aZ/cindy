/**
 * Mobile beta 测试渠道的**设备级**本地快照。
 *
 * 与 canaryChannelStore 的关键区别:
 *   - canary 是账号级、服务端下发(login 后 feature-flags → 本地持久化 → 登出清);
 *   - beta 是设备级、客户端本地设置(设置页开关),登出/换号都不清。
 *
 * 所以这里没有 clearBetaChannel(登出清理):开关只随设备走,不随账号生命周期。
 * 其余机制(AsyncStorage 快照 + hydrate 门 + mutation 队列)与 canaryChannelStore 一致,
 * 保证「冷启动任何更新请求前先恢复本地快照」、损坏 fail-safe 到 stable。
 *
 * 标记不敏感(只选择公开 CDN 指针),AsyncStorage 即可。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'cindy.mobile.update.beta';

let beta = false;
let hydrated = false;
let hydratePromise: Promise<boolean> | null = null;
let mutationEpoch = 0;
let mutationQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // ignore listener failures
    }
  }
}

function enqueueMutation(operation: () => Promise<void>): Promise<void> {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.catch(() => undefined);
  return run;
}

/** 冷启动时调用一次；损坏/不可读一律 fail-safe 到 false(不启用 beta)。 */
export function hydrateBetaChannel(): Promise<boolean> {
  if (hydrated) return Promise.resolve(beta);
  if (hydratePromise) return hydratePromise;
  const epoch = mutationEpoch;
  hydratePromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (epoch === mutationEpoch) {
        const next = raw === 'true';
        if (beta !== next || !hydrated) {
          beta = next;
          notifyListeners();
        }
      }
      hydrated = true;
      return beta;
    })
    .catch(() => {
      if (epoch === mutationEpoch) {
        if (beta || !hydrated) {
          beta = false;
          notifyListeners();
        }
      }
      hydrated = true;
      return beta;
    })
    .finally(() => {
      hydratePromise = null;
    });
  return hydratePromise;
}

/** 启动 gate 完成后可同步读取。未 hydrate 时按 false(不启用 beta)。 */
export function isBetaChannel(): boolean {
  return hydrated && beta;
}

/** 订阅开关变化；返回取消订阅函数。 */
export function subscribeBetaChannel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 设置页开关写入；同步内存态 + 串行落盘。 */
export function syncBetaChannel(next: boolean): Promise<void> {
  const value = next === true;
  mutationEpoch += 1;
  hydrated = true;
  beta = value;
  notifyListeners();
  return enqueueMutation(() => (
    value
      ? AsyncStorage.setItem(STORAGE_KEY, 'true')
      : AsyncStorage.removeItem(STORAGE_KEY)
  ));
}

export const __testing = {
  storageKey: STORAGE_KEY,
  async resetMemory(): Promise<void> {
    await mutationQueue.catch(() => undefined);
    beta = false;
    hydrated = false;
    hydratePromise = null;
    mutationEpoch = 0;
    mutationQueue = Promise.resolve();
    listeners.clear();
  },
};
