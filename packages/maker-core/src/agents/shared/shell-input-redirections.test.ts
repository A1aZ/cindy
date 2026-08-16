import { describe, expect, it } from 'vitest';

import { parseShellInputRedirections } from './shell-input-redirections.js';

describe('parseShellInputRedirections', () => {
  it.each([
    ['cat<.env', '.env', 'cat'],
    ['cat < ".env.local"', '.env.local', 'cat'],
    ['env -- cat 0<./.env.production', './.env.production', 'env -- cat 0'],
    ['cat<.e"nv"', '.env', 'cat'],
    ['cat<.e\\nv', '.env', 'cat'],
    ["cat <'$TARGET'", '$TARGET', 'cat'],
    ['cat <*.txt', '*.txt', 'cat'],
  ])('extracts the static input target from %s', (command, target, stripped) => {
    const parsed = parseShellInputRedirections(command);
    expect(parsed.command.trim()).toBe(stripped);
    expect(parsed.targets).toEqual([target]);
    expect(parsed.targetPrefixes).toHaveLength(1);
    expect(parsed.hasUnresolvedTarget).toBe(false);
  });

  it.each([
    'cat <$(printf .env)',
    'cat <$TARGET',
    'cat <"${TARGET}"',
    'cat <`printf .env`',
  ])('preserves dynamic input targets for fail-closed classification: %s', (command) => {
    expect(parseShellInputRedirections(command)).toEqual({
      command,
      targets: [],
      targetPrefixes: [],
      hasUnresolvedTarget: true,
    });
  });

  it('normalizes shell line continuations inside static targets', () => {
    const command = 'cat <.e\\' + '\n' + 'nv';
    expect(parseShellInputRedirections(command)).toEqual({
      command: 'cat  ',
      targets: ['.env'],
      targetPrefixes: ['cat '],
      hasUnresolvedTarget: false,
    });
  });

  it('normalizes shell line continuations outside redirection targets', () => {
    const command = 'cat .e\\' + '\n' + 'nv';
    expect(parseShellInputRedirections(command)).toEqual({
      command: 'cat .env',
      targets: [],
      targetPrefixes: [],
      hasUnresolvedTarget: false,
    });
  });

  it('skips comments only through the current line and resumes target scanning', () => {
    const command = 'true # cat <$TARGET\ncat <.env';
    expect(parseShellInputRedirections(command)).toEqual({
      command: 'true \ncat  ',
      targets: ['.env'],
      targetPrefixes: ['true \ncat '],
      hasUnresolvedTarget: false,
    });
  });

  it('leaves redirection-like text in comments out of the classified command', () => {
    const command = 'cat README.md # example: cat <$TARGET';
    expect(parseShellInputRedirections(command)).toEqual({
      command: 'cat README.md ',
      targets: [],
      targetPrefixes: [],
      hasUnresolvedTarget: false,
    });
  });

  it.each([
    "grep '<.env' data.txt",
    "cat '<.env'",
    'cat <<<.env',
    'cat <<EOF',
    'cat <&0',
    'cat <(printf x)',
    'cat \\<.env',
    'cat <>created',
    'cat 3<>created',
  ])('does not treat data or non-input-file syntax as a target: %s', (command) => {
    expect(parseShellInputRedirections(command)).toEqual({
      command,
      targets: [],
      targetPrefixes: [],
      hasUnresolvedTarget: false,
    });
  });
});
