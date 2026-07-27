/**
 * 搜索 / 引用跳转的落点判定 —— 生产调用方(CCAgentSessionView 的 searchJump effect)与
 * 单测共用同一份逻辑。
 *
 * 抽成纯函数的原因:这个判定原先内联在 effect 里,只有渲染整个会话视图才能覆盖,于是
 * store 侧的自愈回归"绕过了真正的生产入口" —— 调用方在 messages 里看到目标就直接 focus,
 * store 的孤岛感知补齐根本没机会跑(#676 review)。
 */

/** 判定所需的最小窗口状态,便于单测直接构造。 */
export type SearchJumpWindowState = {
  messages: readonly { clientId: string }[];
  /** 窗口里是否掺进过跳转孤岛(补齐失败时 merge 的 around 窗口)。 */
  historyWindowHasIsland?: boolean;
  /** 还能不能继续往上翻页取历史。false = 已经翻到历史起点。 */
  hasMoreMessages?: boolean;
};

/**
 * 能否直接 focus 已在窗口里的目标、跳过 store 的跳转加载?
 *
 * 前提:目标确实在当前窗口里。在此之上:
 *  - 窗口没有孤岛 → 直接 focus。
 *  - 有孤岛 → 一般要交回 store 重新补齐:"在窗口里"可能只是先前失败的深跳留下的孤立片段,
 *    它与已加载的尾部之间隔着没加载的历史,不补的话中间缺失永远修不回来。
 *  - **例外**:有孤岛但 `hasMoreMessages === false`,即已经翻到历史起点、再没有可取的页。
 *    这时任何补齐尝试都不可能改善覆盖(分页只能往更老翻,而那边已经空了),却每次搜索都要
 *    多打一次 around + 一次 list。直接 focus 严格更好:结果一样,少两个请求
 *    (#676 review codex P1)。孤岛标记保留,窗口整体重建时自然清零。
 *
 * 注:靠 boolean 无法证明"窗口已完整覆盖"——那需要把已加载区间显式建模(见 MessageStream
 * 里锚定窗口双向有界的 TODO,同一条后续改动)。这里只做能证明的部分:取不到新页时不白跑。
 */
export function canFocusWithoutJumpLoad(
  state: SearchJumpWindowState,
  targetClientId: string,
): boolean {
  const inWindow = state.messages.some((message) => message.clientId === targetClientId);
  if (!inWindow) return false;
  if (state.historyWindowHasIsland !== true) return true;
  return state.hasMoreMessages === false;
}
