/**
 * 端点清单离线缓存的读写与容错。
 *
 * 重点是「坏数据一律当没有缓存」:这份文件只用来点亮阻断框上的离线按钮,任何解析
 * 异常都必须降级为 null,绝不能反过来变成新的启动失败源。临时目录走 mkdtemp
 * (engineering-conventions §3.1),不碰真实 userData。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENDPOINT_MANIFEST_CACHE_FILE_NAME,
  formatCacheSavedAt,
  readEndpointManifestCache,
  writeEndpointManifestCache,
} from '../endpointManifestCache';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-endpoint-cache-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ENTRY = {
  savedAt: '2026-07-29T06:22:00.000Z',
  sourceUrl: 'https://cdn.example.com/endpoint.json',
  manifestText: JSON.stringify({ schemaVersion: 1, authApiBaseUrl: 'https://auth.example.com' }),
};

function cacheFile(): string {
  return path.join(dir, ENDPOINT_MANIFEST_CACHE_FILE_NAME);
}

describe('endpointManifestCache', () => {
  it('写入后可原样读回', () => {
    expect(writeEndpointManifestCache(dir, ENTRY)).toBe(true);
    expect(readEndpointManifestCache(dir)).toEqual(ENTRY);
  });

  it('目录不存在时自动创建', () => {
    const nested = path.join(dir, 'a', 'b');
    expect(writeEndpointManifestCache(nested, ENTRY)).toBe(true);
    expect(readEndpointManifestCache(nested)).toEqual(ENTRY);
  });

  it('写入不留下临时文件', () => {
    writeEndpointManifestCache(dir, ENTRY);
    expect(fs.existsSync(`${cacheFile()}.tmp`)).toBe(false);
  });

  it('文件缺失返回 null', () => {
    expect(readEndpointManifestCache(dir)).toBeNull();
  });

  it.each([
    ['非 JSON', 'not json'],
    ['JSON 数组', '[]'],
    ['JSON 标量', '42'],
    ['缺 manifestText', JSON.stringify({ savedAt: ENTRY.savedAt, sourceUrl: ENTRY.sourceUrl })],
    ['字段类型不对', JSON.stringify({ ...ENTRY, sourceUrl: 123 })],
    ['savedAt 不可解析', JSON.stringify({ ...ENTRY, savedAt: 'whenever' })],
    ['字段空白', JSON.stringify({ ...ENTRY, manifestText: '   ' })],
  ])('%s → null(坏数据当没有缓存)', (_label, raw) => {
    fs.writeFileSync(cacheFile(), raw, 'utf8');
    expect(readEndpointManifestCache(dir)).toBeNull();
  });

  it('清单原文超上限时拒绝写入', () => {
    const huge = { ...ENTRY, manifestText: 'x'.repeat(64 * 1024 + 1) };
    expect(writeEndpointManifestCache(dir, huge)).toBe(false);
    expect(fs.existsSync(cacheFile())).toBe(false);
  });

  it('formatCacheSavedAt 解析不了就原样回显', () => {
    expect(formatCacheSavedAt('not-a-date', 'zh-CN')).toBe('not-a-date');
    expect(formatCacheSavedAt(ENTRY.savedAt, 'zh-CN')).not.toBe('');
  });
});
