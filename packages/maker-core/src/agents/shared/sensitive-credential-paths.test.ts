import { describe, expect, it } from "vitest";

import {
  isReviewSensitiveCredentialPath,
  isSensitiveCredentialPath,
} from "./sensitive-credential-paths.js";

describe("Review credential path policy", () => {
  it("adds dotenv files without treating arbitrary .env text as a path", () => {
    expect(isSensitiveCredentialPath("/repo/.env.local")).toBe(false);
    expect(isReviewSensitiveCredentialPath("/repo/.env.local")).toBe(true);
    expect(isReviewSensitiveCredentialPath("jq .env data.json")).toBe(false);
  });

  it("retains the shared credential path protections", () => {
    expect(isReviewSensitiveCredentialPath("/Users/me/.ssh/id_ed25519")).toBe(
      true,
    );
    expect(isReviewSensitiveCredentialPath("/repo/.git/config")).toBe(true);
    expect(isReviewSensitiveCredentialPath("/repo/.gitignore")).toBe(false);
    expect(isReviewSensitiveCredentialPath("/repo/src/environment.ts")).toBe(
      false,
    );
  });
});
