import { randomUUID } from "node:crypto";
import { asOrgAdmin } from "@budget/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/** Product decision 2026-09-28: a workspace admin sets and approves budgets alone — no approval step. */

const owner = ownerDb();
const app = appDb();
let h: Harness;
let golden: GoldenResult;
const slug = `direct-${randomUUID().slice(0, 8)}`;

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, `/api/v1${url}`, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("admins apply directly", () => {
  it("a workspace admin's big raise is approved on submit; the same raise by a planner waits for approval", async () => {
    const candidates = [...golden.envelopeIds.values()];
    const raise = async (persona: string) => {
      for (const id of candidates) {
        const env = (await as(persona, "GET", `/envelopes/${id}`)).body as { current?: { id: string; amount: string } | null; draft?: unknown; status?: string };
        if (!env.current || env.draft || env.status !== "APPROVED") continue;
        candidates.splice(candidates.indexOf(id), 1);
        const draft = await as(persona, "PATCH", `/envelopes/${id}/draft`, { amount: (Number(env.current.amount) * 5 + 500000).toFixed(2), basedOnVersionId: env.current.id });
        if (draft.status !== 200) continue;
        // The drawer already says it will apply directly.
        const detail = (await as(persona, "GET", `/envelopes/${id}`)).body as { draftPolicy?: { name: string; steps?: unknown[] } | null };
        const sent = await as(persona, "POST", `/envelopes/${id}/submit`, { versionId: draft.body["id"] });
        return { detail, sent: sent.body };
      }
      throw new Error("no approved budget to raise");
    };
    const admin = await raise("admin");
    expect(admin.sent).toMatchObject({ autoApproved: true, policy: { name: "Admins apply directly" } });
    expect(admin.detail.draftPolicy).toMatchObject({ name: "Admins apply directly" });
    const planner = await raise("planner");
    expect(planner.sent).toMatchObject({ autoApproved: false });

    // ADR-048: an admin's approval is final, however many steps and approvers the policy asks for.
    // W0-6: approval_request is workspace-scoped and needs the org-admin tenant context.
    const [req] = await asOrgAdmin(
      owner,
      (tx) =>
        tx.$queryRawUnsafe<Array<{ id: string; entity_id: string; steps: number }>>(
          `SELECT id::text, entity_id::text, jsonb_array_length(policy_snapshot->'chain')::int AS steps FROM approval_request WHERE workspace_id = $1::uuid AND status = 'PENDING' AND requested_by = $2::uuid ORDER BY requested_at DESC LIMIT 1`,
          golden.workspaceId,
          golden.users.planner,
        ),
      golden.orgId,
    );
    expect(req?.steps).toBeGreaterThan(1);
    const decided = await as("admin", "POST", `/approvals/${req!.id}/decisions`, { decision: "approve" });
    expect(decided.status, JSON.stringify(decided.body)).toBeLessThan(300);
    expect(decided.body).toMatchObject({ status: "APPROVED" });
    const [v] = await asOrgAdmin(
      owner,
      (tx) =>
        tx.$queryRawUnsafe<Array<{ status: string; current: boolean }>>(
          `SELECT v.status::text, (e.current_version_id = v.id) AS current FROM envelope_version v JOIN envelope e ON e.id = v.envelope_id WHERE v.id = $1::uuid`,
          req!.entity_id,
        ),
      golden.orgId,
    );
    expect(v).toEqual({ status: "APPROVED", current: true });
  });
});
