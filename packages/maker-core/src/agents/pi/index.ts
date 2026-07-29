/**
 * PiAgent —— pi coding agent(earendil-works/pi)接入。
 *
 * 形态:spawn `pi --mode rpc`(JSONL/stdio,与 codex app-server 同构但协议薄得多),
 * translator 把 pi 事件映射进统一 AgentEvent。
 *
 * 凭证/模型:pi 本身无 Cindy 账号概念。PiAgent 在 host 注入的 pi 配置目录里生成
 * models.json,把 host 提供的模型清单(capabilityAdditions.availableModels)挂到
 * 单一 provider `cindy` 下,baseUrl = runtimeConfig.endpoint(Cindy 网关 /
 * 本地 proxy),apiKey 走 env 插值($CINDY_PI_API_KEY,由 auth.getAuthEnv 提供),
 * 凭证不落盘。
 *
 * system prompt 拼接顺序(前缀稳定,对齐缓存规则):
 *   PI_SYSTEM_PROMPT_BASE → runtimeConfig.systemPrompt(host 产品段)→ opts.userPrompt
 * 经 `--system-prompt` 整体替换 pi 内置 prompt(pi 的 contextFiles/skills 仍会追加)。
 *
 * P0 骨架已支持:流式文本/thinking/工具事件、steer、abort、set_model/set_thinking_level、
 * resume(switch_session)、usage/cost 快照。
 * 尚未支持(capabilities 声明降级):fork/rewind/planMode/后台任务/远端 host/
 * 权限审批(P0-4 经 cindy-bridge extension 接 interactionResolver)。
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  AgentNotAuthenticatedError,
  BaseAgent,
  type AgentDeps,
  type AgentSessionHandle,
  type SendOptions,
  type StartSessionOptions,
} from '../base-agent.js';
import type {
  Capabilities,
  ModelDescriptor,
} from '../../types/capabilities.js';
import { NotSupportedError } from '../../types/capabilities.js';
import type { AgentEvent, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import type { AgentKind, Effort, UserMessage, UserContentBlock } from '../../types/common.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import { resolveAgentCredentialMode } from '../credential-mode.js';
import { PiRpcProcess, type PiRpcEvent } from './rpc-client.js';
import {
  createPiTranslateContext,
  translatePiEvent,
  usageSnapshotOf,
  type PiTranslateContext,
} from './translator.js';

const PI_PROVIDER_ID = 'cindy';
const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';

/** pi 内置 prompt 被 --system-prompt 整体替换后的最小基底段。 */
const PI_SYSTEM_PROMPT_BASE = `You are a coding agent running inside Cindy. You help users by reading files, executing commands, editing code, and writing new files.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files`;

/** cindy Effort → pi thinking level(pi 无 ultra;cindy 无 off)。 */
function effortToPiThinkingLevel(effort: Effort): string {
  return effort === 'ultra' ? 'max' : effort;
}

function guessImageMime(filePath: string, explicit?: string): string {
  if (explicit) return explicit;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

interface PiPromptImage {
  type: 'image';
  data: string;
  mimeType: string;
}

/** UserMessage → pi prompt 文本 + images。mention/file 以路径文本引用。 */
async function buildPiPrompt(message: UserMessage): Promise<{ text: string; images: PiPromptImage[] }> {
  if (typeof message.content === 'string') {
    return { text: message.content, images: [] };
  }
  const textParts: string[] = [];
  const images: PiPromptImage[] = [];
  for (const block of message.content as UserContentBlock[]) {
    switch (block.type) {
      case 'text':
        textParts.push(block.text);
        break;
      case 'mention':
        textParts.push(`\`${block.path}\``);
        break;
      case 'file':
        textParts.push(`\`${block.path}\``);
        break;
      case 'image': {
        try {
          const data = await fs.readFile(block.path);
          images.push({
            type: 'image',
            data: data.toString('base64'),
            mimeType: guessImageMime(block.path, block.mimeType),
          });
        } catch {
          textParts.push(`(image unavailable: ${block.path})`);
        }
        break;
      }
    }
  }
  return { text: textParts.join(' ').trim(), images };
}

export class PiAgent extends BaseAgent {
  readonly kind: AgentKind = 'pi';
  readonly capabilities: Capabilities;

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(PiAgent.baseCapabilities());
  }

  private static baseCapabilities(): Capabilities {
    return {
      switchModel: { supported: true },
      availableModels: [],
      hasFastMode: false,
      effort: { supported: true },
      effortLevels: [
        { id: 'low', displayName: 'Low' },
        { id: 'medium', displayName: 'Medium' },
        { id: 'high', displayName: 'High' },
        { id: 'xhigh', displayName: 'Extra High' },
        { id: 'max', displayName: 'Max' },
      ],
      reasoningDisplay: ['off', 'full'],
      // P0:pi 无内建权限系统,先只暴露完全放行档;ask 档随 cindy-bridge
      // extension(tool_call 拦截 → interactionResolver)一起上。
      permissionModes: [
        { id: 'bypassPermissions', displayName: '完全访问' },
      ],
      setPermissionModeMidSession: {
        supported: false,
        reason: 'not-implemented',
        message: 'pi permission modes land with the cindy-bridge extension',
      },
      multimodal: {
        text: { supported: true },
        image: { supported: true },
        file: { supported: false, reason: 'not-implemented' },
      },
      fork: { supported: false, reason: 'not-implemented', upstreamRef: 'pi rpc fork(entryId)' },
      rewind: { supported: false, reason: 'sdk-missing', message: 'pi has no file checkpointing' },
      abort: { supported: true },
      sameTurnSteer: { supported: true },
      memory: { supported: { supported: false, reason: 'sdk-missing' } },
      extraDirs: { supported: false, reason: 'sdk-missing' },
    };
  }

  /** host 注入的 pi 配置目录(auth/models/settings/sessions);缺省落系统临时目录。 */
  private resolveAgentHome(): string {
    const injected = this.deps.resolvePiAgentHome?.();
    if (injected && injected.trim().length > 0) return injected;
    return path.join(os.tmpdir(), 'cindy-pi-agent-home');
  }

  /**
   * 生成 agentHome/models.json:host 模型清单 → provider `cindy`。
   * apiKey 用 env 插值形式,凭证本体只进子进程 env,不落盘。
   */
  private async writeModelsJson(agentHome: string): Promise<void> {
    const endpoint = this.deps.runtimeConfig.endpoint;
    if (!endpoint) {
      this.deps.logger.warn('pi: runtimeConfig.endpoint missing — models.json will have no usable provider');
    }
    const models = this.capabilities.availableModels.map((m: ModelDescriptor) => ({
      id: m.id,
      name: m.displayName,
      reasoning: m.efforts.length > 0,
      input: ['text', 'image'],
      contextWindow: m.contextWindow > 0 ? m.contextWindow : 200_000,
      maxTokens: 32_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    const config = {
      providers: {
        [PI_PROVIDER_ID]: {
          name: 'Cindy AI',
          baseUrl: endpoint ?? 'http://127.0.0.1:0',
          api: 'anthropic-messages',
          apiKey: `$${PI_API_KEY_ENV}`,
          models,
        },
      },
    };
    await fs.mkdir(agentHome, { recursive: true });
    await fs.writeFile(path.join(agentHome, 'models.json'), JSON.stringify(config, null, 2) + '\n');
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    if (opts.remoteHostId) {
      throw new NotSupportedError('remoteSession', {
        supported: false,
        reason: 'not-implemented',
        message: 'pi sessions are local-only for now',
      });
    }

    const credentialMode =
      resolveAgentCredentialMode({ agentKind: 'pi', providerId: opts.providerId, model: opts.model }) ??
      'gateway-key';
    const authState = await this.deps.auth.getState({ credentialMode });
    if (!authState.authenticated) {
      throw new AgentNotAuthenticatedError('pi');
    }
    const authEnv = await this.deps.auth.getAuthEnv({ credentialMode });

    const agentHome = this.resolveAgentHome();
    await this.writeModelsJson(agentHome);
    const sessionDir = path.join(agentHome, 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });

    // 前缀稳定拼接:base → host 产品段 → 用户段。易变内容禁止进入(缓存规则 3.1)。
    const promptSections = [
      PI_SYSTEM_PROMPT_BASE,
      this.deps.runtimeConfig.systemPrompt?.trim(),
      opts.userPrompt?.trim(),
    ].filter((s): s is string => !!s && s.length > 0);
    const systemPrompt = promptSections.join('\n\n');

    const args = [
      '--mode', 'rpc',
      '--session-dir', sessionDir,
      '--provider', PI_PROVIDER_ID,
      '--model', opts.model,
      '--system-prompt', systemPrompt,
    ];

    const queue: AsyncQueue<AgentEvent> = createAsyncQueue<AgentEvent>();
    const ctx: PiTranslateContext = createPiTranslateContext(this.deps.logger);
    let interactionResolver: InteractionResolver | null = null;
    let closed = false;

    const proc = new PiRpcProcess({
      binaryPath: this.deps.binaryPath,
      args,
      cwd: opts.workingDir,
      env: {
        ...process.env,
        ...authEnv,
        PI_CODING_AGENT_DIR: agentHome,
      },
      logger: this.deps.logger,
      onEvent: (event: PiRpcEvent) => {
        if (event.type === 'extension_ui_request') {
          this.handleExtensionUiRequest(event, proc, interactionResolver);
          return;
        }
        translatePiEvent(event, queue, ctx);
      },
      onExit: ({ code, signal }) => {
        if (!closed) {
          // 非用户 close 的进程死亡:terminal error + 收尾,避免 UI 永久 running。
          queue.push({
            type: 'error',
            data: { message: `pi process exited unexpectedly (code=${code}, signal=${signal})`, isTerminal: true },
            source: 'pi',
          });
        }
        queue.end();
      },
    });

    // Resume:pi 的会话钥匙是 session JSONL 绝对路径(get_state.sessionFile),
    // 落库 sdk_session_id 存的就是它;切换失败走 invalid-resume CAS 协定。
    if (opts.resumeSessionId) {
      const switched = await proc.request({ type: 'switch_session', sessionPath: opts.resumeSessionId });
      if (!switched.success) {
        const mayFallback = (await opts.onInvalidResumeSession?.(opts.resumeSessionId)) ?? true;
        if (!mayFallback) {
          await proc.close();
          throw new Error(`pi resume failed and fallback rejected: ${switched.error ?? 'unknown'}`);
        }
        this.deps.logger.warn('pi resume failed, starting fresh session', {
          resumeSessionId: opts.resumeSessionId,
          error: switched.error,
        });
      }
    }

    if (opts.effort) {
      const resp = await proc.request({
        type: 'set_thinking_level',
        level: effortToPiThinkingLevel(opts.effort),
      });
      if (!resp.success) {
        this.deps.logger.warn('pi set_thinking_level rejected', { effort: opts.effort, error: resp.error });
      }
    }

    const state = await proc.request({ type: 'get_state' });
    const stateData = (state.data ?? {}) as {
      sessionFile?: string | null;
      sessionId?: string;
      model?: { contextWindow?: number } | null;
    };
    if (typeof stateData.model?.contextWindow === 'number' && stateData.model.contextWindow > 0) {
      ctx.contextWindow = stateData.model.contextWindow;
    }
    const sdkSessionId = stateData.sessionFile || stateData.sessionId || `pi-${Date.now()}`;
    queue.push({ type: 'session_id', data: sdkSessionId, source: 'pi' });

    const deps = this.deps;
    const agentKind = this.kind;

    const handle: AgentSessionHandle = {
      id: sdkSessionId,
      agentKind,
      model: opts.model,

      async send(message: UserMessage, sendOpts?: SendOptions): Promise<void> {
        void sendOpts;
        const { text, images } = await buildPiPrompt(message);
        const command: Record<string, unknown> = { type: 'prompt', message: text };
        if (images.length > 0) command.images = images;
        // send 语义 = 排队开新 turn;pi streaming 中裸 prompt 会被拒,补 followUp。
        if (ctx.isStreaming) command.streamingBehavior = 'followUp';
        const resp = await proc.request(command);
        if (!resp.success) {
          throw new Error(`pi prompt rejected: ${resp.error ?? 'unknown'}`);
        }
      },

      async steer(message: UserMessage): Promise<void> {
        const { text, images } = await buildPiPrompt(message);
        const command: Record<string, unknown> = { type: 'steer', message: text };
        if (images.length > 0) command.images = images;
        const resp = await proc.request(command);
        if (!resp.success) {
          throw new Error(`pi steer rejected: ${resp.error ?? 'unknown'}`);
        }
      },

      async abort(): Promise<void> {
        if (proc.isClosed) return;
        await proc.request({ type: 'abort' }).catch((err: unknown) => {
          deps.logger.warn('pi abort request failed', { message: (err as Error).message });
        });
      },

      async close(): Promise<void> {
        closed = true;
        await proc.close();
      },

      events(): AsyncIterable<AgentEvent> {
        return queue;
      },

      getUsageSnapshot(): UsageSnapshot {
        return usageSnapshotOf(ctx);
      },

      setInteractionResolver(resolver: InteractionResolver): void {
        interactionResolver = resolver;
      },

      async setModel(model: string): Promise<void> {
        const resp = await proc.request({ type: 'set_model', provider: PI_PROVIDER_ID, modelId: model });
        if (!resp.success) throw new Error(`pi set_model failed: ${resp.error ?? 'unknown'}`);
        const data = (resp.data ?? {}) as { contextWindow?: number };
        if (typeof data.contextWindow === 'number' && data.contextWindow > 0) {
          ctx.contextWindow = data.contextWindow;
        }
      },

      async setEffort(effort: Effort): Promise<void> {
        const resp = await proc.request({
          type: 'set_thinking_level',
          level: effortToPiThinkingLevel(effort),
        });
        if (!resp.success) throw new Error(`pi set_thinking_level failed: ${resp.error ?? 'unknown'}`);
      },
    };

    return handle;
  }

  /**
   * pi extension UI 子协议桥。
   *
   * P0 兜底:cindy-bridge extension 还没定制审批 payload 前,dialog 类请求一律
   * cancelled 回写(不挂死 agent loop);fire-and-forget 类忽略。P0-4 把 bridge 的
   * tool 审批请求映射进 interactionResolver(kind='permission')。
   */
  private handleExtensionUiRequest(
    event: PiRpcEvent,
    proc: PiRpcProcess,
    resolver: InteractionResolver | null,
  ): void {
    void resolver;
    const method = typeof event.method === 'string' ? event.method : '';
    const id = typeof event.id === 'string' ? event.id : undefined;
    const isDialog = method === 'select' || method === 'confirm' || method === 'input' || method === 'editor';
    if (!isDialog || !id) return;
    this.deps.logger.warn('pi extension dialog auto-cancelled (no bridge mapping yet)', { method });
    proc.send({ type: 'extension_ui_response', id, cancelled: true });
  }
}
