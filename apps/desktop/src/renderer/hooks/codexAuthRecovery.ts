/**
 * 识别需要用户重新连接 ChatGPT 账号的 OpenAI OAuth 失效原因。
 *
 * 这些字符串来自 Codex app-server / CLI 或 Claude 的 ChatGPT bridge，不应直接展示
 * 给用户；renderer 统一把它们收口为“OpenAI 连接需要更新”的可恢复状态。
 */
export function isCodexOAuthReconnectRequired(reason: string | undefined): boolean {
  if (!reason) return false;
  return /app_session_terminated|token_invalidated|token_revoked|refresh_token_reused|Your session has ended|authentication token has been invalidated|authentication token has been revoked|refresh token was already used|refresh_token.*already used|bridge auth unavailable for chatgpt\//i.test(
    reason,
  );
}
