import {
  globSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';

type ReviewSearchHelpers = {
  collectReadonlyCredentialEvidence: (
    toolName: string,
    input: unknown,
  ) => { paths: string[]; touchesCredential: boolean };
  filterReviewGrepResult: (
    result: unknown,
    input: unknown,
    allowedPaths: string[],
  ) => { content: Array<{ text?: string }>; details?: unknown };
  reviewSearchPathIsVisible: (
    candidate: string,
    allowedPaths: string[],
    baseDir?: string,
  ) => boolean;
  rgGlob: (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ) => Promise<string[]>;
};

function loadReviewSearchHelpers(
  workingDir: string,
  overrides: {
    lstatSync?: typeof lstatSync;
    managedRipgrepPath?: string;
  } = {},
): ReviewSearchHelpers {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const helperStart = source.indexOf("function isInsideRoot");
  const helperEnd = source.indexOf("// ── MCP streamable-HTTP");
  const findStart = source.indexOf("function rgGlob(");
  const findEnd = source.indexOf("export default async function cindyBridge");
  const selectorGlobs = /^const CREDENTIAL_SELECTOR_GLOBS = .*;$/m.exec(source)?.[0];
  if (
    helperStart < 0 ||
    helperEnd <= helperStart ||
    findStart < 0 ||
    findEnd <= findStart ||
    !selectorGlobs
  ) {
    throw new Error(
      "Review search helpers were not found in the generated bridge",
    );
  }
  const executableSource = [
    "const CREDENTIAL_PATH_PATTERNS: RegExp[] = [/(?:^|[\\\\/])\\.env(?:\\.[^\\\\/]+)?$/i, /\\.pem$/i];",
    "const REVIEW_CREDENTIAL_PATH_PATTERNS: RegExp[] = [/(?:^|[\\\\/])node_modules(?:[\\\\/]|$)/i];",
    "const REVIEW_CREDENTIAL_GLOB_PATTERNS: string[] = [];",
    selectorGlobs,
    "function touchesCredentialPath(input: unknown): boolean {",
    "  if (typeof input === 'string') return CREDENTIAL_PATH_PATTERNS.some((re) => re.test(input));",
    "  if (Array.isArray(input)) return input.some(touchesCredentialPath);",
    "  return false;",
    "}",
    source.slice(helperStart, helperEnd),
    "function currentPermissionState() {",
    "  return { reviewOnly: true, reviewReadPaths: (globalThis as any).__reviewReadPaths };",
    "}",
    "function managedRipgrepPath() { return (globalThis as any).__managedRipgrepPath; }",
    source.slice(findStart, findEnd),
    "(globalThis as any).collectReadonlyCredentialEvidence = collectReadonlyCredentialEvidence;",
    "(globalThis as any).filterReviewGrepResult = filterReviewGrepResult;",
    "(globalThis as any).reviewSearchPathIsVisible = reviewSearchPathIsVisible;",
    "(globalThis as any).rgGlob = rgGlob;",
  ].join("\n");
  const compiled = ts.transpileModule(executableSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context: Partial<ReviewSearchHelpers> & Record<string, unknown> = {
    path,
    process: { cwd: () => workingDir, platform: process.platform },
    Buffer,
    lstatSync: overrides.lstatSync ?? lstatSync,
    readFileSync,
    realpathSync,
    statSync,
    spawn,
    createInterface,
    __reviewReadPaths: [workingDir],
    __managedRipgrepPath: overrides.managedRipgrepPath ?? "",
  };
  runInNewContext(compiled, context);
  if (
    !context.collectReadonlyCredentialEvidence ||
    !context.filterReviewGrepResult ||
    !context.reviewSearchPathIsVisible ||
    !context.rgGlob
  ) {
    throw new Error("Review search helpers were not loaded");
  }
  return context as ReviewSearchHelpers;
}

describe('cindy-bridge extension source', () => {
  it('is valid standalone TypeScript for the Pi runtime to load', () => {
    const result = ts.transpileModule(CINDY_BRIDGE_EXTENSION_SOURCE, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    });
    const errors = (result.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    expect(errors).toEqual([]);
  });

  it('restricts readonly credential evidence to path and selector fields', () => {
    const helpers = loadReviewSearchHelpers('/repo');
    const evidence = (toolName: string, input: unknown) => {
      const value = helpers.collectReadonlyCredentialEvidence(toolName, input);
      return { paths: [...value.paths], touchesCredential: value.touchesCredential };
    };

    expect(evidence('grep', { pattern: '.env', path: 'src', context: '.env.local' })).toEqual({
      paths: ['src'],
      touchesCredential: false,
    });
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.env*' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.n?trc' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: 'src/.n?trc' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '*.p?m' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.config/g?/**' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '?.key' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.env.?' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.ssh-*/**' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', globs: ['*.key', '!secret.key'] }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '**/.cargo/credentia?s.bak' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '**/.m2/settings.xml.bak' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.s?h' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: 'id_rsa.*' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.s?h/config' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.config/g?/hosts.yml' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.a?s/credentials' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.config/g?-*/**' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: 'nested/.config/g?-*/**' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.e[n-o]v' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '[.-0]env*' }).touchesCredential).toBe(true);
    expect(evidence('find', { pattern: '.e{n,foo}v', path: 'src' }).touchesCredential).toBe(true);
    expect(evidence('find', { pattern: '{safe,.e[n-o]v}', path: 'src' }).touchesCredential).toBe(true);
    expect(evidence('find', { pattern: '@(safe|.env)', path: 'src' }).touchesCredential).toBe(true);
    expect(evidence('find', { pattern: '.e{o,p}v', path: 'src' }).touchesCredential).toBe(false);
    expect(evidence('find', { pattern: '.e[o-p]v', path: 'src' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.environment*' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '!.env*' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', globs: ['*', '!.env*'] }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', globs: ['source.ts', '!.env*'] }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '[!.]*.ts' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '*.ts' }).touchesCredential).toBe(true);
    expect(evidence('find', { pattern: '*.ts', path: 'src' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.n?tes' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '[!.]*.png' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '?.txt' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.envrc?' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.netrcfoo' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.sshhelper' }).touchesCredential).toBe(false);
    expect(evidence('find', { pattern: '.env', path: 'src' }).touchesCredential).toBe(true);
    expect(evidence('read', { path: '.env.local', offset: 1 }).touchesCredential).toBe(true);
    expect(evidence('ls', { path: 'src/.environment' }).touchesCredential).toBe(false);
    expect(evidence('read', { path: 42 }).touchesCredential).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'collects canonical credential targets without flagging ordinary symlinks',
    () => {
      const source = CINDY_BRIDGE_EXTENSION_SOURCE;
      const helperStart = source.indexOf('const CREDENTIAL_PATH_PATTERNS');
      const helperEnd = source.indexOf('// 从 bash 子进程读取任意进程的初始环境');
      expect(helperStart).toBeGreaterThan(-1);
      expect(helperEnd).toBeGreaterThan(helperStart);

      const executableSource = [
        source.slice(helperStart, helperEnd),
        '(globalThis as any).collectResolvedCredentialPaths = collectResolvedCredentialPaths;',
        '(globalThis as any).bashInputReadTargets = bashInputReadTargets;',
        '(globalThis as any).bashInputReadEvidence = bashInputReadEvidence;',
        '(globalThis as any).parseShellInputRedirections = parseShellInputRedirections;',
        '(globalThis as any).resolvedCredentialEvidenceForHost = resolvedCredentialEvidenceForHost;',
      ].join('\n');
      const compiled = ts.transpileModule(executableSource, {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-pi-credential-link-'));
      const context: {
        globSync: typeof globSync;
        realpathSync: typeof realpathSync;
        statSync: typeof statSync;
        path: typeof path;
        process: { cwd: () => string; env: NodeJS.ProcessEnv };
        collectResolvedCredentialPaths?: (input: unknown) => string[];
        bashInputReadTargets?: (input: unknown) => string[];
        bashInputReadEvidence?: (input: unknown) => { targets: string[]; unresolved: boolean };
        parseShellInputRedirections?: (command: string) => {
          command: string;
          targets: string[];
          targetPrefixes: string[];
          targetMayExpand: boolean[];
          hasUnresolvedTarget: boolean;
        };
        resolvedCredentialEvidenceForHost?: (
          paths: readonly string[],
          credentialRead: boolean,
        ) => string[] | null;
      } = {
        globSync,
        realpathSync,
        statSync,
        path,
        process: { cwd: () => tempRoot, env: { HOME: tempRoot, PATH: process.env.PATH } },
      };
      runInNewContext(compiled, context);

      try {
        const secretPath = path.join(tempRoot, 'secrets', '.env');
        const ordinaryPath = path.join(tempRoot, 'ordinary.txt');
        const secretLink = path.join(tempRoot, 'innocent.txt');
        const ordinaryLink = path.join(tempRoot, 'ordinary-link.txt');
        const escapedSecretLink = path.join(tempRoot, 'innocent\\q');
        const nestedDir = path.join(tempRoot, 'nested');
        const dashDir = path.join(tempRoot, '-credential-dir');
        const nestedSecretLink = path.join(nestedDir, 'nested-innocent.txt');
        const dashSecretLink = path.join(dashDir, 'innocent.txt');
        const lateSecretLink = path.join(nestedDir, 'late-only-secret-link');
        const scopedLinkName = 'scoped-innocent.txt';
        const rootScopedSecretLink = path.join(tempRoot, scopedLinkName);
        const nestedScopedOrdinaryLink = path.join(nestedDir, scopedLinkName);
        const cdRedirectName = 'cd-innocent';
        const rootCdRedirectSecretLink = path.join(tempRoot, cdRedirectName);
        const nestedCdRedirectOrdinaryLink = path.join(nestedDir, cdRedirectName);
        const nestedOrdinaryReadName = 'ordinary-after-cd.txt';
        const nestedOrdinaryReadLink = path.join(nestedDir, nestedOrdinaryReadName);
        const cdPathRoot = path.join(tempRoot, 'cdpath-root');
        const cdPathSubDir = path.join(cdPathRoot, 'sub');
        const cdPathSecretLink = path.join(cdPathSubDir, 'link');
        mkdirSync(path.dirname(secretPath), { recursive: true });
        mkdirSync(nestedDir, { recursive: true });
        mkdirSync(dashDir, { recursive: true });
        mkdirSync(cdPathSubDir, { recursive: true });
        writeFileSync(secretPath, 'FAKE PRIVATE KEY');
        writeFileSync(ordinaryPath, 'ordinary');
        symlinkSync(secretPath, secretLink);
        symlinkSync(secretPath, nestedSecretLink);
        symlinkSync(secretPath, dashSecretLink);
        symlinkSync(secretPath, lateSecretLink);
        symlinkSync(secretPath, rootScopedSecretLink);
        symlinkSync(secretPath, escapedSecretLink);
        symlinkSync(secretPath, rootCdRedirectSecretLink);
        symlinkSync(ordinaryPath, nestedScopedOrdinaryLink);
        symlinkSync(ordinaryPath, nestedCdRedirectOrdinaryLink);
        symlinkSync(ordinaryPath, nestedOrdinaryReadLink);
        symlinkSync(secretPath, cdPathSecretLink);
        symlinkSync(ordinaryPath, ordinaryLink);

        expect(context.collectResolvedCredentialPaths?.({ path: secretLink })).toEqual([
          realpathSync(secretPath),
        ]);
        expect(context.collectResolvedCredentialPaths?.({ path: ordinaryLink })).toEqual([]);
        expect(context.resolvedCredentialEvidenceForHost?.([], true)).toBeNull();
        expect(context.resolvedCredentialEvidenceForHost?.([], false)).toEqual([]);
        expect(context.resolvedCredentialEvidenceForHost?.([secretPath], true)).toEqual([secretPath]);

        const secretCommand = `cat<${secretLink}`;
        const ordinaryCommand = `cat<${ordinaryLink}`;
        expect(context.parseShellInputRedirections?.(secretCommand).command.trim()).toBe('cat');
        expect(context.bashInputReadTargets?.({ command: secretCommand })).toEqual([secretLink]);
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: secretCommand }),
        )).toEqual([realpathSync(secretPath)]);
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: ordinaryCommand }),
        )).toEqual([]);
        const escapedBackslashCommand = 'cat <"innocent\\\\q"';
        expect(context.bashInputReadEvidence?.({ command: escapedBackslashCommand })).toEqual({
          targets: [escapedSecretLink],
          unresolved: true,
        });
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: escapedBackslashCommand }),
        )).toEqual([realpathSync(secretPath)]);
        for (const cdRedirectOperator of ['<>', '<']) {
          const command = `cd ${nestedDir} ${cdRedirectOperator}${cdRedirectName} && cat <${nestedOrdinaryReadName}`;
          const evidence = context.bashInputReadEvidence?.({ command });
          expect(evidence?.unresolved, command).toBe(false);
          expect(evidence?.targets, command).toEqual([
            rootCdRedirectSecretLink,
            nestedOrdinaryReadLink,
          ]);
          expect(context.collectResolvedCredentialPaths?.(evidence?.targets), command)
            .toEqual([realpathSync(secretPath)]);
        }
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({
            command: `cd ${nestedDir} <ordinary-link.txt && cat <${nestedOrdinaryReadName}`,
          }),
        )).toEqual([]);
        const readWriteSecretCommand = `cat 3<>${secretLink}`;
        expect(context.parseShellInputRedirections?.(readWriteSecretCommand)).toEqual({
          command: readWriteSecretCommand,
          targets: [secretLink],
          targetPrefixes: ['cat 3'],
          targetMayExpand: [false],
          hasUnresolvedTarget: false,
        });
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: readWriteSecretCommand }),
        )).toEqual([realpathSync(secretPath)]);
        for (const expandedCommand of [
          `cat <>${path.join(tempRoot, 'innocent.*')}`,
          'cat <>~/innocent.*',
        ]) {
          expect(context.collectResolvedCredentialPaths?.(
            context.bashInputReadTargets?.({ command: expandedCommand }),
          ), expandedCommand).toEqual([realpathSync(secretPath)]);
        }
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: "cat <>'innocent.*'" }),
        )).toEqual([]);
        const nestedCommand = `cd ${nestedDir} && cat <nested-innocent.txt`;
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: nestedCommand }),
        )).toEqual([realpathSync(secretPath)]);

        context.process.env.CDPATH = cdPathRoot;
        for (const cdRedirectOperator of ['<', '<>']) {
          const command = `cd sub ${cdRedirectOperator}ordinary-link.txt && cat <link`;
          expect(context.bashInputReadEvidence?.({ command }), command).toEqual({
            targets: [ordinaryLink, path.join(tempRoot, 'link')],
            unresolved: true,
          });
        }
        expect(context.bashInputReadEvidence?.({
          command: `cd ./nested <ordinary-link.txt && cat <${nestedOrdinaryReadName}`,
        })).toEqual({
          targets: [ordinaryLink, nestedOrdinaryReadLink],
          unresolved: false,
        });
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} && cat <${nestedOrdinaryReadName}`,
        })).toEqual({ targets: [nestedOrdinaryReadLink], unresolved: false });
        context.process.env.CDPATH = '.:';
        expect(context.bashInputReadEvidence?.({ command: 'cd nested && cat <nested-innocent.txt' }))
          .toEqual({ targets: [nestedSecretLink], unresolved: false });
        delete context.process.env.CDPATH;

        context.process.env.BASHOPTS = 'checkwinsize:cdable_vars';
        context.process.env.sub = cdPathSubDir;
        expect(context.bashInputReadEvidence?.({ command: 'cd sub && cat <link' }))
          .toEqual({ targets: [path.join(tempRoot, 'link')], unresolved: true });
        delete context.process.env.BASHOPTS;
        delete context.process.env.sub;

        context.process.env.BASH_ENV = path.join(tempRoot, 'shell-startup');
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} && cat <${nestedOrdinaryReadName}`,
        })).toEqual({
          targets: [path.join(tempRoot, nestedOrdinaryReadName)],
          unresolved: true,
        });
        delete context.process.env.BASH_ENV;
        context.process.env.ENV = 'development';
        expect(context.bashInputReadEvidence?.({ command: nestedCommand }))
          .toEqual({ targets: [nestedSecretLink], unresolved: false });
        delete context.process.env.ENV;
        for (const builtin of ['cd', 'pushd']) {
          context.process.env[`BASH_FUNC_${builtin}%%`] = '() { builtin cd "$HOME"; }';
          expect(context.bashInputReadEvidence?.({
            command: `${builtin} ${nestedDir} && cat <${nestedOrdinaryReadName}`,
          }), builtin).toEqual({ targets: [path.join(tempRoot, nestedOrdinaryReadName)], unresolved: true });
          delete context.process.env[`BASH_FUNC_${builtin}%%`];
        }

        const redirectedDirectoryCommands = [
          `cd ${nestedDir} >/dev/null && cat <nested-innocent.txt`,
          `cd ${nestedDir} 2>/dev/null 3>&1 && cat <nested-innocent.txt`,
          `pushd ${nestedDir} &>/dev/null && cat <nested-innocent.txt`,
          `cd ${nestedDir} </dev/null >>redirect.log && cat <nested-innocent.txt`,
          `cd ${nestedDir} <<<ready && cat <nested-innocent.txt`,
          `cd ${nestedDir} >/dev/null \\\n&& cat <nested-innocent.txt`,
          `cd ${nestedDir} >/dev/null # quiet\ncat <nested-innocent.txt`,
        ];
        for (const redirectedCommand of redirectedDirectoryCommands) {
          expect(context.collectResolvedCredentialPaths?.(
            context.bashInputReadTargets?.({ command: redirectedCommand }),
          ), redirectedCommand).toEqual([realpathSync(secretPath)]);
        }
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} >/dev/null && cat <${scopedLinkName}`,
        })).toEqual({ targets: [nestedScopedOrdinaryLink], unresolved: false });
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({
            command: `cd ${nestedDir} >/missing/output; cat <${scopedLinkName}`,
          }),
        )).toEqual([realpathSync(secretPath)]);
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} >$LOG && cat <ordinary-link.txt`,
        })).toEqual({ targets: [ordinaryLink], unresolved: true });
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} {fd}>/dev/null && cat <ordinary-link.txt`,
        })).toEqual({ targets: [ordinaryLink], unresolved: true });
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} <<EOF\nignored\nEOF\ncat <ordinary-link.txt`,
        })).toEqual({ targets: [ordinaryLink], unresolved: true });
        for (const groupedCommand of [
          `(cd ${nestedDir} && cat <>nested-innocent.txt)`,
          `{ cd ${nestedDir} && cat 3<>nested-innocent.txt; }`,
          `if cd ${nestedDir}; then cat 7<>nested-innocent.txt; fi`,
          'cd ~/nested && cat 8<>nested-innocent.txt',
          'cd nest* && cat 9<>nested-innocent.txt',
        ]) {
          expect(context.collectResolvedCredentialPaths?.(
            context.bashInputReadTargets?.({ command: groupedCommand }),
          ), groupedCommand).toEqual([realpathSync(secretPath)]);
        }
        for (const scopedCommand of [
          `(cd ${nestedDir} && true); cat <>${scopedLinkName}`,
          `if false; then cd ${nestedDir}; fi; cat 3<>${scopedLinkName}`,
          `false && cd ${nestedDir}; cat 4<>${scopedLinkName}`,
          `true || cd ${nestedDir}; cat 5<>${scopedLinkName}`,
          `cd ${path.join(tempRoot, 'missing')} && :; cat 6<>${scopedLinkName}`,
          `case x in y) cd ${nestedDir};; esac; cat 7<>${scopedLinkName}`,
        ]) {
          expect(context.collectResolvedCredentialPaths?.(
            context.bashInputReadTargets?.({ command: scopedCommand }),
          ), scopedCommand).toEqual([realpathSync(secretPath)]);
        }
        const optionTerminatedCdCommand = 'cd -- -credential-dir && cat <innocent.txt';
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: optionTerminatedCdCommand }),
        )).toEqual([realpathSync(secretPath)]);
        const quotedNoiseCommand = `printf '%s' '; cd a; cd b; cd c; cd d; cd e; cd f'; cd ${nestedDir}; cat <nested-innocent.txt`;
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: quotedNoiseCommand }),
        )).toEqual([realpathSync(secretPath)]);
        const targetBeforeCdCommand = `cat <late-only-secret-link; cd ${nestedDir}`;
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: targetBeforeCdCommand }),
        )).toEqual([]);
        const multilineCommand = `true # cat <ignored\ncd ${nestedDir}\ncat <nested-innocent.txt`;
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: multilineCommand }),
        )).toEqual([realpathSync(secretPath)]);
        const dynamicCommand = 'cat <$(printf .env)';
        expect(context.parseShellInputRedirections?.(dynamicCommand)).toEqual({
          command: dynamicCommand,
          targets: [],
          targetPrefixes: [],
          targetMayExpand: [],
          hasUnresolvedTarget: true,
        });
        expect(context.bashInputReadTargets?.({ command: dynamicCommand })).toEqual([]);
        expect(context.bashInputReadEvidence?.({ command: dynamicCommand })).toEqual({
          targets: [],
          unresolved: true,
        });
        expect(context.bashInputReadEvidence?.({ command: 'cat <>~cindy-no-such-user/innocent.txt' }))
          .toEqual({ targets: [], unresolved: true });
        expect(context.parseShellInputRedirections?.('cat <>created')).toEqual({
          command: 'cat <>created',
          targets: ['created'],
          targetPrefixes: ['cat '],
          targetMayExpand: [false],
          hasUnresolvedTarget: false,
        });
        expect(source).toContain("event.toolName === 'bash'\n      ? bashInputReadEvidence(event.input)");
        expect(source).toContain('bashReadEvidence.unresolved || touchesCredentialPath(bashReadTargets)');
        expect(source).toContain('resolvedCredentialPaths: credentialEvidenceForHost');
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it('overrides find with the managed ripgrep backend instead of runtime fd download', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;

    for (const tool of ['createBashTool', 'createFindTool', 'createGrepTool', 'createLsTool']) {
      expect(source).toContain(tool + ',');
    }
    expect(source).toContain("const args = ['--files', '--hidden', '--no-require-git']");
    expect(source).toContain("if (pattern.includes('/')) {");
    expect(source).toContain('path.basename(relative)');
    expect(source).toContain("effectivePattern = '**/' + pattern");
    expect(source).toContain('path.resolve(cwd, relative)');
    expect(source).toContain('path.matchesGlob(candidate, effectivePattern)');
    expect(source).not.toContain("'--glob', pattern");
    expect(source).toContain('glob: rgGlob');
    expect(source).toContain('const grepTool = createGrepTool(process.cwd())');
    expect(source).toContain(
      'filterReviewGrepResult(result, params, permission.reviewReadPaths)',
    );
    expect(source).toContain(
      'reviewSearchPathIsVisible(relative, permission.reviewReadPaths, cwd)',
    );
    expect(source).toContain('spawn(managedRipgrepPath(), args, {');
    expect(source).not.toContain("spawn('rg'");
    expect(source).toContain("const MANAGED_RG_PATH_ENV = 'CINDY_PI_MANAGED_RG_PATH'");
    expect(source).toContain('const lsTool = createLsTool(process.cwd())');
    expect(source).not.toContain("spawn('fd'");
  });

  it('keeps generated extension source free of template literals', () => {
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).not.toContain('`');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).not.toContain('${');
  });

  it('keeps Pi vision bridge tool security invariants (registration, size, magic-byte, redirect, redaction)', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    // 工具只在已启用且可解析 primary 后端时注册（fallback-only 不注册）。
    expect(source).toContain('piVisionCfg.enabled && piVisionCfg.primary');
    // 图片大小上限（stat 前置 + read 后 TOCTOU 复查）与魔数校验，防止任意本地文件外传。
    expect(source).toContain('MAX_IMAGE_BYTES');
    expect(source).toContain('statSync(imagePath)');
    expect(source).toContain('sniffImageMime');
    // 请求禁止跟随重定向（凭证/图片不流向非预期端点）。
    expect(source).toContain("redirect: 'error'");
    // 路由指定额外头必须合并进请求（anthropic-version / x-api-key / 自定义 provider 头），
    // 缺失会被后端拒（对齐 host 侧 vision-channel 的 headers 合并）。
    expect(source).toContain('...spec.headers');
    // anthropic-messages 视觉请求必须带 max_tokens（/v1/messages 强制要求，缺省会 400）。
    expect(source).toContain('max_tokens: 1024');
    // fallback 去重必须比较 headers——同 (url/model/auth) 但路由头不同（如不同
    // anthropic-beta）的 fallback 是独立后端，不得误判为重复跳过（P2）。
    expect(source).toContain('JSON.stringify(cfg.fallback.headers');
    // 本地图片转 data URL 进请求体，路径字符串不外发。
    expect(source).toContain('image_url:');
    expect(source).toContain("'data:'");
    // 错误脱敏：模型侧只看到泛化文案，不含本地路径 / key / URL。
    expect(source).toContain("'vision: vision backend request failed'");
    expect(source).toContain("'vision HTTP '");
    expect(source).toContain("'vision: unable to read the image file'");
    // host 可关联日志：fallback 行为有结构化 stderr 输出（脱敏，仅 backendRole/model）。
    expect(source).toContain('vision bridge pi primary backend failed');
    expect(source).toContain('vision bridge pi used fallback backend');
    expect(source).toContain('vision bridge pi fallback backend failed');
  });

  it('captures known writes before execution and marks opaque tools only after a result', () => {
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("pi.on('tool_call'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('FILE_WRITE_BUILTINS.has(event.toolName)');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("pi.on('tool_result'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("event.toolName !== 'bash'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("startsWith('mcp__')");
  });

  it('checks the Review deny-by-default boundary before ordinary permission handling', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    const reviewGate = source.indexOf('if (permission.reviewOnly)');
    const ordinaryWriteHandling = source.indexOf('if (FILE_WRITE_BUILTINS.has(event.toolName))');

    expect(reviewGate).toBeGreaterThan(-1);
    expect(ordinaryWriteHandling).toBeGreaterThan(reviewGate);
    expect(source).toContain(
      "reason: 'Cindy Review only permits read-only access to this task and its explicit artifacts.'",
    );
    expect(source).toContain('normalizeReviewReadInput(');
    expect(source).toContain('collectReviewPathFields(input)');
    expect(source).toContain("new Set(['glob', 'globs', 'pattern', 'patterns'])");
    expect(source).toContain('reviewSelectorTouchesCredential(selector)');
    expect(source).toContain('resolveReviewReadPath(candidate, allowedPaths)');
    expect(source).toContain('(input as Record<string, unknown>).path = resolvedPaths[0]!');
    expect(source).toContain('pathFields[index].write(resolvedPaths[index]!)');
    expect(source).not.toContain("toolName === 'grep' && statSync(target).isDirectory()");
    expect(source).toContain('reviewFileLinkLayoutIsSafe(target, targetStat, allowed)');
    expect(source).toContain("candidates.add(path.join(dependencyRoot, 'node_modules'");
    expect(source).toContain('reviewSearchPathHasUnsafeLinkLayout');
    expect(source).toContain(
      'reviewSearchPathIsVisible(relative, permission.reviewReadPaths, cwd)',
    );
    expect(source).not.toContain('reviewSearchPathHasMultipleLinks');
    expect(source).toContain('REVIEW_CREDENTIAL_PATH_PATTERNS.some');
    expect(source).toContain('REVIEW_CREDENTIAL_GLOB_PATTERNS.some');
  });

  it.skipIf(process.platform === 'win32')(
    'pins every Pi read tool to the real path that passed Review validation',
    () => {
      const source = CINDY_BRIDGE_EXTENSION_SOURCE;
      const helperStart = source.indexOf('function isInsideRoot');
      const helperEnd = source.indexOf('function reviewSearchPathTouchesCredential');
      expect(helperStart).toBeGreaterThan(-1);
      expect(helperEnd).toBeGreaterThan(helperStart);

      const executableSource = [
        "const REVIEW_CREDENTIAL_PATH_PATTERNS: RegExp[] = [/(?:^|[\\\\/])node_modules(?:[\\\\/]|$)/i];",
        source.slice(helperStart, helperEnd),
        '(globalThis as any).normalizeReviewReadInput = normalizeReviewReadInput;',
      ].join('\n');
      const compiled = ts.transpileModule(executableSource, {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;

      const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-pi-review-read-'));
      try {
        const workingDir = path.join(tempRoot, 'workspace');
        const outsideDir = path.join(tempRoot, 'outside');
        mkdirSync(workingDir);
        mkdirSync(outsideDir);
        const approvedPath = path.join(workingDir, 'approved.txt');
        const outsidePath = path.join(outsideDir, 'secret.txt');
        const linkPath = path.join(workingDir, 'review-input.txt');
        writeFileSync(approvedPath, 'approved');
        writeFileSync(outsidePath, 'outside');
        symlinkSync(approvedPath, linkPath);

        type NormalizeReviewReadInput = (
          toolName: string,
          input: unknown,
          allowedPaths: string[],
        ) => boolean;
        const context: {
          normalizeReviewReadInput?: NormalizeReviewReadInput;
        } & Record<string, unknown> = {
          path,
          process: { cwd: () => workingDir, platform: process.platform },
          Buffer,
          lstatSync,
          readFileSync,
          realpathSync,
          statSync,
        };
        runInNewContext(compiled, context);
        const normalizeReviewReadInput = context.normalizeReviewReadInput;
        expect(normalizeReviewReadInput).toBeTypeOf('function');
        if (!normalizeReviewReadInput) throw new Error('Review read normalizer was not loaded');

        const readInput = { path: linkPath };
        const grepInput = { request: { paths: [linkPath] }, pattern: 'approved' };
        const findInput = { options: { filePath: linkPath }, pattern: '*.txt' };
        const lsInput = { filepath: linkPath };
        const inputs = [
          { tool: 'read', input: readInput },
          {
            tool: 'grep',
            input: grepInput,
          },
          {
            tool: 'find',
            input: findInput,
          },
          { tool: 'ls', input: lsInput },
        ];
        for (const { tool, input } of inputs) {
          expect(normalizeReviewReadInput(tool, input, [approvedPath])).toBe(true);
        }

        expect(readInput.path).toBe(realpathSync(approvedPath));
        expect(grepInput.request.paths).toEqual([realpathSync(approvedPath)]);
        expect(findInput.options.filePath).toBe(realpathSync(approvedPath));
        expect(lsInput.filepath).toBe(realpathSync(approvedPath));

        for (const tool of ['read', 'grep', 'find', 'ls']) {
          const defaultInput: Record<string, unknown> = {};
          expect(normalizeReviewReadInput(tool, defaultInput, [workingDir])).toBe(true);
          expect(defaultInput.path).toBe(realpathSync(workingDir));
        }

        const localPackage = path.join(workingDir, 'packages', 'maker-core');
        const localSource = path.join(localPackage, 'src', 'index.ts');
        const localMirror = path.join(
          workingDir,
          'node_modules',
          '@cindy',
          'maker-core',
          'src',
          'index.ts',
        );
        mkdirSync(path.dirname(localSource), { recursive: true });
        mkdirSync(path.dirname(localMirror), { recursive: true });
        writeFileSync(
          path.join(localPackage, 'package.json'),
          '{"name":"@cindy/maker-core"}',
        );
        writeFileSync(localSource, 'export const value = 1;');
        linkSync(localSource, localMirror);
        expect(
          normalizeReviewReadInput('read', { path: localSource }, [workingDir]),
        ).toBe(true);

        const outsideManifest = path.join(outsideDir, 'package.json');
        const localManifest = path.join(localPackage, 'package.json');
        writeFileSync(outsideManifest, '{"name":"@cindy/maker-core"}');
        unlinkSync(localManifest);
        symlinkSync(outsideManifest, localManifest);
        expect(
          normalizeReviewReadInput('read', { path: localSource }, [workingDir]),
        ).toBe(false);
        unlinkSync(localManifest);
        writeFileSync(localManifest, '{"name":"@cindy/maker-core"}');

        linkSync(localSource, path.join(outsideDir, 'third-link.ts'));
        expect(
          normalizeReviewReadInput('read', { path: localSource }, [workingDir]),
        ).toBe(false);

        unlinkSync(linkPath);
        symlinkSync(outsidePath, linkPath);
        expect(readFileSync(readInput.path, 'utf8')).toBe('approved');
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps safe pnpm links visible to Pi Grep and managed Find while rejecting unsafe layouts",
    async () => {
      const tempRoot = mkdtempSync(
        path.join(tmpdir(), "cindy-pi-review-search-"),
      );
      try {
        const workingDir = path.join(tempRoot, "workspace");
        const outsideDir = path.join(tempRoot, "outside");
        mkdirSync(workingDir);
        mkdirSync(outsideDir);

        const sourcePackage = path.join(
          workingDir,
          "packages",
          "maker-core",
        );
        const sourcePath = path.join(sourcePackage, "src", "index.ts");
        const mirrorPath = path.join(
          workingDir,
          "node_modules",
          "@cindy",
          "maker-core",
          "src",
          "index.ts",
        );
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        mkdirSync(path.dirname(mirrorPath), { recursive: true });
        writeFileSync(
          path.join(sourcePackage, "package.json"),
          '{"name":"@cindy/maker-core"}',
        );
        writeFileSync(sourcePath, "export const safe = true;");
        linkSync(sourcePath, mirrorPath);

        const managedRipgrepPath = path.resolve(
          process.cwd(),
          "..",
          "..",
          "apps",
          "ripgrep-bin",
          `${process.platform}-${process.arch}`,
          "rg",
        );
        expect(statSync(managedRipgrepPath).isFile()).toBe(true);
        const helpers = loadReviewSearchHelpers(workingDir, {
          managedRipgrepPath,
        });
        const relativeSource = path.relative(workingDir, sourcePath);
        expect(
          helpers.reviewSearchPathIsVisible(
            relativeSource,
            [workingDir],
            workingDir,
          ),
        ).toBe(true);
        const visibleGrep = helpers.filterReviewGrepResult(
          {
            content: [
              {
                type: "text",
                text: `${relativeSource}:1:export const safe = true;`,
              },
            ],
          },
          { path: workingDir },
          [workingDir],
        );
        expect(visibleGrep.content[0]?.text).toContain(relativeSource);
        expect(
          await helpers.rgGlob("index.ts", workingDir, {
            ignore: [],
            limit: 100,
          }),
        ).toContain(sourcePath);

        const outsideSecret = path.join(outsideDir, "secret.ts");
        const outsideAlias = path.join(workingDir, "outside-alias.ts");
        writeFileSync(outsideSecret, "export const secret = true;");
        linkSync(outsideSecret, outsideAlias);
        expect(
          helpers.reviewSearchPathIsVisible(
            "outside-alias.ts",
            [workingDir],
            workingDir,
          ),
        ).toBe(false);
        expect(
          await helpers.rgGlob("*.ts", workingDir, { ignore: [], limit: 100 }),
        ).not.toContain(outsideAlias);

        const thirdLink = path.join(outsideDir, "third-link.ts");
        linkSync(sourcePath, thirdLink);
        expect(
          helpers.reviewSearchPathIsVisible(
            relativeSource,
            [workingDir],
            workingDir,
          ),
        ).toBe(false);
        expect(
          await helpers.rgGlob("index.ts", workingDir, {
            ignore: [],
            limit: 100,
          }),
        ).not.toContain(sourcePath);
        unlinkSync(thirdLink);

        let replaced = false;
        const sourceIdentity = statSync(sourcePath);
        const replacingHelpers = loadReviewSearchHelpers(workingDir, {
          managedRipgrepPath,
          lstatSync: ((candidate: Parameters<typeof lstatSync>[0]) => {
            const candidateStat = lstatSync(candidate);
            if (
              !replaced &&
              candidateStat.isFile() &&
              candidateStat.ino === sourceIdentity.ino &&
              candidateStat.dev === sourceIdentity.dev
            ) {
              replaced = true;
              const candidatePath = candidate.toString();
              unlinkSync(candidatePath);
              writeFileSync(candidatePath, "export const replacement = true;");
              return lstatSync(candidate);
            }
            return candidateStat;
          }) as typeof lstatSync,
        });
        expect(
          await replacingHelpers.rgGlob("index.ts", workingDir, {
            ignore: [],
            limit: 100,
          }),
        ).not.toContain(sourcePath);
        expect(replaced).toBe(true);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(
    process.platform === "win32" || !process.env.CINDY_REVIEW_REAL_WORKSPACE,
  )(
    "keeps a real pnpm-linked workspace file visible to Pi Grep and managed Find",
    async () => {
      const workingDir = process.env.CINDY_REVIEW_REAL_WORKSPACE!;
      const sourcePath = path.join(
        workingDir,
        "apps",
        "mobile",
        "modules",
        "xdt-ios-app-distribution",
        "src",
        "index.ts",
      );
      expect(statSync(sourcePath).nlink).toBe(2);
      const relativeSource = path.relative(workingDir, sourcePath);
      const managedRipgrepPath = path.resolve(
        process.cwd(),
        "..",
        "..",
        "apps",
        "ripgrep-bin",
        `${process.platform}-${process.arch}`,
        "rg",
      );
      const helpers = loadReviewSearchHelpers(workingDir, {
        managedRipgrepPath,
      });
      expect(
        helpers.reviewSearchPathIsVisible(
          relativeSource,
          [workingDir],
          workingDir,
        ),
      ).toBe(true);
      const visibleGrep = helpers.filterReviewGrepResult(
        {
          content: [
            {
              type: "text",
              text: `${relativeSource}:1:export * from './types';`,
            },
          ],
        },
        { path: workingDir },
        [workingDir],
      );
      expect(visibleGrep.content[0]?.text).toContain(relativeSource);
      expect(
        await helpers.rgGlob("index.ts", workingDir, {
          ignore: [],
          limit: 1000,
        }),
      ).toContain(sourcePath);
    },
  );
});
