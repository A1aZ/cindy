import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SubagentScanBudgetError,
  discoverSubagentDefinitions,
} from '../subagent-definitions.js';

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

  // 回归:CLAUDE_CONFIG_DIR 在 host boot 期就被剥离出 process.env,dev 多实例的重定向只
  // 存在于**子进程 env**里(auth-adapters 注入)。不传子进程 env 就会扫错目录,判定失真。
  it('用传入 env 的 CLAUDE_CONFIG_DIR 定位用户作用域,而不是 process.env', async () => {
    const isolated = path.join(root, 'userData', 'claude-home');
    await writeAgent(path.join(isolated, 'agents'), 'iso.md', 'name: iso\nmodel: xai/grok-4.5');
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    // 故意让 process.env 指向另一个(空)目录:传入的 env 必须胜出。
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'wrong-home');
    try {
      const found = await discoverSubagentDefinitions({
        workingDir: path.join(root, 'repo-without-agents'),
        env: { CLAUDE_CONFIG_DIR: isolated },
      });
      expect(found.map((f) => f.name)).toEqual(['iso']);
    } finally {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
  });

  // SDK spawn 用的是 { ...process.env, ...userEnv } —— host 自己 process.env 上的
  // CLAUDE_CONFIG_DIR 照样会合并进子进程(我们的字典副本里被 cleanProcessEnv 剥掉了,
  // 但 cc 读的就是它)。所以两份 env 都要参与解析,否则没调过 strip 的 host 会被扫错目录。
  it('递入 env 没有 CLAUDE_CONFIG_DIR 时,回落 host env 的同名值', async () => {
    const hostHome = path.join(root, 'host-home');
    await writeAgent(path.join(hostHome, 'agents'), 'h.md', 'name: from-host-env\nmodel: opus');

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo-without-agents'),
      env: {},
      hostEnv: { CLAUDE_CONFIG_DIR: hostHome },
    });

    expect(found.map((f) => f.name)).toEqual(['from-host-env']);
  });

  it('递入 env 的 CLAUDE_CONFIG_DIR 压过 host env(dev 多实例重定向必须胜出)', async () => {
    const childHome = path.join(root, 'userData', 'claude-home');
    const hostHome = path.join(root, 'host-home');
    await writeAgent(path.join(childHome, 'agents'), 'c.md', 'name: from-child-env\nmodel: opus');
    await writeAgent(path.join(hostHome, 'agents'), 'h.md', 'name: from-host-env\nmodel: opus');

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo-without-agents'),
      env: { CLAUDE_CONFIG_DIR: childHome },
      hostEnv: { CLAUDE_CONFIG_DIR: hostHome },
    });

    expect(found.map((f) => f.name)).toEqual(['from-child-env']);
  });

  // 回归:本仓建 worktree 时刻意保留 .claude/agents 里的软链(WorktreeManager 用
  // dereference: false)。软链的 Dirent 既非 file 也非 dir,漏掉它 = 误判「没人声明 model」。
  it('跟随软链的 agent 定义文件', async () => {
    const real = path.join(root, 'shared');
    await writeAgent(real, 'reviewer.md', 'name: reviewer\nmodel: xai/grok-4.5');
    const agents = path.join(root, 'repo', '.claude', 'agents');
    await fs.mkdir(agents, { recursive: true });
    await fs.symlink(path.join(real, 'reviewer.md'), path.join(agents, 'reviewer.md'));

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found.map((f) => f.name)).toEqual(['reviewer']);
    expect(found[0].declaredModel).toBe('xai/grok-4.5');
  });

  it('跟随软链目录', async () => {
    const real = path.join(root, 'shared-agents');
    await writeAgent(real, 'a.md', 'name: linked-dir-agent\nmodel: opus');
    const agents = path.join(root, 'repo', '.claude', 'agents');
    await fs.mkdir(agents, { recursive: true });
    await fs.symlink(real, path.join(agents, 'shared'), 'dir');

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found.map((f) => f.name)).toEqual(['linked-dir-agent']);
  });

  it('悬空软链跳过,不影响同目录其它定义', async () => {
    const agents = path.join(root, 'repo', '.claude', 'agents');
    await writeAgent(agents, 'ok.md', 'name: ok\nmodel: opus');
    await fs.symlink(path.join(root, 'gone', 'nothing.md'), path.join(agents, 'dead.md'));

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found.map((f) => f.name)).toEqual(['ok']);
  });

  it('软链环不会无限递归(按 realpath 去重)', async () => {
    const agents = path.join(root, 'repo', '.claude', 'agents');
    await writeAgent(agents, 'a.md', 'name: a\nmodel: opus');
    // agents/loop -> agents 自己
    await fs.symlink(agents, path.join(agents, 'loop'), 'dir');

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found.map((f) => f.name)).toEqual(['a']);
  });

  // 预算超限必须**抛**,不能静默返回半份结果 —— 半份结果会被上层当成「扫完了,没人声明」,
  // 于是又把覆盖用的 env 设回去。抛出来才能走调用方的显式降级。
  it('文件数超预算 → 抛 SubagentScanBudgetError', async () => {
    const agents = path.join(root, 'repo', '.claude', 'agents');
    await fs.mkdir(agents, { recursive: true });
    await Promise.all(
      Array.from({ length: 210 }, (_, i) =>
        fs.writeFile(path.join(agents, `a${i}.md`), `---\nname: a${i}\n---\nbody\n`, 'utf8'),
      ),
    );

    await expect(
      discoverSubagentDefinitions({
        workingDir: path.join(root, 'repo'),
        env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
      }),
    ).rejects.toBeInstanceOf(SubagentScanBudgetError);
  });

  it('耗时超预算 → 抛 SubagentScanBudgetError', async () => {
    await writeAgent(path.join(root, 'repo', '.claude', 'agents'), 'a.md', 'name: a');
    // now() 注入一个「已经超时」的起点,不依赖真实慢盘也能锁住这条分支。
    await expect(
      discoverSubagentDefinitions({
        workingDir: path.join(root, 'repo'),
        env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
        now: () => Date.now() - 60_000,
      }),
    ).rejects.toBeInstanceOf(SubagentScanBudgetError);
  });

  // 计数式 checkTime() 只在两次 await 之间执行,挂死的网络盘会让它永远轮不到 —— 必须有个
  // 真定时器让**等待方**放弃。这里注入极短 deadline 验证外层超时确实会拒绝。
  it('外层 deadline 到点即拒绝(不指望被等的 fs 调用回来)', async () => {
    const agents = path.join(root, 'repo', '.claude', 'agents');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeAgent(path.join(agents, `d${i}`), `a${i}.md`, `name: a${i}`),
      ),
    );

    await expect(
      discoverSubagentDefinitions({
        workingDir: path.join(root, 'repo'),
        env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
        deadlineMs: 0,
      }),
    ).rejects.toBeInstanceOf(SubagentScanBudgetError);
  });

  it('deadline 充裕时正常返回(定时器不会误伤正常路径)', async () => {
    await writeAgent(path.join(root, 'repo', '.claude', 'agents'), 'a.md', 'name: a\nmodel: opus');

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
      deadlineMs: 5_000,
    });

    expect(found.map((f) => f.name)).toEqual(['a']);
  });

  // 回归:workingDir 可能是软链。子进程 cwd 会被解析成物理路径,cc 于是看得到
  // <真实仓库>/.claude/agents;按软链的字面父目录往上走会走到另一支,漏掉那份定义。
  it('workingDir 是软链时,按真实路径向上走查', async () => {
    const realRepo = path.join(root, 'real-repo');
    const workSub = path.join(realRepo, 'packages', 'app');
    await fs.mkdir(workSub, { recursive: true });
    await writeAgent(path.join(realRepo, '.claude', 'agents'), 'r.md', 'name: real-ancestor\nmodel: opus');
    // 软链放在一个完全没有 .claude 祖先的位置,字面向上走查什么也找不到。
    const linkParent = path.join(root, 'elsewhere');
    await fs.mkdir(linkParent, { recursive: true });
    const link = path.join(linkParent, 'app-link');
    await fs.symlink(workSub, link, 'dir');

    const found = await discoverSubagentDefinitions({
      workingDir: link,
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found.map((f) => f.name)).toEqual(['real-ancestor']);
  });


  // 回归:长 prompt 的 agent 完全合法。按大小整条跳过看着安全,实则漏掉一份声明了 model 的
  // 定义 → 上层误判「没人声明」→ 又把覆盖用的 env 设回去,正是本 PR 要修的 bug。
  it('超大定义文件照样读出 frontmatter(只读开头前缀,不按大小跳过)', async () => {
    const agents = path.join(root, 'repo', '.claude', 'agents');
    await fs.mkdir(agents, { recursive: true });
    await fs.writeFile(
      path.join(agents, 'huge.md'),
      `---\nname: huge\nmodel: xai/grok-4.5\n---\n${'x'.repeat(400 * 1024)}`,
      'utf8',
    );

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'huge', declaredModel: 'xai/grok-4.5' });
  });

  it('frontmatter 本身超出前缀 → 抛(结果不可信,不能当成「没人声明」)', async () => {
    const agents = path.join(root, 'repo', '.claude', 'agents');
    await fs.mkdir(agents, { recursive: true });
    // 起始分隔符在,但收尾分隔符被推到 32 KiB 之外。
    await fs.writeFile(
      path.join(agents, 'bloated.md'),
      `---\nname: bloated\ndescription: ${'d'.repeat(40 * 1024)}\nmodel: opus\n---\nbody\n`,
      'utf8',
    );

    await expect(
      discoverSubagentDefinitions({
        workingDir: path.join(root, 'repo'),
        env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
      }),
    ).rejects.toBeInstanceOf(SubagentScanBudgetError);
  });

  // 本仓既有的 customization-scanner 就是 toLowerCase().endsWith('.md');大小写敏感地漏掉
  // 一份声明 = 又把 env 设回去。
  it('扩展名大小写不敏感(reviewer.MD 也算定义)', async () => {
    const agents = path.join(root, 'repo', '.claude', 'agents');
    await fs.mkdir(agents, { recursive: true });
    await fs.writeFile(path.join(agents, 'Reviewer.MD'), '---\nmodel: opus\n---\nbody\n', 'utf8');

    const found = await discoverSubagentDefinitions({
      workingDir: path.join(root, 'repo'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
    });

    // name 缺失回退文件名,扩展名要被剥掉(不留 .MD)。
    expect(found.map((f) => f.name)).toEqual(['Reviewer']);
    expect(found[0].declaredModel).toBe('opus');
  });

  // readdir 会把整个目录物化成数组再排序 —— 生成出来的巨型目录能在计数预算生效前吃掉内存,
  // 同步排序还堵住事件循环让外层定时器都没机会触发。改 opendir 流式并就地封顶。
  it('单目录条目数超上限 → 抛(不物化、不排序)', async () => {
    const agents = path.join(root, 'repo', '.claude', 'agents');
    await fs.mkdir(agents, { recursive: true });
    await Promise.all(
      Array.from({ length: 520 }, (_, i) =>
        fs.writeFile(path.join(agents, `x${i}.txt`), 'not a definition', 'utf8'),
      ),
    );

    await expect(
      discoverSubagentDefinitions({
        workingDir: path.join(root, 'repo'),
        env: { CLAUDE_CONFIG_DIR: path.join(root, 'empty-home') },
      }),
    ).rejects.toBeInstanceOf(SubagentScanBudgetError);
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
