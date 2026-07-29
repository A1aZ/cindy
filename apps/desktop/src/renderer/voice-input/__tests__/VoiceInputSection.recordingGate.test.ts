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
    // 录制 effect 必须同时依赖监听权限：用户可能在录制中途去授权再切回来，那次失败的
    // startModifierShortcutRecording 已经让 main 把本 renderer 从转发名单里摘掉，只有
    // 让 effect 重跑（cleanup + setup）才能重新挂起快捷键并重建 Fn capture。
    //
    // 这里必须写全依赖数组：只断言 '}, [recordingShortcut]);' 会被同文件另一个 reset
    // effect 的同名数组匹配到，看着通过实则脱靶。
    expect(source).toContain('}, [recordingShortcut, permissions.inputMonitoring.ok, t]);');
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
