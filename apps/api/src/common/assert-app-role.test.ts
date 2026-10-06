import { describe, expect, it } from "vitest";
import { assertAppRoleIsRestricted, type RoleFlags, type RoleQueryClient } from "./assert-app-role.js";

/** A fake client returning a fixed role-flags row, so this test needs no database (W2-3 done-when). */
function clientReturning(role: RoleFlags | undefined): RoleQueryClient {
  return {
    $queryRawUnsafe: async () => (role ? [role] : []),
  } as RoleQueryClient;
}

describe("assertAppRoleIsRestricted (audit S-3)", () => {
  it("passes for an ordinary role", async () => {
    await expect(assertAppRoleIsRestricted(clientReturning({ rolbypassrls: false, rolsuper: false }))).resolves.toBeUndefined();
  });

  it("refuses a role with rolbypassrls", async () => {
    await expect(assertAppRoleIsRestricted(clientReturning({ rolbypassrls: true, rolsuper: false }))).rejects.toThrow(/Refusing to start/);
  });

  it("refuses a role with rolsuper", async () => {
    await expect(assertAppRoleIsRestricted(clientReturning({ rolbypassrls: false, rolsuper: true }))).rejects.toThrow(/BYPASSRLS\/superuser/);
  });

  it("refuses when both flags are set", async () => {
    await expect(assertAppRoleIsRestricted(clientReturning({ rolbypassrls: true, rolsuper: true }))).rejects.toThrow(/Refusing to start/);
  });

  it("refuses when pg_roles returns no row for current_user (fail closed)", async () => {
    await expect(assertAppRoleIsRestricted(clientReturning(undefined))).rejects.toThrow(/Refusing to start/);
  });
});
