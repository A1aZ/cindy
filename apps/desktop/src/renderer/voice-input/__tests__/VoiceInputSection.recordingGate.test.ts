import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('VoiceInputSection shortcut recording gate', () => {
  it('disables app shortcuts while recording voice input shortcuts', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain("document.body.dataset.appShortcutRecording = '1'");
    expect(source).toContain('window.electronAPI.appShortcuts.setRecording(true)');
    expect(source).toContain('delete document.body.dataset.appShortcutRecording');
    expect(source).toContain('window.electronAPI.appShortcuts.setRecording(false)');
  });

  it('waits for shortcut suspension before committing and restores the latest persisted shortcut', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('await shortcutSuspendPromiseRef.current');
    expect(source).toContain('shortcutSuspendPromiseRef.current = suspendPromise');
    expect(source).toContain('syncVoiceInputGlobalShortcut(getVoiceInputSettings().shortcut)');
    // 录制 effect 刻意**不**依赖监听权限：录制中途授权只需补一次 Fn capture（由权限
    // effect 直接调 startFnKeyCapture），让本 effect 重跑会先由 cleanup 异步恢复已保存
    // 的全局快捷键、再由 setup 挂起，中间那段窗口里用户按下旧快捷键会真的触发语音输入。
    //
    // 这里必须写全依赖数组：只断言 '}, [recordingShortcut]);' 会被同文件另一个 reset
    // effect 的同名数组匹配到，看着通过实则脱靶。
    expect(source).toContain('}, [recordingShortcut, startFnKeyCapture]);');
    expect(source).not.toContain('}, [recordingShortcut, permissions.inputMonitoring.ok, t]);');
  });

  // 上面那条只锁住 effect 自己的依赖数组，但它依赖 startFnKeyCapture —— 后者的依赖一旦
  // 非空（最初是 [t]，身份随界面语言变化），录制期切语言就会经由它的身份变化把整个录制
  // effect 重跑，照样打开「旧快捷键被短暂恢复」的窗口。所以那个 callback 的依赖必须为空，
  // 文案走 translateRef 取最新值。
  it('keeps the Fn capture callback identity stable so the recording effect never re-runs mid-recording', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(/const startFnKeyCapture = useCallback\([\s\S]*?\n {2}\}, \[\]\);/);
    expect(source).not.toMatch(/const startFnKeyCapture = useCallback\([\s\S]*?\n {2}\}, \[t\]\);/);
    expect(source).toContain('const translateRef = useRef(t);');
    expect(source).toContain('translateRef.current = t;');
  });

  it('clears stale custom ASR form fields when the saved config is removed', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('if (!selection?.customAsr) {');
    expect(source).toContain("setCustomAsrProtocol('openai-realtime')");
    expect(source).toContain("setCustomAsrWebsocketUrl('')");
    expect(source).toContain("setCustomAsrModel('')");
    expect(source).toContain("setCustomAsrApiKey('')");
  });

  it('preserves a dirty custom ASR endpoint and key across unrelated selection refreshes', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('if (customAsrSelected && customAsrFormDirtyRef.current) return;');
    expect(source).toContain('}, [customAsrSelected, selection?.customAsr]);');
    expect(source).toContain('customAsrFormDirtyRef.current = true;');
  });

  it('invalidates a previous connection result when any local custom ASR field changes', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(
      /setConnectionTest\(\{ status: 'idle' \}\);[\s\S]*customAsrProtocol,[\s\S]*customAsrWebsocketUrl,[\s\S]*customAsrModel,[\s\S]*customAsrApiKey,/,
    );
  });
});
