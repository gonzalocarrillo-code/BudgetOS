import { randomUUID } from "node:crypto";
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
  });
});
