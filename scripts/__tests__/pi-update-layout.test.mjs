import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { flattenExtractedDir } from '../../tools/pi/update.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-layout-'));
}

test('Pi updater accepts the flat Windows release layout', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'pi.exe');
  fs.writeFileSync(exe, Buffer.alloc(4096));
  fs.mkdirSync(path.join(dir, 'theme'));
  assert.equal(flattenExtractedDir(dir, 'pi.exe'), exe);
  assert.ok(fs.existsSync(path.join(dir, 'theme')));
});

test('Pi updater still flattens the nested Unix release layout', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nested = path.join(dir, 'pi');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'pi'), Buffer.alloc(4096));
  fs.mkdirSync(path.join(nested, 'theme'));
  assert.equal(flattenExtractedDir(dir, 'pi'), path.join(dir, 'pi'));
  assert.ok(fs.statSync(path.join(dir, 'pi')).isFile());
  assert.ok(fs.statSync(path.join(dir, 'theme')).isDirectory());
});

test('Pi release pin covers every supported desktop architecture', () => {
  const pin = JSON.parse(fs.readFileSync(new URL('../../tools/pi/latest.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pin.runtimeAssets).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64',
  ]);
});
