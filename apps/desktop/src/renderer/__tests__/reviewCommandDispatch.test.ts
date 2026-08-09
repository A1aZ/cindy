import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');
const dispatchStart = sessionViewSource.indexOf('const maybeDispatchDesktopSlashCommand');
const dispatchEnd = sessionViewSource.indexOf('const maybeShowContextUsage', dispatchStart);
const dispatchSource = sessionViewSource.slice(dispatchStart, dispatchEnd);

describe('/review command dispatch', () => {
  it('crosses the Main boundary with this invocation attachment snapshot before returning', () => {
    expect(dispatchSource).toContain("if (hit.name === 'review')");
    expect(dispatchSource).toContain('serializeAttachedFiles(files)');
    expect(dispatchSource).toContain('.startReview({');
    expect(dispatchSource.indexOf('.startReview({')).toBeLessThan(
      dispatchSource.indexOf('void dispatchCommand(hit'),
    );
  });

  it('does not hand Review attachments through a shared mutable ref or renderer event', () => {
    expect(sessionViewSource).not.toContain('pendingReviewFilesRef');
    expect(sessionViewSource).not.toContain("payload.command !== 'review'");
  });
});
