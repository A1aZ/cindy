import type { DeviceLinkStatus } from '@cindy/device-link';
import { relayStatusHint, relayStatusLabel } from '@cindy/maker-shared/device-link-contract';

export interface MobileSettingsOverviewInput {
  authBaseUrl: string;
  authRegion: 'cn' | 'global' | 'dev';
  deviceId: string | null;
  deviceName: string;
  lastSyncedAt?: number | null;
  platform: string;
  relayStatus: DeviceLinkStatus;
  userEmail?: string | null;
  userId?: string | null;
  userName?: string | null;
}

export interface MobileSettingsRow {
  copyValue?: string;
  detail?: string;
  id: string;
  label: string;
  value: string;
}

export interface MobileSettingsSection {
  /** true 表示该分组默认折叠(如「调试 / 开发者」),普通用户不必直面。 */
  collapsible?: boolean;
  id: 'about' | 'debug';
  rows: MobileSettingsRow[];
  title: string;
}

/**
 * 设置页顶部账号头部。替代旧版重复的「账号 / 手机 / Relay」三 metric 条 —— 账号、设备、
 * 连接状态在这里一次性呈现,下面的分组不再重复同样的身份信息。
 */
export interface MobileSettingsHeader {
  deviceName: string;
  /** 仅当与展示名不同才给出,避免「名 = 邮箱」时重复两行。 */
  email?: string;
  name: string;
  relayDetail: string;
  relayLabel: string;
  relayTone: 'ready' | 'busy' | 'off';
}

export interface MobileSettingsOverview {
  header: MobileSettingsHeader;
  sections: MobileSettingsSection[];
}

/**
 * 把账号 / 设备 / 连接 / 调试信息整理成设置页的展示模型(纯函数,便于单测)。
 * 分两层:`header` 承载用户最常看的身份 + 连接状态;`sections` 把「关于这台手机」与
 * 默认折叠的「调试 / 开发者」分开,避免一墙 ID / hash 与真正可操作项平铺等权重。
 * App 版本 / OTA 运行信息不在此处 —— 由设置页的「版本」行直接读 expo-constants / expo-updates。
 */
export function buildMobileSettingsOverview(input: MobileSettingsOverviewInput): MobileSettingsOverview {
  const relayLabel = relayStatusLabel(input.relayStatus);
  const relayDetail = relayStatusHint(input.relayStatus, input.lastSyncedAt ?? null);
  const name = input.userName?.trim() || input.userEmail?.trim() || '未登录';
  const deviceName = input.deviceName.trim() || '当前手机';
  const email = input.userEmail?.trim();
  return {
    header: {
      deviceName,
      email: email && email !== name ? email : undefined,
      name,
      relayDetail,
      relayLabel,
      relayTone: relayStatusTone(input.relayStatus),
    },
    sections: [
      {
        id: 'about',
        title: '关于这台手机',
        rows: compactRows([
          {
            id: 'about.deviceName',
            label: '设备名称',
            value: deviceName,
            detail: '电脑端授权列表会显示这个名称。',
          },
          {
            id: 'about.platform',
            label: '平台',
            value: platformLabel(input.platform),
          },
          {
            id: 'about.remoteControl',
            label: '被控权限',
            value: '电脑端管理',
            detail: '手机只作为控制端。允许被控、撤销和恢复权限仍在电脑端设置里完成。',
          },
        ]),
      },
      {
        id: 'debug',
        title: '调试 / 开发者',
        collapsible: true,
        rows: compactRows([
          {
            id: 'debug.userId',
            label: '用户 ID',
            value: input.userId?.trim() || '未同步',
            copyValue: input.userId?.trim() || undefined,
          },
          {
            id: 'debug.deviceId',
            label: '设备 ID',
            value: input.deviceId?.trim() || '初始化中',
            copyValue: input.deviceId?.trim() || undefined,
          },
          {
            id: 'debug.authBaseUrl',
            label: 'Auth Server',
            value: input.authBaseUrl,
            copyValue: input.authBaseUrl,
          },
          {
            id: 'debug.authRegion',
            label: '登录区域',
            value: input.authRegion === 'global' ? 'Global' : 'CN',
          },
        ]),
      },
    ],
  };
}

export function relayStatusTone(status: DeviceLinkStatus): 'ready' | 'busy' | 'off' {
  if (status === 'online') return 'ready';
  if (status === 'connecting') return 'busy';
  return 'off';
}

function compactRows(rows: MobileSettingsRow[]): MobileSettingsRow[] {
  return rows.filter((row) => row.value.length > 0);
}

function platformLabel(platform: string): string {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  if (platform === 'web') return 'Web';
  return platform || 'Unknown';
}
