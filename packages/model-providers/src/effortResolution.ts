/**
 * effortResolution —— 「选中模型 / 切换来源后应落到哪一档 effort」的纯逻辑(跨端共享)。
 *
 * 从 apps/desktop renderer 的 sourceSwitch.ts 原样下沉:桌面 ModelSelector / ChatInput 与
 * 手机版模型选择列表都要用同一套落档优先级,避免两端各写一套后口径发散(手机对齐桌面的
 * 「逻辑完全相同」承诺依赖这里的单一实现)。语义与函数签名保持与桌面历史版本逐字一致。
 *
 * 类型注:参数用 `string` 而非本包的 `Effort` 字面量联合 —— 桌面 renderer 的 Effort 就是
 * `string` 别名(userPreferences.types),catalog 侧才是严格联合;两端都要直接消费本函数,
 * 取二者的公共形状。运行时语义只依赖「候选值 ∈ efforts」的成员判断,与联合收窄无关。
 */

type Effort = string;

/**
 * 解析「选中某模型后应落到哪一档 effort」—— 纯函数,集中 effort 优先级策略。
 *
 * 优先级(高 → 低),每一档都要求候选值仍在 `efforts` 列表里(不同模型 effort 档不同,旧值可能非法):
 *   0. 模型无 effort 档(efforts 为空)→ 'low'(占位,UI 不显示 effort segmented)。
 *   1. preferred:切来源时由 resolveSourceSwitch 带回的落点 hint(目标来源 lastModel 的 effort)。
 *   2. providerEffort:调用方提供的模型预设(桌面端现为 (agent, model) 全局预设;参数名为兼容保留)。
 *   3. rememberedEffort:per-model 记忆(provider 无关,跨来源兜底;手机端无此存储,恒不传)。
 *   4. activeEffort:当前 effort 仍被目标模型支持 → 沿用(切模型时少打扰用户)。
 *   5. 模型默认 defaultEffort(仍需 ∈ efforts;非法/缺失时落 efforts 首档)。
 *
 * 注:之所以用代码而非 prompt 固化这套优先级(规则 9),是为了让「选回来恢复上次选择」可预测、
 * 可单测。本函数只负责「在给定 efforts 下挑哪一档」,模型 efforts 由调用方按 catalog 提供。
 */
export function resolveEffort(args: {
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  activeEffort: Effort;
  preferred?: Effort;
  providerEffort?: Effort;
  rememberedEffort?: Effort;
}): Effort {
  const { efforts, defaultEffort, activeEffort, preferred, providerEffort, rememberedEffort } = args;
  if (efforts.length === 0) return 'low';
  const ok = (e: Effort | undefined): e is Effort => !!e && efforts.includes(e);
  if (ok(preferred)) return preferred;
  if (ok(providerEffort)) return providerEffort;
  if (ok(rememberedEffort)) return rememberedEffort;
  if (efforts.includes(activeEffort)) return activeEffort;
  // defaultEffort 同样要求 ∈ efforts(catalog 病态数据防御):非法/缺失时落 efforts 首档,
  // efforts.length === 0 已在上方 early return,这里 efforts[0] 必然存在。
  if (ok(defaultEffort ?? undefined)) return defaultEffort as Effort;
  return efforts[0];
}

/**
 * 「同模型只切来源」时落档。与 resolveEffort 的关键区别是没有 activeEffort 沿用档:
 * 有显式模型预设就按目标来源支持范围恢复;没有预设则回落模型默认,避免把当前会话 live 值
 * 意外写成全局默认。
 *
 * 优先级(高 → 低,每档都要求仍在 efforts 内):
 *   1. preferred:来源切换 hint(resolveSourceSwitch 带回的目标来源记忆档);当前 picker 行点击
 *      不传,保留以兼容未来带 hint 的调用方。
 *   2. providerEffort:调用方提供的模型预设(桌面端跨来源共享,再由 efforts 校验是否合法)。
 *   3. 模型默认 defaultEffort。
 *   4. efforts 首档。
 *   5. fallbackEffort:efforts 为空等极端兜底(通常 = 当前 activeEffort,该模型无 effort 档、UI 不显示)。
 */
export function resolveProviderSwitchEffort(args: {
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  providerEffort?: Effort;
  preferred?: Effort;
  fallbackEffort: Effort;
}): Effort {
  const { efforts, defaultEffort, providerEffort, preferred, fallbackEffort } = args;
  if (efforts.length === 0) return fallbackEffort;
  const ok = (e: Effort | undefined): e is Effort => !!e && efforts.includes(e);
  if (ok(preferred)) return preferred;
  if (ok(providerEffort)) return providerEffort;
  if (ok(defaultEffort ?? undefined)) return defaultEffort as Effort;
  return efforts[0];
}

/** effort 强弱序(低 → 高);未知档排在最高之上(保守不上调)。 */
const EFFORT_ORDER: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function effortRank(e: Effort): number {
  const i = EFFORT_ORDER.indexOf(e);
  return i === -1 ? EFFORT_ORDER.length : i;
}

/**
 * 把请求的 effort clamp 到某模型「实际声明支持」的档位 —— 供**未门控入口**(定时任务
 * fire、跨 agent worker 创建等)在发到运行时前做安全 reconcile,避免把模型不支持的档
 * (如 gpt-5.5 + max/ultra)透给上游被拒(issue #456)。
 *
 * 口径与交互式 UI 一致:**模型已声明支持的档原样保留**(不降级 —— 保 issue #352「不静默
 * 降级用户在支持模型上的显式选择」);只有不受支持时才 clamp 到最高兼容档。
 *
 * 规则:
 *   - `effort` 为空(null/undefined/空串)→ 原样返回(调用方语义:留空 = 不改)。
 *   - `efforts` 空/缺失 → 原样返回(模型未声明 effort 门控,不动它,no-break)。
 *   - `effort ∈ efforts` → 原样(支持则不动)。
 *   - 否则 clamp 到「rank ≤ 请求档 的最高受支持档」。
 *   - 请求档低于全部受支持档 → 最低受支持档(floor;绝不上调,见下方注释)。
 */
export function clampEffortToSupported(
  effort: Effort | null | undefined,
  efforts: readonly Effort[] | undefined,
): Effort | null | undefined {
  // falsy(null / undefined / 空串)一律透传:空串不在 EFFORT_ORDER 内,若不在此拦下会被
  // 当成"未知档"(rank 最高)clamp 到模型最高受支持档 —— 与"留空 = 不改"的语义相反(#456 review)。
  if (!effort) return effort;
  if (!efforts || efforts.length === 0) return effort;
  if (efforts.includes(effort)) return effort;

  const wantRank = effortRank(effort);
  // 受支持档里挑「rank ≤ 请求档」的最高档(clamp down 到最高兼容档)。
  let best: Effort | undefined;
  let bestRank = -1;
  for (const e of efforts) {
    const r = effortRank(e);
    if (r <= wantRank && r > bestRank) {
      best = e;
      bestRank = r;
    }
  }
  if (best !== undefined) return best;

  // 请求档低于全部受支持档(如 minimal 落在只支持 low+ 的模型)→ clamp 到最低受支持档(floor)。
  // 绝不上调到模型默认:请求档比 floor 还低时上调 = 违背用户"尽量便宜"的意图,且会把存量
  // 定时任务里存的 minimal 静默升成 default(通常 high)—— codex 旧行为是 minimal→low,
  // reconcile 不该反而把它升级(#456 review)。
  let lowest: Effort = efforts[0];
  for (const e of efforts) {
    if (effortRank(e) < effortRank(lowest)) lowest = e;
  }
  return lowest;
}
