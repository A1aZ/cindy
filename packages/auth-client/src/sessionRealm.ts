import { z } from "zod";

import { authRegionSchema, type AuthRegion } from "./types.js";

export const authSessionRecordSchema = z.object({
  version: z.literal(1),
  realm: authRegionSchema,
  refreshToken: z.string().min(1),
});

export interface AuthSessionRecord {
  version: 1;
  realm: AuthRegion;
  refreshToken: string;
}

export const accountDeletionReceiptRecordSchema = z.object({
  version: z.literal(1),
  realm: authRegionSchema,
  receiptToken: z.string().min(1),
});

export interface AccountDeletionReceiptRecord {
  version: 1;
  realm: AuthRegion;
  receiptToken: string;
}

/** Parse an encrypted-storage plaintext without throwing or logging credentials. */
export function parseAuthSessionRecord(
  raw: string | null,
): AuthSessionRecord | null {
  if (!raw) return null;
  try {
    const parsed = authSessionRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializeAuthSessionRecord(
  realm: AuthRegion,
  refreshToken: string,
): string {
  return JSON.stringify(
    authSessionRecordSchema.parse({ version: 1, realm, refreshToken }),
  );
}

/**
 * Account-deletion receipts outlive the authenticated session, so their realm
 * must travel with the credential after logout resets the active session realm.
 */
export function parseAccountDeletionReceiptRecord(
  raw: string | null,
): AccountDeletionReceiptRecord | null {
  if (!raw) return null;
  try {
    const parsed = accountDeletionReceiptRecordSchema.safeParse(
      JSON.parse(raw),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializeAccountDeletionReceiptRecord(
  realm: AuthRegion,
  receiptToken: string,
): string {
  return JSON.stringify(
    accountDeletionReceiptRecordSchema.parse({
      version: 1,
      realm,
      receiptToken,
    }),
  );
}
