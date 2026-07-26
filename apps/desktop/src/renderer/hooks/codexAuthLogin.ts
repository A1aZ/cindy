/** Renderer 内共享的 Codex OAuth 登录结果。 */
export type CodexLoginResult = {
  authenticated: boolean;
  identity?: string;
  expiresAt?: number;
  errorReason?: string;
  authSource?: 'oauth' | 'api-key';
};

type PendingCodexLogin = {
  mode: 'browser' | 'device-code';
  promise: Promise<CodexLoginResult>;
};

let pendingCodexLogin: PendingCodexLogin | null = null;

function invokeCodexLogin(mode: 'browser' | 'device-code'): Promise<CodexLoginResult> {
  return mode === 'device-code'
    ? window.electronAPI.maker.auth.triggerLogin('codex', { mode })
    : window.electronAPI.maker.auth.triggerLogin('codex');
}

/**
 * 合并 renderer 内所有 ChatGPT 连接入口的并发请求。
 *
 * main adapter 也会复用正在运行的 CLI 登录，但在 renderer 先合并可以避免设置页、
 * 会话横幅等入口重复发 IPC，并避免同一结果重复执行 main handler 的刷新与广播收尾。
 */
export function triggerCodexLoginOnce(
  mode: 'browser' | 'device-code' = 'browser',
): Promise<CodexLoginResult> {
  if (pendingCodexLogin) {
    if (pendingCodexLogin.mode === mode) return pendingCodexLogin.promise;

    const previous = pendingCodexLogin.promise;
    void window.electronAPI.maker.auth.cancelLogin('codex').catch(() => undefined);
    let queued!: Promise<CodexLoginResult>;
    queued = previous
      .catch(() => undefined)
      .then(() => invokeCodexLogin(mode))
      .finally(() => {
        if (pendingCodexLogin?.promise === queued) pendingCodexLogin = null;
      });
    pendingCodexLogin = { mode, promise: queued };
    return queued;
  }

  let run!: Promise<CodexLoginResult>;
  run = invokeCodexLogin(mode).finally(() => {
    if (pendingCodexLogin?.promise === run) pendingCodexLogin = null;
  });
  pendingCodexLogin = { mode, promise: run };
  return run;
}
