import { describe, expect, it } from 'vitest';
import {
  loadDevConnectionAudienceResolver,
  parseDevConnectionTrustFile,
} from '../connectionAudienceResolver.js';

const TRUST_FILE = JSON.stringify({
  schemaVersion: 1,
  plugins: [
    {
      ghostId: 'plugin-a',
      orgSlug: 'org-example',
      pluginSlug: 'plugin-a',
      hosts: ['service-a.x.test'],
    },
    {
      ghostId: 'plugin-b',
      orgSlug: 'org-example',
      pluginSlug: 'plugin-b',
      hosts: ['service-b.x.test'],
    },
  ],
});

describe('development Connection audience resolver', () => {
  it('derives audience only from the trusted ghost/org mapping', () => {
    const resolver = loadDevConnectionAudienceResolver({
      trustFilePath: '/tmp/connection-trust.json',
      isPackaged: false,
      desktopDevMode: 'local',
      readFile: () => TRUST_FILE,
    });
    expect(
      resolver.resolve('plugin-a', {
        membershipId: 'membership-1',
        membershipKind: 'org',
        orgSlug: 'org-example',
      }),
    ).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:plugin-a',
      pluginSlug: 'plugin-a',
      allowedHosts: ['service-a.x.test'],
    });
    expect(
      resolver.resolve('plugin-b', {
        membershipId: 'membership-1',
        membershipKind: 'org',
        orgSlug: 'org-example',
      })?.audience,
    ).toBe('org-example:plugin-b');
    expect(
      resolver.resolve('plugin-a', {
        membershipId: 'membership-1',
        membershipKind: 'personal',
        orgSlug: null,
      }),
    ).toBeNull();
    expect(
      resolver.resolve('plugin-a', {
        membershipId: 'membership-1',
        membershipKind: 'org',
        orgSlug: 'org-other',
      }),
    ).toBeNull();
    expect(
      resolver.resolve('unknown', {
        membershipId: 'membership-1',
        membershipKind: 'org',
        orgSlug: 'org-example',
      }),
    ).toBeNull();
  });

  it('fails closed for packaged/non-local/relative-path overrides', () => {
    const base = {
      trustFilePath: '/tmp/connection-trust.json',
      desktopDevMode: 'local',
      readFile: () => TRUST_FILE,
    };
    expect(() => loadDevConnectionAudienceResolver({ ...base, isPackaged: true })).toThrow(
      /forbidden/,
    );
    expect(() =>
      loadDevConnectionAudienceResolver({
        ...base,
        isPackaged: false,
        desktopDevMode: 'remote',
      }),
    ).toThrow(/local mode/);
    expect(() =>
      loadDevConnectionAudienceResolver({
        ...base,
        trustFilePath: 'relative.json',
        isPackaged: false,
      }),
    ).toThrow(/absolute/);
  });

  it.each([
    '{}',
    JSON.stringify({ schemaVersion: 2, plugins: [] }),
    JSON.stringify({ schemaVersion: 1, plugins: [] }),
    JSON.stringify({ schemaVersion: 1, plugins: [{ ghostId: 'Bad_ID', orgSlug: 'org-example', pluginSlug: 'plugin-a' }] }),
    JSON.stringify({ schemaVersion: 1, plugins: [{ ghostId: 'plugin-a', orgSlug: 'org-example', pluginSlug: 'Plugin-A' }] }),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [{ ghostId: 'plugin-a', orgSlug: 'org-example', pluginSlug: 'plugin-a', hosts: [] }],
    }),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [{ ghostId: 'plugin-a', orgSlug: 'org-example', pluginSlug: 'plugin-a', hosts: ['*.x.test'] }],
    }),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [{
        ghostId: 'plugin-a',
        orgSlug: 'org-example',
        pluginSlug: 'plugin-a',
        hosts: ['service-a.x.test', 'service-a.x.test'],
      }],
    }),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [
        { ghostId: 'plugin-a', orgSlug: 'org-example', pluginSlug: 'plugin-a', hosts: ['service-a.x.test'] },
        { ghostId: 'plugin-a', orgSlug: 'org-example', pluginSlug: 'plugin-b', hosts: ['service-b.x.test'] },
      ],
    }),
  ])('rejects malformed trust input', (raw) => {
    expect(() => parseDevConnectionTrustFile(raw)).toThrow();
  });
});
