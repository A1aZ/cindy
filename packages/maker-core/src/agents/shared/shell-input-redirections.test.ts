import { describe, expect, it } from 'vitest';

import { parseShellInputRedirections } from './shell-input-redirections.js';

describe('parseShellInputRedirections', () => {
  it.each([
    ['cat<.env', '.env', 'cat'],
    ['cat < ".env.local"', '.env.local', 'cat'],
    ['env -- cat 0<./.env.production', './.env.production', 'env -- cat 0'],
    ['cat<.e"nv"', '.env', 'cat'],
    ['cat<.e\\nv', '.env', 'cat'],
    ['cat<>README.md', 'README.md', 'cat'],
  ])('extracts the input target from %s', (command, target, stripped) => {
    const parsed = parseShellInputRedirections(command);
    expect(parsed.command.trim()).toBe(stripped);
    expect(parsed.targets).toEqual([target]);
  });

  it.each([
    "grep '<.env' data.txt",
    "cat '<.env'",
    'cat <<<.env',
    'cat <<EOF',
    'cat <&0',
    'cat <(printf x)',
    'cat \\<.env',
  ])('does not treat data or non-file input syntax as a target: %s', (command) => {
    expect(parseShellInputRedirections(command)).toEqual({ command, targets: [] });
  });
});
