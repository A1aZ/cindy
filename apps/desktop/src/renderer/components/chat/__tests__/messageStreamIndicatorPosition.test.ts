import { describe, expect, it } from 'vitest';

import { resolveMessageStreamIndicatorBottomOffset } from '../messageStreamIndicatorPosition';

describe('resolveMessageStreamIndicatorBottomOffset', () => {
  it('keeps the indicator anchored to the composer when the status row changes overlay height', () => {
    expect(
      resolveMessageStreamIndicatorBottomOffset({
        bottomPadding: 174,
        composerTopOffset: 142,
      }),
    ).toBe(148);
    expect(
      resolveMessageStreamIndicatorBottomOffset({
        bottomPadding: 206,
        composerTopOffset: 142,
      }),
    ).toBe(148);
  });

  it('preserves the legacy offset when the composer card cannot be measured', () => {
    expect(resolveMessageStreamIndicatorBottomOffset({ bottomPadding: 174 })).toBe(118);
    expect(resolveMessageStreamIndicatorBottomOffset({ bottomPadding: 40 })).toBe(12);
  });
});
