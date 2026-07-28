/**
 * hook-control/paths 单测。
 *
 * 这两个判定是工作目录映射这条安全边界的算术: `isPathWithin` 决定"远端能不能
 * 驱动这个目录", `isSamePath` 决定"真正要跑的会话还在不在校验过的目录里"。
 * 归一化细节(`sub/..`、尾部分隔符、Windows 大小写)错一点就是放行或误拒,
 * 所以单独覆盖(PR #733 review 指出抽模块后丢了覆盖)。
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isPathWithin, isSamePath } from '../paths';

const BASE = path.resolve('/repos/demo');

describe('isPathWithin', () => {
  it('相等 / 子目录算在内, 外部路径不算', () => {
    expect(isPathWithin(BASE, BASE)).toBe(true);
    expect(isPathWithin(BASE, path.join(BASE, 'sub'))).toBe(true);
    expect(isPathWithin(BASE, path.join(BASE, 'a', 'b', 'c'))).toBe(true);
    expect(isPathWithin(BASE, path.resolve('/repos/other'))).toBe(false);
  });

  it('前缀相同但不是子目录的兄弟目录不算(字符串前缀比较会误判)', () => {
    expect(isPathWithin(BASE, path.resolve('/repos/demo-2'))).toBe(false);
    expect(isPathWithin(BASE, `${BASE}-backup`)).toBe(false);
  });

  it('先归一化再判定: `..` 不能借道逃出去', () => {
    expect(isPathWithin(BASE, path.join(BASE, 'sub', '..'))).toBe(true);
    expect(isPathWithin(BASE, path.join(BASE, '..'))).toBe(false);
    expect(isPathWithin(BASE, path.join(BASE, 'sub', '..', '..', 'elsewhere'))).toBe(false);
  });
});

describe('isSamePath', () => {
  it('同一目录的不同写法算相同', () => {
    expect(isSamePath(BASE, BASE)).toBe(true);
    expect(isSamePath(BASE, path.join(BASE, 'sub', '..'))).toBe(true);
    expect(isSamePath(BASE, `${BASE}${path.sep}`)).toBe(true);
  });

  it('子目录与别的目录都不算相同(这是"没被移走"的判据, 不能放宽)', () => {
    expect(isSamePath(BASE, path.join(BASE, 'sub'))).toBe(false);
    expect(isSamePath(BASE, path.resolve('/repos/other'))).toBe(false);
    expect(isSamePath(BASE, `${BASE}-backup`)).toBe(false);
  });

  it('大小写: Windows 上不敏感, 其它平台敏感(规则 15)', () => {
    const upper = BASE.toUpperCase();
    const expected = process.platform === 'win32';
    expect(isSamePath(BASE, upper)).toBe(expected);
    expect(isPathWithin(BASE, path.join(upper, 'sub'))).toBe(expected);
  });
});
