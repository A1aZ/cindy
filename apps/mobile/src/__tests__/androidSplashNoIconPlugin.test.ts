import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { stripSplashAnimatedIcon } =
  require("../../plugins/with-android-splash-no-icon.js") as {
    stripSplashAnimatedIcon: (styles: unknown) => {
      resources?: {
        style?: Array<{
          $?: { name?: string; parent?: string };
          item?: Array<{ $?: { name?: string }; _?: string }>;
        }>;
      };
    };
  };

// styles.xml AST 形态复刻 expo-splash-screen 生成的 Theme.App.SplashScreen(只给
// backgroundColor、没给 image 时会写死悬空的 windowSplashScreenAnimatedIcon)。
function splashStylesFixture() {
  return {
    resources: {
      style: [
        {
          $: { name: "AppTheme", parent: "Theme.AppCompat.DayNight.NoActionBar" },
          item: [{ $: { name: "colorPrimary" }, _: "@color/colorPrimary" }],
        },
        {
          $: { name: "Theme.App.SplashScreen", parent: "Theme.SplashScreen" },
          item: [
            {
              $: { name: "windowSplashScreenBackground" },
              _: "@color/splashscreen_background",
            },
            {
              $: { name: "windowSplashScreenAnimatedIcon" },
              _: "@drawable/splashscreen_logo",
            },
            { $: { name: "postSplashScreenTheme" }, _: "@style/AppTheme" },
          ],
        },
      ],
    },
  };
}

describe("with-android-splash-no-icon config plugin", () => {
  it("removes the dangling windowSplashScreenAnimatedIcon reference", () => {
    const result = stripSplashAnimatedIcon(splashStylesFixture());
    const splash = result.resources?.style?.find(
      (s) => s.$?.name === "Theme.App.SplashScreen",
    );
    const itemNames = (splash?.item ?? []).map((i) => i.$?.name);
    expect(itemNames).not.toContain("windowSplashScreenAnimatedIcon");
    // 背景色与其它条目必须保留(红色连续性由 windowSplashScreenBackground 维持)。
    expect(itemNames).toContain("windowSplashScreenBackground");
    expect(itemNames).toContain("postSplashScreenTheme");
  });

  it("leaves unrelated styles untouched", () => {
    const result = stripSplashAnimatedIcon(splashStylesFixture());
    const appTheme = result.resources?.style?.find(
      (s) => s.$?.name === "AppTheme",
    );
    expect((appTheme?.item ?? []).map((i) => i.$?.name)).toEqual([
      "colorPrimary",
    ]);
  });

  it("is a no-op when styles have no style array", () => {
    expect(() => stripSplashAnimatedIcon({})).not.toThrow();
    expect(() => stripSplashAnimatedIcon({ resources: {} })).not.toThrow();
  });
});
