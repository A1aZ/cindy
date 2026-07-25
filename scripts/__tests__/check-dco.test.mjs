// check-dco.test.mjs — DCO 门禁的判定契约与端到端行为。
//
// 纯函数部分断言判定规则（签名解析、author 比对、merge/bot 豁免、git log 解析）；
// 端到端部分在 os.tmpdir 里造一个真 git 仓库，跑 CLI 与 prepare-commit-msg hook——
// 格式串、范围解析、hook 里的 sh/sed 写错都只能在真 git 上暴露。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  exemptReason,
  isBotIdentity,
  parseGitLog,
  parseSignOffs,
  validateCommit,
  validateCommits,
} from '../check-dco.mjs';
import {
  HOOK_MARKER,
  HOOK_NAME,
  HOOK_SOURCE_PATH,
  classifyHook,
  readHookSource,
} from '../install-dco-hook.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CHECK_DCO = path.join(ROOT, 'scripts', 'check-dco.mjs');
const INSTALL_HOOK = path.join(ROOT, 'scripts', 'install-dco-hook.mjs');

const AUTHOR = { name: 'Contributor', email: 'contributor@example.com' };

function commitFixture(overrides = {}) {
  return {
    sha: '1111111111111111111111111111111111111111',
    parents: ['0000000000000000000000000000000000000000'],
    authorName: AUTHOR.name,
    authorEmail: AUTHOR.email,
    committerName: AUTHOR.name,
    committerEmail: AUTHOR.email,
    message: 'feat: subject\n',
    ...overrides,
  };
}

test('parseSignOffs picks up every sign-off line and ignores other trailers', () => {
  const signOffs = parseSignOffs(
    [
      'fix: something',
      '',
      'Co-authored-by: Someone <someone@example.com>',
      'signed-off-by:  Lower Case  <lower@example.com> ',
      'Signed-off-by: Contributor <contributor@example.com>',
    ].join('\n')
  );
  assert.deepEqual(signOffs, [
    { name: 'Lower Case', email: 'lower@example.com' },
    { name: 'Contributor', email: 'contributor@example.com' },
  ]);
  assert.deepEqual(parseSignOffs('docs: no trailer here'), []);
  // 「提到」sign-off 不等于签署：正文里的散句不构成 trailer 行。
  assert.deepEqual(parseSignOffs('chore: mention Signed-off-by: nobody in prose'), []);
});

const signedOff = (subject = 'feat: x') =>
  `${subject}\n\nSigned-off-by: ${AUTHOR.name} <${AUTHOR.email}>\n`;

test('validateCommit accepts a sign-off matching author or committer', () => {
  assert.deepEqual(validateCommit(commitFixture({ message: signedOff() })), []);
  // rebase / apply 他人 patch 时 author 与 committer 不同，committer 的签名也算。
  assert.deepEqual(
    validateCommit(commitFixture({ authorEmail: 'original@example.com', message: signedOff() })),
    []
  );
  // 大小写与空白不应造成误报。
  assert.deepEqual(
    validateCommit(
      commitFixture({ message: `feat: x\n\nSigned-off-by: CONTRIBUTOR <CONTRIBUTOR@Example.com> \n` })
    ),
    []
  );
});

test('validateCommit rejects a missing or mismatched sign-off', () => {
  const missing = validateCommit(commitFixture());
  assert.equal(missing.length, 1);
  assert.match(missing[0], /No Signed-off-by trailer/);

  const mismatched = validateCommit(
    commitFixture({ message: 'feat: x\n\nSigned-off-by: Other <other@example.com>\n' })
  );
  assert.equal(mismatched.length, 1);
  assert.match(mismatched[0], /other@example\.com/);
  assert.match(mismatched[0], /Expected a sign-off from/);
});

test('validateCommit matches the DCO App on names and address shape', () => {
  // App 的判定是 name ∈ {author.name, committer.name} 且 email ∈ {…emails}。只查
  // email 会比 PR 门禁宽松，导致本地绿、CI 红。
  const wrongName = validateCommit(
    commitFixture({ message: `feat: x\n\nSigned-off-by: Someone Else <${AUTHOR.email}>\n` })
  );
  assert.equal(wrongName.length, 1);
  assert.match(wrongName[0], /both the name and the address/i);

  // App 用 validator.isEmail 拒掉没有 TLD 的地址，例如 git 在未配 user.email 时
  // 自动生成的 user@hostname。
  const badEmail = validateCommit(
    commitFixture({
      authorName: 'Contributor',
      authorEmail: 'contributor@localhost',
      committerEmail: 'contributor@localhost',
      message: 'feat: x\n\nSigned-off-by: Contributor <contributor@localhost>\n',
    })
  );
  assert.equal(badEmail.length, 1);
  assert.match(badEmail[0], /not a valid email address/);
});

test('merge commits and bot commits are exempt, humans are not', () => {
  assert.equal(exemptReason(commitFixture({ parents: ['a'.repeat(40), 'b'.repeat(40)] })), 'merge commit');
  assert.equal(exemptReason(commitFixture()), null);

  assert.ok(isBotIdentity('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'));
  assert.ok(isBotIdentity('GitHub', 'noreply@github.com'));
  // 普通用户的 noreply 邮箱不是 bot，不能借此绕过签名。
  assert.equal(isBotIdentity('Contributor', '12345+contributor@users.noreply.github.com'), false);
});

test('validateCommits separates failures from exemptions', () => {
  const result = validateCommits([
    commitFixture({ sha: 'a'.repeat(40) }),
    commitFixture({ sha: 'b'.repeat(40), message: signedOff('fix: y') }),
    commitFixture({ sha: 'c'.repeat(40), parents: ['x'.repeat(40), 'y'.repeat(40)] }),
  ]);
  assert.equal(result.checked, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].commit.sha, 'a'.repeat(40));
  assert.equal(result.exempted.length, 1);
});

test('parseGitLog keeps multi-line messages and parent lists intact', () => {
  const FIELD = '\u001f';
  const RECORD = '\u001e';
  const record = (fields) => fields.join(FIELD) + RECORD + '\n';
  const stdout =
    record([
      'a'.repeat(40),
      `${'p'.repeat(40)} ${'q'.repeat(40)}`,
      'Bot',
      'bot@example.com',
      'Bot',
      'bot@example.com',
      'chore: merge\n\nbody line\n',
    ]) +
    record([
      'b'.repeat(40),
      'p'.repeat(40),
      '贡献者',
      AUTHOR.email,
      '贡献者',
      AUTHOR.email,
      `feat: 中文标题\n\nSigned-off-by: 贡献者 <${AUTHOR.email}>\n`,
    ]);

  const commits = parseGitLog(stdout);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].parents.length, 2);
  assert.match(commits[0].message, /body line/);
  assert.equal(commits[1].authorName, '贡献者');
  assert.deepEqual(validateCommit(commits[1]), []);
});

test('classifyHook only overwrites hooks this repo installed', () => {
  assert.equal(classifyHook(null), 'missing');
  assert.equal(classifyHook('#!/bin/sh\necho unrelated\n'), 'foreign');
  assert.equal(classifyHook(`#!/bin/sh\n# ${HOOK_MARKER}\nold body\n`), 'outdated');
  assert.equal(classifyHook(readHookSource()), 'installed');
});

test('the hook source is a POSIX sh script that pins its trailer behaviour', () => {
  const source = readHookSource();
  assert.match(source, /^#!\/bin\/sh\n/);
  assert.ok(source.includes(HOOK_MARKER), 'hook 必须带 marker，否则安装器无法认领它');
  // 这两个开关的默认值可被开发者的 trailer.ifExists / trailer.ifMissing 配置改掉，
  // 配成 doNothing 时 hook 会在已有他人签名的提交上静默漏签，必须显式钉住。
  assert.match(source, /--if-exists addIfDifferent/);
  assert.match(source, /--if-missing add/);
  // 语法必须是 POSIX sh：hook 由 git 用 /bin/sh 执行，bashism 在 dash 上会直接失败。
  execFileSync('sh', ['-n', path.join(ROOT, HOOK_SOURCE_PATH)]);
});

// --- 端到端：真 git 仓库 ---

const canRunGitFixture = process.platform !== 'win32';

function createRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dco-')));
  // 隔离全局/系统 git 配置，避免宿主机的 hooksPath、gpgsign、template 影响结果。
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const run = (args, options = {}) =>
    execFileSync(args[0], args.slice(1), { cwd: dir, env, encoding: 'utf8', ...options });

  run(['git', 'init', '--quiet', '--initial-branch=main', '.']);
  run(['git', 'config', 'user.name', AUTHOR.name]);
  run(['git', 'config', 'user.email', AUTHOR.email]);
  run(['git', 'config', 'commit.gpgsign', 'false']);

  const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);
  const commit = (name, message, extraArgs = []) => {
    write(name, `${name}\n`);
    run(['git', 'add', name]);
    run(['git', 'commit', '--quiet', ...extraArgs, '-m', message]);
  };
  const checkDco = (args, extraEnv = {}) => {
    try {
      const stdout = run(['node', CHECK_DCO, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, ...extraEnv },
      });
      return { code: 0, output: stdout };
    } catch (error) {
      return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  };
  const sha = (ref) => run(['git', 'rev-parse', ref]).trim();
  /** 写一份 pull_request 事件 payload，模拟 CI 里的 GITHUB_EVENT_PATH。 */
  const writeEvent = (baseSha, headSha) => {
    const eventPath = path.join(dir, 'event.json');
    fs.writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { base: { sha: baseSha }, head: { sha: headSha } } })
    );
    return eventPath;
  };

  return { dir, run, commit, checkDco, sha, writeEvent };
}

test('CLI fails on an unsigned commit and passes once it is signed off', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  // 历史提交故意不签名：门禁只看范围内的新 commit，不追溯历史。
  repo.commit('history.txt', 'chore: pre-DCO history');
  repo.run(['git', 'checkout', '--quiet', '-b', 'feature']);
  repo.commit('feature.txt', 'feat: unsigned work');

  const failed = repo.checkDco(['--base', 'main']);
  assert.equal(failed.code, 1);
  assert.match(failed.output, /DCO check failed/);
  assert.match(failed.output, /No Signed-off-by trailer/);
  assert.match(failed.output, /git rebase --signoff/);

  repo.run(['git', 'commit', '--quiet', '--amend', '-s', '--no-edit']);
  const passed = repo.checkDco(['--base', 'main']);
  assert.equal(passed.code, 0);
  assert.match(passed.output, /DCO check passed/);
});

test('installed hook signs off subsequent commits automatically', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.commit('history.txt', 'chore: pre-DCO history');
  repo.run(['git', 'checkout', '--quiet', '-b', 'feature']);
  repo.run(['node', INSTALL_HOOK]);

  const hookPath = path.join(repo.dir, '.git', 'hooks', HOOK_NAME);
  assert.equal(classifyHook(fs.readFileSync(hookPath, 'utf8')), 'installed');

  // 注意这里没有 -s：hook 必须自己补上签名。
  repo.commit('feature.txt', 'feat: work committed without -s');
  const message = repo.run(['git', 'log', '-1', '--format=%B']);
  assert.match(message, new RegExp(`Signed-off-by: ${AUTHOR.name} <${AUTHOR.email}>`));

  // 已带签名时不重复追加。
  repo.commit('second.txt', `fix: already signed\n\nSigned-off-by: ${AUTHOR.name} <${AUTHOR.email}>`);
  const secondMessage = repo.run(['git', 'log', '-1', '--format=%B']);
  assert.equal(secondMessage.match(/Signed-off-by:/g).length, 1);

  // 开发者把 trailer.ifExists 配成 doNothing（interpret-trailers 的默认值可被覆盖）时，
  // 带着他人签名的提交仍必须补上本人签名，否则门禁会红而 hook 一声不响。
  repo.run(['git', 'config', 'trailer.ifExists', 'doNothing']);
  repo.commit('third.txt', 'fix: carries someone elses sign-off\n\nSigned-off-by: Other <other@example.com>');
  const thirdMessage = repo.run(['git', 'log', '-1', '--format=%B']);
  assert.match(thirdMessage, new RegExp(`Signed-off-by: ${AUTHOR.name} <${AUTHOR.email}>`));
  repo.run(['git', 'config', '--unset', 'trailer.ifExists']);

  assert.equal(repo.checkDco(['--base', 'main']).code, 0);
});

test('hook keeps the native `commit -s` layout for interactive commits', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.commit('history.txt', 'chore: pre-DCO history');
  repo.run(['git', 'checkout', '--quiet', '-b', 'feature']);
  repo.run(['node', INSTALL_HOOK]);

  // 模拟交互式提交：编辑器把标题写到消息首行，此时 hook 早已跑过。
  const editor = path.join(repo.dir, 'editor.sh');
  fs.writeFileSync(
    editor,
    ['#!/bin/sh', 'printf "feat: interactive title\\n" > "$1.tmp"', 'cat "$1" >> "$1.tmp"', 'mv "$1.tmp" "$1"', ''].join('\n')
  );
  fs.chmodSync(editor, 0o755);

  fs.writeFileSync(path.join(repo.dir, 'feature.txt'), 'feature\n');
  repo.run(['git', 'add', 'feature.txt']);
  repo.run(['git', 'commit', '--quiet'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_EDITOR: editor } });

  // 标题与签名之间必须有空行——这正是 `git commit -s` 的模板格式。
  assert.equal(
    repo.run(['git', 'log', '-1', '--format=%B']).trim(),
    `feat: interactive title\n\nSigned-off-by: ${AUTHOR.name} <${AUTHOR.email}>`
  );
  assert.equal(repo.run(['git', 'log', '-1', '--format=%s']).trim(), 'feat: interactive title');
  assert.equal(repo.checkDco(['--base', 'main']).code, 0);
});

test('CLI takes its range from the pull_request payload in CI', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.commit('history.txt', 'chore: pre-DCO history');
  const prBase = repo.sha('HEAD');
  repo.run(['git', 'checkout', '--quiet', '-b', 'feature']);
  repo.commit('feature.txt', 'feat: signed work', ['-s']);
  const prHead = repo.sha('HEAD');

  const fromPayload = repo.checkDco([], {
    GITHUB_EVENT_PATH: repo.writeEvent(prBase, prHead),
  });
  assert.equal(fromPayload.code, 0);
  assert.match(fromPayload.output, /DCO check passed: 1 commit signed off/);

  // base 分支在 PR 开着期间前进，且新提交没有签名：merge-base 必须把它排除在范围外，
  // 否则每个 PR 都会因为别人推到 main 的提交无端变红。
  repo.run(['git', 'checkout', '--quiet', 'main']);
  repo.commit('other.txt', 'chore: unsigned commit pushed to main by someone else');
  const movedBase = repo.sha('HEAD');
  repo.run(['git', 'checkout', '--quiet', 'feature']);

  const afterBaseMoved = repo.checkDco([], {
    GITHUB_EVENT_PATH: repo.writeEvent(movedBase, prHead),
  });
  assert.equal(afterBaseMoved.code, 0);
  assert.match(afterBaseMoved.output, /DCO check passed: 1 commit signed off/);
});
