import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverSubagentDefinitions } from '../subagent-definitions.js';

let root: string;

async function writeAgent(dir: string, file: string, frontmatter: string, body = 'prompt body') {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), `---\n${frontmatter}\n---\n${body}\n`, 'utf8');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-subagent-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('discoverSubagentDefinitions', () => {
  it('读出 frontmatter 声明的 model 与正文', async () => {
    const wd = path.join(root, 'repo');
    await writeAgent(
      path.join(wd, '.claude', 'agents'),
      'x-search.md',
      'name: x-search\ndescription: 搜 X\nmodel: xai/grok-4.5',
      '你负责搜 X。',
    );

    const found = await discoverSubagentDefinitions({
      workingDir: wd,
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: 'x-search',
      scope: 'project',
      declaredModel: 'xai/grok-4.5',
    });
    expect(found[0].body.trim()).toBe('你负责搜 X。');
  });

  it('model: inherit 与空值都归一成「未声明」(平台语义等同没写)', async () => {
    const dir = path.join(root, 'repo', '.claude', 'agents');
    await writeAgent(dir, 'a.md', 'name: a\nmodel: inherit');
    await writeAgent(dir, 'b.md', 'name: b\nmodel: "  "');
    await writeAgent(dir, 'c.md', 'name: c');

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found.map((f) => f.name).sort()).toEqual(['a', 'b', 'c']);
    expect(found.every((f) => f.declaredModel === undefined)).toBe(true);
  });

  it('递归子目录(平台允许用子目录归类,身份只认 name)', async () => {
    await writeAgent(
      path.join(root, 'repo', '.claude', 'agents', 'review', 'deep'),
      'sec.md',
      'name: security-review\nmodel: opus',
    );

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found.map((f) => f.name)).toEqual(['security-review']);
  });

  it('项目作用域优先于用户作用域(同名取项目)', async () => {
    const home = path.join(root, 'home', '.claude');
    await writeAgent(path.join(home, 'agents'), 'dup.md', 'name: dup\nmodel: haiku');
    await writeAgent(
      path.join(root, 'repo', '.claude', 'agents'),
      'dup.md',
      'name: dup\nmodel: opus',
    );

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: home },
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ scope: 'project', declaredModel: 'opus' });
  });

  it('向上逐级查找项目目录,近者优先', async () => {
    const outer = path.join(root, 'repo');
    const inner = path.join(outer, 'packages', 'app');
    await fs.mkdir(inner, { recursive: true });
    await writeAgent(path.join(outer, '.claude', 'agents'), 'n.md', 'name: n\nmodel: far');
    await writeAgent(path.join(inner, '.claude', 'agents'), 'n.md', 'name: n\nmodel: near');

    const found = await discoverSubagentDefinitions({
      workingDir: inner,
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found).toHaveLength(1);
    expect(found[0].declaredModel).toBe('near');
  });

  it('也扫用户作用域', async () => {
    const home = path.join(root, 'home', '.claude');
    await writeAgent(path.join(home, 'agents'), 'u.md', 'name: u\nmodel: sonnet');

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo-without-agents'),
      env: { CLAUDE_CONFIG_DIR: home },
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'u', scope: 'user', declaredModel: 'sonnet' });
  });

  it('name 缺失时回退文件名;无 frontmatter 的文件跳过', async () => {
    const dir = path.join(root, 'repo', '.claude', 'agents');
    await writeAgent(dir, 'from-filename.md', 'description: 没写 name\nmodel: opus');
    await fs.writeFile(path.join(dir, 'plain.md'), '没有 frontmatter 的普通 md\n', 'utf8');

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found.map((f) => f.name)).toEqual(['from-filename']);
  });

  it('目录不存在 / workingDir 非绝对路径都安全返回空,不抛错', async () => {
    await expect(
      discoverSubagentDefinitions({
        workingDir: path.join(root, 'nope'),
        env: { CLAUDE_CONFIG_DIR: path.join(root, 'also-nope') },
      }),
    ).resolves.toEqual([]);

    await expect(
      discoverSubagentDefinitions({
        workingDir: 'relative/path',
        env: { CLAUDE_CONFIG_DIR: path.join(root, 'also-nope') },
      }),
    ).resolves.toEqual([]);
  });
});
