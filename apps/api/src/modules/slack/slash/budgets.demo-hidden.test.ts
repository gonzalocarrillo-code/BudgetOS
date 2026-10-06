import { randomUUID } from "node:crypto";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb } from "../../../test-support/harness.js";
import type { AuthContext } from "../../../common/tenant.js";
import { listReply } from "./budgets.js";

/**
 * HF-1 (audit T-5 follow-up): `/budget list` says when demo budgets are sitting there excluded,
 * instead of just answering with fewer budgets than the workspace holds. One context line when the
 * workspace has both demo and real budgets (T-5's default exclusion is then hiding something); none
 * in a pure-demo workspace, where nothing is hidden yet.
 */

const owner = ownerDb();
const app = appDb();
const orgId = randomUUID();
const workspaceIds: string[] = [];

function authFor(workspaceId: string, userId: string): AuthContext {
  return {
    ctx: { workspaceId, orgId, userId, isOrgAdmin: true, actorType: "user", requestId: `hf1-${randomUUID()}` },
    user: { id: userId, orgId, email: "org-admin@hf1.test", name: "Org Admin" },
    isOrgAdmin: true,
    roles: ["ORG_ADMIN"],
    assignments: [{ role: "ORG_ADMIN", scope: {} }],
  };
}

async function envelope(workspaceId: string, userId: string, demo: boolean) {
  await owner.envelope.create({
    data: { id: randomUUID(), workspaceId, name: demo ? "Demo budget" : "Real budget", dimensionValues: {}, startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z"), currency: "USD", createdBy: userId, demo },
  });
}

async function workspace(): Promise<{ workspaceId: string; userId: string }> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  await owner.workspace.create({ data: { id: workspaceId, orgId, slug: `hf1-${workspaceId}`, name: "HF-1", reportingCurrency: "USD" } });
  await owner.user.create({ data: { id: userId, orgId, email: `${workspaceId}@hf1.test`, name: "Org Admin", googleSub: `hf1-${workspaceId}` } });
  workspaceIds.push(workspaceId);
  return { workspaceId, userId };
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "HF-1" } });
});

afterAll(async () => {
  await deleteWorkspaceForTests(owner, workspaceIds);
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.deleteMany({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("Slack /budget list and T-5's demo visibility (HF-1)", () => {
  it("a pure-demo workspace (no real budgets) gets no demo-hidden line", async () => {
    const { workspaceId, userId } = await workspace();
    await envelope(workspaceId, userId, true);
    const res = await listReply(app, authFor(workspaceId, userId), workspaceId, "", "");
    expect(JSON.stringify(res["blocks"])).not.toContain("demo budgets hidden");
  });

  it("a workspace with demo and a real budget gets the demo-hidden line", async () => {
    const { workspaceId, userId } = await workspace();
    await envelope(workspaceId, userId, true);
    await envelope(workspaceId, userId, false);
    const res = await listReply(app, authFor(workspaceId, userId), workspaceId, "", "");
    expect(JSON.stringify(res["blocks"])).toContain("1 demo budgets hidden — this workspace has real budgets. Manage demo data in Settings › Workspace.");
  });
});
