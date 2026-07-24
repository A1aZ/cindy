/**
 * clientEndpointsService.ts
 * ---------------------------------------------------------------------------
 * 客户端远程端点清单(`<hotfix CDN base>/endpoint.json`)的 desktop 宿主层。
 *
 * 语义是**清单即唯一事实源 + 阻断式**(2026-07 与 Lizi 定案,三次收紧):
 * app.ready 内、createWindow / 一切更新检查之前解析清单;endpoint 字段允许按
 * region 缺失或留空,不会阻断启动;拉不到、JSON / schema 无法解析或非空值非法
 * 时才弹系统错误框(重试 / 退出),用户不重试成功就不放行启动。
 * **没有缓存回退、没有超时后静默继续、没有逐字段烘焙回退**——生效的端点
 * (含更新链 CDN base)全部来自清单,非空值配置非法会在启动时立刻暴露。
 *
 * 清单来源按运行形态三选一(resolveEndpointSource,纯函数可单测):
 *  - packaged / dev + --endpoints-cdn:从烘焙自举基址 ENDPOINT_MANIFEST_BASE_URL
 *    (region 化 hotfix 域名,客户端唯一"有感"的烘焙远程 URL)直连拉取;
 *  - dev 默认:读仓内 `config/endpoint.json`(XDT_ENDPOINT_MANIFEST_FILE 可
 *    指定其它文件,restart:desktop:local 用它指到 config/endpoint.local.json),
 *    同一条阻断循环,文件缺失 / 非法同样弹框——配置错要炸出来,不静默猜测;
 *    仅本地文件路径放开 allowHttp(localhost 场景),CDN 路径校验零放松。
 *
 * 共享逻辑(schema / 非空 URL 校验 / 缺省字段归一)在 @cindy/maker-shared/client-endpoints;
 * 本文件负责 desktop 侧 IO 与 renderer 消费(sendSync IPC,首帧同步可用)。
 *
 * 依赖方向(2026-07 重构后):manifestService(更新链)经 getClientEndpoint
 * 读清单的 cdnBaseUrl——本文件**不得** import manifestService(会成环);
 * isDev 语义在此内联为 !app.isPackaged。
 */

import fs from 'node:fs';
import path from 'node:path';

import { app, dialog, ipcMain, net } from 'electron';

import {
  resolveClientEndpointsStrict,
  type ClientEndpointKey,
  type ClientEndpointMap,
} from '@cindy/maker-shared/client-endpoints';

import { createLogger } from './logger';
import { ENDPOINT_MANIFEST_BASE_URL } from '../shared/endpoints';

const log = createLogger('clientEndpoints');

const MANIFEST_FILE_NAME = 'endpoint.json';
/** 单次请求的网络超时——只用于触发错误框,不是静默降级。 */
const ATTEMPT_TIMEOUT_MS = 15_000;

export const CLIENT_ENDPOINTS_SYNC_CHANNEL = 'client-endpoints:get-sync';

// ── 清单来源解析(纯函数,规则 14:内存 harness 可测) ─────────────────────

export type EndpointSource =
  | { kind: 'cdn' }
  | { kind: 'file'; filePath: string };

export interface ResolveEndpointSourceInput {
  isPackaged: boolean;
  env: {
    /** '1' = dev 也走完整 CDN 拉取(index.ts 已把 --endpoints-cdn 收敛到该 env)。 */
    XDT_ENDPOINTS_CDN?: string;
    /** dev 本地清单文件覆盖(restart:desktop:local 指到 endpoint.local.json)。 */
    XDT_ENDPOINT_MANIFEST_FILE?: string;
  };
  /** 仓库根(dev 下 app.getAppPath() = apps/desktop,向上两级)。 */
  repoRoot: string;
}

/**
 * 决定清单从哪来:packaged 恒 CDN;dev 默认读仓内 config/endpoint.json,
 * XDT_ENDPOINT_MANIFEST_FILE 覆盖文件路径(相对路径以仓根为基准),
 * XDT_ENDPOINTS_CDN='1' 切回完整 CDN 链路。
 */
export function resolveEndpointSource(input: ResolveEndpointSourceInput): EndpointSource {
  if (input.isPackaged) return { kind: 'cdn' };
  if (input.env.XDT_ENDPOINTS_CDN === '1') return { kind: 'cdn' };
  const override = input.env.XDT_ENDPOINT_MANIFEST_FILE?.trim();
  const filePath = override
    ? path.resolve(input.repoRoot, override)
    : path.join(input.repoRoot, 'config', MANIFEST_FILE_NAME);
  return { kind: 'file', filePath };
}

// ── IO:CDN 拉取 / 本地文件读取 ─────────────────────────────────────────────

/** net.request 拉清单原文;任何失败(非 200 / 超时 / 异常)返回 null。 */
function fetchTextViaNet(url: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const request = net.request(url);
      let body = '';
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        request.abort();
        finish(null);
      }, timeoutMs);

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          log.info('HTTP %d for %s', response.statusCode, url);
          finish(null);
          return;
        }
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => finish(body));
        response.on('error', () => finish(null));
      });
      request.on('error', () => finish(null));
      request.end();
    } catch {
      resolve(null);
    }
  });
}

function fetchManifestTextViaCdn(timeoutMs: number): Promise<string | null> {
  if (!ENDPOINT_MANIFEST_BASE_URL) {
    // 烘焙基址缺失属打包/构建配置事故,同样走阻断暴露(fetch-failed → 弹框)。
    log.error('ENDPOINT_MANIFEST_BASE_URL is empty (build misconfiguration)');
    return Promise.resolve(null);
  }
  // cache-bust:防 Chromium / CDN 复用陈旧清单。
  return fetchTextViaNet(
    `${ENDPOINT_MANIFEST_BASE_URL}/${MANIFEST_FILE_NAME}?t=${Date.now()}`,
    timeoutMs,
  );
}

/** dev 本地清单文件读取;缺失 / 读失败返回 null(→ 同一条阻断弹框链路)。 */
function readManifestTextFromFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log.warn('failed to read local endpoint manifest %s: %s', filePath, String(err));
    return null;
  }
}

// ── 阻断式解析循环 ──────────────────────────────────────────────────────────

/** 阻断循环的依赖注入面(规则 14:测试用内存 harness 驱动,不起 Electron)。 */
export interface BlockingResolveDeps {
  fetchManifestText(timeoutMs: number): Promise<string | null>;
  /** 拉取/校验失败时问用户;生产实现是系统模态错误框。 */
  promptRetry(reason: string): 'retry' | 'exit';
  exitApp(): void;
  timeoutMs?: number;
  /** 仅 dev 本地文件路径为 true(localhost http);CDN 路径一律不传。 */
  allowHttp?: boolean;
}

/**
 * 阻断式解析循环:成功返回完整端点 map;用户选择退出返回 null(调用方不再继续启动)。
 * 失败 → promptRetry → 'retry' 无限重试;没有任何静默降级路径。
 */
export async function resolveClientEndpointsBlocking(
  deps: BlockingResolveDeps,
): Promise<ClientEndpointMap | null> {
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const options = deps.allowHttp ? { allowHttp: true } : undefined;
  for (;;) {
    let rawText: string | null = null;
    try {
      rawText = await deps.fetchManifestText(timeoutMs);
    } catch {
      rawText = null;
    }
    const result = resolveClientEndpointsStrict(rawText, options);
    if (result.ok) return result.endpoints;
    log.warn(`client endpoints manifest unavailable (${result.reason}), prompting user`);
    if (deps.promptRetry(result.reason) === 'exit') {
      deps.exitApp();
      return null;
    }
  }
}

function promptRetryDialog(reason: string, sourceLabel: string): 'retry' | 'exit' {
  // createWindow 之前无父窗口,showMessageBoxSync 直接系统模态。
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'Cindy',
    message: '无法获取服务器配置',
    detail:
      `启动所需的服务器端点清单获取失败(${reason})。\n` +
      `来源 source: ${sourceLabel}\n` +
      '请检查网络连接后重试;无法联网时应用不能继续启动。\n\n' +
      `Failed to load the server endpoint manifest (${reason}). ` +
      'Please check your network connection and retry.',
    buttons: ['重试 Retry', '退出 Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return choice === 0 ? 'retry' : 'exit';
}

// ── 模块状态与启动入口 ──────────────────────────────────────────────────────

let resolvedEndpoints: ClientEndpointMap | null = null;

/**
 * 启动第一步(先于一切更新检查):阻断式解析清单(packaged=CDN;dev=本地文件,
 * --endpoints-cdn 时同 packaged)。返回 true = 可以继续启动;false = 用户在
 * 错误框选择退出(app.exit 已调用,调用方必须立即 return,不再继续启动流程)。
 */
export async function initClientEndpoints(): Promise<boolean> {
  const source = resolveEndpointSource({
    isPackaged: app.isPackaged,
    env: {
      XDT_ENDPOINTS_CDN: process.env.XDT_ENDPOINTS_CDN,
      XDT_ENDPOINT_MANIFEST_FILE: process.env.XDT_ENDPOINT_MANIFEST_FILE,
    },
    // dev 下 app.getAppPath() = apps/desktop;packaged 不走 file 分支,该值无消费。
    repoRoot: path.resolve(app.getAppPath(), '..', '..'),
  });
  const sourceLabel =
    source.kind === 'cdn'
      ? `${ENDPOINT_MANIFEST_BASE_URL}/${MANIFEST_FILE_NAME}`
      : source.filePath;
  const endpoints = await resolveClientEndpointsBlocking({
    fetchManifestText:
      source.kind === 'cdn'
        ? fetchManifestTextViaCdn
        : () => Promise.resolve(readManifestTextFromFile(source.filePath)),
    promptRetry: (reason) => promptRetryDialog(reason, sourceLabel),
    exitApp: () => app.exit(1),
    allowHttp: source.kind === 'file',
  });
  if (endpoints === null) return false; // 用户选择退出,app.exit 已调用
  resolvedEndpoints = endpoints;
  log.info(
    'resolved from %s (%s): auth=%s cdn=%s',
    source.kind === 'cdn' ? 'remote manifest' : 'local manifest file',
    sourceLabel,
    endpoints.authApiBaseUrl,
    endpoints.cdnBaseUrl,
  );
  return true;
}

/**
 * 运行期端点读取入口(main 进程)。init 成功前调用 = 启动时序 bug,直接抛错
 * 炸出来(没有任何烘焙兜底可回落;--smoke-test 旁路只碰 localDb,不消费端点)。
 */
export function getClientEndpoint(key: ClientEndpointKey): string {
  if (resolvedEndpoints === null) {
    throw new Error(
      `client endpoints not initialized (getClientEndpoint('${key}') called before initClientEndpoints)`,
    );
  }
  return resolvedEndpoints[key];
}

export function getResolvedClientEndpoints(): ClientEndpointMap {
  if (resolvedEndpoints === null) {
    throw new Error('client endpoints not initialized');
  }
  return { ...resolvedEndpoints };
}

/** renderer 首帧同步读取(preload 模块级 sendSync);必须在 createWindow() 前注册。 */
export function registerClientEndpointsIpc(): void {
  ipcMain.on(CLIENT_ENDPOINTS_SYNC_CHANNEL, (event) => {
    event.returnValue = getResolvedClientEndpoints();
  });
}

/** 仅测试:重置/注入模块状态。 */
export function resetClientEndpointsForTest(resolved?: ClientEndpointMap): void {
  resolvedEndpoints = resolved ?? null;
}
