/**
 * 「待授权」语音快捷键自动恢复失败时的提示。
 *
 * 触发场景：用户在语音输入设置页**之外**拿到 macOS 监听权限（切走 tab 后才去系统设置里
 * 打开开关），main 侧的兜底恢复据此重新注册，但 helper 仍起不来（二进制缺失、swiftc 失败、
 * 启动超时）。设置页此刻不在，它自己那条 listenerUnavailable toast 也就不在 —— 少了这条
 * 提示，用户被告知「授权后自动生效」之后什么都不会发生，也无处得知为什么。
 *
 * 复用设置页那条文案：故障与成因完全相同（自带「重启 Cindy 再试」的下一步），两处给不同
 * 说法只会让人以为是两种问题。
 *
 * main 侧一次 App 运行只推一次（触发点是窗口聚焦，helper 真坏掉会每次切回来都失败），这里
 * 不再额外去重。
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';

export function useVoiceInputShortcutRecoveryToast(): void {
  const { t } = useTranslation();
  useEffect(() => {
    return window.electronAPI.voiceInput.onShortcutRecoveryFailed(() => {
      toast.error(t('settings.voiceInput.shortcut.toast.listenerUnavailable'), { duration: 10000 });
    });
  }, [t]);
}
