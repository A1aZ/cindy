import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/session/SwipeableSessionRow.tsx'),
  'utf8',
);

describe('SwipeableSessionRow native animation lifecycle', () => {
  it('does not schedule a no-op timing animation when an action panel mounts', () => {
    expect(source).toContain('const armedProgress = useSharedValue(0);');
    expect(source).toContain('if (previous === null) {');
    expect(source).toContain('armedProgress.value = next ? 1 : 0;');
    expect(source).toContain(
      'armedProgress.value = withTiming(next ? 1 : 0, { duration: ARM_ANIMATION_MS });',
    );
    expect(source).not.toContain('const armedProgress = useDerivedValue(');
  });
});
