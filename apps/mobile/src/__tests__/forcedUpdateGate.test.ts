import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 强更阻断契约(读源码断言)。
 *
 * 回归背景:强更曾经是一个 `cancelable: false` 的单按钮 Alert —— 但 RN Alert 的按钮
 * 点一下就关,弹窗消失后底下的 App 照旧可用,且模块级去重让本进程内不再弹。也就是
 * "强提醒"而非"强制"。现在强更必须是 root 层的阻断屏:命中门槛就不挂业务树。
 */
describe('强更阻断闸门', () => {
  const read = (rel: string) =>
    readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

  it('root layout 用 forcedUpdate 状态阻断业务树,唯一出口是「去更新」', () => {
    const layout = read('app/_layout.tsx');

    expect(layout).toContain("from '@/update/forcedUpdateStore'");
    expect(layout).toContain('const forcedUpdate = useForcedUpdate();');
    // 阻断分支必须先于 ready 分支(ready 才会挂 RootAfterEndpoints 业务树)。
    expect(layout.indexOf('} else if (forcedUpdate) {')).toBeGreaterThan(0);
    expect(layout.indexOf('} else if (forcedUpdate) {')).toBeLessThan(
      layout.indexOf('body = <RootAfterEndpoints />;'),
    );
    expect(layout).toContain('<ForcedUpdateGateContent target={forcedUpdate} />');
    expect(layout).toContain("actionLabel={t('update.goUpdate')}");
    // 阻断屏不得有"稍后 / 跳过"出口。
    expect(layout).not.toContain('update.later');
  });

  it('强更路径不再走 Alert:promptBundleUpdate 直接进入阻断态', () => {
    const prompt = read('src/update/useBundleUpdatePrompt.ts');

    expect(prompt).toContain('enterForcedUpdate(evaluation.target)');
    // 不可取消弹窗是被替换掉的旧实现,不允许回归。
    expect(prompt).not.toContain('cancelable');
    expect(prompt).not.toContain("i18n.t('update.forcedTitle')");
    // 拿不到安装地址时不得进入阻断态(否则把用户关进没有出口的屏)。
    expect(prompt).toContain('if (!url) return;');
  });

  it('阻断态只存内存,不持久化(服务端撤回门槛后用户不能被本地缓存锁死)', () => {
    const store = read('src/update/forcedUpdateStore.ts');

    expect(store).not.toContain('AsyncStorage');
    expect(store).toContain('export function enterForcedUpdate');
  });
});
