/**
 * 账号用量受限识别 —— 纯函数,零依赖,可独立单测。
 *
 * 被动检测:goal turn 以 error 收尾时,判断该错误是不是"账号/套餐限流"(rate limit /
 * quota),从而把状态置 `usageLimited`(可恢复、到点自动续)而非 `blocked`(真出错)。
 *
 * 两个 agent 的错误形状不同(见 maker-core translator):
 *  - Claude Code:error 事件带结构化 `data.sdkError`,限流时 = `'rate_limit'`。
 *    注意 `billing_error`(余额耗尽、无周期重置)**不算** usage limit —— 那是"去充值",
 *    保持 blocked 更合适。
 *  - Codex:error 事件只有 `data.message` 文本,限流靠文本匹配(无结构化 tag)。
 */

/** turn error 的 data 是否表示"账号用量/限流"。 */
export function classifyTurnUsageLimit(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as {
    sdkError?: unknown;
    message?: unknown;
    errorStatus?: unknown;
    usageLimit?: unknown;
  };
  // Claude:结构化 tag(权威)。
  if (d.sdkError === 'rate_limit') return true;
  if (d.usageLimit === true) return true;
  if (d.errorStatus === 429 || d.errorStatus === 529) return true;
  // Codex / 兜底:文本匹配。
  const msg = typeof d.message === 'string' ? d.message : '';
  return /rate.?limit|usage.?limit|quota|too\s*many\s*requests/i.test(msg);
}
