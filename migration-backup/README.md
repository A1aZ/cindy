# 原私有仓未迁移 PR 的原始补丁备份

以下 3 个 PR 因与开源快照存在合并冲突,迁移时需人工解冲突;本目录保存其**原始未改动补丁**(git diff --binary --full-index,相对各自 merge-base)与原正文,作为无损备份。

- PR #493:head=0134ec871d9b39857090dcb774242951de81eeda merge-base=2c9ac54b9bbb3860f7b2b49c70b26f3d1504eeb8 → `pr-493.patch` / `pr-493-body.md`
- PR #552:head=14c53fe3a75b0e4c2a957671463a97aaa8caae17 merge-base=79013fcc830595199186c09d92e1fbcb1c323871 → `pr-552.patch` / `pr-552-body.md`
- PR #592:head=4abf4f9518a018b97d403342cb10f8297e6ce38b merge-base=d47a8ae53dae4affc38eed989596bdf45609c08d → `pr-592.patch` / `pr-592-body.md`

恢复方式:`git apply --3way pr-<n>.patch`(需要时先 checkout 对应基线)。
