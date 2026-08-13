/**
 * Distinguishes an absent legacy value from a transient read failure.
 * Migration callers may safely complete on `missing`, but must keep the
 * stable-owner scope retryable when the old storage could not be inspected.
 */
export type LegacyMigrationRead<T> =
  | { status: 'available'; value: T }
  | { status: 'missing' }
  | { status: 'retryable-failure' };

export function legacyMigrationAvailable<T>(value: T): LegacyMigrationRead<T> {
  return { status: 'available', value };
}

export const LEGACY_MIGRATION_MISSING: LegacyMigrationRead<never> = { status: 'missing' };
export const LEGACY_MIGRATION_RETRYABLE_FAILURE: LegacyMigrationRead<never> = {
  status: 'retryable-failure',
};
