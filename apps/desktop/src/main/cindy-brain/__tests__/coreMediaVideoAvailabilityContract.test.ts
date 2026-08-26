import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function functionBody(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Core media video availability wiring', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('uses Core executable availability without the legacy video alias registry', () => {
    const preferenceBody = functionBody(
      source,
      'function getMediaPreferenceConfig(',
      '\nfunction resolveMediaPreferenceModel(',
    );
    const pluginCatalogBody = functionBody(
      source,
      'async function getGhostConfigurableMediaModels(',
      '\nfunction getGhostConfiguredMediaModel(',
    );

    expect(preferenceBody).toContain('isMediaModelExecutable(model.id, coreCapability)');
    expect(pluginCatalogBody).toContain('await listExecutableMediaModels()');
    expect(preferenceBody).not.toContain('getVideoProviderRegistry()');
    expect(preferenceBody).not.toContain('.hasAlias(');
    expect(pluginCatalogBody).not.toContain('getVideoProviderRegistry()');
    expect(pluginCatalogBody).not.toContain('.hasAlias(');
  });

  it('keeps legacy cindy-request gated by its actual video executor registry', () => {
    const legacyCatalogBody = functionBody(
      source,
      'function getCatalogMediaConfig(',
      '\nconst getCatalogImageConfig =',
    );

    expect(legacyCatalogBody).toContain('getVideoProviderRegistry()');
    expect(legacyCatalogBody).toContain('videoRegistry?.hasAlias(modelId, providerId)');
  });
});
