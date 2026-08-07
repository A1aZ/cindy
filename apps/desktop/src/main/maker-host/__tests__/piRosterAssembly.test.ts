import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  deps: null as Record<string, unknown> | null,
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/cindy-pi-roster-assembly',
  },
}));

vi.mock('../../agent-binaries/index.js', () => ({
  getReadyBinaryPath: () => '/tmp/cindy-pi-roster-assembly/pi',
}));

vi.mock('@cindy/maker-core', () => ({
  PiAgent: class {
    constructor(deps: Record<string, unknown>) {
      state.deps = deps;
    }
  },
}));

import { buildPiAgent, composePiSystemPrompt } from '../pi-host.js';

describe('buildPiAgent roster prompt assembly', () => {
  it('forwards getGhostRosterPrompt into PiAgent deps and composes its output', () => {
    const getGhostRosterPrompt = vi.fn(({ workingDir }: { workingDir?: string }) =>
      workingDir ? '<ghost-roster>\n{"id":"art"}\n</ghost-roster>' : '',
    );

    buildPiAgent({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      getGhostRosterPrompt,
    });

    expect(state.deps?.getGhostRosterPrompt).toBe(getGhostRosterPrompt);
    const forwarded = state.deps?.getGhostRosterPrompt as typeof getGhostRosterPrompt;
    const roster = forwarded({ workingDir: '/workspace' });
    expect(roster).toContain('"id":"art"');
    expect(composePiSystemPrompt('Pi host identity', roster)).toBe(
      'Pi host identity\n\n<ghost-roster>\n{"id":"art"}\n</ghost-roster>',
    );
  });
});
