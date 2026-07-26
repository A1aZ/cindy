/**
 * maker:auth:* IPC 的纯 handler body。
 *
 * Electron adapter 只负责注入 registry 和 broadcast，这里维护参数校验、Maker 调用和
 * push payload 归一化。
 */

import type { AgentKind, AgentLoginMode, AuthState, Maker } from '@cindy/maker-core';

import { optionalEnum, requireEnum, requireObject, throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

const log = createLogger('maker-ipc:authHandlers');

/** main → renderer 的 push 广播能力。 */
export type MakerIpcBroadcast = (channel: string, payload: unknown) => void;

/** IPC 允许的 agent 种类；运行时枚举校验不能靠 TypeScript 强转替代。 */
const AGENT_KINDS = ['claude-code', 'codex'] as const satisfies readonly AgentKind[];
const AGENT_LOGIN_MODES = ['browser', 'device-code'] as const satisfies readonly AgentLoginMode[];
const MAX_LOGIN_PROGRESS_CHARS = 16_384;
const ANSI_SEQUENCE = new RegExp(
  `${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);

export interface CodexDeviceCodeProgress {
  verificationUrl: string;
  userCode: string;
}

/** Codex CLI 输出带 ANSI 色码；Renderer 只应收到可展示的纯文本。 */
function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE, '');
}

/**
 * 从 `codex login --device-auth` 的渐进输出提取验证页与一次性代码。
 * 输入可以是不完整的多 chunk 累积文本；两项没齐时返回 null。
 */
export function parseCodexDeviceCodeProgress(text: string): CodexDeviceCodeProgress | null {
  const clean = stripAnsi(text);
  const codeMatch = clean.match(/\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+\b/);
  if (!codeMatch) return null;
  for (const match of clean.matchAll(/https:\/\/[^\s]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol === 'https:' && url.hostname === 'auth.openai.com') {
        return { verificationUrl: url.toString(), userCode: codeMatch[0] };
      }
    } catch {
      // CLI prose may trail punctuation after a URL; keep scanning later candidates.
    }
  }
  return null;
}

export function registerMakerAuthHandlers(
  registry: IpcHandlerRegistry,
  maker: Maker,
  broadcast: MakerIpcBroadcast,
  /** 网关 API key 读取器(host 注入,同 renderer useApiKey 那把 key;handler 只暴露 presence)。 */
  readApiKey: () => string | null,
  /**
   * Codex(OpenAI)账号成功登录/登出后的额外回调(可选,可 async)；参数是边界后的登录态。
   * 生产注入收口(见 auth.ts):live `model/list` 已应用时保留该快照；否则重读
   * models_cache(缺失即清空旧账号清单)。handler 在 AUTH_STATE_CHANGED 广播**之前**
   * await 它 —— renderer 收到广播后 refetch 的必须已是最新目录。
   */
  onCodexAuthChange?: (
    authenticated: boolean,
    liveModelsApplied: boolean,
    isCurrent: () => boolean,
  ) => void | Promise<void>,
): void {
  const mutationGeneration = new Map<AgentKind, number>();
  const beginMutation = (kind: AgentKind): number => {
    const generation = (mutationGeneration.get(kind) ?? 0) + 1;
    mutationGeneration.set(kind, generation);
    return generation;
  };
  const isMutationCurrent = (kind: AgentKind, generation: number): boolean =>
    (mutationGeneration.get(kind) ?? 0) === generation;

  registry.handle(MAKER_INVOKE.AUTH_GET_STATE, async (_e, agentKind: unknown): Promise<AuthState> => {
    return maker.getAgentAuthState(requireAgentKind(agentKind));
  });

  // presence-only:只回「有没有配 key」,绝不回密钥本体。device-link 控制端(手机 / 远程桌面)
  // 用它决定折扣版(codex/)行是否置灰 —— key 与请求都在被控端,这里才是判定真相。
  registry.handle(MAKER_INVOKE.API_KEY_PRESENT, async (): Promise<{ present: boolean }> => {
    return { present: !!readApiKey() };
  });

  registry.handle(
    MAKER_INVOKE.AUTH_TRIGGER_LOGIN,
    async (_e, agentKind: unknown, rawOptions?: unknown): Promise<AuthState> => {
      const kind = requireAgentKind(agentKind);
      const mode = requireLoginMode(kind, rawOptions);
      const generation = beginMutation(kind);
      const isCurrent = (): boolean => isMutationCurrent(kind, generation);
      let progressText = '';
      let emittedDeviceCode = '';
      const result = await maker.triggerAgentLogin(kind, {
        mode,
        onProgress: (msg) => {
          if (!isCurrent()) return;
          broadcast(MAKER_PUSH.AUTH_LOGIN_PROGRESS, toLoginProgressPayload(kind, msg, mode));
          if (kind !== 'codex' || mode !== 'device-code') return;

          progressText = (progressText + '\n' + progressDetail(msg)).slice(
            -MAX_LOGIN_PROGRESS_CHARS,
          );
          const deviceCode = parseCodexDeviceCodeProgress(progressText);
          if (!deviceCode) return;
          const signature = `${deviceCode.verificationUrl}\n${deviceCode.userCode}`;
          if (signature === emittedDeviceCode) return;
          emittedDeviceCode = signature;
          broadcast(MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
            agentKind: kind,
            phase: 'device-code',
            mode,
            ...deviceCode,
          });
        },
      });
      if (!isCurrent()) return supersededAuthState();
      if (kind === 'codex' && result.authenticated && result.authSource === 'oauth') {
        let liveModelsApplied = false;
        try {
          liveModelsApplied = await maker.refreshAgentLocalModels('codex');
        } catch (e) {
          // 登录本身已成功；实时模型发现失败时由 host 回退磁盘快照，不能把登录判失败。
          // 但记异常原因(原先静默吞掉,首登无模型时无从诊断是 app-server 起不来还是
          // model/list RPC 出错)——走统一 logger(规则 12),不影响登录结果。
          log.warn(
            `codex live model refresh threw during login: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        if (!isCurrent()) return supersededAuthState();
        await onCodexAuthChange?.(true, liveModelsApplied, isCurrent);
        if (!isCurrent()) return supersededAuthState();
      }
      broadcast(MAKER_PUSH.AUTH_STATE_CHANGED, { agentKind: kind, ...result });
      return result;
    },
  );

  registry.handle(MAKER_INVOKE.AUTH_CANCEL_LOGIN, async (_e, agentKind: unknown): Promise<void> => {
    maker.cancelAgentLogin(requireAgentKind(agentKind));
  });

  registry.handle(MAKER_INVOKE.AUTH_LOGOUT, async (_e, agentKind: unknown): Promise<void> => {
    const kind = requireAgentKind(agentKind);
    const generation = beginMutation(kind);
    const isCurrent = (): boolean => isMutationCurrent(kind, generation);
    try {
      await maker.logoutAgent(kind);
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
    if (!isCurrent()) return;
    if (kind === 'codex') await onCodexAuthChange?.(false, false, isCurrent);
    if (!isCurrent()) return;
    broadcast(MAKER_PUSH.AUTH_STATE_CHANGED, { agentKind: kind, authenticated: false });
  });
}

/** 被更新的 auth mutation 作废时，旧 IPC 调用方不得再把过期成功结果写回 UI。 */
function supersededAuthState(): AuthState {
  return { authenticated: false, errorReason: 'auth_mutation_superseded' };
}

function requireAgentKind(value: unknown): AgentKind {
  return requireEnum(value, AGENT_KINDS, 'agentKind');
}

function requireLoginMode(agentKind: AgentKind, value: unknown): AgentLoginMode {
  const mode =
    value === undefined
      ? 'browser'
      : (optionalEnum(requireObject(value, 'options').mode, AGENT_LOGIN_MODES, 'login mode') ??
        'browser');
  if (agentKind !== 'codex' && mode === 'device-code') {
    throwIpcError('INVALID_PARAMS', 'device-code login is only supported by codex');
  }
  return mode;
}

function progressDetail(msg: string): string {
  if (msg.startsWith('stdout:')) return stripAnsi(msg.slice('stdout:'.length));
  if (msg.startsWith('stderr:')) return stripAnsi(msg.slice('stderr:'.length));
  return stripAnsi(msg);
}

function toLoginProgressPayload(
  agentKind: AgentKind,
  msg: string,
  mode: AgentLoginMode,
): Record<string, unknown> {
  // Codex CLI 会把 OAuth URL 打到 stdout/stderr，两路都归一成 login-pending。
  if (msg.startsWith('stdout:')) {
    return { agentKind, phase: 'login-pending', mode, detail: progressDetail(msg) };
  }
  if (msg.startsWith('stderr:')) {
    return { agentKind, phase: 'login-pending', mode, detail: progressDetail(msg) };
  }
  return { agentKind, phase: stripAnsi(msg), mode };
}
