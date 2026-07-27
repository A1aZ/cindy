import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IOSSimulatorPackagedSidecarArtifactResolver,
  verifyIOSSimulatorPackagedSidecarArtifact,
  verifyIOSSimulatorSidecarDigest,
} from '../ios-simulator-artifact.js';

const TEAM_ID = 'ABCDE12345';
const MAIN_BUNDLE_ID = 'com.xd.cindycn';
const HELPER_BUNDLE_ID = `${MAIN_BUNDLE_ID}.ios-simulator-helper`;
const VERSION = '1.2.3';
const REQUIREMENT =
  `anchor apple generic and identifier "${HELPER_BUNDLE_ID}" ` +
  `and certificate leaf[subject.OU] = "${TEAM_ID}"`;

interface Fixture {
  root: string;
  appPath: string;
  resourcesPath: string;
  helperPath: string;
  executablePath: string;
  manifestPath: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(
  patch: {
    executable?: string;
    sha256?: string;
    mode?: 'developer-id' | 'adhoc';
    teamIdentifier?: string | null;
    bundleIdentifier?: string;
    architectures?: string[];
    designatedRequirement?: string;
    extraManifestField?: boolean;
  } = {},
): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-artifact-test-')));
  temporaryRoots.push(root);
  const appPath = path.join(root, 'Cindy.app');
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const helperPath = path.join(appPath, 'Contents', 'Helpers', 'Cindy iOS Simulator Helper.app');
  const executablePath = path.join(helperPath, 'Contents', 'MacOS', 'ios-simulator-sidecar');
  const manifestPath = path.join(resourcesPath, 'ios-simulator', 'native-sidecar-manifest.json');
  const executable = patch.executable ?? 'native-sidecar';
  const sha256 = patch.sha256 ?? createHash('sha256').update(executable).digest('hex');

  await Promise.all([
    mkdir(path.dirname(executablePath), { recursive: true }),
    mkdir(path.dirname(manifestPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(appPath, 'Contents', 'Info.plist'), '<plist/>'),
    writeFile(path.join(helperPath, 'Contents', 'Info.plist'), '<plist/>'),
    writeFile(executablePath, executable, { mode: 0o755 }),
    writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        artifactId: 'cindy.ios-simulator-sidecar',
        bundleIdentifier: patch.bundleIdentifier ?? HELPER_BUNDLE_ID,
        version: VERSION,
        architectures: patch.architectures ?? ['arm64'],
        sha256,
        signing: {
          mode: patch.mode ?? 'developer-id',
          teamIdentifier: patch.teamIdentifier === undefined ? TEAM_ID : patch.teamIdentifier,
          designatedRequirement: patch.designatedRequirement ?? REQUIREMENT,
          hardenedRuntime: true,
        },
        ...(patch.extraManifestField ? { executablePath: '/tmp/injected' } : {}),
      }),
    ),
  ]);
  return { root, appPath, resourcesPath, helperPath, executablePath, manifestPath };
}

function codesignMetadata(identifier: string, teamIdentifier: string): string {
  return [
    'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+0 location=embedded',
    `Identifier=${identifier}`,
    `TeamIdentifier=${teamIdentifier}`,
  ].join('\n');
}

function createCommandRunner(
  fixture: Fixture,
  patch: {
    helperBundleIdentifier?: string;
    mainTeamIdentifier?: string;
    helperTeamIdentifier?: string;
    helperSignatureIdentifier?: string;
    architectures?: string;
    designatedRequirement?: string;
    rejectRequirement?: boolean;
  } = {},
) {
  return vi.fn(async (command: string, args: readonly string[]) => {
    if (command === '/usr/libexec/PlistBuddy') {
      const plistPath = args.at(-1);
      return {
        stdout:
          plistPath === path.join(fixture.appPath, 'Contents', 'Info.plist')
            ? `${MAIN_BUNDLE_ID}\n`
            : `${patch.helperBundleIdentifier ?? HELPER_BUNDLE_ID}\n`,
        stderr: '',
      };
    }
    if (command === '/usr/bin/lipo') {
      return { stdout: `${patch.architectures ?? 'arm64'}\n`, stderr: '' };
    }
    if (command === '/usr/bin/codesign' && args.includes('-R=' + REQUIREMENT)) {
      if (patch.rejectRequirement) throw new Error('requirement rejected');
      return { stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/codesign' && args[0] === '--verify') {
      return { stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/codesign' && args[1] === '-r') {
      return {
        stdout: '',
        stderr: `designated => ${patch.designatedRequirement ?? REQUIREMENT}\n`,
      };
    }
    if (command === '/usr/bin/codesign' && args.includes('--verbose=4')) {
      const bundlePath = args.at(-1);
      const isHelper = bundlePath === fixture.helperPath;
      return {
        stdout: '',
        stderr: codesignMetadata(
          isHelper ? (patch.helperSignatureIdentifier ?? HELPER_BUNDLE_ID) : MAIN_BUNDLE_ID,
          isHelper
            ? (patch.helperTeamIdentifier ?? TEAM_ID)
            : (patch.mainTeamIdentifier ?? TEAM_ID),
        ),
      };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  });
}

describe('packaged iOS Simulator sidecar artifact verification', () => {
  it('promotes only the fixed signed Helper layout to a verified descriptor', async () => {
    const fixture = await createFixture();
    const commandRunner = createCommandRunner(fixture);

    await expect(
      verifyIOSSimulatorPackagedSidecarArtifact({
        resourcesPath: fixture.resourcesPath,
        version: VERSION,
        architecture: 'arm64',
        platform: 'darwin',
        commandRunner,
      }),
    ).resolves.toMatchObject({
      artifactId: 'cindy.ios-simulator-sidecar',
      source: 'bundled',
      version: VERSION,
      architecture: 'arm64',
      executablePath: fixture.executablePath,
      trust: 'verified',
      sha256: createHash('sha256').update('native-sidecar').digest('hex'),
    });
    expect(commandRunner).toHaveBeenCalledWith('/usr/bin/codesign', [
      '--verify',
      '--strict',
      `-R=${REQUIREMENT}`,
      fixture.helperPath,
    ]);
  });

  it.each([
    ['digest mismatch', { sha256: '0'.repeat(64) }, {}],
    ['ad-hoc signature', { mode: 'adhoc' as const, teamIdentifier: null }, {}],
    ['manifest bundle mismatch', { bundleIdentifier: 'com.example.helper' }, {}],
    ['main/helper team mismatch', {}, { helperTeamIdentifier: 'ZZZZZ99999' }],
    ['architecture mismatch', { architectures: ['x86_64'] }, { architectures: 'x86_64' }],
    ['designated requirement rejection', {}, { rejectRequirement: true }],
    ['manifest path injection', { extraManifestField: true }, {}],
  ])('keeps %s untrusted', async (_label, manifestPatch, commandPatch) => {
    const fixture = await createFixture(manifestPatch);
    const resolver = new IOSSimulatorPackagedSidecarArtifactResolver({
      resourcesPath: fixture.resourcesPath,
      version: VERSION,
      architecture: 'arm64',
      platform: 'darwin',
      commandRunner: createCommandRunner(fixture, commandPatch),
    });

    await expect(
      resolver.resolve({
        instanceId: 'instance-a',
        simulatorUdid: 'A1B2C3D4-1111-2222-3333-444455556666',
        generation: 7,
      }),
    ).resolves.toMatchObject({
      executablePath: fixture.executablePath,
      trust: 'untrusted',
      sha256: null,
    });
  });

  it('rejects a symlinked executable before invoking codesign', async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.root, 'replacement');
    await writeFile(targetPath, 'native-sidecar');
    await rm(fixture.executablePath);
    await symlink(targetPath, fixture.executablePath);
    const commandRunner = createCommandRunner(fixture);

    await expect(
      verifyIOSSimulatorPackagedSidecarArtifact({
        resourcesPath: fixture.resourcesPath,
        version: VERSION,
        architecture: 'arm64',
        platform: 'darwin',
        commandRunner,
      }),
    ).rejects.toThrow('verification failed');
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('fails a final pre-spawn check after the verified executable changes', async () => {
    const fixture = await createFixture();
    const expectedDigest = createHash('sha256').update('native-sidecar').digest('hex');
    await expect(
      verifyIOSSimulatorSidecarDigest(fixture.executablePath, expectedDigest),
    ).resolves.toBeUndefined();

    await writeFile(fixture.executablePath, 'changed-sidecar');
    await expect(
      verifyIOSSimulatorSidecarDigest(fixture.executablePath, expectedDigest),
    ).rejects.toThrow('verification failed');
  });

  it('signs the nested Helper before the main app in both macOS signing paths', async () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(testDirectory, '../../../../scripts/ci/lib.mjs');
    const source = await readFile(sourcePath, 'utf8');
    const adhocBody = source.slice(
      source.indexOf('export function adhocSignMacApp'),
      source.indexOf('export function signMacAppWithIdentity'),
    );
    const developerIdBody = source.slice(
      source.indexOf('export function signMacAppWithIdentity'),
      source.indexOf('export function notarizeMacApp'),
    );

    expect(adhocBody.indexOf('signIOSSimulatorHelper(')).toBeGreaterThan(-1);
    expect(adhocBody.indexOf('signIOSSimulatorHelper(')).toBeLessThan(
      adhocBody.indexOf('--entitlements "${mainEntitlementsPath}"'),
    );
    expect(developerIdBody.indexOf('signIOSSimulatorHelper(')).toBeGreaterThan(-1);
    expect(developerIdBody.indexOf('signIOSSimulatorHelper(')).toBeLessThan(
      developerIdBody.indexOf('Signing main app'),
    );
  });

  it('qualifies the final signed app before creating distributable archives', async () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(testDirectory, '../../../../scripts/package-desktop.mjs');
    const source = await readFile(sourcePath, 'utf8');
    const finishDarwinBody = source.slice(
      source.indexOf('async function finishDarwin'),
      source.indexOf('async function finishLinux'),
    );
    const notarizeIndex = finishDarwinBody.indexOf('notarizeMacApp(appPath, identity)');
    const verifiedGateIndex = finishDarwinBody.indexOf(
      "runIOSSimulatorReleaseGate(appPath, arch, 'verified'",
    );
    const dmgIndex = finishDarwinBody.indexOf('createMacDMG(');
    const adhocIndex = finishDarwinBody.indexOf('adhocSignMacApp(');
    const untrustedGateIndex = finishDarwinBody.indexOf(
      "runIOSSimulatorReleaseGate(appPath, arch, 'untrusted')",
    );
    const appZipIndex = finishDarwinBody.indexOf('Creating app ZIP (ad-hoc signed)');

    expect(notarizeIndex).toBeGreaterThan(-1);
    expect(verifiedGateIndex).toBeGreaterThan(notarizeIndex);
    expect(dmgIndex).toBeGreaterThan(verifiedGateIndex);
    expect(adhocIndex).toBeGreaterThan(-1);
    expect(untrustedGateIndex).toBeGreaterThan(adhocIndex);
    expect(appZipIndex).toBeGreaterThan(untrustedGateIndex);
  });
});
