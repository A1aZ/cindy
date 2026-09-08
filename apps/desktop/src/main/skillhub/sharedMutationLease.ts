import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { withCrossProcessLock } from '../device-link/crossProcessLock';
import { createLogger } from '../logger';
import { skillInstallLockKey } from './installLock';

const log = createLogger('skillhub:shared-mutation');
export type SkillMutationRelease = () => Promise<void>;

/**
 * All Desktop profiles share native Skill directories. Keep the lease root
 * outside profile-specific userData. Names conservatively serialize the same
 * final basename across every install location, like the in-process lock.
 * Import aliases and rename operations acquire all affected names in order.
 */
export async function acquireSharedSkillMutationLease(
  names: readonly string[],
): Promise<SkillMutationRelease | null> {
  let root: string;
  try {
    root = path.join(app.getPath('appData'), 'Cindy', 'shared-skill-mutation-locks');
    fs.mkdirSync(root, { recursive: true });
  } catch {
    log.warn('Skill mutation lock directory is unavailable');
    return null;
  }
  const keys = [...new Set(names.map(skillInstallLockKey))].sort();
  let enter!: (release: SkillMutationRelease | null) => void;
  const entered = new Promise<SkillMutationRelease | null>((resolve) => { enter = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let finished: Promise<void>;
  const acquire = async (index: number): Promise<void> => {
    if (index === keys.length) {
      enter(async () => { release(); await finished; });
      await released;
      return;
    }
    const key = createHash('sha256').update(keys[index]!).digest('hex');
    await withCrossProcessLock(path.join(root, `${key}.lock`),
      { label: 'skill-mutation', waitMs: 0 }, async (status) => {
        if (status.held) await acquire(index + 1);
      });
  };
  finished = acquire(0).catch(() => {
    log.warn('Skill mutation lock could not be acquired or released');
  }).finally(() => { enter(null); });
  return entered;
}
