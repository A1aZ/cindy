import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/chat/GhostToolCard.tsx', import.meta.url),
  'utf8',
);

describe('ghost card iframe canvas styling', () => {
  it('removes frame chrome without forcing a background onto transparent cards', () => {
    expect(source).toContain("border: 'none'");
    expect(source).toContain("outline: 'none'");
    expect(source).toContain("boxShadow: 'none'");
    expect(source).not.toContain(
      'background:var(--msg-tool-card-bg,var(--surface-elevated,transparent))',
    );
    expect(source).not.toContain(
      "backgroundColor: 'var(--msg-tool-card-bg, var(--surface-elevated))'",
    );
  });
});
