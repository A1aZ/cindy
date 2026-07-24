# WeChat Open SDK 合规记录

> 状态：`restricted-review-required`。这份记录整理官方要求和仓库接入事实，**不等同于腾讯对 Cindy 商业分发的法律授权或法务批准**。正式发布前仍需由产品/法务确认当前 SDK 版本及目标发行地区的分发条款。

## 接入范围

| 平台 | 依赖 | 仓库位置 |
|---|---|---|
| Android | `com.tencent.mm.opensdk:wechat-sdk-android:6.8.38` | `apps/mobile/modules/xdt-wechat-login/android/build.gradle` |
| iOS | `WechatOpenSDK` `2.0.5` | `apps/mobile/modules/xdt-wechat-login/ios/XdtWechatLogin.podspec` |

Cindy 当前只使用微信授权码登录（`snsapi_userinfo`）。SDK 产生的授权码会交给 auth-server 换取登录结果；仓库不把微信 SDK 当作 Apache-2.0 开源依赖计数。

## 官方依据

- [Android 接入指南](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/Android.html)
- [iOS 接入指南](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/iOS.html)
- [微信 Open SDK 开发者合规使用指南](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/agreement/sdk.html)
- [微信 Open SDK 个人信息处理规则](https://support.weixin.qq.com/cgi-bin/mmsupportacctnodeweb-bin/pages/RYiYJkLOrQwu0nb8)

官方接入指南要求接入者阅读开发者合规使用指南和个人信息处理规则。当前官方个人信息处理规则页面标注的更新/生效日期为 **2024-10-10**；发布前应重新核对页面是否有更新。

## 官方要求映射

1. **版本维护**：官方建议使用最新 Open SDK。发布前必须重新核对 `6.8.38` / `2.0.5` 是否仍为目标发行线允许的版本；升级时同步更新 `THIRD-PARTY-RESTRICTED.txt`、本记录和对应测试。
2. **隐私政策披露**：Cindy 的隐私政策需要明确披露腾讯微信 Open SDK、使用目的（微信登录）、处理的信息（用户主动选择的微信头像/昵称）以及官方隐私规则链接。
3. **系统能力披露**：Android 接入会验证设备是否安装微信；iOS 接入会使用剪切板完成应用与微信之间的数据传输。隐私政策和权限说明应按实际 SDK 版本及实际调用情况调整。
4. **同意前不得初始化/调用**：必须在用户阅读并同意 Cindy 隐私政策后，再初始化或调用微信 SDK；用户拒绝时不得调用 SDK。调用应由用户主动触发微信登录，不应在 App 启动时提前初始化。
5. **变更复核**：微信规则或 SDK 版本发生变化时，重新做隐私披露、权限行为和分发条款复核，并记录复核日期及负责人。

## 当前代码核对结果

- `xdt-wechat-login` 仅在构建环境提供微信 App ID 和 Universal Link 时注入原生插件。
- `apps/mobile/src/auth/nativeSocial.ts` 通过动态导入使用模块，登录请求由用户点击社交登录按钮触发；未发现 App 启动时主动调用微信授权 API 的路径。
- 本仓库没有可证明“用户已同意隐私政策后才进入微信登录”的统一 consent 状态或测试；这是正式发布前的**待办项**，不能仅凭本文件视为已完成。
- Android/iOS 组件继续单列为 `restricted-review-required`，不声明为 SPDX 开源许可证。

## 发布前签核清单

- [ ] 产品/法务确认目标地区和版本允许将微信 SDK 随 Cindy 商业包分发。
- [ ] 隐私政策加入微信 Open SDK 披露，并链接官方个人信息处理规则。
- [ ] 登录入口在用户同意隐私政策前阻止微信 SDK 初始化/调用；拒绝路径已验证。
- [ ] 真机验证 Android 安装状态检查、iOS 剪切板行为及权限说明与实际一致。
- [ ] 记录复核日期、SDK 版本、发布渠道和签核人。
