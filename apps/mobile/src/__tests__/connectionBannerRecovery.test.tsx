// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useShowConnectionBanner } from '@/components/ConnectionBanner';
import type { DeviceLinkStatus } from '@cindy/device-link';

vi.mock('react-native', () => ({ ActivityIndicator: () => null, View: () => null, StyleSheet: { create: (s: unknown) => s } }));
vi.mock('lucide-react-native', () => ({ LoaderCircle: () => null }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/components/AppText', () => ({ Text: () => null }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: () => null, StatusDot: () => null }));
vi.mock('@/theme', () => ({ fontWeight: {}, useTheme: () => ({}), useThemedStyles: () => ({}) }));

let root: Root;
let visible = false;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });
function Probe({ status, recovery, error, unresponsive }: {
  status: DeviceLinkStatus; recovery?: 'syncing' | 'recovered'; error?: string; unresponsive?: boolean;
}) {
  visible = useShowConnectionBanner(status, error ?? null, null, unresponsive, recovery);
  return null;
}
function render(status: DeviceLinkStatus, recovery?: 'syncing' | 'recovered', error?: string, unresponsive?: boolean) {
  act(() => root.render(createElement(Probe, { status, recovery, error, unresponsive })));
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it('keeps repeated online task loads quiet, even when content takes several seconds', () => {
  for (let visit = 0; visit < 3; visit++) {
    render('online', 'syncing'); advance(5_000); expect(visible).toBe(false);
    render('online', 'recovered'); advance(500); expect(visible).toBe(false);
  }
});
it('keeps a real outage visible through content repair, then clears the recovered tail', () => {
  render('connecting', 'syncing'); advance(1_199); expect(visible).toBe(false);
  advance(1); expect(visible).toBe(true);
  render('online', 'syncing'); advance(5_000); expect(visible).toBe(true);
  render('online', 'recovered'); advance(1_999); expect(visible).toBe(true);
  advance(1); expect(visible).toBe(false);
  render('online', 'syncing'); advance(5_000); expect(visible).toBe(false);
});
it('does not promote a brief connection blip into a long content recovery banner', () => {
  render('connecting', 'syncing'); advance(300);
  render('online', 'syncing'); advance(5_000); expect(visible).toBe(false);
});
it('still shows actual request errors and an unresponsive computer immediately', () => {
  render('online', 'syncing', 'INVOKE_TIMEOUT'); expect(visible).toBe(true);
  render('online', 'syncing', undefined, true); expect(visible).toBe(true);
  render('online', 'recovered'); expect(visible).toBe(false);
});
