const { withAndroidStyles } = require("@expo/config-plugins");

// expo-splash-screen 的 Android 插件无条件往 styles.xml 的 Theme.App.SplashScreen
// 写死 `windowSplashScreenAnimatedIcon = @drawable/splashscreen_logo`,但只有当 splash
// 配置里带了 image/drawable 时才会真正生成该 drawable。Cindy 的 splash 配置只给了
// backgroundColor(原生启动屏只要品牌红、logo 交给 JS StartupSplashOverlay),没有 image,
// 于是 styles.xml 引用了一个不存在的 drawable → Android 资源链接(processReleaseResources)
// 报 `resource drawable/splashscreen_logo not found`,所有 Android 构建都会失败。
//
// 本插件从 Theme.App.SplashScreen 里剥掉这条悬空的 windowSplashScreenAnimatedIcon。
// 去掉后 Android 12+ 会回退到 app 启动图标,背景色仍由 windowSplashScreenBackground 保持
// #DF0C27,native→JS 交接的红色连续性不变。iOS 无此机制,不受影响。
//
// ⚠️ 排序:Expo 的 withAndroidStyles mod 执行顺序与 app.json plugins 数组**相反**
// (后注册的先跑、被先注册的覆盖)。因此本插件必须排在 expo-splash-screen **之前**,
// 才能在 expo-splash-screen 写入 styles.xml 之后再剥掉该 item(已实测:排在其后无效)。
const SPLASH_STYLE_NAME = "Theme.App.SplashScreen";
const DANGLING_ICON_ITEM = "windowSplashScreenAnimatedIcon";

function stripSplashAnimatedIcon(styles) {
  const stylesList = styles?.resources?.style;
  if (!Array.isArray(stylesList)) {
    return styles;
  }
  for (const style of stylesList) {
    if (style?.$?.name !== SPLASH_STYLE_NAME || !Array.isArray(style.item)) {
      continue;
    }
    style.item = style.item.filter(
      (item) => item?.$?.name !== DANGLING_ICON_ITEM,
    );
  }
  return styles;
}

function withAndroidSplashNoIcon(config) {
  return withAndroidStyles(config, (androidConfig) => {
    androidConfig.modResults = stripSplashAnimatedIcon(androidConfig.modResults);
    return androidConfig;
  });
}

module.exports = withAndroidSplashNoIcon;
module.exports.stripSplashAnimatedIcon = stripSplashAnimatedIcon;
