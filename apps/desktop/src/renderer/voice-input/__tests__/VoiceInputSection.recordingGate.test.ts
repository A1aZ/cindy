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
    expect(source).toContain('}, [recordingShortcut]);');
  });
});
