import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(__dirname, '..', '..');

function read(relPath: string): string {
  return readFileSync(resolve(APP_ROOT, relPath), 'utf8');
}

describe('mobile localized presentation refresh', () => {
  it('renders the automation form title once', () => {
    const source = read('app/automations/[deviceId].tsx');
    const formHeader = source.slice(
      source.indexOf('<View style={styles.formHeader}>'),
      source.indexOf('{error ? <Text style={styles.formError}>'),
    );

    expect(formHeader.match(/devices\.automations\.form\.title\.edit/g)).toHaveLength(1);
    expect(formHeader.match(/devices\.automations\.form\.title\.create/g)).toHaveLength(1);
  });

  it('rebuilds the cached composer presentation when the language changes', () => {
    const source = read('app/sessions/[sessionId].tsx');
    const composerProjection = source.slice(
      source.indexOf('const composerLayout = useMemo'),
      source.indexOf('const compactComposer ='),
    );

    expect(composerProjection).toContain('i18nInstance.language');
  });

  it('rebuilds open interaction cards when the language changes', () => {
    const source = read('src/session/InteractionPanel.tsx');

    expect(source).toContain('[i18nInstance.language, item.request]');
    expect(source).toContain('[currentIndex, i18nInstance.language, questions]');
    expect(source).toContain('[filePath, i18nInstance.language, originalPlan, planText]');
  });

  it('rebuilds cached payload presentations when the language changes', () => {
    const source = read('src/session/MessageRenderer.tsx');

    expect(source.match(/\[i18nInstance\.language, payload\]/g)).toHaveLength(4);
    expect(source).toContain('[diff, i18nInstance.language]');
  });

  it('rebuilds bulk-action copy when the language changes', () => {
    const source = read('app/devices/[deviceId].tsx');

    expect(source).toContain('[i18nInstance.language, selectedSessions]');
  });
});
