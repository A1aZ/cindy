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
  deriveTrustedEndpointDomains,
  findUntrustedCachedEndpoint,
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

  it('文件字节数超上限时读前就拒绝(不把大文件读进内存)', () => {
    fs.writeFileSync(cacheFile(), 'x'.repeat(64 * 1024 * 2 + 1), 'utf8');
    expect(readEndpointManifestCache(dir)).toBeNull();
  });

  it('多字节 UTF-8 内容按字节而非字符数判断', () => {
    // 每个汉字 3 字节:字符数远小于上限,字节数刚好越界。用 string.length 判断会放行。
    const cjk = '配'.repeat(64 * 1024 * 2 / 3 + 10);
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(64 * 1024 * 2);
    expect(cjk.length).toBeLessThan(64 * 1024 * 2);
    fs.writeFileSync(cacheFile(), cjk, 'utf8');
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

describe('缓存端点的受信任域约束(安全边界)', () => {
  // 生产实际取值:两份自举基址都由构建脚本注入,userData 写入改不了。
  const GLOBAL_BASE = 'https://hotfix.cindy.app/cindy';
  const CN_BASE = 'https://hotfix.cindy.com.cn/cindy';
  const TRUSTED = deriveTrustedEndpointDomains([GLOBAL_BASE, CN_BASE]);

  it('从自举基址推导注册域(多段去掉最左一段,两段用自己)', () => {
    expect(deriveTrustedEndpointDomains([GLOBAL_BASE])).toEqual(['cindy.app']);
    expect(deriveTrustedEndpointDomains([CN_BASE])).toEqual(['cindy.com.cn']);
    expect(deriveTrustedEndpointDomains(['https://cindy.app'])).toEqual(['cindy.app']);
    expect(TRUSTED.sort()).toEqual(['cindy.app', 'cindy.com.cn']);
  });

  it.each([
    ['空值', ''],
    ['非 URL', 'not a url'],
    ['单段主机', 'https://localhost'],
  ])('%s 不产出受信任域', (_label, baseUrl) => {
    expect(deriveTrustedEndpointDomains([baseUrl])).toEqual([]);
  });

  it('仓内两份清单的真实端点全部合规(含 CN 跨域的 hook 端点)', () => {
    // CN 清单里 slack / telegram hook 落在 cindy.app、其余在 cindy.com.cn:
    // 只取本区基址会把这两个合法端点判成不可信,所以受信任域必须取两份。
    expect(
      findUntrustedCachedEndpoint(
        {
          authApiBaseUrl: 'https://auth.cindy.com.cn',
          slackHookWsUrl: 'wss://slack-hook.cindy.app',
          telegramHookWsUrl: 'wss://telegram-hook.cindy.app',
          websiteUrl: 'https://cindy.com.cn',
          cdnBaseUrl: 'https://hotfix.cindy.com.cn/cindy',
          authDesktopCallbackUrl: 'https://auth.cindy.com.cn/api/auth/desktop/callback',
        },
        TRUSTED,
      ),
    ).toBeNull();
  });

  it.each([
    ['攻击者自选主机', 'https://evil.example.com'],
    ['受信任域作为子串但不是后缀', 'https://cindy.app.evil.com'],
    ['受信任域拼在主机名里', 'https://notcindy.app'],
    ['末尾多一段', 'https://auth.cindy.app.attacker.net'],
  ])('%s 被拒(返回越界的 key)', (_label, hostile) => {
    expect(
      findUntrustedCachedEndpoint(
        { authApiBaseUrl: hostile, websiteUrl: 'https://cindy.app' },
        TRUSTED,
      ),
    ).toBe('authApiBaseUrl');
  });

  it('空值端点跳过检查(缺失端点本就归一成空串)', () => {
    expect(
      findUntrustedCachedEndpoint({ authApiBaseUrl: '', heartbeatUrl: '' }, TRUSTED),
    ).toBeNull();
  });

  it('推导不出受信任域时一律拒绝(fail closed,不是放行)', () => {
    expect(findUntrustedCachedEndpoint({ authApiBaseUrl: 'https://auth.cindy.app' }, [])).toBe(
      'trusted-domains-unavailable',
    );
  });
});
