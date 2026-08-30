import { describe, expect, it } from 'vitest';
import {
  buildHomeProjectChildOffsets,
  findHomeProjectChildIndex,
  resolveHomeProjectChildWindow,
} from '@/session/homeProjectChildWindow';

describe('home project child window', () => {
  it('locates mixed-height rows without changing their total occupied height', () => {
    const offsets = buildHomeProjectChildOffsets([60, 78, 60, 78, 60, 78]);

    expect(offsets).toEqual([0, 60, 138, 198, 276, 336, 414]);
    expect(findHomeProjectChildIndex(offsets, 0)).toBe(0);
    expect(findHomeProjectChildIndex(offsets, 59)).toBe(0);
    expect(findHomeProjectChildIndex(offsets, 60)).toBe(1);
    expect(findHomeProjectChildIndex(offsets, 275)).toBe(3);

    const range = resolveHomeProjectChildWindow({
      anchor: 3,
      childOffsets: offsets,
      overscan: 1,
      windowSize: 2,
    });
    expect(range).toEqual({
      end: 6,
      leadingSpacerHeight: 138,
      start: 2,
      trailingSpacerHeight: 0,
    });
    expect(
      range.leadingSpacerHeight
      + (offsets[range.end] - offsets[range.start])
      + range.trailingSpacerHeight,
    ).toBe(offsets.at(-1));
  });

  it('keeps a tall expanded automation group inside the same prefix-sum model', () => {
    const offsets = buildHomeProjectChildOffsets([60, 78 + 60 + 78 + 54, 78, 60, 78]);

    expect(findHomeProjectChildIndex(offsets, 59)).toBe(0);
    expect(findHomeProjectChildIndex(offsets, 60)).toBe(1);
    expect(findHomeProjectChildIndex(offsets, 329)).toBe(1);
    expect(findHomeProjectChildIndex(offsets, 330)).toBe(2);
  });

  it('clamps the window at both ends and ignores invalid height estimates', () => {
    const offsets = buildHomeProjectChildOffsets([60, Number.NaN, -1, 78, 60]);

    expect(offsets).toEqual([0, 60, 60, 60, 138, 198]);
    expect(resolveHomeProjectChildWindow({
      anchor: 99,
      childOffsets: offsets,
      overscan: 1,
      windowSize: 2,
    })).toEqual({
      end: 5,
      leadingSpacerHeight: 60,
      start: 3,
      trailingSpacerHeight: 0,
    });
  });
});
