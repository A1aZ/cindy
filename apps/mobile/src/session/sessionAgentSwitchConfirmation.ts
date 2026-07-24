/** 手机端首次进入另一 Agent 浏览态时的原生确认门。 */
import { Alert, type AlertButton, type AlertOptions } from 'react-native';

import { mobileAgentLabel, type MobileSessionAgentKind } from './sessionAgentSwitch';

type ShowAlert = (
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions,
) => void;

/**
 * 已有 pending intent 说明本轮选择已经确认过；改模型、切来源或回到当前 Agent
 * 都不重复弹。取消 / 系统 dismiss 保持原浏览分段。
 */
export function confirmMobileSessionAgentSwitch(
  targetAgentKind: MobileSessionAgentKind,
  hasPendingIntent: boolean,
  showAlert: ShowAlert = Alert.alert,
): Promise<boolean> {
  if (hasPendingIntent) return Promise.resolve(true);
  const target = mobileAgentLabel(targetAgentKind);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };
    showAlert(
      `切换到 ${target}？`,
      `下一条消息发送时，Cindy 会把当前会话交接给 ${target}。两个 Agent 对上下文和工具的理解可能不同，请确认后再选择目标模型。`,
      [
        { text: '取消', style: 'cancel', onPress: () => finish(false) },
        { text: '继续选择', onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
