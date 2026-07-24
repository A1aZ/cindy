/**
 * ssh-host-prefs-store —— 每台 SSH 远端机器的本地偏好(目前只有 autoConnect)。
 *
 * 设计上跟 ~/.ssh/config 解耦: 不污染用户的 ssh config (那是 ssh 客户端通用配置),
 * 用一个独立 JSON 落 <userData>/ssh-host-prefs.json. 数据极小, 同步 R/W + 内存
 * cache, 跟 codex-auth-mode-store / memory-settings-store 同套路。
 *
 * Schema:
 *   {
 *     "<hostId>": { "autoConnect": true },
 *     ...
 *   }
 *
 * 缺失 host 默认 autoConnect=false (启动不自动连, 新建对话不显远程项目入口)。
 * 这样老用户升级零破坏 —— 没有 prefs 文件就当所有 host 都没勾。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';

const log = createLogger('ssh-host-prefs-store');

export interface SshHostPref {
  autoConnect: boolean;
}

export type SshHostPrefs = Record<string, SshHostPref>;

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'ssh-host-prefs.json');
}

function normalize(raw: unknown): SshHostPrefs {
  if (!raw || typeof raw !== 'object') return {};
  const out: SshHostPrefs = {};
  for (const [hostId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    out[hostId] = { autoConnect: v.autoConnect === true };
  }
  return out;
}

let cached: SshHostPrefs | null = null;

/** 同步读取全部 prefs, 第一次从盘读, 后续走 cache. */
export function readSshHostPrefs(): SshHostPrefs {
  if (cached) return cached;
  const file = settingsFilePath();
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf-8');
      cached = normalize(JSON.parse(text));
      log.info('ssh host prefs loaded', { hosts: Object.keys(cached).length, path: file });
      return cached;
    }
  } catch (err) {
    log.warn('ssh-host-prefs.json read failed → falling back to empty', {
      error: err instanceof Error ? err.message : String(err),
      path: file,
    });
    try { fs.unlinkSync(file); } catch { /* no-op */ }
  }
  cached = {};
  return cached;
}

/** 单 host 的 autoConnect 标志, 缺失即 false. */
export function getSshHostAutoConnect(hostId: string): boolean {
  return readSshHostPrefs()[hostId]?.autoConnect === true;
}

/** 写入单 host 的 autoConnect, atomic write + 更新 cache. */
export function setSshHostAutoConnect(hostId: string, autoConnect: boolean): void {
  const current = { ...readSshHostPrefs() };
  current[hostId] = { ...current[hostId], autoConnect };
  const file = settingsFilePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  cached = current;
  log.info('ssh host autoConnect written', { hostId, autoConnect });
}

/** 是否至少一台 host 勾了 autoConnect. 新建对话「添加远程项目」入口的可见性 gate. */
export function hasAnyAutoConnectHost(): boolean {
  const prefs = readSshHostPrefs();
  for (const id of Object.keys(prefs)) {
    if (prefs[id]?.autoConnect) return true;
  }
  return false;
}

/** host 被删时清理 prefs (避免长尾僵尸 key). */
export function removeSshHostPref(hostId: string): void {
  const current = readSshHostPrefs();
  if (!(hostId in current)) return;
  const next = { ...current };
  delete next[hostId];
  const file = settingsFilePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  cached = next;
  log.info('ssh host pref removed', { hostId });
}
