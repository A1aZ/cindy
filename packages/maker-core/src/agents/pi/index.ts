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
 * system prompt:保留 pi 内置默认 prompt(工具用法/工程约定是 pi 自己调好的),
 * 经 `--append-system-prompt` 追加 runtimeConfig.systemPrompt(host 产品段)→
 * opts.userPrompt。前缀稳定(默认 prompt 静态),对齐缓存规则。
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
  type PiExtraSpawnConfig,
  type PiNativeProviderSpec,
  type SendOptions,
  type StartSessionOptions,
} from '../base-agent.js';
import {
  CINDY_BRIDGE_EXTENSION_FILENAME,
  CINDY_BRIDGE_EXTENSION_SOURCE,
} from './cindy-bridge-source.js';
import { classifyPiToolForAutoReview } from './auto-review-policy.js';
import { buildMemoryScopeKey } from '../../memory/storage.js';
import type {
  Capabilities,
  ManualCompactResult,
  ModelDescriptor,
} from '../../types/capabilities.js';
import { NotSupportedError } from '../../types/capabilities.js';
import type {
  AgentEvent,
  ForkSdkSessionOptions,
  ForkSdkSessionResult,
  InteractionResolver,
  UsageSnapshot,
} from '../../types/events.js';
import type { AgentKind, Effort, UserMessage, UserContentBlock } from '../../types/common.js';
import type { ListAgentSkillsOptions, ListAgentSkillsResult } from '../../types/palette.js';
import { scanPiCustomizations } from './customization-scanner.js';
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
const PI_SESSION_ID_ENV = 'CINDY_PI_SESSION_ID';
/** 手动压缩 = 一次完整 LLM 摘要调用(大上下文 + 网关排队),远超默认 30s RPC 超时。 */
const PI_COMPACT_TIMEOUT_MS = 600_000;

/**
 * digest 分片 body 的**字节**上限(硬上限 8192,留 headroom)。存储层按 UTF-8 字节
 * 卡 hardShardBytes,故截断必须按字节而非字符 —— 否则中文摘要(每字 3 字节)会在
 * 字符数远未到阈值时就超字节硬上限,write 抛 shard-too-large 被吞掉,digest 静默丢失。
 */
const PI_DIGEST_MAX_BODY_BYTES = 7000;

/** 按 UTF-8 字节预算截断(码点安全,不切断多字节字符);超预算时补省略号。 */
function truncateToByteBudget(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '\n…';
  const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > budget) break;
    bytes += chBytes;
    out += ch;
  }
  return out + ellipsis;
}

/** 任意串 → memory slug 片段([a-z0-9-],截断)。 */
function slugifyForMemory(input: string, maxLen: number): string {
  const s = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'anon').slice(0, maxLen);
}

/** 摘要正文 → 一行 description(折叠空白、去换行、截断)。 */
function oneLineDescription(text: string, maxLen: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > maxLen ? line.slice(0, maxLen - 1) + '…' : line;
}

/**
 * NO_PROXY 兜底:pi 的模型请求打的是 Cindy 本地 compat proxy(loopback),bridge 的
 * MCP fetch 也是 localhost —— 用户设了全局 HTTP_PROXY 时这些请求不能进代理隧道。
 * 合并用户已有 NO_PROXY,同时吞并小写 no_proxy 并删除,防止大小写双份互相覆盖
 * (与 codex/env-builder.ts 同一策略)。
 */
function mergeLoopbackNoProxy(env: NodeJS.ProcessEnv): void {
  const existing = [env.NO_PROXY, env.no_proxy]
    .filter((v): v is string => typeof v === 'string')
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  env.NO_PROXY = Array.from(new Set([...existing, '127.0.0.1', 'localhost', '::1'])).join(',');
  delete env.no_proxy;
}

/** cindy Effort → pi thinking level(pi 无 ultra;cindy 无 off)。 */
function effortToPiThinkingLevel(effort: Effort): string {
  return effort === 'ultra' ? 'max' : effort;
}

/**
 * pi 的 RPC prompt 会**执行**扩展命令(实测:/plan 直接被 plan-mode 扩展吃掉,零 LLM
 * 请求)并展开 /skill: 与 /template;内置 TUI 命令(/help、/model 等)则按字面进模型。
 * 用户输入以 / 开头时,除显式技能调用(/skill:)外一律前置空格转义成字面文本(实测
 * 有效)—— 防止误触扩展命令让 Cindy 侧状态镜像脱同步(如 /plan),也堵住未来扩展/包
 * 新增命令带来的攻击面。内部控制路径(setPlanMode 的 /plan)不走本函数。
 */
function escapeLeadingSlashCommand(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('/') && !trimmed.startsWith('/skill:')) return ' ' + text;
  return text;
}

/** fork 尾部丢弃 turn 数归一:非有限/负值 → 0。 */
function normalizeTailTurnsToDrop(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
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
      // 权限执行层在 cindy-bridge extension 的 tool_call 拦截:ask 档下只读内置
      // 工具放行,bash/edit/write 与全部桥接 MCP 工具逐次经 cindy 审批;
      // bypassPermissions 全放行。档位从权限文件热读,setPermissionMode 即时生效。
      // auto 档:bridge 行为同 ask(非只读全部冒泡),Cindy 侧 dispatcher 先过
      // Auto-Review Core(shared/auto-review.ts)—— 区内写/安全命令静默放行,
      // 越界写/危险命令/MCP 工具仍弹窗(见 handleExtensionUiRequest)。
      // displayName/description 为英文 fallback,真实文案走 i18n
      // newChat.permissionSelector.modes.pi.*(与 cc/codex 同结构)。
      permissionModes: [
        { id: 'ask', displayName: 'Default permissions', description: 'Read-only tools run directly; writing files, running commands, and MCP tools ask each time.' },
        { id: 'auto', displayName: 'Auto-review', description: 'In-workspace writes and safe commands run automatically; out-of-workspace writes, risky commands, and MCP tools still ask.' },
        { id: 'bypassPermissions', displayName: 'Full access', description: 'Every tool runs without asking. Highest risk; use only for trusted tasks.' },
      ],
      setPermissionModeMidSession: { supported: true },
      // plan 模式经 pi 自带 plan-mode 扩展(--extension 加载):开启后禁用 edit/write、
      // bash 仅允许只读白名单;plan 提示词仅在激活时注入(不增基线上下文)。
      // Cindy 用 setPlanMode 经 /plan 命令 toggle 驱动 enter/exit。
      planMode: { supported: true },
      multimodal: {
        text: { supported: true },
        image: { supported: true },
        file: { supported: false, reason: 'not-implemented' },
      },
      // fork:整条克隆(clone)或按 tailTurnsToDrop rewind 到某条 user 消息(fork{entryId}),
      // 与 Codex 粗粒度 fork 同构(uuidMap 空、upToMessageId 忽略)。见 forkSdkSession。
      fork: { supported: true },
      // 对话分支可做,但 pi 无文件级 checkpoint —— 文件回滚型 rewind 真做不了,诚实降级。
      rewind: { supported: false, reason: 'sdk-missing', message: 'pi 无文件级 checkpoint;对话分支走 fork' },
      abort: { supported: true },
      sameTurnSteer: { supported: true },
      memory: { supported: { supported: false, reason: 'sdk-missing' } },
      extraDirs: { supported: false, reason: 'sdk-missing' },
      // pi 原生 export_html RPC:自带 export-html 渲染器,离线、无网关。
      sessionHtmlExport: { supported: true },
      // pi 原生 compact RPC:手动压缩(可带聚焦指令,调 LLM 生成摘要)。
      // 斜杠转义后用户无法手输 /compact,此能力是 pi 会话手动压缩的唯一入口。
      manualCompact: { supported: true },
    };
  }

  /** host 注入的 pi 配置目录(auth/models/settings/sessions);缺省落系统临时目录。 */
  private resolveAgentHome(): string {
    const injected = this.deps.resolvePiAgentHome?.();
    if (injected && injected.trim().length > 0) return injected;
    return path.join(os.tmpdir(), 'cindy-pi-agent-home');
  }

  /**
   * 生成 agentHome/models.json:
   *   - 网关模型 → 单一 provider `cindy`(baseUrl = compat proxy);
   *   - BYOM 原生 provider(nativeProviders)→ **各自独立 provider 块**,baseUrl 直连用户端点,
   *     不过 compat 代理(设计原则:pi 主导,禁双重转义)。
   * apiKey 一律用 `$ENV` 插值,凭证本体只进子进程 env,不落盘。
   */
  private async writeModelsJson(
    agentHome: string,
    nativeProviders: PiNativeProviderSpec[] = [],
  ): Promise<void> {
    const endpoint = this.deps.runtimeConfig.endpoint;
    if (!endpoint) {
      this.deps.logger.warn('pi: runtimeConfig.endpoint missing — models.json will have no usable provider');
    }
    // 原生 provider 的模型只进各自 provider 块,**不进网关 cindy 块** —— 否则 catalog 派生
    // 出的自定义 pi 模型会同时出现在网关块(指向 compat 代理),造成双重路由/双重转义。
    const nativeModelIds = new Set(nativeProviders.flatMap((np) => np.models.map((m) => m.id)));
    const models = this.capabilities.availableModels
      .filter((m: ModelDescriptor) => !nativeModelIds.has(m.id))
      .map((m: ModelDescriptor) => ({
      id: m.id,
      name: m.displayName,
      reasoning: m.efforts.length > 0,
      input: ['text', 'image'],
      contextWindow: m.contextWindow > 0 ? m.contextWindow : 200_000,
      maxTokens: m.maxOutputTokens && m.maxOutputTokens > 0 ? m.maxOutputTokens : 32_000,
      // 计费单位与目录一致($/1M tokens);pi 按此自行计价,usage 事件的 cost 才有真值。
      cost: {
        input: m.cost?.input ?? 0,
        output: m.cost?.output ?? 0,
        cacheRead: m.cost?.cacheRead ?? 0,
        cacheWrite: m.cost?.cacheWrite ?? 0,
      },
    }));
    const providers: Record<string, unknown> = {
      [PI_PROVIDER_ID]: {
        name: 'Cindy AI',
        baseUrl: endpoint ?? 'http://127.0.0.1:0',
        api: 'anthropic-messages',
        apiKey: `$${PI_API_KEY_ENV}`,
        headers: {
          'x-cindy-pi-session-id': `$${PI_SESSION_ID_ENV}`,
        },
        models,
      },
    };
    for (const np of nativeProviders) {
      if (np.id === PI_PROVIDER_ID) {
        this.deps.logger.warn('pi: native provider id collides with gateway provider "cindy" — skipped', { id: np.id });
        continue;
      }
      providers[np.id] = {
        name: np.name,
        baseUrl: np.baseUrl,
        api: np.api,
        // keyless(本机 Ollama 等)也要给 dummy key,否则 pi /model 不显示该模型。
        apiKey: np.apiKeyEnvVar ? `$${np.apiKeyEnvVar}` : 'pi-native-keyless',
        ...(np.headers && Object.keys(np.headers).length > 0 ? { headers: np.headers } : {}),
        models: np.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: m.reasoning ?? false,
          input: m.input ?? ['text'],
          contextWindow: m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 128_000,
          maxTokens: m.maxTokens && m.maxTokens > 0 ? m.maxTokens : 16_000,
        })),
      };
    }
    await fs.mkdir(agentHome, { recursive: true });
    await fs.writeFile(path.join(agentHome, 'models.json'), JSON.stringify({ providers }, null, 2) + '\n');
  }

  /**
   * model id → provider id 路由表。网关模型 → `cindy`;BYOM 原生模型 → 各自 provider id
   * (撞 id 时原生优先——用户显式配置)。setModel / 初始 --provider 据此选对 provider。
   */
  private buildModelProviderMap(nativeProviders: PiNativeProviderSpec[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const m of this.capabilities.availableModels) map.set(m.id, PI_PROVIDER_ID);
    for (const np of nativeProviders) {
      if (np.id === PI_PROVIDER_ID) continue;
      for (const m of np.models) map.set(m.id, np.id);
    }
    return map;
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    if (opts.remoteHostId) {
      throw new NotSupportedError('remoteSession', {
        supported: false,
        reason: 'not-implemented',
        message: 'pi sessions are local-only for now',
      });
    }

    const authProviderId =
      opts.providerId ??
      (opts.model.startsWith('chatgpt/')
        ? 'openai'
        : opts.model.startsWith('xai/')
          ? 'xai'
          : null);
    const credentialMode =
      resolveAgentCredentialMode({ agentKind: 'pi', providerId: authProviderId, model: opts.model }) ??
      'gateway-key';
    const authState = await this.deps.auth.getState({
      credentialMode,
      providerId: authProviderId,
    });
    if (!authState.authenticated) {
      throw new AgentNotAuthenticatedError('pi');
    }
    const authEnv = await this.deps.auth.getAuthEnv({
      credentialMode,
      providerId: authProviderId,
    });

    // BYOM:host 解析当前会话可用的原生 provider(用户自定义/本地模型)+ 需注入的 env(keys)。
    // 缺省 → 空,只有网关 provider `cindy`(现状不变)。失败不致命,降级为无原生 provider。
    let nativeProviders: PiNativeProviderSpec[] = [];
    let nativeEnv: Record<string, string> = {};
    if (this.deps.resolvePiNativeProviders) {
      try {
        const resolved = await this.deps.resolvePiNativeProviders({
          workingDir: opts.workingDir,
          remoteHostId: opts.remoteHostId,
        });
        nativeProviders = resolved?.providers ?? [];
        nativeEnv = resolved?.env ?? {};
      } catch (err) {
        this.deps.logger.warn('pi resolvePiNativeProviders failed, continuing gateway-only', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const modelProviderMap = this.buildModelProviderMap(nativeProviders);
    // 选定模型所属 provider(BYOM 模型 → 其原生 provider;其余 → 网关 cindy)。
    const resolveProviderForModel = (model: string): string =>
      modelProviderMap.get(model) ?? PI_PROVIDER_ID;
    const initialProvider = resolveProviderForModel(opts.model);

    const agentHome = this.resolveAgentHome();
    await this.writeModelsJson(agentHome, nativeProviders);
    const sessionDir = path.join(agentHome, 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });

    // cindy-bridge extension:每次 startSession 覆写,保证桥代码与本版本一致。
    const extensionsDir = path.join(agentHome, 'extensions');
    await fs.mkdir(extensionsDir, { recursive: true });
    await fs.writeFile(
      path.join(extensionsDir, CINDY_BRIDGE_EXTENSION_FILENAME),
      CINDY_BRIDGE_EXTENSION_SOURCE,
    );

    // 权限档文件:extension 每次 tool_call 现读(热切换);读不到按 ask fail-closed。
    const runtimeDir = path.join(agentHome, 'runtime');
    await fs.mkdir(runtimeDir, { recursive: true });
    const permissionFile = path.join(
      runtimeDir,
      `perm-${opts.sessionId ?? `anon-${process.pid}-${Date.now()}`}.json`,
    );
    // auto 保留(Cindy 侧 dispatcher 用);bridge 只特判 bypassPermissions,auto 在
    // 桥内行为同 ask(非只读全部冒泡)。其余档(default/acceptEdits/plan)归 ask 最严。
    const normalizePermissionMode = (mode: string | undefined): 'ask' | 'auto' | 'bypassPermissions' =>
      mode === 'bypassPermissions' ? 'bypassPermissions' : mode === 'auto' ? 'auto' : 'ask';
    let permissionMode = normalizePermissionMode(opts.permissionMode);
    const writePermissionFile = async (): Promise<void> => {
      await fs.writeFile(permissionFile, JSON.stringify({ mode: permissionMode }) + '\n');
    };
    await writePermissionFile();

    // MCP 桥:host 把 in-process MCP providers 暴露成 localhost streamable-HTTP。
    // 传 session 身份(sessionId/workingDir/vendorOptions)让 host 在 bridge 上注册
    // 身份 ctx + 给 server URL 打 `?session=` 路由 —— orca/会话身份类工具据此绑定
    // 当前 pi 会话。disposeSessionCtx 在 close() 注销该注册(幂等)。
    let mcpBridge: PiExtraSpawnConfig['mcpBridge'] = null;
    let disposeSessionCtx: (() => void) | undefined;
    if (this.deps.preparePiExtraSpawnConfig) {
      try {
        const extra = await this.deps.preparePiExtraSpawnConfig(this.deps.mcpProviders ?? [], {
          sessionId: opts.sessionId,
          workingDir: opts.workingDir,
          vendorOptions: opts.vendorOptions,
        });
        mcpBridge = extra?.mcpBridge ?? null;
        disposeSessionCtx = extra?.disposeSessionCtx;
      } catch (err) {
        this.deps.logger.error('pi MCP bridge prep failed, continuing without cindy tools', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 压缩即记忆:makerMemory 开启时,把 pi 压缩上下文时丢弃内容的摘要沉淀成 `digest`
    // 记忆(进 FTS 可 memory_search 检索,但排除出 MEMORY.md / system prompt,不污染
    // curated 记忆)。gate 与 CC 同口径;best-effort,失败只 warn,绝不阻断会话。
    const compactionMemoryEnabled =
      (opts.makerMemoryEnabled ?? this.deps.runtimeConfig.makerMemoryEnabled ?? false) === true &&
      !!this.deps.makerMemory;
    const memoryScopeKey = buildMemoryScopeKey(opts.workingDir, opts.remoteHostId);
    const digestSlugBase = slugifyForMemory(opts.sessionId ?? `pi-${process.pid}`, 24);
    let digestSeq = 0;
    const writeCompactionDigest = async (summary: string, reason: string): Promise<void> => {
      const manager = this.deps.makerMemory;
      if (!compactionMemoryEnabled || !manager) return;
      const body = truncateToByteBudget(summary, PI_DIGEST_MAX_BODY_BYTES);
      const seq = ++digestSeq;
      // slug 唯一:sessionId 片段 + 递增序号;resume/跨会话用 Date.now 防撞名(create 模式撞名会抛)。
      const slug = slugifyForMemory(`digest-${digestSlugBase}-${Date.now()}-${seq}`, 64);
      try {
        await manager.write(memoryScopeKey, {
          type: 'digest',
          name: slug,
          // reason 收敛(去换行 + 截断):防某版本 pi 给出长 reason 撑爆 maxTitleLen(100)被吞。
          title: `PI compaction digest (${oneLineDescription(reason, 40)})`,
          description: oneLineDescription(summary, 180),
          body,
          mode: 'create',
        });
        this.deps.logger.debug('pi compaction digest saved to memory', { slug, reason });
      } catch (err) {
        this.deps.logger.warn('pi compaction digest write failed (non-fatal)', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // 追加而非替换:pi 默认 prompt(工具用法/工程约定)原样保留,只追加 host 产品段
    // 与用户段。前缀稳定(默认 prompt 静态),易变内容禁止进入(缓存规则 3.1)。
    const appendSections = [
      this.deps.runtimeConfig.systemPrompt?.trim(),
      opts.userPrompt?.trim(),
    ].filter((s): s is string => !!s && s.length > 0);
    const appendSystemPrompt = appendSections.join('\n\n');

    // plan 模式:挂载 pi 自带的 plan-mode example 扩展(随 pi 分发,版本匹配,免 vendoring)。
    // 只在文件存在时 --extension;缺失则 plan 模式静默降级(setPlanMode 时 warn)。
    // 加载本身零副作用:plan 模式默认关,扩展 hook 全早返;仅 /plan 开启后才注入 plan 提示词。
    const planModeExtPath = path.join(
      path.dirname(this.deps.binaryPath),
      'examples', 'extensions', 'plan-mode', 'index.ts',
    );
    let planModeExtAvailable = false;
    try {
      planModeExtAvailable = (await fs.stat(planModeExtPath)).isFile();
    } catch {
      /* 缺失 → 不挂载 plan-mode */
    }

    const args = [
      '--mode', 'rpc',
      '--session-dir', sessionDir,
      '--provider', initialProvider,
      '--model', opts.model,
      ...(appendSystemPrompt.length > 0 ? ['--append-system-prompt', appendSystemPrompt] : []),
      ...(planModeExtAvailable ? ['--extension', planModeExtPath] : []),
    ];

    const queue: AsyncQueue<AgentEvent> = createAsyncQueue<AgentEvent>();
    const ctx: PiTranslateContext = createPiTranslateContext(this.deps.logger);
    let interactionResolver: InteractionResolver | null = null;
    let closed = false;
    // Cindy 侧对 pi plan 模式的镜像态;setPlanMode 经 /plan toggle 驱动,与 pi 内部
    // planModeEnabled 保持一致(RPC 下 Execute/Refine 选择框被 auto-cancel,pi 不会自行
    // 翻转,故镜像不漂移)。
    let planModeActive = false;

    // proc 构造即 spawn 子进程 —— spawn 参数非法等会**同步**抛。此刻 ctx 已在
    // preparePiExtraSpawnConfig 注册、但 handle 尚未交出,close() 不会跑 → 单独
    // 兜底注销 ctx 再抛(构造失败没有 proc 可关)。catch 必抛,故其后 proc 恒已赋值。
    let proc: PiRpcProcess;
    try {
      const spawnEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...authEnv,
        // BYOM 原生 provider 的 api keys(键名对应 spec.apiKeyEnvVar,models.json 用 $ENV 引用)。
        ...nativeEnv,
        [PI_SESSION_ID_ENV]: opts.sessionId ?? '',
        PI_CODING_AGENT_DIR: agentHome,
        CINDY_PI_PERMISSION_FILE: permissionFile,
        // 嵌入式 runtime 不做启动期联网:关掉 pi 的版本检查与安装遥测
        // (pi.dev/api/latest-version、report-install)。LLM 请求走 provider 通道不受影响。
        PI_OFFLINE: '1',
        ...(mcpBridge && mcpBridge.servers.length > 0
          ? { CINDY_PI_MCP_BRIDGE: JSON.stringify(mcpBridge) }
          : {}),
      };
      mergeLoopbackNoProxy(spawnEnv);
      proc = new PiRpcProcess({
        binaryPath: this.deps.binaryPath,
        args,
        cwd: opts.workingDir,
        env: spawnEnv,
        logger: this.deps.logger,
        onEvent: (event: PiRpcEvent) => {
          if (event.type === 'extension_ui_request') {
            this.handleExtensionUiRequest(event, proc, () => ({
              resolver: interactionResolver,
              permissionMode,
              workspaceRoots: [opts.workingDir],
            }));
            return;
          }
          // 压缩即记忆:compaction_end 带摘要正文时沉淀 digest(auto/manual 都触发,pi
          // 文档:两种压缩都发此事件)。fire-and-forget,不阻塞事件流。
          if (event.type === 'compaction_end' && compactionMemoryEnabled) {
            const summary = (event.result as { summary?: unknown } | null)?.summary;
            if (typeof summary === 'string' && summary.trim().length > 0) {
              const reason = typeof event.reason === 'string' ? event.reason : 'auto';
              void writeCompactionDigest(summary.trim(), reason);
            }
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
    } catch (err) {
      try {
        disposeSessionCtx?.();
      } catch {
        /* best-effort:注销失败不掩盖原始构造错误 */
      }
      throw err;
    }

    // startSession 在把 handle 交给调用方之前若失败(resume 硬失败、启动期 RPC
    // 超时/进程夭折等),close() 永远不会被调用。这里 try/catch 兜底:注销 bridge
    // 身份注册(否则 ?session= ctx 泄漏)+ 关掉可能已 spawn 的子进程(否则僵尸 pi
    // 仍持有本会话的 MCP 路由),再把原始错误抛给调用方。
    let sdkSessionId = '';
    try {
      // Resume:pi 的会话钥匙是 session JSONL 绝对路径(get_state.sessionFile),
      // 落库 sdk_session_id 存的就是它;切换失败走 invalid-resume CAS 协定。
      if (opts.resumeSessionId) {
        const switched = await proc.request({ type: 'switch_session', sessionPath: opts.resumeSessionId });
        if (!switched.success) {
          const mayFallback = (await opts.onInvalidResumeSession?.(opts.resumeSessionId)) ?? true;
          if (!mayFallback) {
            // proc 关闭 + ctx 注销由下面的 catch 统一处理,这里只抛。
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

      // 显式保证 auto-compaction 开 —— 这是"pi 保持轻上下文"的不变量:上下文接近满时
      // pi 自动压缩(与 CC/Codex 一致)。pi 默认即开,这里显式化并兜底(幂等,失败不致命)。
      {
        const resp = await proc.request({ type: 'set_auto_compaction', enabled: true });
        if (!resp.success) {
          this.deps.logger.warn('pi set_auto_compaction failed (non-fatal)', { error: resp.error });
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
      sdkSessionId = stateData.sessionFile || stateData.sessionId || `pi-${Date.now()}`;
      queue.push({ type: 'session_id', data: sdkSessionId, source: 'pi' });

      // plan 镜像与 pi 持久态对齐(resume 关键):pi 的 plan-mode 扩展在 session_start 会从
      // session entry 自恢复 planModeEnabled,但不发 notify。若镜像固定为 false 而 pi 实为 true,
      // 由于 /plan 是 toggle + setPlanMode 幂等短路,会导致方向反转或关不掉。故从 get_entries
      // 读最后一条 plan-mode custom entry 的 enabled 校正镜像(get_entries 已验证暴露该 entry)。
      if (planModeExtAvailable) {
        try {
          const entriesResp = await proc.request({ type: 'get_entries' });
          // request() 对业务失败是 resolve({success:false}) 而非 reject。不查 success
          // 就会静默落 entries=[]、镜像默认 false —— 若 pi 实际 planModeEnabled=true,
          // 后续 setPlanMode 的幂等短路会误判、/plan toggle 方向反转。显式查并 warn;
          // 镜像保持默认 false(宁可不声称保护,也不谎报),与兄弟 RPC 调用的 success 检查一致。
          if (!entriesResp.success) {
            this.deps.logger.warn('pi plan-mode state sync: get_entries failed; plan mirror unverified (defaulting off)', {
              error: entriesResp.error,
            });
          } else {
            const entries =
              (entriesResp.data as { entries?: Array<{ customType?: string; data?: { enabled?: boolean } }> } | undefined)
                ?.entries ?? [];
            for (let i = entries.length - 1; i >= 0; i--) {
              if (entries[i]?.customType === 'plan-mode') {
                const enabled = entries[i]?.data?.enabled;
                if (typeof enabled === 'boolean') planModeActive = enabled;
                break;
              }
            }
          }
        } catch (err) {
          this.deps.logger.warn('pi plan-mode state sync failed (non-fatal)', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      try {
        disposeSessionCtx?.();
      } catch {
        /* best-effort:注销失败不掩盖原始启动错误 */
      }
      await proc.close().catch(() => {});
      throw err;
    }

    const deps = this.deps;
    const agentKind = this.kind;

    const handle: AgentSessionHandle = {
      id: sdkSessionId,
      agentKind,
      model: opts.model,

      async send(message: UserMessage, sendOpts?: SendOptions): Promise<void> {
        void sendOpts;
        const { text, images } = await buildPiPrompt(message);
        const command: Record<string, unknown> = { type: 'prompt', message: escapeLeadingSlashCommand(text) };
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
        const command: Record<string, unknown> = { type: 'steer', message: escapeLeadingSlashCommand(text) };
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
        // 先注销 bridge 身份注册(幂等),再关子进程。放前面:即便 proc.close 抛错
        // 也不泄漏 ctx —— 该 sessionId 的 `?session=` 路由必须随会话结束失效。
        try {
          disposeSessionCtx?.();
        } catch (err) {
          deps.logger.warn('pi disposeSessionCtx failed (non-fatal)', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
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
        // BYOM:按 model→provider 路由(原生模型走其 provider,其余走网关 cindy)。
        const provider = resolveProviderForModel(model);
        const resp = await proc.request({ type: 'set_model', provider, modelId: model });
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

      async setPermissionMode(mode): Promise<void> {
        // ask/auto/bypass 三档;extension 每次 tool_call 现读,写完即生效。
        // auto 的差异在 Cindy 侧 dispatcher(handleExtensionUiRequest),bridge 无感知。
        permissionMode = normalizePermissionMode(mode);
        await writePermissionFile();
      },

      isTurnRunning(): boolean {
        // ctx.isStreaming 由 agent_start / agent_settled 翻转(translator 维护)。
        return ctx.isStreaming;
      },

      async setPlanMode(enabled: boolean): Promise<void> {
        if (!planModeExtAvailable) {
          deps.logger.warn('pi setPlanMode ignored: plan-mode extension not available');
          return;
        }
        if (enabled === planModeActive) return; // 幂等:已在目标态不重复 toggle
        // /plan 是扩展命令,pi 即时执行(扩展命令不受 streaming 拒绝约束);toggle 翻转
        // pi 内部 planModeEnabled(开→禁 edit/write + 只读 bash;关→恢复全权)。
        const resp = await proc.request({ type: 'prompt', message: '/plan' });
        if (!resp.success) {
          throw new Error(`pi setPlanMode(/plan) rejected: ${resp.error ?? 'unknown'}`);
        }
        planModeActive = enabled;
      },

      getPlanMode(): boolean {
        return planModeActive;
      },

      async exportSessionHtml(outputPath?: string): Promise<string> {
        // pi 原生 export_html:纯本地渲染,不调网关。省略 outputPath 时 pi 自选默认位置。
        const command: Record<string, unknown> = { type: 'export_html' };
        if (outputPath && outputPath.trim().length > 0) command.outputPath = outputPath;
        const resp = await proc.request(command);
        if (!resp.success) {
          throw new Error(`pi export_html failed: ${resp.error ?? 'unknown'}`);
        }
        const path = (resp.data as { path?: string } | undefined)?.path;
        if (!path || path.trim().length === 0) {
          throw new Error('pi export_html: output path unavailable');
        }
        return path;
      },

      async compactSession(instructions?: string): Promise<ManualCompactResult> {
        // pi 原生 compact:调 LLM 生成摘要(耗时数秒起),压缩边界经
        // compaction_start/end 事件流上报,translator 映射成 compact_boundary。
        // 压缩请求本身可能远超 RPC 默认 30s 超时(大上下文 + 网关排队),放宽到 10 分钟。
        const command: Record<string, unknown> = { type: 'compact' };
        if (instructions && instructions.trim().length > 0) command.customInstructions = instructions.trim();
        const resp = await proc.request(command, { timeoutMs: PI_COMPACT_TIMEOUT_MS });
        if (!resp.success) {
          // 良性拒绝:上下文太小 / 无内容可压缩 —— 不是错误,返回 noop 让 UI 给信息性提示。
          const err = (resp.error ?? '').toLowerCase();
          if (err.includes('nothing to compact') || err.includes('too small')) {
            return { noop: true };
          }
          throw new Error(`pi compact failed: ${resp.error ?? 'unknown'}`);
        }
        const data = (resp.data ?? {}) as { tokensBefore?: number; estimatedTokensAfter?: number };
        const result: ManualCompactResult = {};
        if (typeof data.tokensBefore === 'number') result.tokensBefore = data.tokensBefore;
        if (typeof data.estimatedTokensAfter === 'number') result.estimatedTokensAfter = data.estimatedTokensAfter;
        return result;
      },
    };

    return handle;
  }

  /**
   * 会话分支(fork）—— 与 Codex 粗粒度 fork 同构。
   *
   * pi 的会话是 append-only entry 树,提供两条纯文件操作(不调模型):
   *   - clone:整条复制当前活动分支成新 session 文件并切过去(get_state.sessionFile 给新路径)
   *   - fork{entryId}:rewind 到某条 user 消息之前,同样落新 session 文件
   * 二者都离线,故这里 spawn 一个短命 `pi --mode rpc --offline` one-shot 进程完成,
   * 无需网关、无需真凭证。
   *
   * 语义映射(对齐 ForkSdkSessionOptions):
   *   - tailTurnsToDrop=0 → clone(整条 fork)
   *   - tailTurnsToDrop=N → fork 到倒数第 N 条 user 消息(丢掉尾部 N 个 turn);越界退化为 clone
   *   - upToMessageId 被忽略(pi 的锚点是 entry id,非 SDK message uuid;与 Codex 一致)
   *   - uuidMap 返回空(pi agentMeta 不落 SDK uuid,host 无处可 remap,不会 break 再 fork)
   */
  async forkSdkSession(opts: ForkSdkSessionOptions): Promise<ForkSdkSessionResult> {
    const log = this.deps.logger;
    const agentHome = this.resolveAgentHome();
    // 保证 models.json 里 provider `cindy` 可解析(pi 启动会校验 --provider)。
    await this.writeModelsJson(agentHome);
    const sessionDir = path.join(agentHome, 'sessions');

    // fork 全程离线(clone/fork 是纯 session 文件操作),真凭证拿不到也不影响;
    // 尽量取真 authEnv(含网关相关变量),失败则占位。
    const credentialMode = resolveAgentCredentialMode({ agentKind: 'pi' }) ?? 'gateway-key';
    let authEnv: Record<string, string | undefined> = {};
    try {
      authEnv = await this.deps.auth.getAuthEnv({ credentialMode });
    } catch {
      /* offline fork 不需要真凭证 */
    }

    // 模型 id 必须在 models.json 内(pi 启动校验 --model);用 host 注入的首个可用模型。
    const forkModel = this.capabilities.availableModels[0]?.id ?? 'claude-sonnet-5';

    const proc = new PiRpcProcess({
      binaryPath: this.deps.binaryPath,
      args: [
        '--mode', 'rpc',
        '--session-dir', sessionDir,
        '--session', opts.sourceSdkSessionId,
        '--provider', PI_PROVIDER_ID,
        '--model', forkModel,
        '--no-context-files',
        '--offline',
      ],
      cwd: opts.workingDir && opts.workingDir.trim().length > 0 ? opts.workingDir : sessionDir,
      env: {
        ...process.env,
        ...authEnv,
        [PI_API_KEY_ENV]: authEnv[PI_API_KEY_ENV] ?? 'pi-fork-offline',
        PI_CODING_AGENT_DIR: agentHome,
      },
      logger: log,
      onEvent: () => {},
      onExit: () => {},
    });

    try {
      // 首个 get_state 兼作"进程就绪"探测。
      const ready = await proc.request({ type: 'get_state' });
      if (!ready.success) {
        throw new Error(`pi fork: session load failed: ${ready.error ?? 'unknown'}`);
      }

      const tailDrop = normalizeTailTurnsToDrop(opts.tailTurnsToDrop);
      if (tailDrop > 0) {
        const fm = await proc.request({ type: 'get_fork_messages' });
        // 必须查 success:失败时 fm.data 为空会让 idx 恒负,误落"越界→整条 clone"分支,
        // 把 RPC 故障静默降级成"保留全部历史"(用户要丢尾却拿到全量),且日志误导排障。
        if (!fm.success) {
          throw new Error(`pi get_fork_messages failed: ${fm.error ?? 'unknown'}`);
        }
        const messages =
          (fm.data as { messages?: Array<{ entryId?: string }> } | undefined)?.messages ?? [];
        const idx = messages.length - tailDrop;
        const target = idx >= 0 ? messages[idx]?.entryId : undefined;
        if (target) {
          const fk = await proc.request({ type: 'fork', entryId: target });
          if (!fk.success) throw new Error(`pi fork(entryId) failed: ${fk.error ?? 'unknown'}`);
        } else {
          // 越界(要丢的 turn 比 user 消息还多）→ 退化为整条 clone,不静默丢语义。
          log.warn('pi fork: tailTurnsToDrop out of range, falling back to full clone', {
            tailTurnsToDrop: tailDrop,
            userMessageCount: messages.length,
          });
          const cl = await proc.request({ type: 'clone' });
          if (!cl.success) throw new Error(`pi clone failed: ${cl.error ?? 'unknown'}`);
        }
      } else {
        const cl = await proc.request({ type: 'clone' });
        if (!cl.success) throw new Error(`pi clone failed: ${cl.error ?? 'unknown'}`);
      }

      const st = await proc.request({ type: 'get_state' });
      const newPath = (st.data as { sessionFile?: string } | undefined)?.sessionFile;
      if (!newPath || newPath.trim().length === 0) {
        throw new Error('pi fork: forked session file path unavailable');
      }

      if (opts.title && opts.title.trim().length > 0) {
        await proc
          .request({ type: 'set_session_name', name: opts.title })
          .catch((err: unknown) =>
            log.warn('pi fork: set_session_name failed (non-fatal)', {
              message: err instanceof Error ? err.message : String(err),
            }),
          );
      }

      log.info('pi forkSdkSession ◀', {
        source: opts.sourceSdkSessionId,
        newSdkSessionId: newPath,
        tailTurnsToDrop: tailDrop,
      });
      // uuidMap 空:与 Codex 一致,pi agentMeta 不存 SDK message uuid。
      return { newSdkSessionId: newPath, uuidMap: new Map() };
    } finally {
      await proc.close();
    }
  }

  /**
   * ChatInput `/` palette 的 agent-skill 类目 —— 纯文件系统发现,与 CC/Codex 对齐。
   *
   * 扫共享根 ~/.agents/skills(cc/codex 同源,pi 因此看到一致的技能包)+ pi 原生
   * ~/.pi/agent/skills + 项目目录。只暴露技能"存在"(name/description),技能正文仅
   * 在 /skill:name 被调用时进上下文 —— 故此发现层零基线上下文增长(契合精简 pi)。
   */
  override async listAgentSkills(opts: ListAgentSkillsOptions): Promise<ListAgentSkillsResult> {
    const { items, errors } = await scanPiCustomizations({ workingDirs: [opts.workingDir] });
    const out: ListAgentSkillsResult = {
      skills: items
        .filter((it) => it.kind === 'skill' && it.enabled !== false)
        .map((it) => ({
          kind: 'agent-skill' as const,
          name: it.name,
          description: it.description,
          source: 'skill' as const,
          path: it.absolutePath,
          scope: (it.scope === 'repo' ? 'repo' : 'user') as 'user' | 'repo',
          enabled: it.enabled ?? true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
    if (errors.length > 0) out.errors = errors;
    return out;
  }

  /**
   * pi extension UI 子协议桥。
   *
   * cindy-bridge 的权限询问走 confirm(title='cindy:permission', message=JSON
   * {toolName, input}),映射成 InteractionRequest(kind='permission')交给
   * cindy 审批 UI;resolver 缺失或抛错一律 deny(fail-closed —— ask 档没人接
   * 不得放行)。其它 dialog 请求 cancelled 兜底,不挂死 agent loop。
   *
   * auto 档 dispatcher:弹窗前先过 Cindy Auto-Review Core(pi adapter 见
   * auto-review-policy.ts)—— `auto-approve` 静默放行,`prompt`/`prompt-each-time`
   * 照常升级弹窗(pi 无 allow-always 记忆,两档在此收敛为同一弹窗)。分类抛错按
   * 未分类处理(弹窗,不放行)。
   */
  private handleExtensionUiRequest(
    event: PiRpcEvent,
    proc: PiRpcProcess,
    getPermissionCtx: () => {
      resolver: InteractionResolver | null;
      permissionMode: 'ask' | 'auto' | 'bypassPermissions';
      workspaceRoots: string[];
    },
  ): void {
    const method = typeof event.method === 'string' ? event.method : '';
    const id = typeof event.id === 'string' ? event.id : undefined;
    if (!id) return;

    if (method === 'confirm' && event.title === 'cindy:permission') {
      let toolName = 'tool';
      let input: Record<string, unknown> = {};
      try {
        const payload = JSON.parse(typeof event.message === 'string' ? event.message : '{}') as {
          toolName?: unknown;
          input?: unknown;
        };
        if (typeof payload.toolName === 'string' && payload.toolName.length > 0) toolName = payload.toolName;
        if (payload.input && typeof payload.input === 'object') input = payload.input as Record<string, unknown>;
      } catch {
        /* keep defaults */
      }
      const { resolver, permissionMode, workspaceRoots } = getPermissionCtx();
      if (permissionMode === 'auto') {
        try {
          if (classifyPiToolForAutoReview({ toolName, input, workspaceRoots }) === 'auto-approve') {
            proc.send({ type: 'extension_ui_response', id, confirmed: true });
            return;
          }
        } catch (err) {
          this.deps.logger.warn('pi auto-review classification failed; escalating to prompt', {
            toolName,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!resolver) {
        this.deps.logger.warn('pi permission request denied: no interaction resolver', { toolName });
        proc.send({ type: 'extension_ui_response', id, confirmed: false });
        return;
      }
      void (async () => {
        try {
          const decision = await resolver({
            kind: 'permission',
            requestId: id,
            toolName,
            input,
          });
          const allow = decision.kind === 'permission' && decision.behavior === 'allow';
          proc.send({ type: 'extension_ui_response', id, confirmed: allow });
        } catch (err) {
          this.deps.logger.warn('pi permission resolver failed; denying', {
            toolName,
            message: err instanceof Error ? err.message : String(err),
          });
          proc.send({ type: 'extension_ui_response', id, confirmed: false });
        }
      })();
      return;
    }

    const isDialog = method === 'select' || method === 'confirm' || method === 'input' || method === 'editor';
    if (!isDialog) return;
    this.deps.logger.warn('pi extension dialog auto-cancelled (no mapping)', { method });
    proc.send({ type: 'extension_ui_response', id, cancelled: true });
  }
}
