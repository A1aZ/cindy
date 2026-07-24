/**
 * codex-model-backfill —— 启动时为「已登录但无模型」的存量 Codex 用户主动补拉一次 live 模型。
 *
 * 背景:`ba831a9e` 让 Codex **OAuth 新登录动作**在收口时主动调 `model/list`(不跑 session)
 * 发现模型。但它只覆盖「登录那一下」——存量已登录用户(app 启动即是登录态、从不重新登录)
 * 不触发该收口,只能靠启动时读 `~/.codex/models_cache.json`;而 codex CLI 只在跑过会话后才写
 * 该 cache,于是「已登录 + 从没跑过 codex 会话」的用户 discoveredCodex 恒空,OpenAI 供应商
 * 无任何模型,直到手动跑一次会话。
 *
 * 本模块补上这个缺口:maker 首次就绪时,若 Codex 已登录且当前无 codex 模型,fire-and-forget
 * 触发一次和登录收口同源的 live 拉取(`maker.refreshAgentLocalModels('codex')`),成功即广播
 * PROVIDER_CHANGED 让设置页刷新。纯函数 + 注入 deps,不碰 maker-core 热路径(启动一次性)。
 */

export interface CodexBackfillDeps {
  /** Codex 是否已 OAuth 登录(未登录不拉——没凭证 app-server 也起不来)。 */
  hasCodexLogin(): Promise<boolean>;
  /** 当前 catalog 是否已有 codex 模型(非空则无需补拉,避免重复 spawn app-server)。 */
  hasCodexModels(): boolean;
  /** live 拉取(生产 = maker.refreshAgentLocalModels('codex')),返回是否成功注入。 */
  refreshLive(): Promise<boolean>;
  /** 成功注入后回调(生产 = 广播 PROVIDER_CHANGED 让 renderer refetch)。 */
  onApplied(): void;
  log: { info(msg: string): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

export type CodexBackfillOutcome =
  | 'skipped-unauthed'
  | 'skipped-has-models'
  | 'applied'
  | 'not-applied'
  | 'error';

/**
 * 补拉决策:未登录 / 已有模型直接跳过;否则 live 拉取,applied 则广播。任何异常吞掉记日志
 * (启动增强,绝不能因它抛错影响 maker 就绪 / 启动)。
 */
export async function maybeBackfillCodexModels(deps: CodexBackfillDeps): Promise<CodexBackfillOutcome> {
  try {
    if (!(await deps.hasCodexLogin())) return 'skipped-unauthed';
    // 已有模型(启动读磁盘 cache 命中,或其它路径已注入)→ 不重复起 app-server。
    if (deps.hasCodexModels()) return 'skipped-has-models';
    const applied = await deps.refreshLive();
    if (applied) {
      deps.onApplied();
      deps.log.info('startup codex model backfill: live model/list applied');
      return 'applied';
    }
    // live 未 applied(app-server 起不来 / RPC 无结果):不广播,等用户跑一次会话或手动重试。
    deps.log.warn('startup codex model backfill: live model/list not applied');
    return 'not-applied';
  } catch (e) {
    deps.log.warn('startup codex model backfill threw', {
      error: e instanceof Error ? e.message : String(e),
    });
    return 'error';
  }
}
