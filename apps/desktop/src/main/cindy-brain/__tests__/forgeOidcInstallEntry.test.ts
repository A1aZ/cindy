import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

function forgeInstallBody(): string {
  const start = source.indexOf('export async function installOrUpdateLocalGhostPackageFromForge');
  const end = source.indexOf('/**\n * Plugin 市场专用装入入口', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Forge OIDC install entry wiring', () => {
  it('finishes the narrow confirmation before any install/update mutation begins', () => {
    const body = forgeInstallBody();
    const confirm = body.indexOf(
      'await ensureForgeOidcInstallConfirmBridge().request(confirmFacts)',
    );
    const mutation = body.indexOf('return withGhostInstallLock');
    expect(confirm).toBeGreaterThanOrEqual(0);
    expect(mutation).toBeGreaterThan(confirm);
    expect(body).toContain("throwIpcError('MUTATION_CANCELLED'");
  });

  it('marks both new installs and in-place updates as explicit agent-forge', () => {
    const body = forgeInstallBody();
    expect(body).toContain("installOrigin: 'agent-forge'");
    expect(body).toContain("getActiveAppSession(),\n        'agent-forge',");
  });

  it('authorizes tokenBroker against Forge facts without making it trigger the OIDC dialog', () => {
    const body = forgeInstallBody();
    expect(body).toContain(
      "rejectUnauthorizedTokenBroker(inspected.manifest, { installOrigin: 'agent-forge' })",
    );
    expect(body).toContain('forgeOidcInstallConfirmFacts(');
  });

  it('wires OIDC confirmation to the registered main App window instead of focused auxiliaries', () => {
    const start = source.indexOf('function ensureForgeOidcInstallConfirmBridge()');
    const end = source.indexOf('/**\n * 确认弹窗槽单例', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const wiring = source.slice(start, end);

    expect(wiring).toContain('createForgeOidcInstallMainWindowSender<BrowserWindow>({');
    expect(wiring).toContain('getMainWindow: getDeepLinkMainWindow');
    expect(wiring).not.toContain('BrowserWindow.getFocusedWindow');
    expect(wiring).not.toContain('BrowserWindow.getAllWindows');
    expect(source).not.toContain('function pickTrustedAppWindow');
  });
});
