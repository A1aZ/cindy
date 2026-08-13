import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  root: '',
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  ownerId: 'owner-a' as string | null,
  ownerGeneration: 1,
  boundaryPending: false,
  exclusive: true,
}));

vi.mock('electron', () => ({
  app: { getPath: () => harness.root },
}));

vi.mock('../../appSessionState.js', () => ({
  dataOwnerStorageKey: (ownerId: string) => `key-${ownerId}`,
  getActiveAppSession: () => ({
    mode: harness.mode,
    dataOwnerId: harness.ownerId,
  }),
  getActiveDataOwnerPushStamp: () => ({
    dataOwnerId: harness.ownerId,
    ownerGeneration: harness.ownerGeneration,
  }),
  isAppSessionBoundaryPending: () => harness.boundaryPending,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../ownerNamespaceMigration.js', () => ({
  hasExclusiveSharedLegacyUserDataAccess: () => harness.exclusive,
}));

import { claimLegacyModelVisibilityOwner } from '../model-visibility-owner-claim.js';

const markerName = 'model-visibility-renderer-legacy-owner.v1.json';

beforeEach(() => {
  harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-model-visibility-owner-'));
  harness.mode = 'cloud';
  harness.ownerId = 'owner-a';
  harness.ownerGeneration = 1;
  harness.boundaryPending = false;
  harness.exclusive = true;
});

afterEach(() => {
  fs.rmSync(harness.root, { recursive: true, force: true });
});

describe('model visibility legacy Renderer owner claim', () => {
  it('atomically binds the legacy key to the active verified cloud account only once', () => {
    expect(claimLegacyModelVisibilityOwner()).toEqual({
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
      claimed: true,
      claimedByOtherOwner: false,
      canInitialize: true,
    });
    expect(JSON.parse(fs.readFileSync(path.join(harness.root, markerName), 'utf-8'))).toEqual({
      version: 1,
      ownerKey: 'key-owner-a',
    });

    harness.ownerId = 'owner-b';
    harness.ownerGeneration = 2;
    expect(claimLegacyModelVisibilityOwner()).toEqual({
      dataOwnerId: 'owner-b',
      ownerGeneration: 2,
      claimed: false,
      claimedByOtherOwner: true,
      canInitialize: false,
    });
  });

  it('does not claim from signed-out, local, boundary-pending, or shared access', () => {
    harness.mode = 'local';
    expect(claimLegacyModelVisibilityOwner().claimed).toBe(false);
    harness.mode = 'cloud';
    harness.boundaryPending = true;
    expect(claimLegacyModelVisibilityOwner().claimed).toBe(false);
    harness.boundaryPending = false;
    harness.exclusive = false;
    expect(claimLegacyModelVisibilityOwner().claimed).toBe(false);
    expect(fs.existsSync(path.join(harness.root, markerName))).toBe(false);
  });

  it('keeps a claimed owner readable but blocks legacy initialization without exclusivity', () => {
    expect(claimLegacyModelVisibilityOwner().canInitialize).toBe(true);
    harness.exclusive = false;
    expect(claimLegacyModelVisibilityOwner()).toMatchObject({
      claimed: true,
      claimedByOtherOwner: false,
      canInitialize: false,
    });
  });

  it('fails closed instead of replacing a malformed marker', () => {
    fs.writeFileSync(path.join(harness.root, markerName), '{broken', 'utf-8');
    expect(claimLegacyModelVisibilityOwner()).toMatchObject({
      claimed: false,
      claimedByOtherOwner: false,
      canInitialize: false,
    });
    expect(fs.readFileSync(path.join(harness.root, markerName), 'utf-8')).toBe('{broken');
  });
});
