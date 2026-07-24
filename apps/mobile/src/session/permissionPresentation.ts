import {
  ClipboardList,
  CodeXml,
  Hand,
  Shield,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react-native';
import type { ThemeColors } from '@/theme';

/**
 * 权限模式的视觉呈现 —— **与桌面 `new-chat/PermissionSelector.tsx` 严格对齐**:
 * 同一权限模式用同一 lucide 图标、同一语义色。改这里前先对照桌面,保持跨端一致(见设计指南 §6)。
 *
 * 色彩规则(同桌面):只有 auto / bypass 着色,其余中性。
 *  - auto(自动审批)→ permAutoAccent(TapTap 星蓝 light / teal dark)
 *  - bypassPermissions(完全访问)→ statusAccent(Heart Orange)
 */
export type PermissionAccent = 'neutral' | 'auto' | 'bypass';

export interface PermissionPresentation {
  Icon: LucideIcon;
  label: string;
  accent: PermissionAccent;
}

const PRESENTATION: Record<string, PermissionPresentation> = {
  default: { Icon: Hand, label: '默认权限', accent: 'neutral' },
  ask: { Icon: Hand, label: '默认权限', accent: 'neutral' },
  acceptEdits: { Icon: CodeXml, label: '允许编辑', accent: 'neutral' },
  plan: { Icon: ClipboardList, label: '计划模式', accent: 'neutral' },
  auto: { Icon: Sparkles, label: '自动审批', accent: 'auto' },
  bypassPermissions: { Icon: TriangleAlert, label: '完全访问', accent: 'bypass' },
};

/** 取某权限模式的图标 / 标签 / 着色语义;未知 id 回退到中性盾牌 + 传入标签。 */
export function permissionPresentation(id: string, fallbackLabel?: string): PermissionPresentation {
  return PRESENTATION[id] ?? { Icon: Shield, label: fallbackLabel || id, accent: 'neutral' };
}

/** 把 accent 语义解析成当前主题的具体色值。 */
export function permissionAccentColor(accent: PermissionAccent, colors: ThemeColors): string {
  if (accent === 'auto') return colors.permAutoAccent;
  if (accent === 'bypass') return colors.statusAccent;
  return colors.textSecondary;
}
