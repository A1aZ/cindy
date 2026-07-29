/**
 * clientEndpointsService.ts
 * ---------------------------------------------------------------------------
 * 客户端远程端点清单(`<hotfix CDN base>/endpoint.json`)的 desktop 宿主层。
 *
 * 语义是**清单即唯一事实源 + 阻断式**(2026-07 与 Lizi 定案,三次收紧):
 * app.ready 内、createWindow / 一切更新检查之前解析清单;endpoint 字段允许按
 * region 缺失或留空,不会阻断启动;拉不到、JSON / schema 无法解析或非空值非法
 * 时才弹系统错误框(重试 / 退出),用户不重试成功就不放行启动。
 * **没有自动缓存回退、没有超时后静默继续、没有逐字段烘焙回退**——生效的端点
 * (含更新链 CDN base)默认全部来自本次拉到的清单,非空值配置非法会在启动时立刻暴露。
 *
 * 柔性只有两处,都不破坏"不静默降级":
 *  1. 弹框**之前**的网络层自动重试(AUTO_RETRY_DELAYS_MS,只对拉取失败生效、
 *     不对解析/校验失败生效),用于自愈首启瞬时抖动;重试用尽仍失败照样阻断。
 *  2. **用户在弹框上显式点击**的离线出口(2026-07 追加):传输层失败且本地存有
 *     上次成功清单时,弹框多一个「用上次配置启动」按钮。原设计连"用户明知自己
 *     离线、只想打开应用看看本地内容"都没有出口,只能反复弹框或退出。严格边界见
 *     endpointManifestCache.ts:只有**传输层**失败给出口(JSON / schema / 非法值 /
 *     region 不匹配,以及永久性 HTTP 3xx/4xx 这类配置事故照旧硬阻断——给出口等于
 *     帮用户绕过真实配置错,分类规则见 classifyManifestFailure),缓存存的是校验通过
 *     的原文、读回后重新走同一套严格解析,清单地址变化即作废,全程必须用户点击。
 *
 * 传输层失败在弹框前还会跑一轮分阶段诊断(endpointFetchDiagnostics:代理决策 /
 * DNS / TCP,每段各有硬 deadline——这段跑在阻断路径上,探针挂住等于启动卡死)
 * 并抓一份 netlog,摘要同时进日志和弹框。原因是 Electron `net.request`
 * 把 DNS、代理、TLS、被本机网络过滤扩展拦下全折叠成通用的 `ERR_FAILED`,
 * 只报一个错误码等于没有现场(2026-07 实测:同一 URL curl 与裸 Electron 都是 200,
 * 安装版毫秒级 ERR_FAILED,单看错误码无从下手)。
 *
 * 清单来源按运行形态三选一(resolveEndpointSource,纯函数可单测):
 *  - packaged / dev + --endpoints-cdn:从当前构建区域的烘焙自举基址
 *    ENDPOINT_MANIFEST_BASE_URL 直连拉取；另一物理区域的基址也在构建期注入，
 *    只用于组织区域发现和已绑定会话恢复；
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
  type ClientEndpointRegion,
  type ParseClientEndpointManifestResult,
  type RealmManifestBaseUrls,
} from '@cindy/maker-shared/client-endpoints';

import {
  createDefaultProbes,
  formatEndpointFetchDiagnosis,
  probeEndpointFetch,
  withDeadline,
} from './endpointFetchDiagnostics';
import {
  deriveTrustedEndpointDomains,
  findUntrustedCachedEndpoint,
  formatCacheSavedAt,
  readEndpointManifestCache,
  writeEndpointManifestCache,
} from './endpointManifestCache';
import {
  buildEndpointManifestDialogContent,
  type EndpointManifestDialogChoice,
  type EndpointManifestDialogLocale,
  type EndpointManifestFailureKind,
} from './endpointManifestDialogCopy';
import { createLogger, getLogDir } from './logger';
import {
  ENDPOINT_MANIFEST_BASE_URL,
  ENDPOINT_MANIFEST_PEER_BASE_URL,
} from '../shared/endpoints';
import { resolvePreferredSystemLocale } from '../shared/locale';

const log = createLogger('clientEndpoints');

const MANIFEST_FILE_NAME = 'endpoint.json';
const BUILD_VARIANT = import.meta.env.VITE_CINDY_AUTH_REGION;
/** 与 authManager 的构建区域判定保持一致；dev 使用 CN auth 身份。 */
const BUILD_AUTH_REGION: ClientEndpointRegion =
  BUILD_VARIANT === 'global' ? 'global' : 'cn';
const DEFAULT_REALM_MANIFEST_BASE_URLS: RealmManifestBaseUrls =
  BUILD_AUTH_REGION === 'global'
    ? {
        cn: ENDPOINT_MANIFEST_PEER_BASE_URL,
        global: ENDPOINT_MANIFEST_BASE_URL,
      }
    : {
        cn: ENDPOINT_MANIFEST_BASE_URL,
        global: ENDPOINT_MANIFEST_PEER_BASE_URL,
      };
/**
 * **缓存**端点允许落在的域(编译期锚点)。两份自举基址都由构建脚本注入二进制,
 * userData 里的任何写入都改不了它们,所以它是"这个构建被编译成信任哪些域"的唯一事实。
 * 取两份而不只取本区:CN 清单的 slack / telegram hook 在 cindy.app、其余在
 * cindy.com.cn,只取本区会把这两个合法端点判成不可信。仅约束缓存路径,理由见
 * endpointManifestCache.ts 的 findUntrustedCachedEndpoint。
 */
const TRUSTED_ENDPOINT_DOMAINS = deriveTrustedEndpointDomains([
  ENDPOINT_MANIFEST_BASE_URL,
  ENDPOINT_MANIFEST_PEER_BASE_URL,
]);

/** 单次请求的网络超时——只用于触发错误框,不是静默降级。 */
const ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * 弹阻断框**之前**的自动重试节奏(ms);长度 = 额外尝试次数,总尝试 = 1 + 长度。
 *
 * 背景(2026-07,mac 首次安装启动的现场反馈):本函数是 app.ready 的第一枪,而
 * "首次安装后的第一次启动"恰好是网络栈最冷的时刻——userData / Chromium profile
 * 与 network context 尚未建立、Gatekeeper 公证校验与 XProtect 还在扫整个 bundle、
 * 系统代理(macOS SystemConfiguration / PAC)与 DNS 全无缓存。原实现单次失败即
 * 弹阻断框,用户重启一次或点一下「重试」就正常 = 典型瞬时失败,却被呈现成
 * "无法获取服务器配置"。
 *
 * 这里补的只是"瞬时抖动自愈",不是静默降级:预算用尽仍失败照样弹框阻断,
 * 依然没有缓存回退、没有烘焙兜底。**只有网络层失败(fetch 未拿到正文)消耗
 * 预算**;JSON / schema / 非法值这类配置事故重试同一份内容没有意义,立刻弹框。
 *
 * 时长权衡:真断网时 DNS 立即失败,约 3.2s 就会弹框;最坏情况(三次都卡到
 * 15s 超时)约 48s 才弹框——此时网络确实不通,慢比误报好。
 */
const AUTO_RETRY_DELAYS_MS: readonly number[] = [800, 2400];

/**
 * 整个诊断阶段的兜底预算。生产实现(diagnoseCdnManifestFetch)内部每一段都已经各自
 * 有界、并发跑,墙钟约 11s;这里再套一层是因为 diagnose 是**注入点**——阻断路径上
 * 不允许出现"某个实现忘了设超时,于是启动永远停在这里"的可能。
 */
const DIAGNOSIS_TOTAL_BUDGET_MS = 15_000;

export const CLIENT_ENDPOINTS_SYNC_CHANNEL = 'client-endpoints:get-sync';

// ── 清单来源解析(纯函数,规则 14:内存 harness 可测) ─────────────────────

export type EndpointSource = { kind: 'cdn' } | { kind: 'file'; filePath: string };

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

/**
 * 一次清单取原文的结果。失败携带 `detail`(错误码级别的短标识)——原实现把
 * error 对象整个丢掉、统一折叠成 `fetch-failed`,现场只能看到一句
 * "fetch-failed",日志里也无从区分 DNS / 代理 / TLS / 超时,排查全靠猜。
 */
export type ManifestFetchResult =
  | { ok: true; text: string }
  /**
   * detail = 错误码级别的短标识(进 reason / 弹框);raw = 未抽码的原始错误消息,
   * 只进日志。两者分开是因为 `ERR_FAILED` 这类通用码丢掉原文后就再无信息可查。
   */
  | { ok: false; detail: string; raw?: string };

/** 归一为单行并截断:避免多行栈把弹框 detail 与日志行撑爆。 */
function normalizeDetail(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * 错误细节 → 简短错误码。Electron net 的 error.message 形如
 * `net::ERR_NAME_NOT_RESOLVED`,优先抽 `ERR_*` 码;抽不出时退回消息原文。
 */
function describeFetchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = /\b(ERR_[A-Z0-9_]+)\b/.exec(message)?.[1];
  return normalizeDetail(code ?? message);
}

/** 未抽码的原始错误消息(含 errno / syscall 等),只写日志不进弹框。 */
function rawFetchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const errno = err as NodeJS.ErrnoException | null;
  const extras = [errno?.code, errno?.syscall].filter(Boolean).join(' ');
  return normalizeDetail(extras ? `${message} (${extras})` : message);
}

/** 失败 detail → 阻断循环用的 reason(保持 maker-shared 的 `fetch-failed` 前缀语义)。 */
function fetchFailedReason(detail: string): string {
  const normalized = normalizeDetail(detail);
  return normalized ? `fetch-failed:${normalized}` : 'fetch-failed';
}

/** net.request 拉清单原文;任何失败(非 200 / 超时 / 异常)带错误码返回。 */
function fetchTextViaNet(url: string, timeoutMs: number): Promise<ManifestFetchResult> {
  return new Promise((resolve) => {
    try {
      const request = net.request(url);
      let body = '';
      let settled = false;
      const finish = (
        value: ManifestFetchResult,
        timeoutToClear?: ReturnType<typeof setTimeout>,
      ) => {
        if (settled) return;
        settled = true;
        if (timeoutToClear !== undefined) clearTimeout(timeoutToClear);
        if (!value.ok) {
          // raw 只在这里落日志:detail 抽过码后可能只剩 ERR_FAILED,原文是唯一现场。
          log.warn(
            'fetch failed (%s%s) for %s',
            value.detail,
            value.raw && value.raw !== value.detail ? ` | ${value.raw}` : '',
            url,
          );
        }
        resolve(value);
      };
      const timeout = setTimeout(() => {
        request.abort();
        finish({ ok: false, detail: `timeout-${timeoutMs}ms` });
      }, timeoutMs);

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          response.on('data', () => {});
          finish({ ok: false, detail: `http-${response.statusCode}` }, timeout);
          return;
        }
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => finish({ ok: true, text: body }, timeout));
        response.on('error', (err) =>
          finish(
            { ok: false, detail: describeFetchError(err), raw: rawFetchError(err) },
            timeout,
          ),
        );
      });
      request.on('error', (err) =>
        finish(
          { ok: false, detail: describeFetchError(err), raw: rawFetchError(err) },
          timeout,
        ),
      );
      request.end();
    } catch (err) {
      resolve({ ok: false, detail: describeFetchError(err), raw: rawFetchError(err) });
    }
  });
}

function fetchManifestViaCdn(timeoutMs: number): Promise<ManifestFetchResult> {
  if (!ENDPOINT_MANIFEST_BASE_URL) {
    // 烘焙基址缺失属打包/构建配置事故,同样走阻断暴露(→ 弹框)。
    log.error('ENDPOINT_MANIFEST_BASE_URL is empty (build misconfiguration)');
    return Promise.resolve({ ok: false, detail: 'missing-manifest-base-url' });
  }
  // cache-bust:防 Chromium / CDN 复用陈旧清单。
  return fetchTextViaNet(
    `${ENDPOINT_MANIFEST_BASE_URL}/${MANIFEST_FILE_NAME}?t=${Date.now()}`,
    timeoutMs,
  );
}

/** dev 本地清单文件读取;缺失 / 读失败带 errno 返回(→ 同一条阻断弹框链路)。 */
function readManifestFromFile(filePath: string): ManifestFetchResult {
  try {
    return { ok: true, text: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    log.warn('failed to read local endpoint manifest %s: %s', filePath, String(err));
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return { ok: false, detail: code ?? describeFetchError(err) };
  }
}

// ── 阻断式解析循环 ──────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * **不该被当成"清单配置错"的 4xx**。两类,理由不同但结论相同:
 *  - 瞬时:408 Request Timeout / 425 Too Early(传输层抖动)、429 Too Many Requests
 *    (被限流,过一会儿就好)——把它们判成配置错会让一个正被限流的用户既不能重试、
 *    又用不上手里那份可用缓存,直接开不了应用;
 *  - 环境侧:407 Proxy Authentication Required。按 RFC 9110 §15.5.8 它**只可能来自
 *    代理**,永远不会由源站发出,所以它描述的是这台机器的网络环境(代理凭据缺失或
 *    过期),不是清单的部署错。这恰恰是离线出口最该生效的场景——公司代理没登录时
 *    正好该允许用上次的配置把应用打开。它同时也会拿到重试预算,这是有意的:代价只有
 *    约 3.2s,而这期间系统/代理有可能把凭据补上。
 * 其余 3xx/4xx 才是路径 / 权限 / 部署配置错。
 */
const NON_CONFIG_4XX_STATUSES = new Set([407, 408, 425, 429]);

/** HTTP 状态码是否属于"重试没有意义"的永久性错误(分类与重试预算共用同一判定)。 */
function isPermanentHttpStatus(status: number): boolean {
  return status < 500 && !NON_CONFIG_4XX_STATUSES.has(status);
}

/**
 * 失败 reason → 失败分类(决定文案与是否给离线出口)。
 *
 * 分界不是"有没有拿到正文",而是**这次失败是不是我们的配置错**,并且与自动重试循环
 * 共用同一判定(isPermanentHttpStatus),避免同一个失败被判成"配置错所以不重试"又
 * "网络问题所以可以用缓存绕过":
 *  - 永久性 HTTP(3xx/4xx 去掉 NON_CONFIG_4XX_STATUSES)= 路径 / 权限 / 部署配置错 → config;
 *  - 5xx、407/408/425/429 与传输层失败(超时 / DNS / 代理 / ERR_*)→ network,可重试、可离线;
 *  - 烘焙基址为空是打包事故,同样 config。
 */
export function classifyManifestFailure(reason: string): EndpointManifestFailureKind {
  if (!reason.startsWith('fetch-failed')) return 'config';
  const detail = reason.slice('fetch-failed'.length).replace(/^:/, '');
  if (detail === 'missing-manifest-base-url') return 'config';
  const httpStatus = /^http-(\d+)$/.exec(detail)?.[1];
  if (httpStatus && isPermanentHttpStatus(Number(httpStatus))) return 'config';
  return 'network';
}

/** 弹框需要的全部上下文;由阻断循环组装,宿主只负责渲染与取回选择。 */
export interface ManifestPromptContext {
  reason: string;
  kind: EndpointManifestFailureKind;
  /** 分阶段网络诊断摘要;非网络失败或诊断未跑时为 null。 */
  diagnosis: string | null;
  /** 诊断产物(netlog / 日志)所在目录;拿不到时为 null。 */
  logPath: string | null;
  /** 有值 = 存在已通过严格解析的离线缓存,弹框应给出「用上次配置启动」。 */
  offlineSavedAt: string | null;
}

/** 严格解析过的离线缓存候选。 */
export interface OfflineManifestCandidate {
  parsed: Extract<ParseClientEndpointManifestResult, { ok: true }>;
  /** 已格式化好的写入时间,直接进弹框文案。 */
  savedAt: string;
}

/** 阻断循环的依赖注入面(规则 14:测试用内存 harness 驱动,不起 Electron)。 */
export interface BlockingResolveDeps {
  fetchManifest(timeoutMs: number): Promise<ManifestFetchResult>;
  /** 拉取/校验失败时问用户;生产实现是系统模态错误框。 */
  promptRetry(context: ManifestPromptContext): EndpointManifestDialogChoice;
  exitApp(): void;
  timeoutMs?: number;
  /** 仅 dev 本地文件路径为 true(localhost http);CDN 路径一律不传。 */
  allowHttp?: boolean;
  /**
   * 清单带 region 元数据时必须与构建区域一致；缺少元数据的旧清单仍保持兼容。
   */
  expectedRegionWhenPresent?: ClientEndpointRegion;
  /**
   * 弹框前的自动重试节奏,默认 AUTO_RETRY_DELAYS_MS。file 模式传 `[]` 关闭:
   * 本地文件读不到 / 内容非法都是配置事故,重读同一路径没有意义,只会白等。
   */
  autoRetryDelaysMs?: readonly number[];
  /** 仅测试注入(默认 setTimeout);让重试节奏在内存 harness 里零等待可测。 */
  sleep?(ms: number): Promise<void>;
  /**
   * 失败分类覆写,默认 classifyManifestFailure。dev 的本地文件模式传 `() => 'config'`:
   * 读不到 config/endpoint.json 的 reason 也是 `fetch-failed:ENOENT`,按默认规则会
   * 被判成网络失败,弹框于是让开发者"检查网络连接"——真正的问题在本地路径或内容。
   */
  classifyFailure?(reason: string): EndpointManifestFailureKind;
  /**
   * 弹框前的分阶段网络诊断(代理 / DNS / TCP + netlog)。只在网络层失败时调用,
   * 抛错不影响阻断流程——诊断是排查辅助,绝不能变成新的启动失败源。
   */
  diagnose?(reason: string): Promise<{ summary: string | null; logPath: string | null }>;
  /** 诊断阶段的兜底预算,默认 DIAGNOSIS_TOTAL_BUDGET_MS;仅测试需要调小。 */
  diagnosisBudgetMs?: number;
  /**
   * 读取并**严格解析**离线缓存;返回 null = 无可用缓存(缺失 / 损坏 / 清单地址
   * 变化 / region 不符)。只在网络层失败时调用,且结果仅用于点亮弹框上的离线按钮。
   */
  loadOfflineManifest?(): OfflineManifestCandidate | null;
  /**
   * 启动宿主保存清单元数据;纯端点调用方无需提供。
   * source 区分本次是网络拉到的还是用户选了离线缓存——宿主据此决定是否回写缓存。
   * rawText 只在 source==='network' 时给出:**校验通过的原始正文**。缓存必须存它而
   * 不是按当前 CLIENT_ENDPOINT_KEYS 重新序列化的结果,否则清单里那些本构建还不认识
   * 的新字段会被抹掉(前向兼容的发布模型正是"先发清单再发客户端"),等客户端升级后
   * 从这份缓存离线启动,新端点会静默变成空串。
   */
  onResolved?(
    manifest: Extract<ParseClientEndpointManifestResult, { ok: true }>,
    source: 'network' | 'cache',
    rawText?: string,
  ): void;
}

/**
 * 阻断式解析循环:成功返回完整端点 map;用户选择退出返回 null(调用方不再继续启动)。
 *
 * 每一轮 = 一次首发尝试 + 若干次自动重试(仅网络层失败消耗预算,见
 * AUTO_RETRY_DELAYS_MS);一轮全败才 promptRetry,用户选 'retry' 则重新开一轮
 * (同样带完整自动重试预算)。
 *
 * 出口只有三个,都由用户在弹框上点出来:retry(再来一轮)、exit(退出)、
 * offline(用上次成功清单启动,仅网络层失败且缓存可用时才会被点亮)。
 * **没有任何自动降级路径**——不点就一直阻断。
 */
export async function resolveClientEndpointsBlocking(
  deps: BlockingResolveDeps,
): Promise<ClientEndpointMap | null> {
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const options = deps.allowHttp ? { allowHttp: true } : undefined;
  const retryDelays = deps.autoRetryDelaysMs ?? AUTO_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? defaultSleep;

  for (;;) {
    let reason = 'fetch-failed';
    for (let attempt = 0; ; attempt += 1) {
      let fetched: ManifestFetchResult;
      try {
        fetched = await deps.fetchManifest(timeoutMs);
      } catch (err) {
        fetched = { ok: false, detail: describeFetchError(err), raw: rawFetchError(err) };
      }

      if (fetched.ok) {
        const parsed = resolveClientEndpointsStrict(fetched.text, options);
        if (parsed.ok) {
          if (
            deps.expectedRegionWhenPresent &&
            parsed.region !== null &&
            parsed.region !== deps.expectedRegionWhenPresent
          ) {
            reason = `region-mismatch:${deps.expectedRegionWhenPresent}:${parsed.region}`;
            break;
          }
          deps.onResolved?.(parsed, 'network', fetched.text);
          return parsed.endpoints;
        }
        // 拿到了正文但解析/校验不过 = 配置事故:重试同一份内容没有意义,直接弹框。
        reason = parsed.reason;
        break;
      }

      reason = fetchFailedReason(fetched.detail);
      // 构建/打包配置事故(基址为空)重试不会改变结果,立即跳出。
      if (fetched.detail === 'missing-manifest-base-url') break;
      // 永久性 HTTP(路径/权限/配置)重试同一 URL 不会自愈;5xx 与
      // NON_CONFIG_4XX_STATUSES(407/408/425/429)可能自愈,继续消耗预算。
      // 判定与失败分类共用 isPermanentHttpStatus,两处不会分叉。
      const httpStatus = /^http-(\d+)$/.exec(fetched.detail)?.[1];
      if (httpStatus && isPermanentHttpStatus(Number(httpStatus))) break;
      const delay = retryDelays[attempt];
      if (delay === undefined) break; // 预算用尽 → 阻断弹框
      log.warn(
        'manifest fetch failed (%s); auto-retry %d/%d in %dms',
        reason,
        attempt + 1,
        retryDelays.length,
        delay,
      );
      await sleep(delay);
    }

    const kind = (deps.classifyFailure ?? classifyManifestFailure)(reason);
    // 只有 network 才诊断:config 里包含"烘焙基址为空",拿空 URL 去跑 DNS/TCP
    // 只会得到一堆 invalid-url;HTTP 4xx / 内容非法也不是网络栈的问题。
    let diagnosis: string | null = null;
    let logPath: string | null = null;
    if (kind === 'network' && deps.diagnose) {
      try {
        // 兜底 deadline:diagnose 的内部各段都已有界,但它是注入点——阻断路径上不能
        // 存在"实现方忘了设超时就永久卡住启动"的可能。超时按诊断缺失继续弹框。
        const report = await withDeadline(
          deps.diagnose(reason),
          deps.diagnosisBudgetMs ?? DIAGNOSIS_TOTAL_BUDGET_MS,
          'diagnosis',
        );
        diagnosis = report.summary;
        logPath = report.logPath;
      } catch (err) {
        log.debug('manifest fetch diagnosis failed: %s', String(err));
      }
    }

    let offline: OfflineManifestCandidate | null = null;
    if (kind === 'network' && deps.loadOfflineManifest) {
      try {
        offline = deps.loadOfflineManifest();
      } catch (err) {
        log.debug('offline endpoint manifest unavailable: %s', String(err));
      }
    }

    log.warn(
      'client endpoints manifest unavailable (%s, kind=%s, diagnosis=%s, offline=%s), prompting user',
      reason,
      kind,
      diagnosis ?? 'n/a',
      offline ? 'available' : 'none',
    );
    const choice = deps.promptRetry({
      reason,
      kind,
      diagnosis,
      logPath,
      offlineSavedAt: offline?.savedAt ?? null,
    });
    if (choice === 'exit') {
      deps.exitApp();
      return null;
    }
    if (choice === 'offline' && offline) {
      log.warn(
        'starting with cached endpoint manifest (savedAt=%s) after user confirmation',
        offline.savedAt,
      );
      deps.onResolved?.(offline.parsed, 'cache');
      return offline.parsed.endpoints;
    }
    // 'retry',或选了离线但缓存在这一瞬间失效 → 重开一轮完整尝试。
  }
}

/** 弹框宿主实现:按系统语言取四语文案(不再中英混排),返回用户选择的语义。 */
function promptRetryDialog(
  context: ManifestPromptContext,
  sourceLabel: string,
  locale: EndpointManifestDialogLocale,
): EndpointManifestDialogChoice {
  const content = buildEndpointManifestDialogContent({
    locale,
    kind: context.kind,
    reason: context.reason,
    source: sourceLabel,
    diagnosis: context.diagnosis,
    logPath: context.logPath,
    offlineSavedAt: context.offlineSavedAt,
  });
  // createWindow 之前无父窗口,showMessageBoxSync 直接系统模态。
  const clicked = dialog.showMessageBoxSync({
    type: 'error',
    title: 'Cindy',
    message: content.message,
    detail: content.detail,
    buttons: content.buttons,
    defaultId: content.defaultId,
    cancelId: content.cancelId,
    noLink: true,
  });
  return content.choices[clicked] ?? 'exit';
}

// ── 模块状态与启动入口 ──────────────────────────────────────────────────────

let resolvedEndpoints: ClientEndpointMap | null = null;
let resolvedRegion: ClientEndpointRegion | null = null;
let crossRealmOrgLoginEnabled = BUILD_VARIANT !== 'dev';
let realmManifestBaseUrls: RealmManifestBaseUrls = DEFAULT_REALM_MANIFEST_BASE_URLS;
let activeSessionRealm: ClientEndpointRegion | null = null;
const realmEndpointCache = new Map<ClientEndpointRegion, ClientEndpointMap>();
/** 本次启动是否走了用户确认的离线缓存(而非本次网络拉取)。 */
let startedFromCachedManifest = false;

const BUILD_SCOPED_ENDPOINT_KEYS = new Set<ClientEndpointKey>([
  'websiteUrl',
  'cdnBaseUrl',
  'mobileUpdateBaseUrl',
]);

/** 弹框语言:跟随系统语言偏好列表,与原生菜单栏同一套解析。 */
function resolveDialogLocale(): EndpointManifestDialogLocale {
  const langs = app.getPreferredSystemLanguages();
  return resolvePreferredSystemLocale(langs.length > 0 ? langs : [app.getLocale()]);
}

/** netlog 固定文件名:每次失败覆盖同一份,避免在日志目录里无界堆积。 */
const ENDPOINT_NETLOG_FILE_NAME = 'endpoint-netlog.json';
/** 诊断用的额外一次请求预算,比正常尝试短——用户已经在等弹框。 */
const DIAGNOSIS_ATTEMPT_TIMEOUT_MS = 5_000;
/**
 * netLog start / stop 各自的预算。Chromium 的 NetworkService 或磁盘出问题时这两个
 * promise 也可能永不 settle,而它们同样在阻断路径上——不套 deadline 就等于把
 * "探针已经有超时"这件事白做了(review 抓到的正是这条剩余缺口)。
 */
const NETLOG_STEP_TIMEOUT_MS = 3_000;

/** netLog 里本模块用到的两个方法(测试注入内存实现,不起 Electron)。 */
export interface NetLogLike {
  startLogging(file: string, options: { captureMode: 'default' }): Promise<void>;
  stopLogging(): Promise<unknown>;
}

/**
 * 围绕一次请求抓 netlog。成功返回文件路径,任何异常都降级为 null(没有 netlog)。
 *
 * 三个 await 全部有界:start / stop 各 stepTimeoutMs,中间那次请求由调用方自带预算。
 * stop 超时只记日志、仍然返回文件路径——那份 netlog 已经落了盘(可能残缺),
 * 对排查仍有价值。
 *
 * **迟到成功的 start 必须补一次 stop**(review 抓到的第三条):withDeadline 只解除
 * 我们这边的等待,并不能取消 Electron 侧的操作。如果 startLogging 在超时之后才成功,
 * 一次**进程级**抓包就在无人收尾的情况下跑起来了——它会持续记录后续所有应用流量,
 * 让 endpoint-netlog.json 无界增长(顺带把与本次诊断无关的请求也录进去)。
 * 所以放弃等待时把收尾挂回原 promise 上,谁先到都保证有一次配对的 stop。
 */
export async function captureNetLogAround(
  netLogApi: NetLogLike,
  file: string,
  runWhileRecording: () => Promise<unknown>,
  stepTimeoutMs: number,
): Promise<string | null> {
  let stopped = false;
  const stopOnce = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await withDeadline(netLogApi.stopLogging(), stepTimeoutMs, 'netlog-stop');
    } catch (err) {
      log.debug('netlog stopLogging did not settle: %s', String(err));
    }
  };

  const startPromise = netLogApi.startLogging(file, { captureMode: 'default' });
  try {
    await withDeadline(startPromise, stepTimeoutMs, 'netlog-start');
  } catch (err) {
    // 放弃等待,但不放弃收尾:start 迟到成功时仍要把这次进程级抓包关掉。
    // startPromise 已 settle 时 then 会立即排上,所以不存在"标志位还没置好"的竞态。
    void startPromise.then(
      () => stopOnce(),
      () => {
        // start 本身失败 → 没有 capture 需要关闭;这里只是消化 rejection。
      },
    );
    log.debug('netlog capture failed: %s', String(err));
    return null;
  }

  try {
    await runWhileRecording();
  } finally {
    await stopOnce();
  }
  return file;
}

/**
 * 抓一份 netlog:在录制期间再打一次同样的清单请求,把 Chromium 内部对这次失败的
 * 判定(代理决策、socket、TLS、被谁取消)留在磁盘上。`ERR_FAILED` 这类通用码
 * 单看错误字符串永远得不到这些信息。
 */
async function captureEndpointNetLog(): Promise<string | null> {
  try {
    // 动态 import(仓内先例:mcp-providers / createDesktopProviderService):netLog 只在
    // 这条诊断路径用到,静态引入会让本模块的所有单测都必须在 electron mock 里补这个 key。
    const { netLog } = await import('electron');
    return await captureNetLogAround(
      netLog,
      path.join(getLogDir(), ENDPOINT_NETLOG_FILE_NAME),
      () => fetchManifestViaCdn(DIAGNOSIS_ATTEMPT_TIMEOUT_MS),
      NETLOG_STEP_TIMEOUT_MS,
    );
  } catch (err) {
    log.debug('netlog capture failed: %s', String(err));
    return null;
  }
}

/**
 * CDN 路径的诊断实现:分阶段探针摘要 + netlog 落盘路径。
 *
 * 两件事**并发**跑:探针只读网络栈状态、netlog 抓的是 Chromium 内部事件,互不干扰,
 * 串行只会让用户在阻断框前多等一截(墙钟从 ~15s 降到 ~11s)。
 */
async function diagnoseCdnManifestFetch(
  manifestUrl: string,
): Promise<{ summary: string | null; logPath: string | null }> {
  const [summary, netLogPath] = await Promise.all([
    probeEndpointFetch(manifestUrl, createDefaultProbes())
      .then((report) => {
        const line = formatEndpointFetchDiagnosis(report);
        log.warn('endpoint manifest fetch diagnosis: %s (%s)', line, manifestUrl);
        return line;
      })
      .catch((err: unknown) => {
        log.debug('endpoint fetch probe failed: %s', String(err));
        return null;
      }),
    captureEndpointNetLog(),
  ]);
  return { summary, logPath: netLogPath ?? getLogDirSafe() };
}

/** 日志目录取值失败(logger 未初始化)时不要连带炸掉阻断流程。 */
function getLogDirSafe(): string | null {
  try {
    return getLogDir();
  } catch {
    return null;
  }
}

/**
 * 读离线缓存并做与主路径完全相同的严格校验。任何一项不符都返回 null——
 * 弹框上就不会出现离线按钮,用户看到的仍是"重试 / 退出"。
 */
function loadOfflineManifestCandidate(
  manifestUrl: string,
  locale: EndpointManifestDialogLocale,
): OfflineManifestCandidate | null {
  let cached: ReturnType<typeof readEndpointManifestCache>;
  try {
    cached = readEndpointManifestCache(app.getPath('userData'));
  } catch {
    return null;
  }
  if (!cached) return null;
  if (cached.sourceUrl !== manifestUrl) {
    log.warn(
      'cached endpoint manifest ignored: source changed (cached=%s current=%s)',
      cached.sourceUrl,
      manifestUrl,
    );
    return null;
  }
  // 磁盘内容不被信任:CDN 路径同样零放松(不开 allowHttp)。
  const parsed = resolveClientEndpointsStrict(cached.manifestText);
  if (!parsed.ok) {
    log.warn('cached endpoint manifest ignored: %s', parsed.reason);
    return null;
  }
  if (parsed.region !== null && parsed.region !== BUILD_AUTH_REGION) {
    log.warn(
      'cached endpoint manifest ignored: region %s != build %s',
      parsed.region,
      BUILD_AUTH_REGION,
    );
    return null;
  }
  // 安全边界:这个文件在 userData、可被其他进程写,严格解析只管语法不管来源。
  // 用编译期烘焙的两份自举基址推导受信任域,拒掉攻击者自选的主机——否则一份被改过的
  // 缓存 + 一次 CDN 不可达,就能让 authManager 把 Bearer token 发到对方主机。
  const untrusted = findUntrustedCachedEndpoint(parsed.endpoints, TRUSTED_ENDPOINT_DOMAINS);
  if (untrusted) {
    log.error(
      'cached endpoint manifest rejected: endpoint %s outside trusted domains [%s]',
      untrusted,
      TRUSTED_ENDPOINT_DOMAINS.join(', '),
    );
    return null;
  }
  return { parsed, savedAt: formatCacheSavedAt(cached.savedAt, locale) };
}

/**
 * 把本次**校验通过的清单原文**写入缓存,供下次网络失败时的离线出口使用。
 *
 * 存原文而不是按当前 CLIENT_ENDPOINT_KEYS 重新序列化:清单的发布模型是前向兼容的
 * ——先上新字段的清单,再发认识它的客户端;老客户端按"未知字段忽略"接受这份清单。
 * 如果缓存写的是重新序列化的结果,那些字段就在写入时被抹掉了,等客户端升级后从这份
 * 缓存离线启动,新端点会静默变成空串(review 抓到的正是这条)。
 * 原文是刚刚被同一个 parser 接受过的,所以"存原文会不会读不回来"不成立;真正需要
 * 防的是读取时用新 parser 判定不通过,那条路径已经 fail closed(不给离线按钮)。
 */
function cacheResolvedManifest(manifestUrl: string, manifestText: string): void {
  let written = false;
  try {
    written = writeEndpointManifestCache(app.getPath('userData'), {
      savedAt: new Date().toISOString(),
      sourceUrl: manifestUrl,
      manifestText,
    });
  } catch (err) {
    log.debug('endpoint manifest cache write threw: %s', String(err));
  }
  if (!written) log.warn('failed to persist endpoint manifest cache');
}

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
  const manifestUrl = `${ENDPOINT_MANIFEST_BASE_URL}/${MANIFEST_FILE_NAME}`;
  const sourceLabel = source.kind === 'cdn' ? manifestUrl : source.filePath;
  const dialogLocale = resolveDialogLocale();
  // The resolver reports the parsed manifest through a callback. Keep it in a
  // box so TypeScript does not incorrectly conclude that the callback-owned
  // assignment is unreachable at the reads below.
  const resolvedManifestBox: {
    value: Extract<ParseClientEndpointManifestResult, { ok: true }> | null;
    fromCache: boolean;
  } = { value: null, fromCache: false };
  const endpoints = await resolveClientEndpointsBlocking({
    fetchManifest:
      source.kind === 'cdn'
        ? fetchManifestViaCdn
        : () => Promise.resolve(readManifestFromFile(source.filePath)),
    promptRetry: (context) => promptRetryDialog(context, sourceLabel, dialogLocale),
    exitApp: () => app.exit(1),
    allowHttp: source.kind === 'file',
    expectedRegionWhenPresent: BUILD_AUTH_REGION,
    // dev 本地文件:读不到就是路径/内容配置错,不自动重试、也按配置事故出文案
    // (见 BlockingResolveDeps 的 autoRetryDelaysMs / classifyFailure)。
    autoRetryDelaysMs: source.kind === 'cdn' ? undefined : [],
    classifyFailure: source.kind === 'cdn' ? undefined : () => 'config',
    // 诊断与离线出口只对 CDN 路径有意义:file 模式的失败是本地路径/内容配置错,
    // 探测网络毫无信息量,拿远端缓存顶掉本地正本更是把 dev 的配置错藏起来。
    diagnose: source.kind === 'cdn' ? () => diagnoseCdnManifestFetch(manifestUrl) : undefined,
    loadOfflineManifest:
      source.kind === 'cdn'
        ? () => loadOfflineManifestCandidate(manifestUrl, dialogLocale)
        : undefined,
    onResolved: (manifest, origin, rawText) => {
      resolvedManifestBox.value = manifest;
      resolvedManifestBox.fromCache = origin === 'cache';
      if (origin === 'network' && source.kind === 'cdn' && rawText) {
        cacheResolvedManifest(manifestUrl, rawText);
      }
    },
  });
  if (endpoints === null) return false; // 用户选择退出,app.exit 已调用
  const resolvedManifest = resolvedManifestBox.value;
  startedFromCachedManifest = resolvedManifestBox.fromCache;
  resolvedEndpoints = endpoints;
  resolvedRegion = resolvedManifest?.region ?? null;
  // 老清单没有 region 元数据，但它一定来自构建区域的自举地址。只把这份端点
  // 缓存在构建区域，不能同时塞进两区，否则升级后留下的跨区 token 会被误发。
  activeSessionRealm = resolvedRegion ?? BUILD_AUTH_REGION;
  realmEndpointCache.clear();
  realmEndpointCache.set(activeSessionRealm, endpoints);
  log.info(
    'resolved from %s (%s): auth=%s cdn=%s',
    startedFromCachedManifest
      ? 'cached manifest (user-confirmed offline start)'
      : source.kind === 'cdn'
        ? 'remote manifest'
        : 'local manifest file',
    sourceLabel,
    endpoints.authApiBaseUrl,
    endpoints.cdnBaseUrl,
  );
  return true;
}

/**
 * 本次启动是否用的是用户确认的离线缓存。需要联网的功能可以据此给出更准确的提示,
 * 而不是把"清单是旧的"表现成一堆各自失败的请求。
 */
export function isUsingCachedClientEndpoints(): boolean {
  return startedFromCachedManifest;
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
  if (BUILD_SCOPED_ENDPOINT_KEYS.has(key) || activeSessionRealm === null) {
    return resolvedEndpoints[key];
  }
  const sessionEndpoints = realmEndpointCache.get(activeSessionRealm);
  if (!sessionEndpoints) {
    throw new Error(`client endpoints for active realm '${activeSessionRealm}' not loaded`);
  }
  return sessionEndpoints[key];
}

/** 安装包身份/更新链始终读取启动时清单，不随组织会话区域切换。 */
export function getBuildClientEndpoint(key: ClientEndpointKey): string {
  if (resolvedEndpoints === null) {
    throw new Error('client endpoints not initialized');
  }
  return resolvedEndpoints[key];
}

export function getClientEndpointRealmConfig(): {
  buildRegion: ClientEndpointRegion;
  crossRealmOrgLoginEnabled: boolean;
  realmManifestBaseUrls: RealmManifestBaseUrls;
} {
  if (resolvedEndpoints === null) {
    throw new Error('client endpoints not initialized');
  }
  return {
    buildRegion: BUILD_AUTH_REGION,
    crossRealmOrgLoginEnabled,
    realmManifestBaseUrls,
  };
}

/**
 * 从构建期受信任地址加载指定区域清单。区域身份由地址表的 key 决定；清单不必
 * 重复自报 region，但一旦携带就必须与目标区域一致。失败不会修改当前会话端点，
 * 也不会退回构建区域发送跨区 token。
 */
export async function loadClientEndpointsForRealm(
  region: ClientEndpointRegion,
): Promise<ClientEndpointMap> {
  const cached = realmEndpointCache.get(region);
  if (cached) return cached;
  const baseUrl = realmManifestBaseUrls[region];
  if (!baseUrl) {
    throw new Error('realm-manifest-url-unavailable');
  }
  const fetched = await fetchTextViaNet(
    `${baseUrl}/${MANIFEST_FILE_NAME}?t=${Date.now()}`,
    ATTEMPT_TIMEOUT_MS,
  );
  if (!fetched.ok) {
    throw new Error(fetchFailedReason(fetched.detail));
  }
  const parsed = resolveClientEndpointsStrict(fetched.text);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  if (parsed.region !== null && parsed.region !== region) {
    throw new Error(`region-mismatch:${region}:${parsed.region}`);
  }
  realmEndpointCache.set(region, parsed.endpoints);
  return parsed.endpoints;
}

export function getClientEndpointForRealm(
  region: ClientEndpointRegion,
  key: ClientEndpointKey,
): string {
  if (BUILD_SCOPED_ENDPOINT_KEYS.has(key)) return getBuildClientEndpoint(key);
  const endpoints = realmEndpointCache.get(region);
  if (!endpoints) {
    throw new Error(`client endpoints for realm '${region}' not loaded`);
  }
  return endpoints[key];
}

export function activateClientEndpointRealm(region: ClientEndpointRegion): void {
  if (!realmEndpointCache.has(region)) {
    throw new Error(`client endpoints for realm '${region}' not loaded`);
  }
  activeSessionRealm = region;
}

export function resetClientEndpointRealm(): void {
  activeSessionRealm = resolvedRegion ?? BUILD_AUTH_REGION;
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

export interface ResetClientEndpointsForTestOptions {
  /** 指定后模拟一份真实带 region 元数据的构建清单。 */
  buildRegion?: ClientEndpointRegion;
  /** 注入其它区域清单，供运行期 realm 切换测试使用。 */
  realmEndpoints?: Partial<Record<ClientEndpointRegion, ClientEndpointMap>>;
  crossRealmOrgLoginEnabled?: boolean;
  realmManifestBaseUrls?: RealmManifestBaseUrls | null;
}

/** 仅测试:重置/注入模块状态。 */
export function resetClientEndpointsForTest(
  resolved?: ClientEndpointMap,
  options?: ResetClientEndpointsForTestOptions,
): void {
  resolvedEndpoints = resolved ?? null;
  resolvedRegion = resolved ? (options?.buildRegion ?? null) : null;
  startedFromCachedManifest = false;
  crossRealmOrgLoginEnabled = options?.crossRealmOrgLoginEnabled ?? BUILD_VARIANT !== 'dev';
  realmManifestBaseUrls =
    options?.realmManifestBaseUrls ?? DEFAULT_REALM_MANIFEST_BASE_URLS;
  activeSessionRealm = resolvedRegion;
  realmEndpointCache.clear();
  // 既有 desktop 单测只注入一份逻辑端点，不关心物理区域；让两种构建区域都能
  // 使用同一 fixture，避免测试辅助接口被生产清单元数据耦合。
  if (resolved) {
    if (resolvedRegion) {
      realmEndpointCache.set(resolvedRegion, resolved);
    } else {
      realmEndpointCache.set('cn', resolved);
      realmEndpointCache.set('global', resolved);
    }
  }
  for (const region of ['cn', 'global'] as const) {
    const endpoints = options?.realmEndpoints?.[region];
    if (endpoints) realmEndpointCache.set(region, endpoints);
  }
}
