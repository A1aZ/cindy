/**
 * 手机端语音词典展示模型(纯函数,不碰 UI 与网络)。
 *
 * 手机上的词典是**只读投影**:正本在电脑上,电脑之间用 CRDT 对等同步,手机拉一份
 * 快照用于润色。这里只负责「拿哪些电脑的词典」和「怎么排列词条」,让设置页那一层
 * 只剩渲染。
 */

import type { DeviceView } from '@cindy/device-link';
import type { MobileVoiceCredentialSyncDictionaryEntry } from '@cindy/maker-shared/device-link-contract';

/** 桌面平台白名单:词典只存在于电脑上,手机之间不互相同步。 */
const DESKTOP_PLATFORMS = new Set(['darwin', 'win32', 'linux']);

export interface MobileVoiceDictionaryHost {
  deviceId: string;
  name: string;
  online: boolean;
}

/**
 * 从设备清单里筛出可能持有词典的电脑。
 *
 * 排除自己(手机没有词典正本)与非桌面平台;在线的排前面,便于用户先看到当前
 * 能拉到最新内容的那台。同名设备按 deviceId 兜底排序,保证顺序稳定。
 */
export function collectMobileVoiceDictionaryHosts(
  devices: readonly DeviceView[],
): MobileVoiceDictionaryHost[] {
  return devices
    .filter((device) => !device.isSelf && isDesktopDevice(device.platform))
    .map((device) => ({
      deviceId: device.deviceId,
      name: device.name?.trim() || device.deviceId.slice(0, 8),
      online: Boolean(device.online),
    }))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name) || (a.deviceId < b.deviceId ? -1 : 1);
    });
}

export function isDesktopDevice(platform: string | null | undefined): boolean {
  return typeof platform === 'string' && DESKTOP_PLATFORMS.has(platform);
}

export interface MobileVoiceDictionaryEntryView {
  /** React key:归一化文本在一份词典里唯一。 */
  key: string;
  text: string;
  /** 别名(误识别写法),已按观察次数降序;没有则为空数组。 */
  aliases: string[];
}

/**
 * 把若干台电脑的词典快照合成用户看到的**那一份**词典。
 *
 * 词典对用户是单数:同账号下所有开启同步的电脑收敛到同一份内容,「哪台电脑的词典」
 * 不是用户需要理解的概念,更不该在界面上分组呈现 —— 同一台机器换过名字或重装过
 * 就会冒出好几个组,列表立刻没法看。
 *
 * 合并按归一化文本去重;同一个词在不同快照里频次不同(某台还没收敛完)时取最大值,
 * 别名取并集。这样只要有一台电脑拉取成功,用户就能看到完整词典。
 *
 * 排序按频次降序 —— 用得最多的排最前,与电脑端词典列表一致;频次并列时按文本排序
 * 保证稳定。
 */
export function buildMobileVoiceDictionaryEntryViews(
  snapshots: ReadonlyArray<readonly MobileVoiceCredentialSyncDictionaryEntry[]>,
  options?: { maxAliases?: number },
): MobileVoiceDictionaryEntryView[] {
  const maxAliases = options?.maxAliases ?? 3;
  const merged = new Map<
    string,
    { text: string; frequency: number; aliases: Map<string, { text: string; count: number }> }
  >();

  for (const entries of snapshots) {
    for (const entry of entries ?? []) {
      const text = entry?.text?.trim();
      if (!text) continue;
      const key = text.toLocaleLowerCase();
      const frequency = readPositive(entry.frequency);
      const existing = merged.get(key);
      const target = existing ?? { text, frequency, aliases: new Map() };
      if (existing) {
        // 频次取最大值而不是相加:这些快照是同一份词典的不同副本,相加会凭空翻倍。
        target.frequency = Math.max(existing.frequency, frequency);
      }
      for (const alias of entry.aliases ?? []) {
        const aliasText = alias?.text?.trim();
        if (!aliasText) continue;
        const aliasKey = aliasText.toLocaleLowerCase();
        const count = readPositive(alias.count);
        const existingAlias = target.aliases.get(aliasKey);
        target.aliases.set(aliasKey, {
          text: aliasText,
          count: existingAlias ? Math.max(existingAlias.count, count) : count,
        });
      }
      merged.set(key, target);
    }
  }

  return [...merged.entries()]
    .map(([key, entry]) => ({
      key,
      text: entry.text,
      aliases: [...entry.aliases.values()]
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
        .slice(0, maxAliases)
        .map((alias) => alias.text),
    }))
    .sort((a, b) => {
      const frequencyA = merged.get(a.key)?.frequency ?? 1;
      const frequencyB = merged.get(b.key)?.frequency ?? 1;
      if (frequencyA !== frequencyB) return frequencyB - frequencyA;
      return a.text.localeCompare(b.text);
    });
}

function readPositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}
