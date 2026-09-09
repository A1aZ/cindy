# 用量历史分类配色

- 日期：2026-09-09；平台：macOS Desktop / Electron；主题：Default Light、Default Dark。
- 分支：`fix/usage-category-colors`；基于 `ebcb181a5b61f8c27984190f76de687e576b1686`，证据对应本次未提交源码，相关生产文件的 Git blob 记录在本地 manifest。提交后以文件 blob 核对，不把启动脚本打印的基线 SHA 当作改后源码 SHA。
- 实例：独立 `usage-colors-20260909` 沙箱，CDP 9246；1280×800 CSS px，DPR 2。启动结果 `DESKTOP_DEV_VERDICT=ready`。
- 数据：35 个明确标为 `preview-model-*` 的模拟模型、三个 harness、40 天用量，通过 CDP 注入真实页面的内存数据状态；实际 `UsageHistorySection` 与其子组件正常渲染，无替代 HTML 样张。未写入真实账号的数据库，也未验证生产用量采集链路。

## 验证结果

- 35 个模型均得到非透明分类色；模型表色块、占比短条与每日柱图对应片段的 computed 颜色一致，柱体保留 35 个片段。
- Agent 顶部占比条、行前色块与占比短条一致。Light：`rgb(20, 184, 166)` / `rgb(99, 102, 241)` / `rgb(245, 158, 11)`；Dark：`rgb(45, 212, 191)` / `rgb(129, 140, 248)` / `rgb(251, 191, 36)`。
- Electron 支持从主题变量派生 OKLCH；两种主题的所有模型 computed 值见 JSON。
- 单日点击保持筛选，柱高不变，柱体四角仍为 2px。现有命中尺寸欠账不由本次颜色测试解决。
- `pnpm test:unit:related`、`pnpm --filter desktop run --if-present typecheck` 通过。测试覆盖 1000 个颜色分配、35 个模型的分段/表格对应、Agent 排名反转、早于 30 天的历史模型与单日筛选。
- 仅修改 Desktop；未测试 Mobile、其他操作系统和自定义主题组合。AI 采集和检查不构成设计师视觉批准。

## 截图与记录

当前保存在工作区忽略目录 `.cindy/usage-category-evidence-2026-09-09/`：

- `light-tables.png`、`dark-tables.png`：Agent 与模型表。
- `dark-models-tail.png`：第 35 个模型仍有颜色。
- `light.json`、`dark.json`：逐项 computed 颜色与几何记录。
- `manifest.json`：来源文件 blob 与证据校验值。

尚未上传 PR 附件；设计师视觉验收待完成。截图中的模型名与数值均为测试数据。
