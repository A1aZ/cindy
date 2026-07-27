/**
 * hook-control/bindings.ts
 * ---------------------------------------------------------------------------
 * externalKey -> sessionId 映射存储(协议铁律「同 key 同 session」的落地)。
 *
 * 结构:
 * { [connectionId]: { [externalKey]: { sessionId, workingDir, authority, … } } }
 * —— 以 connectionId 为命名空间隔离, 两个 hook server 的同名 key 不会串台。
 * 持久化为 <userData>/hook-bindings.json(原子写), 跨 app 重启保持会话连续性。
 * 体量: 每 thread/issue 一条, 实际规模远小于消息量, JSON 文件足够;
 * 若未来需要清理策略再升级 localDb 表。
 *
 * ## 为什么绑定要记「授权来源」
 *
 * 会话的工作目录必须落在该连接的工作目录映射内, IM 侧才驱动得动它 —— 这是
 * 「远端能碰哪些本地目录」的边界。唯一的例外是用户自己在桌面端把对话移到了
 * 映射外的项目: 那时应当跟随, 否则同一个 thread 每条消息都会重开新对话。
 *
 * 判断"是不是用户移的"**不能**靠比对 session 元数据 —— `sessions` 行的
 * workingDir 经通用 patch IPC 就能改(见 localDb/ipc/sessions.ts 的
 * `local-db:sessions:update`), 而 Renderer 按 electron-security 规则属不可信
 * 环境; 目录写法归一化之类的无关写入也会让"目录变了"成立。因此授权由**移动
 * 动作本身**在 Main 侧登记(`noteSessionMoved`), dispatcher 只认已登记的结论:
 *
 * - `authority: 'workspace'` —— 上次放行是因为目录在映射(或内置对话根)内;
 *   映射被改/删且目录没动时即失效(撤权语义不变)。
 * - `authority: 'local-move'` + `workingDir` —— 用户把对话移到了这个目录,
 *   此后目录只要没再变就继续复用; 移回映射内会复位成 'workspace'。
 * - `noticePending` —— 该次移动还没在渠道里说明过, dispatcher 说明一次后清掉。
 *
 * 老文件没有这些字段 = null/false, 判定按保守侧(见 dispatcher.resolveTarget)。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 上次放行这条绑定的依据:
 * - 'workspace': 目录当时落在工作目录映射(或内置对话根)内, 授权随映射走。
 * - 'local-move': 由 Main 侧登记的一次真实「移动对话」动作授权, 目录不在映射
 *   内也继续复用, 直到它再被移动(重新登记)或移回映射内。
 */
export type HookBindingAuthority = 'workspace' | 'local-move';

/** 一条绑定的完整视图(只要 sessionId 时用 get, 需要授权状态时用 getEntry)。 */
export interface HookBindingEntry {
  sessionId: string;
  /** 上次确认/登记时会话的工作目录; null = 老数据未记录。 */
  workingDir: string | null;
  /** 上次放行的依据; null = 老数据未记录。 */
  authority: HookBindingAuthority | null;
  /** 已登记的移动尚未在渠道里说明过。 */
  noticePending: boolean;
}

/** set 的可选元信息(整行覆盖写, 省略即清空对应字段)。 */
export interface HookBindingMeta {
  workingDir?: string | null;
  authority?: HookBindingAuthority | null;
  noticePending?: boolean;
}

export interface HookBindingStore {
  get(connectionId: string, externalKey: string): string | null;
  /** 含目录快照与授权状态的绑定视图; 不存在时 null。 */
  getEntry(connectionId: string, externalKey: string): HookBindingEntry | null;
  /** 整行覆盖写: meta 里省略的字段等于清空, 调用方应显式传当前状态。 */
  set(connectionId: string, externalKey: string, sessionId: string, meta?: HookBindingMeta): void;
  /**
   * 登记一次「用户在桌面端把这个会话移到了 workingDir」—— 由 Main 侧真实的
   * 移动写入调用(见 localDb/ipc/sessions.ts), 是 local-move 授权的唯一来源。
   * 跨全部 connection 命名空间反查该 sessionId; 返回更新的绑定条数。
   */
  noteSessionMoved(sessionId: string, workingDir: string): number;
  /** 删除单条绑定(session 失效重建前清理)。 */
  remove(connectionId: string, externalKey: string): void;
}

interface BindingRow {
  sessionId: string;
  /** 见文件头: 上次确认/登记时的工作目录; 缺省 = 老数据。 */
  workingDir?: string | null;
  /** 见文件头: 上次放行的依据; 缺省 = 老数据。 */
  authority?: HookBindingAuthority | null;
  /** 见文件头: 已登记的移动还没说明过。 */
  noticePending?: boolean;
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

  function toRow(sessionId: string, meta: HookBindingMeta | undefined): BindingRow {
    return {
      sessionId,
      ...(typeof meta?.workingDir === 'string' && meta.workingDir.length > 0
        ? { workingDir: meta.workingDir }
        : {}),
      ...(meta?.authority === 'workspace' || meta?.authority === 'local-move'
        ? { authority: meta.authority }
        : {}),
      ...(meta?.noticePending === true ? { noticePending: true } : {}),
      updatedAt: Date.now(),
    };
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
        // 未知字面量(手改文件 / 更早的实验值)按"没有授权记录"处理, fail closed
        authority:
          row.authority === 'workspace' || row.authority === 'local-move' ? row.authority : null,
        noticePending: row.noticePending === true,
      };
    },
    set(connectionId, externalKey, sessionId, meta) {
      const data = readAll();
      (data[connectionId] ??= {})[externalKey] = toRow(sessionId, meta);
      writeAll(data);
    },
    noteSessionMoved(sessionId, workingDir) {
      if (!sessionId || !workingDir) return 0;
      const data = readAll();
      let updated = 0;
      for (const rows of Object.values(data)) {
        for (const [externalKey, row] of Object.entries(rows)) {
          if (row?.sessionId !== sessionId) continue;
          rows[externalKey] = {
            sessionId,
            workingDir,
            authority: 'local-move',
            noticePending: true,
            updatedAt: Date.now(),
          };
          updated += 1;
        }
      }
      if (updated > 0) writeAll(data);
      return updated;
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
