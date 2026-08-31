export interface MobileHistoryAnchor {
  key: string;
  /** Item top relative to the viewport top before older rows are prepended. */
  viewportOffset: number;
  /** Nearby rows captured at the same time, used if a live render group replaces the primary key. */
  fallbacks?: readonly MobileHistoryAnchorCandidate[];
}

export interface MobileHistoryAnchorCandidate {
  key: string;
  viewportOffset: number;
}

export interface MobileHistoryAnchorCaptureState<ItemT> {
  data: readonly ItemT[];
  positionAtIndex(index: number): number | undefined;
  scroll: number;
  start: number;
}

export interface MobileHistoryAnchorResolveState {
  positionByKey(key: string): number | undefined;
  /** LegendList can briefly omit a key from its position cache while committing a prepend. */
  data?: readonly { key: string }[];
  positionAtIndex?(index: number): number | undefined;
}

const MAX_MOBILE_HISTORY_ANCHOR_CANDIDATES = 8;
const MAX_MOBILE_HISTORY_ANCHOR_POSITION_PROBES = 24;

function findClosestMobileHistoryAnchorIndex<ItemT>(
  state: MobileHistoryAnchorCaptureState<ItemT>,
): number | null {
  if (Number.isInteger(state.start) && state.start >= 0 && state.start < state.data.length) {
    return state.start;
  }

  // Item positions are monotonic. When LegendList has not published `start` yet, locate the
  // viewport with O(log n) position reads instead of scanning the whole retained history.
  let lower = 0;
  let upper = state.data.length - 1;
  let closestIndex: number | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  while (lower <= upper) {
    const index = Math.floor((lower + upper) / 2);
    const position = state.positionAtIndex(index);
    if (!Number.isFinite(position)) break;
    const distance = Math.abs((position as number) - state.scroll);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
    if ((position as number) < state.scroll) lower = index + 1;
    else upper = index - 1;
  }
  return closestIndex;
}

/**
 * Capture the first visible row in LegendList's own coordinate space.
 *
 * Native `contentOffset` is deliberately not used here: during a prepend,
 * Android may report the old physical offset while LegendList has already
 * moved its item positions to the new data coordinates.
 */
export function captureMobileHistoryAnchor<ItemT>(
  state: MobileHistoryAnchorCaptureState<ItemT>,
  keyOf: (item: ItemT) => string,
): MobileHistoryAnchor | null {
  if (!Number.isFinite(state.scroll)) return null;

  const closestIndex = findClosestMobileHistoryAnchorIndex(state);
  if (closestIndex === null) return null;
  const candidates: MobileHistoryAnchorCandidate[] = [];
  const seenKeys = new Set<string>();
  let positionProbes = 0;
  for (
    let distance = 0;
    candidates.length < MAX_MOBILE_HISTORY_ANCHOR_CANDIDATES
      && positionProbes < MAX_MOBILE_HISTORY_ANCHOR_POSITION_PROBES;
    distance++
  ) {
    const indices = distance === 0
      ? [closestIndex]
      : [closestIndex + distance, closestIndex - distance];
    let hasIndexInRange = false;
    for (const index of indices) {
      if (index < 0 || index >= state.data.length) continue;
      hasIndexInRange = true;
      if (positionProbes >= MAX_MOBILE_HISTORY_ANCHOR_POSITION_PROBES) break;
      positionProbes += 1;
      const key = keyOf(state.data[index]);
      const position = state.positionAtIndex(index);
      if (!key || seenKeys.has(key) || !Number.isFinite(position)) continue;
      seenKeys.add(key);
      candidates.push({
        key,
        viewportOffset: (position as number) - state.scroll,
      });
      if (
        candidates.length >= MAX_MOBILE_HISTORY_ANCHOR_CANDIDATES
        || positionProbes >= MAX_MOBILE_HISTORY_ANCHOR_POSITION_PROBES
      ) break;
    }
    if (!hasIndexInRange) break;
  }
  if (candidates.length === 0) return null;

  const startKey = keyOf(state.data[closestIndex]);
  candidates.sort((left, right) => {
    if (left.key === startKey) return -1;
    if (right.key === startKey) return 1;
    return Math.abs(left.viewportOffset) - Math.abs(right.viewportOffset);
  });

  const [primary, ...fallbacks] = candidates.slice(0, MAX_MOBILE_HISTORY_ANCHOR_CANDIDATES);
  return {
    ...primary,
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

/** Resolve the non-animated scroll offset that keeps the captured row in place. */
export function resolveMobileHistoryAnchorOffset(
  anchor: MobileHistoryAnchor,
  state: MobileHistoryAnchorResolveState,
): number | null {
  const candidates: readonly MobileHistoryAnchorCandidate[] = [anchor, ...(anchor.fallbacks ?? [])];
  for (const candidate of candidates) {
    let position = state.positionByKey(candidate.key);
    if (
      !Number.isFinite(position)
      && state.data
      && state.positionAtIndex
    ) {
      const index = state.data.findIndex((item) => item.key === candidate.key);
      if (index >= 0) position = state.positionAtIndex(index);
    }
    if (Number.isFinite(position)) {
      return Math.max(0, (position as number) - candidate.viewportOffset);
    }
  }
  return null;
}

export function isMobileHistoryAnchorSettled(
  currentOffset: number,
  targetOffset: number,
  previousTargetOffset: number | null,
  tolerance: number,
): boolean {
  return Number.isFinite(currentOffset)
    && Number.isFinite(targetOffset)
    && previousTargetOffset !== null
    && Math.abs(currentOffset - targetOffset) <= tolerance
    && Math.abs(previousTargetOffset - targetOffset) <= tolerance;
}
