/**
 * hook-control/bindings.ts
 * ---------------------------------------------------------------------------
 * externalKey -> sessionId 映射存储(协议铁律「同 key 同 session」的落地)。
 *
 * 结构: { [connectionId]: { [externalKey]: { sessionId, updatedAt } } } ——
 * 以 connectionId 为命名空间隔离, 两个 hook server 的同名 key 不会串台。
 * 持久化为 <userData>/hook-bindings.json(原子写), 跨 app 重启保持会话连续性。
 * 体量: 每 thread/issue 一条, 实际规模远小于消息量, JSON 文件足够;
 * 若未来需要清理策略再升级 localDb 表。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface HookBindingStore {
  get(connectionId: string, externalKey: string): string | null;
  set(connectionId: string, externalKey: string, sessionId: string): void;
  /** 删除单条绑定(session 失效重建前清理)。 */
  remove(connectionId: string, externalKey: string): void;
}

interface BindingRow {
  sessionId: string;
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
    set(connectionId, externalKey, sessionId) {
      const data = readAll();
      (data[connectionId] ??= {})[externalKey] = { sessionId, updatedAt: Date.now() };
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
