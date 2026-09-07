import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it.skipIf(process.platform !== 'darwin')(
  'preserves native system shortcut flags without posting input',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cindy-keyboard-flags-'));
    try {
      const native = path.resolve(import.meta.dirname, '../../../../native/remote-desktop');
      const source = await readFile(path.join(native, 'macos-input.swift'), 'utf8');
      const tests = await readFile(path.join(native, 'macos-input.test.swift'), 'utf8');
      const main = path.join(directory, 'main.swift');
      const binary = path.join(directory, 'keyboard-test');
      await writeFile(main, `${source}\n${tests}`);
      await exec('swiftc', ['-D', 'DESKTOP_INPUT_TEST', main, '-o', binary], { timeout: 120_000 });
      const { stdout } = await exec(binary, [], { timeout: 5000 });
      expect(stdout.trim()).toBe('native keyboard flags passed');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  130_000,
);
