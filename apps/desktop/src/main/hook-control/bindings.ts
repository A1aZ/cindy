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
 * - `previousWorkingDir` —— 移动登记时会话**还在**的那个目录。移动是"先登记、
 *   再写库"两步, 其间到达的消息看到的 session 仍是旧目录; 靠这个字段识别出
 *   "登记已落、库还没落"的中间态, 照常在旧目录跑而不误判成撤权。落库后的第一次
 *   收敛就清掉它。
 * - `noticePending` —— 该次移动还没在渠道里说明过, dispatcher 说明一次后清掉。
 * - `rev` —— 单调递增的行版本, 供 set 的 expectedRev 做乐观并发控制。用计数而
 *   不是时间戳: 毫秒精度下同一毫秒的两次写会撞版本, CAS 就形同虚设。
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
  /** 见文件头: 移动登记时会话还在的目录; null = 没有在途的移动。 */
  previousWorkingDir: string | null;
  /** 上次放行的依据; null = 老数据未记录。 */
  authority: HookBindingAuthority | null;
  /** 已登记的移动尚未在渠道里说明过。 */
  noticePending: boolean;
  /** 单调递增的行版本; set 的 expectedRev 用它做乐观并发控制。 */
  rev: number;
}

/** set 的可选元信息(整行覆盖写, 省略即清空对应字段)。 */
export interface HookBindingMeta {
  workingDir?: string | null;
  previousWorkingDir?: string | null;
  authority?: HookBindingAuthority | null;
  noticePending?: boolean;
  /**
   * 乐观并发控制: 只有当前行存在且 rev 仍等于该值时才写。dispatcher 的回填用它
   * 避免抹掉「读取之后、回填之前」落下的移动登记(PR #669 review 指出的反向
   * 竞态)。行在此期间被删掉时同样拒绝写入 —— 那说明状态已经不是读到的那份。
   * 省略 = 无条件覆盖。
   */
  expectedRev?: number;
}

/**
 * 一次移动登记的结果。rollback 把被覆盖的行原样写回 —— 移动写库失败时必须回滚,
 * 否则 previousWorkingDir 会永久残留成一张"在途通行证"(PR #669 review 指出)。
 */
export interface HookMoveRegistration {
  /** 实际改写的绑定条数(0 = 该会话没有 IM 绑定)。 */
  updated: number;
  rollback(): void;
}

export interface HookBindingStore {
  get(connectionId: string, externalKey: string): string | null;
  /** 含目录快照与授权状态的绑定视图; 不存在时 null。 */
  getEntry(connectionId: string, externalKey: string): HookBindingEntry | null;
  /**
   * 整行覆盖写: meta 里省略的字段等于清空, 调用方应显式传当前状态。
   * 返回是否真的写入(带 expectedRev 且行版本已变/行已被删时返回 false)。
   */
  set(
    connectionId: string,
    externalKey: string,
    sessionId: string,
    meta?: HookBindingMeta,
  ): boolean;
  /**
   * 登记一次「用户在桌面端把这个会话从 move.from 移到了 move.to」—— 由窄口径的
   * `local-db:sessions:move` 经 sessionMoves.ts 调用, 是 local-move 授权的唯一
   * 来源。authority 由调用方按当前工作目录映射判定(移进映射内的目录记
   * 'workspace', 不留例外); move.from 落进 previousWorkingDir, 让 dispatcher
   * 认得出"登记已落、库还没落"的中间态。跨全部命名空间反查; 返回更新条数。
   */
  noteSessionMoved(
    sessionId: string,
    move: { from: string | null; to: string },
    authority: HookBindingAuthority,
  ): HookMoveRegistration;
  /**
   * 移动写库成功后收尾: 清掉 previousWorkingDir(在途标记), 让它严格只存在于
   * 「登记已落、库还没落」那一小段。不清的话这个标记会一直有效, 之后有人把
   * 会话目录改回旧值就能靠它绕过撤权(PR #669 review 指出)。
   * 只对仍指向本次目标目录的绑定生效; 返回更新条数。
   */
  completeSessionMove(sessionId: string, workingDir: string): number;
  /** 删除单条绑定(session 失效重建前清理)。 */
  remove(connectionId: string, externalKey: string): void;
}

interface BindingRow {
  sessionId: string;
  /** 见文件头: 上次确认/登记时的工作目录; 缺省 = 老数据。 */
  workingDir?: string | null;
  /** 见文件头: 移动登记时会话还在的目录; 缺省 = 没有在途移动。 */
  previousWorkingDir?: string | null;
  /** 见文件头: 上次放行的依据; 缺省 = 老数据。 */
  authority?: HookBindingAuthority | null;
  /** 见文件头: 已登记的移动还没说明过。 */
  noticePending?: boolean;
  /** 见文件头: 单调递增的行版本(缺省 = 老数据, 按 0 起算)。 */
  rev?: number;
  updatedAt: number;
}

type BindingFile = Record<string, Record<string, BindingRow>>;

export function createHookBindingStore(deps: {
  filePath: string;
  log: { warn(msg: string): void };
}): HookBindingStore {
  const { filePath, log } = deps;

  /**
   * 严格读取: 文件不存在 = 真的没有绑定(返回空表), 读不动 / 解析不了则**抛出**。
   * 读侧的常规调用容忍失败(见 readAll), 但移动登记必须把失败当失败 —— 把一次
   * 读故障当成"空表"会让登记静默变成 no-op, 移动照常提交, 等文件恢复可读后
   * 下一条 IM 消息就把绑定当撤权删掉(PR #669 review 指出)。
   */
  function readAllStrict(): BindingFile {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('hook-bindings.json is not an object');
    }
    return raw as BindingFile;
  }

  function readAll(): BindingFile {
    try {
      return readAllStrict();
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

  function toRow(
    sessionId: string,
    meta: HookBindingMeta | undefined,
    previousRev: number,
  ): BindingRow {
    return {
      sessionId,
      ...(typeof meta?.workingDir === 'string' && meta.workingDir.length > 0
        ? { workingDir: meta.workingDir }
        : {}),
      ...(typeof meta?.previousWorkingDir === 'string' && meta.previousWorkingDir.length > 0
        ? { previousWorkingDir: meta.previousWorkingDir }
        : {}),
      ...(meta?.authority === 'workspace' || meta?.authority === 'local-move'
        ? { authority: meta.authority }
        : {}),
      ...(meta?.noticePending === true ? { noticePending: true } : {}),
      rev: previousRev + 1,
      updatedAt: Date.now(),
    };
  }

  function revOf(row: BindingRow | undefined): number {
    return typeof row?.rev === 'number' ? row.rev : 0;
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
        previousWorkingDir:
          typeof row.previousWorkingDir === 'string' ? row.previousWorkingDir : null,
        // 未知字面量(手改文件 / 更早的实验值)按"没有授权记录"处理, fail closed
        authority:
          row.authority === 'workspace' || row.authority === 'local-move' ? row.authority : null,
        noticePending: row.noticePending === true,
        rev: revOf(row),
      };
    },
    set(connectionId, externalKey, sessionId, meta) {
      const data = readAll();
      const current = data[connectionId]?.[externalKey];
      if (meta?.expectedRev !== undefined) {
        // 期间被别人写过(典型: 一次移动登记)或整行被删 —— 放弃本次覆盖
        if (current === undefined || revOf(current) !== meta.expectedRev) return false;
      }
      (data[connectionId] ??= {})[externalKey] = toRow(sessionId, meta, revOf(current));
      writeAll(data);
      return true;
    },
    noteSessionMoved(sessionId, move, authority) {
      const noop: HookMoveRegistration = { updated: 0, rollback: () => {} };
      if (!sessionId || !move.to) return noop;
      // 严格读: 读故障不能被当成"没有绑定"(见 readAllStrict)
      const data = readAllStrict();
      const before: Array<{ namespace: string; externalKey: string; row: BindingRow }> = [];
      let updated = 0;
      for (const [namespace, rows] of Object.entries(data)) {
        for (const [externalKey, row] of Object.entries(rows)) {
          if (row?.sessionId !== sessionId) continue;
          before.push({ namespace, externalKey, row: { ...row } });
          rows[externalKey] = {
            sessionId,
            workingDir: move.to,
            // 记下移动前的目录: 登记与写库之间到达的消息看到的还是它
            ...(move.from ? { previousWorkingDir: move.from } : {}),
            authority,
            // 只有映射外的跟随才需要在渠道里解释一句
            ...(authority === 'local-move' ? { noticePending: true } : {}),
            rev: revOf(row) + 1,
            updatedAt: Date.now(),
          };
          updated += 1;
        }
      }
      if (updated === 0) return noop;
      writeAll(data);
      return {
        updated,
        rollback: () => {
          const current = readAll();
          for (const { namespace, externalKey, row } of before) {
            const live = current[namespace]?.[externalKey];
            // 回滚期间又被别人写过(新的移动登记)就别覆盖它
            if (!live || live.sessionId !== sessionId) continue;
            (current[namespace] ??= {})[externalKey] = { ...row, rev: revOf(live) + 1 };
          }
          writeAll(current);
        },
      };
    },
    completeSessionMove(sessionId, workingDir) {
      if (!sessionId || !workingDir) return 0;
      const data = readAll();
      let updated = 0;
      for (const rows of Object.values(data)) {
        for (const [externalKey, row] of Object.entries(rows)) {
          if (row?.sessionId !== sessionId) continue;
          if (row.workingDir !== workingDir) continue;
          if (row.previousWorkingDir == null) continue;
          const { previousWorkingDir: _dropped, ...rest } = row;
          rows[externalKey] = { ...rest, rev: revOf(row) + 1, updatedAt: Date.now() };
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
