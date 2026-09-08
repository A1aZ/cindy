import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';

import { readLocalWorktreeReferences } from '../worktreeReferences';
import type { DatabaseConstructor } from '../runtime';

describe('machine-local task reference reader', () => {
  let root: string;
  let currentPath: string;
  let current: Database.Database;
  const opened = vi.fn();
  const closed = vi.fn();
  const otherQuery = vi.fn();
  class ReadOnlyDatabase {
    constructor(file: string, options: Database.Options) { opened(file, options); }
    prepare(sql: string) { return { all: () => otherQuery(sql) }; }
    close() { closed(); }
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-task-reference-test-'));
    currentPath = path.join(root, 'cindy-current.db');
    fs.writeFileSync(currentPath, 'test fixture placeholder');
    current = { prepare: (sql: string) => ({ all: () => sql === 'PRAGMA database_list'
      ? [{ name: 'main', file: currentPath }]
      : [{ id: 'current-task', status: 'active', workingDir: root, worktreePath: null, source: 'desktop' }] }) } as unknown as Database.Database;
    opened.mockReset(); closed.mockReset();
    otherQuery.mockReset().mockReturnValue([{ id: 'other-task', status: 'active', workingDir: root, worktreePath: null, source: 'desktop' }]);
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const read = () => readLocalWorktreeReferences(current, ReadOnlyDatabase as unknown as DatabaseConstructor, 'test-native-binding');

  it('aggregates current and other local databases through read-only handles without changing owners', () => {
    fs.writeFileSync(path.join(root, 'cindy-other.db'), '');
    fs.writeFileSync(path.join(root, 'xdt-legacy.db'), '');
    fs.writeFileSync(path.join(root, 'unrelated.db'), '');
    const rows = read();
    expect(rows.filter((row) => row.currentDatabase)).toHaveLength(1);
    expect(rows.filter((row) => !row.currentDatabase)).toHaveLength(2);
    expect(opened).toHaveBeenCalledTimes(2);
    for (const [, options] of opened.mock.calls) expect(options).toEqual({ readonly: true, fileMustExist: true, nativeBinding: 'test-native-binding' });
    expect(closed).toHaveBeenCalledTimes(2);
    expect(otherQuery.mock.calls[0][0]).toContain('remote_host_id IS NULL');
    expect(otherQuery.mock.calls[0][0]).not.toContain('messages');
  });
  it('does not return a partial view when another database cannot be queried', () => {
    fs.writeFileSync(path.join(root, 'cindy-other.db'), '');
    otherQuery.mockImplementation(() => { throw new Error('locked database'); });
    expect(read).toThrow('locked database');
    expect(closed).toHaveBeenCalledTimes(1);
  });
  it('rejects unrecognized profile layouts rather than ignoring them', () => {
    fs.mkdirSync(path.join(root, 'profiles'));
    fs.mkdirSync(path.join(root, 'profiles', 'another-profile'));
    expect(read).toThrow('profile database catalog');
  });
  it('rejects a source created during the scan', () => {
    fs.writeFileSync(path.join(root, 'cindy-other.db'), '');
    otherQuery.mockImplementation(() => { fs.writeFileSync(path.join(root, 'cindy-new.db'), ''); return []; });
    expect(read).toThrow('catalog changed');
  });
  it('rejects a directory masquerading as a database', () => {
    fs.mkdirSync(path.join(root, 'cindy-other.db'));
    expect(read).toThrow('regular file');
  });
});
