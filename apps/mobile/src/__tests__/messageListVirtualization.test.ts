import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 消息列表容器契约:LegendList(替代 FlatList —— 滚动 mount 卡顿的实测解,见 listperf profiling:
// windowSize=21 的大挂载树 p95≈167ms/jank46,换 LegendList 小预渲窗口后 p95≈20ms/jank4)。
// 关键 prop 不可回退:估高 + 小 drawDistance(挂载集小)+ 内置贴底/防跳(替代已删除的手搓 open-settle
// / follow rAF / prepend-settle 锚定机制)。
describe('mobile message list container', () => {
  it('uses LegendList with estimated-size virtualization and built-in chat anchoring', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    // 已完全迁出 FlatList:不再出现 FlatList 容器,也不再有其虚拟化专有 prop。
    expect(source).not.toContain('<FlatList');
    expect(source).not.toContain('windowSize={');
    expect(source).not.toContain('getItemLayout={');

    const listStart = source.search(/<LegendList\s/);
    expect(listStart).toBeGreaterThan(-1);
    const listSource = source.slice(listStart, source.indexOf('onViewableItemsChanged', listStart));

    // 估高 + 小预渲窗口:挂载集小、mount 帧压进一帧(不可退回大挂载树)。
    expect(listSource).toContain('estimatedItemSize={MOBILE_MESSAGE_ESTIMATED_ITEM_SIZE}');
    expect(listSource).toContain('drawDistance={MOBILE_MESSAGE_DRAW_DISTANCE}');
    // 与 main 一致，完整历史从首次挂载起就在列表中；不可退回只挂末尾几条的业务尾窗，
    // 否则短尾窗未撑满首屏时 Android 无法拖动历史。
    expect(listSource).toContain('data={listData}');
    expect(listSource).toContain('key={scrollResetKey}');
    expect(source).not.toContain('listData.slice(');
    expect(source).not.toContain('initialEntryBootstrapActive');
    expect(source).not.toContain('initialScrollOffset={');
    expect(source).not.toContain('MOBILE_INITIAL_TAIL_ITEM_COUNT');
    expect(source).not.toContain('MOBILE_TAIL_REVEAL_ITEM_COUNT');
    expect(listSource).not.toMatch(/\binitialScrollIndex\s*=/);
    // 内置贴底 + prepend 防跳(替代手搓 open-settle / follow rAF / prepend-settle,勿回潮)。
    expect(listSource).toContain('alignItemsAtEnd');
    expect(listSource).toContain('maintainScrollAtEnd');
    expect(listSource).toContain('maintainVisibleContentPosition={{ data: true, size: true }}');
    // Release 开启 native cell 回收；DEV 仍保留 listperf 的 on/off 单变量开关。
    // item type 分池 + recycling-aware state 防止菜单/展开态/媒体状态串到另一条消息。
    expect(source).toContain('const recycleItems = __DEV__ ? devRecycleItems === true : true;');
    expect(listSource).toContain('recycleItems={recycleItems}');
    expect(listSource).toContain('getItemType={mobileMessageListItemType}');
    expect(source).toContain('useRecyclingState');
    // 上滑加载:LegendList 近顶阈值触发自动预取(替代手搓的滚动 metric 判定)。
    expect(listSource).toContain('onStartReached={handleStartReached}');
    // 自动预取必须是电平判定(shouldAutoLoadEarlier + 多时机重评估),不许退回只吃 onStartReached
    // 边沿——边沿被业务 guard 吞掉后条件再就绪也等不到下一个边沿(顶部停留永不加载的回归)。
    expect(source).toContain('shouldAutoLoadEarlier({');
    // 冷开只在列表同时贴住 start/end(首屏未填满)时有限补页。
    expect(source).toContain('MAX_INITIAL_HISTORY_AUTOFILL_PAGES');
    expect(source).toContain('atStart: listState.isAtStart');
    expect(source).toContain('listState.isAtStart || nativeAtStart');
    expect(source).toContain('listState.isNearStart || nativeNearStart');
    expect(source).toContain('historyTouchTriggeredRef.current = true');
    // LegendList does not forward every raw touch callback to its native ScrollView. Observe the
    // bubbling gesture on the stable outer frame so a deliberate pull at offset 0 can request a page.
    expect(source).toContain('onTouchStart={handleHistoryTouchStart}');
    expect(source).toContain('onTouchMove={handleHistoryTouchMove}');
    expect(source).toContain('onTouchEnd={handleHistoryTouchEnd}');
    expect(source).toContain('onTouchCancel={handleHistoryTouchCancel}');
    expect(listSource).not.toContain('onTouchMove={handleHistoryTouchMove}');
    expect(source).toContain('if (readingOlderRef.current) return;');
    expect(source).toContain('const firstItemKey = loadEarlierProgressKey ?? itemKeys[0] ?? null;');
    expect(source).toContain('initialHistoryAutofillRemainingRef.current -= 1');
    // 所有 prepend 在请求和新页提交期间抑制贴底；只有 loadingEarlier 的完成态进入
    // 当前 render commit 后才延迟释放。generation 防止旧请求误清新会话 / 新请求。
    expect(source).toContain('onLoadEarlier?: () => void | Promise<void>');
    expect(source).toContain('readingOlderRef.current = true');
    expect(source).toContain('readingOlderLoadingObservedRef.current = true');
    expect(source).toContain('void Promise.resolve(result).then(');
    expect(source).toContain('const releaseAfterRequestSettles = () => {');
    expect(source).toContain('scheduleReadingOlderRelease(readingOlderRequestGenerationRef.current)');
    expect(source).toContain('readingOlderRequestGenerationRef.current === generation');
    expect(source).toContain('!loadingEarlierRef.current');
    // The settle deadline bounds only native prepend layout. It must never unlock while a slow
    // active-session page still reports loadingEarlier=true.
    expect(source).toContain('if (loadingEarlierRef.current) {');
    expect(source).toContain('readingOlderReleaseDeadlineRef.current = 0;');
    expect(source).not.toContain('|| Date.now() >= readingOlderReleaseDeadlineRef.current');
    expect(source).toContain('setLoadEarlierEvaluationVersion((version) => version + 1);');
    expect(source).toContain('[attemptAutoLoadEarlier, loadEarlierEvaluationVersion]');
    expect(source).toMatch(/Math\.min\(\r?\n\s+mvcpSettleAtRef\.current,/);
    expect(source).toContain('MOBILE_HISTORY_PREPEND_SETTLE_MAX_MS');
    const loadEarlierStart = source.indexOf('const requestLoadEarlier = useCallback');
    const loadEarlierEnd = source.indexOf('const attemptAutoLoadEarlier', loadEarlierStart);
    const loadEarlierSource = source.slice(loadEarlierStart, loadEarlierEnd);
    expect(loadEarlierSource).toContain('if (userScrollForOlderRef.current)');
    expect(loadEarlierSource).toContain('nearBottomRef.current = false');
    // A second touch while the page is in flight must not reopen follow-to-latest.
    const dragStart = source.indexOf('const handleScrollBeginDrag = useCallback');
    const dragEnd = source.indexOf('const handleScrollEndDrag', dragStart);
    expect(source.slice(dragStart, dragEnd)).not.toContain('readingOlderRef.current = false');
    // 深链 / 搜索定位本身就是明确的历史浏览意图,后续近顶自动补页无需再拖一下。
    const focusEffectStart = source.indexOf('// 深链/搜索:滚到指定消息');
    const focusEffectEnd = source.indexOf('// 新消息红点', focusEffectStart);
    const focusEffectSource = source.slice(focusEffectStart, focusEffectEnd);
    expect(focusEffectSource).toContain('if (!listRevealed) return;');
    expect(focusEffectSource).toContain('userScrollForOlderRef.current = true');
    expect(focusEffectSource).toContain('lastAutoLoadEarlierKeyRef.current = null');
  });

  it('hides main-compatible initial correction while keeping full history mounted', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    expect(source).toContain('programmaticScrollInFlight: programmaticScrollInFlightRef.current');
    expect(source).toContain('evaluateMobileAnchorVerify({');
    expect(source).toContain('initialAnchorVerifyFrameRef');
    expect(source).toContain('scrollToEndProgrammatically(false)');
    // mVCP 对 data / size 都常开；普通尾部追加与流式 resize 必须先记 settle 安静窗，
    // 跟随 verifier 不能只依赖 readingOlderRef 判断是否等待。
    expect(source).toContain('mvcpSettleAtRef.current = mobileMvcpSettleDeadline(');
    expect(source).toContain('markMobileMvcpSettle();');
    expect(source).toContain('mobileMessageListKeysSignature(itemKeys)');
    expect(source).toContain('[itemKeysSignature, markMobileMvcpSettle]');
    expect(source).not.toContain('[itemKeys, markMobileMvcpSettle]');
    expect(source.match(/isMobileMvcpSettling\(Date\.now\(\), mvcpSettleAtRef\.current\)/g))
      .toHaveLength(2);

    expect(source).toContain('key={scrollResetKey}');
    expect(source).not.toContain('tailWindowAnchor');
    expect(source).toContain('previousUserMessageJumpTarget(listData, firstVisibleIndex)');
    // main 的校正仍会命令式落底，但整个过程处于 opacity 遮罩下，settled/give-up 后
    // 才一次性揭开；进入详情不暴露任何补滚帧。
    expect(source).not.toContain('onLoad={handleListLoad}');
    expect(source).toContain('const [listRevealed, setListRevealed] = useState(false);');
    expect(source).toContain('setListRevealed(true);');
    expect(source).toContain('style={[styles.messageList, !listRevealed && styles.messageListSettling]}');
    expect(source).toContain('messageListSettling: { opacity: 0 }');
    expect(source).toContain('MOBILE_INITIAL_ANCHOR_SETTLE_MS');
    expect(source).not.toContain('MOBILE_INITIAL_ANCHOR_REVEAL_MAX_MS');
  });

  it('resets identity-bound row state before a recycled cell displays another item', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);

    expect(bubbleSource).toContain('useRecyclingState<CopyMessageStatus');
    expect(bubbleSource).toContain('useRecyclingState(false)');
    expect(bubbleSource).toContain('useRecyclingState<{');
    expect(bubbleSource).toContain('useRecyclingState<string | null>(null)');
    expect(source).toContain('const [contentWidth, setContentWidth] = useRecyclingState(0);');
    expect(source).toContain('const [resolveState, setResolveState] = useRecyclingState<MediaThumbnailResolveState>');
    expect(source).toContain('const [recycledLocalExpanded, setRecycledLocalExpanded] = useRecyclingState(defaultExpanded);');
  });

  it('clears stale history intent before verifying an explicit follow-latest request', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const effectStart = source.indexOf('// 「跳到最新」请求');
    const effectEnd = source.indexOf('// 自动加载更早', effectStart);
    const effectSource = source.slice(effectStart, effectEnd);
    const clearHistoryIntentAt = effectSource.indexOf('userScrollForOlderRef.current = false');
    const verifyAt = effectSource.indexOf('runStickToLatestVerify();');

    expect(effectStart).toBeGreaterThan(-1);
    expect(effectEnd).toBeGreaterThan(effectStart);
    expect(clearHistoryIntentAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(clearHistoryIntentAt);
  });

  it('verifies a manual jump-to-latest after issuing the animated scroll', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const callbackStart = source.indexOf('const scrollToBottom = useCallback');
    const callbackEnd = source.indexOf('const jumpToPreviousUserMessage', callbackStart);
    const callbackSource = source.slice(callbackStart, callbackEnd);
    const scrollAt = callbackSource.indexOf('scrollToEndProgrammatically(true);');
    const verifyAt = callbackSource.indexOf('runStickToLatestVerify();');

    expect(callbackStart).toBeGreaterThan(-1);
    expect(callbackEnd).toBeGreaterThan(callbackStart);
    expect(scrollAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(scrollAt);
    expect(callbackSource).toContain(
      '}, [runStickToLatestVerify, scrollToEndProgrammatically]);',
    );
  });

  it('waits for an animated follow scroll to settle before issuing non-animated verification retries', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const verifyStart = source.indexOf('const runStickToLatestVerify = useCallback');
    const verifyEnd = source.indexOf('// DEV-only:', verifyStart);
    const verifySource = source.slice(verifyStart, verifyEnd);
    const contentSizeStart = source.indexOf('const handleContentSize = useCallback');
    const contentSizeEnd = source.indexOf('// 冷开落底', contentSizeStart);
    const contentSizeSource = source.slice(contentSizeStart, contentSizeEnd);

    expect(verifySource).toContain('mobileFollowVerifyStartDelayMs({');
    expect(verifySource).toContain('followVerifyTimerRef.current = setTimeout');
    expect(contentSizeSource).toContain('if (programmaticAnimatedScrollInFlightRef.current)');
    expect(contentSizeSource.indexOf('if (programmaticAnimatedScrollInFlightRef.current)'))
      .toBeLessThan(contentSizeSource.indexOf('scrollToEndProgrammatically(false)'));
  });

  it('clears stale history intent when a manual downward scroll re-pins at the bottom', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const scrollStart = source.indexOf('// 近底/跟随态迁移');
    const scrollEnd = source.indexOf('// 用户开始拖动', scrollStart);
    const scrollSource = source.slice(scrollStart, scrollEnd);

    expect(scrollStart).toBeGreaterThan(-1);
    expect(scrollEnd).toBeGreaterThan(scrollStart);
    expect(scrollSource).toContain('const wasNearBottom = nearBottomRef.current');
    expect(scrollSource).toContain('if (!wasNearBottom && nearBottom && scrollDelta > 0)');
    expect(scrollSource).toContain('userScrollForOlderRef.current = false');
  });

  it('keeps follow verification enabled for a dead-zone drag that never actually unpins', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const verifyStart = source.indexOf('const runStickToLatestVerify');
    const verifyEnd = source.indexOf('// DEV-only:', verifyStart);
    const verifySource = source.slice(verifyStart, verifyEnd);

    expect(verifyStart).toBeGreaterThan(-1);
    expect(verifyEnd).toBeGreaterThan(verifyStart);
    expect(verifySource).toContain('stickToLatest: nearBottomRef.current');
    expect(verifySource).not.toContain(
      'stickToLatest: nearBottomRef.current && !userScrollForOlderRef.current',
    );
  });

  it('measures every mounted shareable message, including expanded group children', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const readerStart = source.indexOf('const readActuallyVisibleShareableMessageIds');
    const readerEnd = source.indexOf('useEffect(() => {', readerStart);
    const readerSource = source.slice(readerStart, readerEnd);

    expect(source).toContain('shareableMessageViewsRef = useRef(new Map<string, View>())');
    expect(source).toContain('onShareableMessageViewChange?: (clientId: string, view: View | null) => void');
    expect(source).toContain('ref={shareableMessage ? handleShareableMessageViewChange : undefined}');
    expect(readerSource).toContain('shareableMessageViewsRef.current.entries()');
    expect(readerSource).not.toContain("token.item.type !== 'message'");
    expect(source).toContain(
      'itemVisiblePercentThreshold: MESSAGE_LIST_VISIBLE_PERCENT_THRESHOLD',
    );
  });
});
