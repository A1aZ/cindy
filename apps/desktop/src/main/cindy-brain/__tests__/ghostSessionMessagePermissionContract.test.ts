import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * cindy-brain/index.ts owns Electron process singletons and cannot be imported
 * in the Node test environment, so keep the session-message permission boundary
 * covered with the established main-process source-contract pattern.
 */
describe('Ghost current-session message permission boundary', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('requires the new session-message add-on before exposing the current session', () => {
    const start = source.indexOf("if (request.kind === 'get-current-session') {");
    const end = source.indexOf("if (request.kind === 'send-message') {", start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("ghost.manifest.slots.includes('session-context')");
    expect(body).toContain("ghost.manifest.slots.includes('agent')");
    expect(body).toContain('ghost.manifest.agent?.sessionMessage !== true');
    expect(body).toContain("throwIpcError('PERMISSION_DENIED', '插件未声明当前任务消息能力')");
  });
});
