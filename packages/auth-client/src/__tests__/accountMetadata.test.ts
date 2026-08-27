import { describe, expect, it } from "vitest";

import {
  accountVaultKey,
  storedAccountMetadataFromMembership,
} from "../accountMetadata.js";

describe("saved account metadata", () => {
  it("keys memberships by realm so cross-region identities never collide", () => {
    expect(accountVaultKey("cn", "membership-1")).not.toBe(
      accountVaultKey("global", "membership-1"),
    );
  });

  it("keeps organization presentation metadata including its logo", () => {
    expect(
      storedAccountMetadataFromMembership(
        {
          id: "membership-1",
          passportId: "passport-1",
          kind: "org",
          role: "member",
          displayName: "Cao Jianbo",
          avatarUrl: "https://example.com/user.png",
          email: "cao@example.com",
          orgId: "org-1",
          orgName: "Cindy",
          orgLogoUrl: "https://example.com/org.png",
        },
        "passport-1",
      ),
    ).toMatchObject({
      kind: "org",
      displayName: "Cao Jianbo",
      orgName: "Cindy",
      orgLogoUrl: "https://example.com/org.png",
    });
  });
});
