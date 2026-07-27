/**
 * hook-control/bindings.ts
 * ---------------------------------------------------------------------------
 * externalKey -> sessionId 映射存储(协议铁律「同 key 同 session」的落地)。
 *
 * 结构: { [connectionId]: { [externalKey]: { sessionId, workingDir, updatedAt } } }
 * —— 以 connectionId 为命名空间隔离, 两个 hook server 的同名 key 不会串台。
 * 持久化为 <userData>/hook-bindings.json(原子写), 跨 app 重启保持会话连续性。
 * 体量: 每 thread/issue 一条, 实际规模远小于消息量, JSON 文件足够;
 * 若未来需要清理策略再升级 localDb 表。
 *
 * workingDir 是**落绑定那一刻**会话工作目录的快照, 只用于让 dispatcher 区分
 * 两件本来看起来一样的事: 「用户在桌面端把会话移动到别的目录」(目录变了)
 * 与「用户改动了工作目录映射」(目录没变, 是白名单变了)。前者应跟随, 后者是
 * 撤权。老文件没有该字段 = null, 判定按保守侧(见 dispatcher.resolveTarget)。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 一条绑定的完整视图(get 只要 sessionId 时用 get, 需要目录快照时用 getEntry)。 */
export interface HookBindingEntry {
  sessionId: string;
  /** 落绑定时会话的工作目录; null = 老数据未记录快照。 */
  workingDir: string | null;
}

export interface HookBindingStore {
  get(connectionId: string, externalKey: string): string | null;
  /** 含工作目录快照的绑定视图; 不存在时 null。 */
  getEntry(connectionId: string, externalKey: string): HookBindingEntry | null;
  /** 整行覆盖写: 省略 workingDir 等于把快照清空, 调用方应显式传当前目录。 */
  set(
    connectionId: string,
    externalKey: string,
    sessionId: string,
    workingDir?: string | null,
  ): void;
  /** 删除单条绑定(session 失效重建前清理)。 */
  remove(connectionId: string, externalKey: string): void;
}

interface BindingRow {
  sessionId: string;
  /** 见文件头: 落绑定时的工作目录快照; 缺省 = 老数据。 */
  workingDir?: string | null;
  updatedAt: number;
}

type BindingFile = Record<string, Record<string, BindingRow>>;

export function createHookBindingStore(deps: {
  filePath: string;
  log: { warn(msg: string): void };
}): HookBindingStore {
  const { filePath, log } = deps;

  function readAll(): BindingFile {
    try {
      if (!fs.existsSync(filePath)) return {};
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw as BindingFile;
    } catch (err) {
      log.warn(`read hook-bindings failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  function writeAll(data: BindingFile): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }

  return {
    get(connectionId, externalKey) {
      const row = readAll()[connectionId]?.[externalKey];
      return typeof row?.sessionId === 'string' ? row.sessionId : null;
    },
    getEntry(connectionId, externalKey) {
      const row = readAll()[connectionId]?.[externalKey];
      if (typeof row?.sessionId !== 'string') return null;
      return {
        sessionId: row.sessionId,
        workingDir: typeof row.workingDir === 'string' ? row.workingDir : null,
      };
    },
    set(connectionId, externalKey, sessionId, workingDir) {
      const data = readAll();
      (data[connectionId] ??= {})[externalKey] = {
        sessionId,
        ...(typeof workingDir === 'string' && workingDir.length > 0 ? { workingDir } : {}),
        updatedAt: Date.now(),
      };
      writeAll(data);
    },
    remove(connectionId, externalKey) {
      const data = readAll();
      if (data[connectionId]?.[externalKey]) {
        delete data[connectionId][externalKey];
        writeAll(data);
      }
    },
  };
}
