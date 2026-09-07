import { describe, expect, it } from 'vitest';
import { desktopCaptureSource } from '../captureSource';

describe('desktop capture availability', () => {
  it('waits for the same attached display when capture temporarily omits it', () => {
    const displays = [{ id: 1 }, { id: 2 }];
    const other = { display_id: '2', id: 'screen:2:0' };
    const selected = { display_id: '1', id: 'screen:1:0' };
    expect(desktopCaptureSource([], '1', displays)).toBeNull();
    expect(desktopCaptureSource([other], '1', displays)).toBeNull();
    expect(desktopCaptureSource([other, selected], '1', displays)).toBe(selected);
  });
  it('still rejects a detached display and does not infer undocumented IDs', () => {
    expect(() => desktopCaptureSource([{ display_id: '1' }], '1', [])).toThrow('DESKTOP_DISPLAY_MISSING');
    expect(desktopCaptureSource([{ display_id: '', id: 'screen:1:0' }], '1', [{ id: 1 }])).toBeNull();
  });
});
