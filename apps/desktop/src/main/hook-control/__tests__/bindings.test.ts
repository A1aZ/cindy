/**
 * hook-control bindings 单测: os.tmpdir 临时文件(规则 23: 测试路径一律走系统
 * 临时目录, 收尾清理)。重点是工作目录快照的写入与老文件兼容 —— dispatcher 靠
 * 它区分「会话被用户移动」与「工作目录映射被改」。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHookBindingStore } from '../bindings';

const noopLog = { warn: () => {} };

let dir: string;
const filePath = (): string => path.join(dir, 'hook-bindings.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-bindings-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const makeStore = () => createHookBindingStore({ filePath: filePath(), log: noopLog });

describe('hook binding store', () => {
  it('落绑定时记下工作目录快照, get / getEntry 都能读回', () => {
    const store = makeStore();
    store.set('conn-1', 'slack:C1:1.1', 'sess-1', '/repos/demo');

    expect(store.get('conn-1', 'slack:C1:1.1')).toBe('sess-1');
    expect(store.getEntry('conn-1', 'slack:C1:1.1')).toEqual({
      sessionId: 'sess-1',
      workingDir: '/repos/demo',
    });
    expect(store.getEntry('conn-1', 'missing')).toBeNull();
  });

  it('快照跨实例持久化, 且未传目录时不写该字段', () => {
    makeStore().set('conn-1', 'k', 'sess-1', '/repos/demo');
    expect(makeStore().getEntry('conn-1', 'k')?.workingDir).toBe('/repos/demo');

    makeStore().set('conn-1', 'k', 'sess-2');
    const row = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(row['conn-1']['k']).not.toHaveProperty('workingDir');
    expect(makeStore().getEntry('conn-1', 'k')).toEqual({ sessionId: 'sess-2', workingDir: null });
  });

  it('老文件(无 workingDir 字段)读成 null, 不当成"目录变过"', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({ 'conn-1': { 'slack:C1:1.1': { sessionId: 'legacy', updatedAt: 1 } } }),
      'utf-8',
    );
    const store = makeStore();

    expect(store.get('conn-1', 'slack:C1:1.1')).toBe('legacy');
    expect(store.getEntry('conn-1', 'slack:C1:1.1')).toEqual({
      sessionId: 'legacy',
      workingDir: null,
    });
  });

  it('remove 清掉整条绑定(含快照)', () => {
    const store = makeStore();
    store.set('conn-1', 'k', 'sess-1', '/repos/demo');
    store.remove('conn-1', 'k');

    expect(store.getEntry('conn-1', 'k')).toBeNull();
  });
});
