import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 启动 splash 覆盖层契约:启动闸门链全程共用根部一个常驻 splash 实例。
 * 回归背景:此前每道闸门(端点清单/canary 渠道/OTA 门/auth 恢复)各自渲染独立的
 * splash,交接 remount 会露出 surface 底色,产生"红→白→红"闪帧(2026-07 用户实报)。
 */
describe('startup splash overlay', () => {
  // Windows 检出(core.autocrlf)下源文件是 CRLF,归一化行尾让含 \n 的断言跨平台成立。
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

  it('root layout mounts a single persistent splash overlay above the gate chain', () => {
    const layout = read('app/_layout.tsx');

    expect(layout).toContain("from '@/components/StartupSplashOverlay'");
    expect(layout).toContain('<StartupSplashOverlay hidden={endpointGate.status === \'error\'}>');
    // 闸门链各关不许再各自渲染 splash 实例(splash-preview 路由是唯一例外)。
    expect(layout).not.toContain('variant="splash"');
  });

  it('gates render null while pending instead of their own splash instance', () => {
    const layout = read('app/_layout.tsx');
    const index = read('app/index.tsx');

    expect(layout).toContain('if (!otaReady) {\n    return null;\n  }');
    expect(layout).toContain("if (!channel.ready) return null;");
    expect(index).toContain('if (!auth.initialized) return null;');
    expect(index).not.toContain('variant="splash"');
  });

  it('releases the overlay on auth.initialized so deep-link cold starts also release', () => {
    const layout = read('app/_layout.tsx');

    expect(layout).toContain('if (auth.initialized) releaseSplash();');
  });

  it('fades out with a one-shot compositor-only opacity animation', () => {
    const overlay = read('src/components/StartupSplashOverlay.tsx');

    expect(overlay).toContain('useNativeDriver: true');
    expect(overlay).toContain('StyleSheet.absoluteFill');
    expect(overlay).toContain('<CenteredScreen title="Cindy" variant="splash" />');
  });

  it('keeps the native launch screen on the same brand red as the JS splash (both platforms)', () => {
    // ios/android 目录是 prebuild 产物(gitignored),native 启动屏颜色的权威来源是
    // app.json 的 expo-splash-screen 插件配置;#DF0C27 = brandSplashBackground
    // (src/theme/tokens.ts),native→JS 交接不许有色差,深浅外观同色。
    const appConfig = JSON.parse(read('app.json')) as {
      expo: { plugins: (string | [string, Record<string, unknown>])[] };
    };
    const splashPlugin = appConfig.expo.plugins.find(
      (p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === 'expo-splash-screen',
    );

    expect(splashPlugin).toBeDefined();
    expect(splashPlugin?.[1]).toEqual({
      backgroundColor: '#DF0C27',
      dark: { backgroundColor: '#DF0C27' },
    });
  });
});
