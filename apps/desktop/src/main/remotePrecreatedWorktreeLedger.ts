/**
 * 远程预创建 worktree 恢复账本的 Main 进程单一真相。
 *
 * 所有 Renderer 通过 IPC 做单条 register/forget，Main 事件循环内同步完成
 * electron-store 的读改写，避免多个窗口各自用 localStorage 整表覆盖而丢 reservation。
 */
import { ipcMain } from 'electron';
import Store from 'electron-store';

import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import {
  REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS,
  coercePendingRemotePrecreatedWorktree,
  coercePendingRemotePrecreatedWorktreeTarget,
  normalizePendingRemotePrecreatedWorktrees,
  remotePrecreatedWorktreeRecordKey,
  type PendingRemotePrecreatedWorktree,
  type PendingRemotePrecreatedWorktreeTarget,
  type RemotePrecreatedWorktreeLedgerSnapshot,
} from '../shared/remotePrecreatedWorktreeLedger.js';

interface RemotePrecreatedWorktreeLedgerShape {
  records: PendingRemotePrecreatedWorktree[];
}

interface LedgerStoreLike {
  get(
    key: 'records',
    defaultValue: PendingRemotePrecreatedWorktree[],
  ): unknown;
  set(key: 'records', value: PendingRemotePrecreatedWorktree[]): void;
}

let storeInstance: LedgerStoreLike | null = null;
const memoryRecords = new Map<string, PendingRemotePrecreatedWorktree>();

function getStore(): LedgerStoreLike {
  if (!storeInstance) {
    storeInstance = new Store<RemotePrecreatedWorktreeLedgerShape>({
      name: 'remote-precreated-worktree-ledger',
      defaults: { records: [] },
      schema: {
        records: {
          type: 'array',
          items: { type: 'object' },
        },
      },
    });
  }
  return storeInstance;
}

function replaceMemoryRecords(records: readonly PendingRemotePrecreatedWorktree[]): void {
  memoryRecords.clear();
  for (const record of records) {
    memoryRecords.set(remotePrecreatedWorktreeRecordKey(record), record);
  }
}

function readMergedRecords(): RemotePrecreatedWorktreeLedgerSnapshot {
  let persisted: PendingRemotePrecreatedWorktree[];
  try {
    persisted = normalizePendingRemotePrecreatedWorktrees(
      getStore().get('records', []),
    );
  } catch {
    return {
      records: normalizePendingRemotePrecreatedWorktrees([...memoryRecords.values()]),
      storageReadable: false,
    };
  }
  const records = normalizePendingRemotePrecreatedWorktrees([
    ...memoryRecords.values(),
    ...persisted,
  ]);
  replaceMemoryRecords(records);
  return { records, storageReadable: true };
}

function writeRecords(records: readonly PendingRemotePrecreatedWorktree[]): boolean {
  try {
    getStore().set(
      'records',
      normalizePendingRemotePrecreatedWorktrees(records),
    );
    return true;
  } catch {
    return false;
  }
}

export function listRemotePrecreatedWorktreeLedger(): RemotePrecreatedWorktreeLedgerSnapshot {
  const snapshot = readMergedRecords();
  if (snapshot.storageReadable) {
    // 顺手清理过期/损坏条目。写失败不把一次成功读取伪装成不可读；后续 register
    // 会明确返回 persisted=false，阻止新的远端副作用。
    writeRecords(snapshot.records);
  }
  return snapshot;
}

export function registerRemotePrecreatedWorktreeLedgerRecord(
  value: unknown,
): boolean {
  const record = coercePendingRemotePrecreatedWorktree(value);
  if (!record) return false;
  const current = readMergedRecords();
  const next = normalizePendingRemotePrecreatedWorktrees([
    record,
    ...current.records.filter(
      (item) =>
        remotePrecreatedWorktreeRecordKey(item)
        !== remotePrecreatedWorktreeRecordKey(record),
    ),
  ]);
  // 即使磁盘暂时不可用，也在 Main 内存镜像中承担 obligation；返回 false 只表示
  // 尚未取得跨进程恢复保证，调用方不得创建远端 worktree。
  replaceMemoryRecords(next);
  if (!current.storageReadable) return false;
  return writeRecords(next);
}

function targetMatches(
  item: PendingRemotePrecreatedWorktree,
  target: PendingRemotePrecreatedWorktreeTarget,
): boolean {
  if (
    item.deviceId !== target.deviceId
    || item.sessionId !== target.sessionId
  ) {
    return false;
  }
  const locatorMatches = target.recoveryKey !== undefined
    ? item.recoveryKey === target.recoveryKey
    : target.path !== undefined && item.path === target.path;
  if (!locatorMatches) return false;
  return target.createdAt === undefined || item.createdAt === target.createdAt;
}

export function forgetRemotePrecreatedWorktreeLedgerRecord(
  value: unknown,
): boolean {
  const target = coercePendingRemotePrecreatedWorktreeTarget(value);
  if (!target) return false;
  const current = readMergedRecords();
  if (!current.storageReadable) return false;
  const next = current.records.filter((item) => !targetMatches(item, target));
  if (!writeRecords(next)) {
    // 删除落盘失败时继续在内存保留，防止当前进程把未确认的持久账本当成已清。
    replaceMemoryRecords(current.records);
    return false;
  }
  replaceMemoryRecords(next);
  return true;
}

export function registerRemotePrecreatedWorktreeLedgerIpc(): void {
  ipcMain.handle(
    REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS.LIST,
    (event): RemotePrecreatedWorktreeLedgerSnapshot => {
      assertTrustedAppRendererEvent(event);
      return listRemotePrecreatedWorktreeLedger();
    },
  );
  ipcMain.handle(
    REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS.REGISTER,
    (event, rawRecord: unknown): { persisted: boolean } => {
      assertTrustedAppRendererEvent(event);
      if (!coercePendingRemotePrecreatedWorktree(rawRecord)) {
        throwIpcError('INVALID_PARAMS', 'invalid remote pre-created worktree record');
      }
      return {
        persisted: registerRemotePrecreatedWorktreeLedgerRecord(rawRecord),
      };
    },
  );
  ipcMain.handle(
    REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS.FORGET,
    (event, rawTarget: unknown): { persisted: boolean } => {
      assertTrustedAppRendererEvent(event);
      if (!coercePendingRemotePrecreatedWorktreeTarget(rawTarget)) {
        throwIpcError('INVALID_PARAMS', 'invalid remote pre-created worktree target');
      }
      return {
        persisted: forgetRemotePrecreatedWorktreeLedgerRecord(rawTarget),
      };
    },
  );
}

export const __testing = {
  setStore: (store: LedgerStoreLike | null): void => {
    storeInstance = store;
  },
  resetMemory: (): void => {
    memoryRecords.clear();
  },
};
