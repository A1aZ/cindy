import { describe, expect, it } from 'vitest';
import {
  captureMobileHistoryAnchor,
  isMobileHistoryAnchorSettled,
  resolveMobileHistoryAnchorOffset,
} from '@/session/messageHistoryAnchor';

describe('messageHistoryAnchor', () => {
  it('captures the first visible row in LegendList coordinates', () => {
    const anchor = captureMobileHistoryAnchor({
      data: [{ key: 'm1' }, { key: 'm2' }, { key: 'm3' }],
      positionAtIndex: (index) => [0, 140, 320][index],
      scroll: 170,
      start: 1,
    }, (item) => item.key);

    expect(anchor).toEqual({
      key: 'm2',
      viewportOffset: -30,
      fallbacks: [
        { key: 'm3', viewportOffset: 150 },
        { key: 'm1', viewportOffset: -170 },
      ],
    });
  });

  it('captures the closest measured row when LegendList has not resolved its visible range', () => {
    expect(captureMobileHistoryAnchor({
      data: [{ key: 'm1' }, { key: 'm2' }],
      positionAtIndex: (index) => [40, 190][index],
      scroll: 170,
      start: -1,
    }, (item) => item.key)).toEqual({
      key: 'm2',
      viewportOffset: 20,
      fallbacks: [{ key: 'm1', viewportOffset: -130 }],
    });
  });

  it('uses logarithmic position lookup and only captures nearby fallback rows', () => {
    const positionReads: number[] = [];
    const data = Array.from({ length: 800 }, (_, index) => ({ key: `m${index}` }));
    const anchor = captureMobileHistoryAnchor({
      data,
      positionAtIndex: (index) => {
        positionReads.push(index);
        return index * 100;
      },
      scroll: 40_050,
      start: -1,
    }, (item) => item.key);

    expect(anchor?.key).toBe('m400');
    expect(anchor?.fallbacks).toHaveLength(7);
    expect(positionReads.length).toBeLessThan(30);
  });

  it('bounds nearby probes when row positions are temporarily unavailable', () => {
    let positionReads = 0;
    const data = Array.from({ length: 800 }, (_, index) => ({ key: `m${index}` }));
    expect(captureMobileHistoryAnchor({
      data,
      positionAtIndex: (index) => {
        positionReads += 1;
        return index === 400 ? 40_000 : undefined;
      },
      scroll: 40_000,
      start: 400,
    }, (item) => item.key)).toEqual({ key: 'm400', viewportOffset: 0 });
    expect(positionReads).toBeLessThanOrEqual(24);
  });

  it('rejects a state with no measured rows', () => {
    expect(captureMobileHistoryAnchor({
      data: [{ key: 'm1' }],
      positionAtIndex: () => undefined,
      scroll: 0,
      start: -1,
    }, (item) => item.key)).toBeNull();
  });

  it('keeps the same row at the same viewport offset after a prepend', () => {
    const target = resolveMobileHistoryAnchorOffset(
      { key: 'm80', viewportOffset: -30 },
      { positionByKey: (key) => key === 'm80' ? 11_300 : undefined },
    );

    expect(target).toBe(11_330);
  });

  it('re-resolves the target when older row measurements settle', () => {
    const anchor = { key: 'm80', viewportOffset: 12 };
    expect(resolveMobileHistoryAnchorOffset(anchor, {
      positionByKey: () => 11_300,
    })).toBe(11_288);
    expect(resolveMobileHistoryAnchorOffset(anchor, {
      positionByKey: () => 11_348,
    })).toBe(11_336);
  });

  it('uses a nearby captured row if a live render group replaces the primary key', () => {
    expect(resolveMobileHistoryAnchorOffset({
      key: 'live-group-old',
      viewportOffset: -30,
      fallbacks: [{ key: 'm79', viewportOffset: 120 }],
    }, {
      positionByKey: (key) => key === 'm79' ? 11_500 : undefined,
    })).toBe(11_380);
  });

  it('falls back to the current data index while LegendList rebuilds its key cache', () => {
    expect(resolveMobileHistoryAnchorOffset({ key: 'm80', viewportOffset: -30 }, {
      data: [{ key: 'older' }, { key: 'm80' }],
      positionAtIndex: (index) => [0, 11_300][index],
      positionByKey: () => undefined,
    })).toBe(11_330);
  });

  it('requires both the scroll offset and target position to be stable', () => {
    expect(isMobileHistoryAnchorSettled(11_330, 11_330, null, 2)).toBe(false);
    expect(isMobileHistoryAnchorSettled(11_330, 11_330, 11_340, 2)).toBe(false);
    expect(isMobileHistoryAnchorSettled(11_329, 11_330, 11_331, 2)).toBe(true);
  });
});
