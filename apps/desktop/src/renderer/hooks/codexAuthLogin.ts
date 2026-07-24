/** Renderer 内共享的 Codex OAuth 登录结果。 */
export type CodexLoginResult = {
  authenticated: boolean;
  identity?: string;
  expiresAt?: number;
  errorReason?: string;
  authSource?: 'oauth' | 'api-key';
};

let pendingCodexLogin: Promise<CodexLoginResult> | null = null;

/**
 * 合并 renderer 内所有 ChatGPT 连接入口的并发请求。
 *
 * main adapter 也会复用正在运行的 CLI 登录，但在 renderer 先合并可以避免设置页、
 * 会话横幅等入口重复发 IPC，并避免同一结果重复执行 main handler 的刷新与广播收尾。
 */
export function triggerCodexLoginOnce(): Promise<CodexLoginResult> {
  if (pendingCodexLogin) return pendingCodexLogin;

  const run = Promise.resolve()
    .then(() => window.electronAPI.maker.auth.triggerLogin('codex'))
    .finally(() => {
      if (pendingCodexLogin === run) pendingCodexLogin = null;
    });
  pendingCodexLogin = run;
  return run;
}
