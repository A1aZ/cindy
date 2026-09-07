import type { PermissionMode } from '@cindy/maker-core';

/** Background triggers inherit the teammate's permission choice, never grant Full Access. */
export function routinePermissionMode(live: unknown, stored: unknown): PermissionMode {
  const mode = live ?? stored;
  if (
    mode === 'ask' ||
    mode === 'default' ||
    mode === 'acceptEdits' ||
    mode === 'plan' ||
    mode === 'auto' ||
    mode === 'bypassPermissions'
  )
    return mode;
  throw new Error('The teammate permission setting is unavailable');
}
