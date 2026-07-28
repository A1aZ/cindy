# 组织登录区域路由

Cindy 的中国大陆版与国际版仍是两个独立的安装包和更新通道。组织 SSO 登录可以在
用户确认后自动发现组织所在的 auth 区域，并让本次登录会话使用该区域的完整服务端点。

## 两类区域状态

- `buildRegion`：由安装包决定，控制 App ID、URL scheme、品牌、法律链接、网站、
  CDN 与更新通道；运行期不可切换。
- `sessionRealm`：`cn | global`，控制 auth、device-link、oauth-broker、OSS、
  heartbeat、model-access、voice、GitHub、SkillHub、plugin 与 hook 等所有使用
  登录令牌的服务；组织登录成功后一直保留到登出。

两者可以不同。例如，中国大陆安装包可以登录位于 `global` 的组织；它的更新仍来自
中国大陆安装包通道，但组织数据与带 Bearer token 的业务请求全部走 `global`。

## 端点清单契约

区域清单在原有 `schemaVersion: 1` 上增加三个向前兼容字段：

```json
{
  "region": "cn",
  "crossRealmOrgLoginEnabled": true,
  "realmManifestBaseUrls": {
    "cn": "https://hotfix.cindy.com.cn/cindy",
    "global": "https://hotfix.cindy.app/cindy"
  }
}
```

`realmManifestBaseUrls` 在正式包中必须是无凭据的 HTTPS URL。构建清单一旦声明
`region`，就必须与安装包区域一致；加载对端清单时也必须与目标区域完全一致。旧清单
缺少这些字段时仍可启动，但跨区域组织登录保持关闭。将
`crossRealmOrgLoginEnabled` 改为 `false` 只关闭新的双区发现；已保存的跨区会话和注销
receipt 仍可按 `realmManifestBaseUrls` 加载原区域，禁止将其退回安装包区域。

## 发现与失败规则

输入企业 ID、组织 slug 或已验证域名前，客户端明确告知该标识会发送到中国大陆和国际
登录服务，并要求本次确认。确认后客户端并行加载两区清单并调用两区
`POST /api/auth/sso/discovery`。服务端响应包含自报的 `region`。

- 一区成功、另一区明确返回 `ORG_SSO_NOT_FOUND`：选择成功区域。
- 两区都成功：`ORG_REALM_AMBIGUOUS`，不自动猜测。
- 两区都明确未找到：保留 `ORG_SSO_NOT_FOUND`。
- 任一区超时、不可达、响应非法或区域不匹配：`ORG_REALM_UNAVAILABLE`；即使另一区
  成功也 fail closed。

选中的临时区域用于本次 SSO authorize、callback、授权码兑换、联系方式验证与身份选择。
取消或 reset 会丢弃临时区域。

## 会话持久化与恢复

Desktop safeStorage 和 Mobile SecureStore 都只保存一个加密的原子记录：

```json
{ "version": 1, "realm": "global", "refreshToken": "…" }
```

旧版裸 refresh token 只在一次性迁移时按 `buildRegion` 解释。冷启动先加载并核验记录中
区域的端点清单，再向该区域 refresh；对端清单暂不可用时保留记录供重试，禁止退回
`buildRegion` 发送 token。登出会清除记录和 `sessionRealm`，业务端点恢复安装包区域。

Mobile 的 Pending OAuth 同时保存 `realm`，但 redirect scheme 始终使用当前安装包的
scheme。个人验证码和社交登录不做跨区域发现，也不合并两区 passport。

## 上线与回滚

必须按服务端先行、能力最后开启的顺序发布：

1. 先升级中国大陆和国际 `auth-server`，确保 discovery 响应都包含正确的 `region`。
2. 发布两区端点清单，补齐区域元数据，但先保持
   `crossRealmOrgLoginEnabled: false`。
3. 发布包含双区域发现能力的 Desktop 与 Mobile 客户端。
4. 确认两区清单互相可达且区域校验通过后，再同时将开关改为 `true`。

需要紧急回滚时，只需同时关闭两区清单中的 `crossRealmOrgLoginEnabled`；已建立的会话
仍按其保存的 `sessionRealm` 恢复，新的组织登录则只访问安装包区域。不要移除对端清单，
否则现有跨区域会话将无法安全 refresh。
