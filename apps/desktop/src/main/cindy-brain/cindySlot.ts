/**
 * cindySlot.ts — cindy 槽代办(卡槽⑤,原名模型槽)。
 * ---------------------------------------------------------------------------
 * 意识沙箱零网络零文件,
 * 想用 AI 只能经管子请主机代办。本模块处理上行 cindy-request(旧名 model-request 兼容):
 *
 *   电子脑 cindy.send({type:'cindy-request', kind:'gen_image'|'edit_image'|'gen_video'|'edit_video', …})
 *     → 资格审(声明了 'cindy' 卡槽 + 能力详单?按类目.动作粒度)
 *     → 频控(默认不限并发;用户可按意识配置在途上限,经 deps.getInflightLimit
 *       注入——配了才闸,防失控刷付费接口;配额治理随分发渠道重启)
 *     → 模型白名单校验(意识只能从主机菜单里挑,挑不了菜单外的任何路由;
 *       图像/视频各一份白名单与默认,同来自 providers.json 目录)
 *     → 吃源图的代办(改图/图生视频):指纹逐张查账验归属(只能用自己名下的媒体)
 *     → 主机走统一媒体通道干活(字节从头到尾在主机手里;视频为分钟级长任务)
 *     → 落 blob(SHA-256 主机算)+ 账本记账(出生=该意识)
 *     → 只回指纹/地址字符串(GhostPipeModelResult)
 *
 * 记账口径:意识产物加一条
 * ghost-gallery ref(出生=该意识)——面板供图的归属校验(ghostCanRead)
 * 与"产物不被回收"同时成立;配额上限由权限策略负责。
 *
 * 依赖注入(规则 14):生成/落盘/记账/归属解析全部经 deps,单测直测。
 */

import {
  GHOST_MODEL_TIERS,
  type GhostModelTier,
  type GhostPipeModelResult,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { probeImageSize } from './imageProbe.js';

/** 媒体能力配置(图像/视频同构):白名单 + 默认/档位选型,真身在 providers.json 目录。 */
export interface CindyMediaConfig {
  models: ReadonlyArray<{ id: string; label: string }>;
  defaults: { standard: string; draft: string; best: string };
}

export interface CindySlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 主机统一图片通道(art 底层客户端);返回图片字节与 mime。 */
  generateImage(params: { prompt: string; model: string }): Promise<{ buffer: Uint8Array; mimeType: string }>;
  /** 主机统一图片通道·改图;源图以磁盘路径喂给网关(意识摸不到路径)。 */
  editImage(params: {
    prompt: string;
    model: string;
    imagePaths: string[];
  }): Promise<{ buffer: Uint8Array; mimeType: string }>;
  /**
   * 主机统一视频通道·文生视频(art 视频 provider 层复用,submit→
   * 轮询→下载一条龙在注入实现里完成);返回视频字节与 mime。长任务:
   * 分钟级才 resolve,在途名额在整个等待期占用。
   */
  generateVideo(params: { prompt: string; model: string }): Promise<{ buffer: Uint8Array; mimeType: string }>;
  /** 主机统一视频通道·参考图生视频(1 张=首帧,2 张=首尾帧;源图以磁盘路径注入)。 */
  editVideo(params: {
    prompt: string;
    model: string;
    imagePaths: string[];
  }): Promise<{ buffer: Uint8Array; mimeType: string }>;
  /**
   * 指纹 → 磁盘路径,且仅当该媒体在此意识名下(出生或画廊,查账本);
   * 不属于它 / 查无此账 / 文件缺失一律 null(不区分,不给探测空间)。
   */
  resolveOwnedMedia(ghostId: string, hash: string): Promise<string | null>;
  /**
   * 意识专属后端覆盖(解析表第②层,用户在意识详情页钉的);无覆盖返回
   * null。capability 为能力键(image.generate / video.edit …);返回值仍过
   * 白名单校验(型号可能已随主机演进下架)。
   */
  getOverride(ghostId: string, capability: string): string | null;
  /**
   * 当前图像能力配置——真身是 providers.json 运行时目录(与会话模型列表
   * 同一获取来源),每单现读跟随热更。models = 白名单与显示名;defaults =
   * 默认/档位选型(同样来自目录,代码零模型字面量)。
   */
  getImageConfig(): CindyMediaConfig;
  /** 当前视频能力配置(同 getImageConfig 语义;白名单 id = 视频 provider 层 alias)。 */
  getVideoConfig(): CindyMediaConfig;
  /**
   * 该意识的在途代办并发上限(用户配置,隐藏配置层级);null = 未配置 =
   * 不限并发。可选依赖:不注入等同全部不限。每单现读,配置热更即生效。
   */
  getInflightLimit?(ghostId: string): number | null;
  /** 落 blob + 账本记账(出生=该意识);返回取件地址与指纹。 */
  saveGhostMedia(params: {
    ghostId: string;
    buffer: Uint8Array;
    mimeType: string;
    /** 人类可读备注(记进账本 label,画廊 caption 用)。 */
    label?: string;
    /** tool-call callId(记入 ghostMediaLedger 供 ghost_call 收口带回)。 */
    callId?: string;
  }): Promise<{ url: string; hash: string; ext: string }>;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** prompt 长度上限(与 ghost.json 工具声明的量级一致,防沙箱塞超长文本)。 */
const MAX_PROMPT_LEN = 4000;

/** 改图单次源图上限(沿用原 lizi_art 多图融合的常用量级)。 */
const MAX_EDIT_SOURCES = 4;

/** 图生视频参考图上限(1 张=首帧动画,2 张=首尾帧过渡;provider 层同上限)。 */
const MAX_VIDEO_SOURCES = 2;

/** 归因号长度上限(tool-call 配对号量级;超长视为沙箱乱填,拒单防日志注水)。 */
const MAX_CALL_ID_LEN = 128;

/** 每种代办类型的静态口径(类目/动作/是否吃源图/人话动词)。 */
interface CindyKindInfo {
  category: 'image' | 'video';
  action: 'generate' | 'edit';
  usesSources: boolean;
  maxSources: number;
  /** 人话动词(资格审与失败话术)。 */
  verb: string;
}

const KIND_INFO: Record<string, CindyKindInfo> = {
  gen_image: { category: 'image', action: 'generate', usesSources: false, maxSources: 0, verb: '出图' },
  edit_image: { category: 'image', action: 'edit', usesSources: true, maxSources: MAX_EDIT_SOURCES, verb: '改图' },
  gen_video: { category: 'video', action: 'generate', usesSources: false, maxSources: 0, verb: '生成视频' },
  edit_video: { category: 'video', action: 'edit', usesSources: true, maxSources: MAX_VIDEO_SOURCES, verb: '图生视频' },
};

const CATEGORY_LABEL: Record<CindyKindInfo['category'], string> = { image: '图像', video: '视频' };

/**
 * ── 图像能力的选型解析(2026-07-11 设计定案)──────────────────────────
 * 意识只表达意图(tier 档位)或透传用户显式点名(model);"用谁干"由主机
 * 解析,优先级:调用显式点名 > 意识专属覆盖(意识详情页钉的,经
 * getImageOverride 注入)> 档位/出厂默认。用户能力全局偏好层等多供应商
 * 接入时在覆盖与档位之间插入。
 */

// 可选清单与默认/档位选型都不再是本模块常量:经 deps.getImageConfig 注入,
// 真身来自 providers.json 运行时目录(与会话模型列表同一获取来源,OSS 热更
// 同机制),见 index.ts 的 getCatalogImageConfig。本文件零模型字面量。

/** 指纹形状(与 blobStore 同一规则;这里先粗筛,细校验在归属解析)。 */
const HASH_RE = /^[0-9a-f]{64}$/;

export class GhostCindySlot {
  private readonly inflight = new Map<string, number>();

  constructor(private readonly deps: CindySlotDeps) {}

  /**
   * 处理一条 cindy-request(ghost-pipe:send 的 invoke 返回值即本结果)。
   * 永不 reject——一切失败折叠成 { ok:false, message },沙箱拿到的是
   * 结构化拒绝而不是异常穿透。
   */
  async handleModelRequest(ghostId: string, payload: unknown): Promise<GhostPipeModelResult> {
    const p = payload as {
      kind?: unknown;
      prompt?: unknown;
      tier?: unknown;
      model?: unknown;
      hashes?: unknown;
      callId?: unknown;
    };
    const info = typeof p?.kind === 'string' ? KIND_INFO[p.kind] : undefined;
    if (!info) {
      return { ok: false, message: `未知的代办类型(当前支持 ${Object.keys(KIND_INFO).join(' / ')})` };
    }
    const kind = p.kind as string;
    if (typeof p.prompt !== 'string' || p.prompt.trim().length === 0) {
      return { ok: false, message: 'prompt 不能为空' };
    }
    if (p.prompt.length > MAX_PROMPT_LEN) {
      return { ok: false, message: `prompt 过长(上限 ${MAX_PROMPT_LEN} 字符)` };
    }
    // 归因号:可选——tool-call 触发的代办把 callId 原样带回,日志/
    // 配额由此对上"哪次调用花的钱";面板交互等自发代办可不带,日志记
    // unattributed。带了就必须像样(非空字符串、长度设限),乱填拒单。
    if (p.callId !== undefined && (typeof p.callId !== 'string' || p.callId.length === 0 || p.callId.length > MAX_CALL_ID_LEN)) {
      return { ok: false, message: 'callId 不合法(1–128 字符的字符串,或不传)' };
    }
    const callId = (p.callId as string | undefined) ?? 'unattributed';

    // 选型优先级(低 → 高逐层覆盖):出厂默认 → 档位(意识意图,主机翻译)
    // → 意识专属覆盖(用户在详情页钉的)→ 调用显式点名(用户当场说的)。
    // 意识报了白名单外的名字 = 拒,不静默降级。配置按类目取(图像/视频
    // 各一份白名单与默认,同来自 providers.json 目录)。
    const cfg = info.category === 'image' ? this.deps.getImageConfig() : this.deps.getVideoConfig();
    const whitelist = new Set(cfg.models.map((m) => m.id));
    let model = cfg.defaults.standard;
    if (p.tier !== undefined) {
      if (typeof p.tier !== 'string' || !(GHOST_MODEL_TIERS as readonly string[]).includes(p.tier)) {
        return { ok: false, message: `未知档位(可用:${GHOST_MODEL_TIERS.join(' / ')})` };
      }
      model = cfg.defaults[p.tier as GhostModelTier];
    }
    const capability = `${info.category}.${info.action}`;
    const override = this.deps.getOverride(ghostId, capability);
    if (override !== null) {
      if (whitelist.has(override)) {
        model = override;
      } else {
        // 钉的型号已随白名单演进下架:落回上面的档位/默认,不让老配置卡死能力。
        this.deps.log?.warn('ghost cindy override no longer whitelisted, ignored', { ghostId, override });
      }
    }
    if (p.model !== undefined) {
      if (typeof p.model !== 'string' || !whitelist.has(p.model)) {
        return { ok: false, message: '不支持的模型(不在主机白名单内)' };
      }
      model = p.model;
    }

    const ghost = this.deps.getGhost(ghostId);
    if (!ghost || !ghost.enabled) {
      return { ok: false, message: '意识不在可用状态' };
    }
    if (!ghost.manifest.slots?.includes('cindy')) {
      // 身份卡没声明模型槽 = 结构上没有这个器官,直接拒。
      return { ok: false, message: '本意识未声明 cindy 卡槽,无权请 Cindy 代办' };
    }
    // 能力粒度资格审:详单里没申请的动作点不了(缺详单 = 零能力,提示作者补声明)。
    const declaredActions: readonly string[] = ghost.manifest.cindy?.[info.category] ?? [];
    if (!declaredActions.includes(info.action)) {
      return {
        ok: false,
        message: `本意识未声明${CATEGORY_LABEL[info.category]}「${info.verb}」能力(身份卡 cindy.${info.category} 缺 "${info.action}"),请意识作者更新声明`,
      };
    }

    // 吃源图的代办(改图/图生视频):指纹形状先粗筛(不占在途名额),
    // 归属查账在下面占名额后做。
    let hashes: string[] = [];
    if (info.usesSources) {
      if (!Array.isArray(p.hashes) || p.hashes.length === 0) {
        return { ok: false, message: `${info.verb}需要至少 1 张源图指纹(hashes)` };
      }
      if (p.hashes.length > info.maxSources) {
        return { ok: false, message: `源图过多(上限 ${info.maxSources} 张)` };
      }
      for (const h of p.hashes) {
        if (typeof h !== 'string' || !HASH_RE.test(h)) {
          return { ok: false, message: '源图指纹格式不合法' };
        }
      }
      hashes = p.hashes as string[];
    }

    // 在途并发闸:默认不限;用户给该意识配了上限才拦(计数始终在记,
    // 配置热更后立即按新上限判)。
    const inflight = this.inflight.get(ghostId) ?? 0;
    const inflightLimit = this.deps.getInflightLimit?.(ghostId) ?? null;
    if (inflightLimit !== null && inflight >= inflightLimit) {
      return { ok: false, message: `同时进行的代办已达上限(${inflightLimit} 单),请稍后再试` };
    }

    this.inflight.set(ghostId, inflight + 1);
    try {
      // 日志口径:发生的事件是"一单 cindy 代办"(kind = 代办类型),槽只是
      // 资格概念不进文案;归因三件套 ghostId / kind / callId 三处日志一致。
      this.deps.log?.info(`ghost cindy-request ${kind} start`, { ghostId, model, callId });

      // 吃源图的代办:逐张查账验归属——任何一张不是它名下的,整单拒
      // (统一话术不泄露细节)。
      const imagePaths: string[] = [];
      for (const hash of hashes) {
        const abs = await this.deps.resolveOwnedMedia(ghostId, hash);
        if (!abs) {
          return { ok: false, message: '源图不在本意识名下(仅能改自己生成或画廊里的媒体)' };
        }
        imagePaths.push(abs);
      }

      let generated: { buffer: Uint8Array; mimeType: string };
      if (kind === 'edit_image') {
        generated = await this.deps.editImage({ prompt: p.prompt, model, imagePaths });
      } else if (kind === 'gen_image') {
        generated = await this.deps.generateImage({ prompt: p.prompt, model });
      } else if (kind === 'edit_video') {
        generated = await this.deps.editVideo({ prompt: p.prompt, model, imagePaths });
      } else {
        generated = await this.deps.generateVideo({ prompt: p.prompt, model });
      }

      const saved = await this.deps.saveGhostMedia({
        ghostId,
        buffer: generated.buffer,
        mimeType: generated.mimeType,
        label: p.prompt.slice(0, 200),
        // 模型代办产物记账(ghostMediaLedger),随 ghost_call 收口带回;
        // 未署名('unattributed')不记,与 networkSlot 同契约防并发串账
        ...(callId !== 'unattributed' ? { callId } : {}),
      });
      this.deps.log?.info(`ghost cindy-request ${kind} done`, {
        ghostId,
        model,
        callId,
        hash: saved.hash,
        bytes: generated.buffer.byteLength,
      });
      // 实际选型随结果回传(主机权威信息):意识交卷 note、会话里的 AI 与
      // 用户由此看得见"这单是谁画的"。
      const modelLabel = cfg.models.find((m) => m.id === model)?.label ?? model;
      // 图片代办附带像素宽高(字节头解析,best-effort):意识供聊天卡片时
      // 据此精确声明卡高,首帧零跳动;解析不出就缺省,意识回退估计值。
      const dims =
        kind === 'gen_image' || kind === 'edit_image' ? probeImageSize(generated.buffer) : null;
      return { ok: true, url: saved.url, hash: saved.hash, ext: saved.ext, model, modelLabel, ...(dims ?? {}) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.warn(`ghost cindy-request ${kind} failed`, { ghostId, callId, error: message });
      return { ok: false, message: `${info.verb}失败:${message}` };
    } finally {
      const left = (this.inflight.get(ghostId) ?? 1) - 1;
      if (left <= 0) this.inflight.delete(ghostId);
      else this.inflight.set(ghostId, left);
    }
  }
}
