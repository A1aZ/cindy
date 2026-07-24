/**
 * Contract tests for Plugin list/detail adapters over the shared Ghost model.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { describe, expect, it } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import {
  filterGhostPluginItems,
  ghostFallbackIconKind,
  sortGhostPluginItemsByRecentUse,
  toGhostPluginDetail,
  toGhostPluginListItem,
  type GhostPluginListItem,
} from '../../features/plugin/lib/ghostPluginViewModel';

function manifest(overrides: Partial<GhostManifest> = {}): GhostManifest {
  return {
    schemaVersion: 2,
    id: 'xd-mivo',
    name: 'XD Mivo',
    version: '1.5.10',
    author: 'XD',
    description: 'Generate media assets.',
    whenToUse: 'When the user needs media generation.',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool', 'network', 'card'],
    tools: [
      { name: 'submit_gen_image', description: 'Generate an image.' },
      { name: 'download_file', description: 'Download a file.' },
    ],
    network: {
      hosts: ['aigc.example.com'],
      secrets: [
        {
          key: 'mivo_api_key',
          label: 'Mivo API Key',
          source: 'user',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
        },
      ],
    },
    command: 'xd-mivo',
    ...overrides,
  };
}

function installed(overrides: Partial<InstalledGhost> = {}): InstalledGhost {
  return {
    manifest: manifest(),
    dir: '/tmp/cindy-brain/xd-mivo',
    enabled: true,
    ...overrides,
  };
}

describe('ghostPluginViewModel', () => {
  it('maps iconless Plugins to restrained functional fallback symbols', () => {
    expect(ghostFallbackIconKind('Lizi Mivo', 'lizi-mivo')).toBe('media');
    expect(ghostFallbackIconKind('Cindy Mermaid', 'cindy-mermaid')).toBe('diagram');
    expect(ghostFallbackIconKind('XD Feishu', 'xd-feishu')).toBe('communication');
    expect(ghostFallbackIconKind('Local Weather', 'local-weather')).toBe('generic');
  });

  it('matches search text against name, description, and id', () => {
    const items = [
      {
        id: 'xd-mivo',
        name: 'XD Mivo',
        description: 'media',
        version: '1',
        enabled: true,
        canUse: true,
      },
      {
        id: 'lizi-mivo',
        name: 'Lizi Mivo',
        description: 'media',
        version: '1',
        enabled: true,
        canUse: true,
      },
      {
        id: 'slack',
        name: 'Cindy Slack',
        description: 'messages',
        version: '1',
        enabled: true,
        canUse: true,
      },
    ] satisfies GhostPluginListItem[];

    const searched = filterGhostPluginItems(items, 'miv');

    expect(searched.map((item) => item.id)).toEqual(['xd-mivo', 'lizi-mivo']);
  });

  it('sorts used Plugins newest-first and keeps untouched Plugins stable', () => {
    const items = [{ id: 'first' }, { id: 'second' }, { id: 'third' }, { id: 'fourth' }];

    expect(
      sortGhostPluginItemsByRecentUse(items, ['third', 'missing', 'first']).map((item) => item.id),
    ).toEqual(['third', 'first', 'second', 'fourth']);
  });

  it('maps install-record facts onto the list item', () => {
    const item = toGhostPluginListItem(installed());

    expect(item).toMatchObject({
      id: 'xd-mivo',
      name: 'XD Mivo',
      enabled: true,
      canUse: true,
      version: '1.5.10',
    });
  });

  it('keeps disabled state and does not invent marketplace fields', () => {
    const item = toGhostPluginListItem(installed({ enabled: false }));

    expect(item.enabled).toBe(false);
    expect(item).not.toHaveProperty('installCount');
    expect(item).not.toHaveProperty('usageCount');
    expect(item).not.toHaveProperty('certified');
    expect(item).not.toHaveProperty('whenToUse');
  });

  it('derives detail permissions and runtime declarations from the manifest', () => {
    const detail = toGhostPluginDetail(installed());

    expect(detail.contents).toEqual(['code', 'slotTool', 'slotNetwork', 'slotCard']);
    expect(detail.tools.map((tool) => tool.name)).toEqual(['submit_gen_image', 'download_file']);
    expect(detail.panelMinWidth).toBeNull();
    expect(detail.installDir).toBe('/tmp/cindy-brain/xd-mivo');
    expect(detail.canUse).toBe(true);
    expect(detail).not.toHaveProperty('manifest');
    expect(detail.permissions.map((item) => item.kind)).toEqual([
      'network',
      'network',
      'tool',
      'tool',
      'command',
      'card',
      'code',
    ]);
  });

  it('does not render absent optional capabilities as empty fake sections', () => {
    const detail = toGhostPluginDetail(
      installed({
        manifest: manifest({
          author: undefined,
          description: undefined,
          tools: undefined,
          network: undefined,
          command: undefined,
          slots: ['tool'],
        }),
      }),
    );

    expect(detail.author).toBeNull();
    expect(detail.description).toBe('');
    expect(detail.tools).toEqual([]);
    expect(detail.canUse).toBe(false);
    expect(detail.permissions.map((item) => item.kind)).toEqual(['code']);
  });

  it('derives the real panel field without exposing the raw manifest', () => {
    const detail = toGhostPluginDetail(
      installed({
        manifest: manifest({
          slots: ['panel', 'cindy'],
          panel: { html: 'panel.html', minWidth: 360 },
          cindy: { image: ['generate', 'edit'], video: ['generate'] },
        }),
      }),
    );

    expect(detail.panelMinWidth).toBe(360);
    expect(detail).not.toHaveProperty('manifest');
  });
});
