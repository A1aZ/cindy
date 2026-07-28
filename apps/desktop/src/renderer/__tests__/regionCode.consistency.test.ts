/**
 * 区域代号的跨机制一致性 —— 界面展示(走 i18n)与常量(走 CINDY_REGION_CODE)必须
 * 对同一个区域给出同一个代号,且各条消费链路之间不得互相漂移。
 *
 * 为什么需要专门一测:界面文案与常量走的是不同机制(界面按 DESIGN.md §16.3 要求走
 * i18n,便于日后改判为可译文案;issue 正文直接落常量,因为读者是维护者、不跟随界面
 * 语言)。机制不同就没有编译期约束——改了一边的取值、或新增区域 / 新增消费链路只补了
 * 一边,typecheck 与各自的单测都不会响。issue 链路还额外有「卡片展示的就是最终写进
 * issue 正文的内容」这条契约,漂移会直接骗到用户;侧栏版本行则会让同一个构建在不同
 * 界面报出不同的区域身份。这一测就是补上那道缺失的信号。
 *
 * 新增消费链路时把它的 i18n 命名空间加进 CONSUMERS 即可,不要另写一份平行断言。
 */

import { describe, expect, it } from 'vitest';

import { CINDY_REGION_CODE, shouldLabelRegion } from '../../shared/regionCode';
import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';

type Bundle = Record<string, unknown>;

const LOCALES: Record<string, Bundle> = {
  'zh-CN': zhCN as Bundle,
  en: en as Bundle,
  ja: ja as Bundle,
  ko: ko as Bundle,
};

/**
 * 消费区域代号的各条链路:i18n key 前缀 + 取到该组 key 所在对象的方式。
 * `regionCode<Region>` 后缀在各链路统一(cn → regionCodeCn)。
 */
const CONSUMERS: ReadonlyArray<{ label: string; prefix: string; pick: (b: Bundle) => Bundle }> = [
  {
    label: 'issue 提交确认卡片',
    prefix: 'issueAgent.confirm',
    pick: (b) => (b.issueAgent as { confirm: Bundle }).confirm,
  },
  {
    label: '侧栏用户卡片版本行',
    prefix: 'sidebar.user',
    pick: (b) => (b.sidebar as { user: Bundle }).user,
  },
];

/** region → i18n key 后缀(cn → regionCodeCn)。 */
function regionKeyFor(region: string): string {
  return `regionCode${region.charAt(0).toUpperCase()}${region.slice(1)}`;
}

describe('区域代号:界面 i18n 与常量一致', () => {
  it('有代号的区域: 每条链路的四语 i18n 值逐字等于常量,且不被翻译', () => {
    const labeled = Object.entries(CINDY_REGION_CODE).filter(([, code]) => code !== null);
    // 防塌陷:常量或消费链路被清空时下面的循环会变成空跑而全绿。
    expect(labeled.length).toBeGreaterThan(0);
    expect(CONSUMERS.length).toBeGreaterThan(0);
    for (const [region, code] of labeled) {
      for (const consumer of CONSUMERS) {
        for (const [locale, bundle] of Object.entries(LOCALES)) {
          const key = regionKeyFor(region);
          expect(
            consumer.pick(bundle)[key],
            `${locale} 的 ${consumer.prefix}.${key}(${consumer.label})应为 ${code}(区域代号四语同文、不翻译)`,
          ).toBe(code);
        }
      }
    }
  });

  it('不标注的区域: 各链路四语都不得存在对应 key,避免出现「能显示但契约不写」的半套实现', () => {
    const unlabeled = Object.entries(CINDY_REGION_CODE).filter(([, code]) => code === null);
    expect(unlabeled.length).toBeGreaterThan(0);
    for (const [region] of unlabeled) {
      for (const consumer of CONSUMERS) {
        for (const [locale, bundle] of Object.entries(LOCALES)) {
          const key = regionKeyFor(region);
          expect(
            consumer.pick(bundle)[key],
            `${locale} 不应有 ${consumer.prefix}.${key}——${region} 按产品规则不标注(DESIGN.md §16.3)`,
          ).toBeUndefined();
        }
      }
    }
  });

  it('global 不标是硬规则(DESIGN.md §16.3 不得回退),缺失 region 同样不标', () => {
    expect(CINDY_REGION_CODE.global).toBeNull();
    expect(shouldLabelRegion('global')).toBe(false);
    expect(shouldLabelRegion(undefined)).toBe(false);
    expect(shouldLabelRegion('cn')).toBe(true);
    expect(shouldLabelRegion('dev')).toBe(true);
  });
});
