import { describe, expect, it } from 'vitest';

import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';
import zhTW from '../i18n/locales/zh-TW/common.json';

describe('iOS Simulator access copy', () => {
  it('explains that session authorization is retained while control pauses off-session', () => {
    expect(zhCN.rightSidebar.iosSimulator.accessDialogDetail).toBe(
      '此权限仅对该任务生效。切换到其他任务后仍会保留授权，但控制会暂停；返回该任务时自动恢复。',
    );
    expect(zhTW.rightSidebar.iosSimulator.accessDialogDetail).toBe(
      '此權限僅對該任務生效。切換到其他任務後仍會保留授權，但控制會暫停；返回該任務時自動恢復。',
    );
    expect(en.rightSidebar.iosSimulator.accessDialogDetail).toBe(
      'This permission applies only to this session. Authorization is retained when you switch away, but control pauses until you return.',
    );
    expect(ja.rightSidebar.iosSimulator.accessDialogDetail).toBe(
      'この権限はこのセッションにのみ適用されます。別のセッションへ切り替えても許可は保持されますが、操作は戻るまで一時停止します。',
    );
    expect(ko.rightSidebar.iosSimulator.accessDialogDetail).toBe(
      '이 권한은 이 세션에만 적용됩니다. 다른 세션으로 전환해도 권한은 유지되지만, 돌아올 때까지 제어가 일시 중지됩니다.',
    );
  });
});
