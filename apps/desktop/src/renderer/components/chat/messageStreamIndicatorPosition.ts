const DEFAULT_BOTTOM_PADDING_PX = 200;
const LEGACY_STATUS_ROW_OFFSET_PX = 56;
const MIN_BOTTOM_OFFSET_PX = 12;
const COMPOSER_GAP_PX = 6;

export function resolveMessageStreamIndicatorBottomOffset({
  bottomPadding,
  composerTopOffset,
}: {
  bottomPadding?: number;
  composerTopOffset?: number;
}): number {
  if (composerTopOffset != null) return composerTopOffset + COMPOSER_GAP_PX;

  const resolvedBottomPadding = bottomPadding ?? DEFAULT_BOTTOM_PADDING_PX;
  return Math.max(resolvedBottomPadding - LEGACY_STATUS_ROW_OFFSET_PX, MIN_BOTTOM_OFFSET_PX);
}
