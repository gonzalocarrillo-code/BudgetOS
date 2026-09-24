import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError } from "@budget/domain";
import { withTenant, type TenantContext } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { InMemoryAssetStore } from "./assets/asset-store.js";
import { addValues } from "./commands/add-values.js";
import { createDimension } from "./commands/create-dimension.js";
import { mergeValues } from "./commands/merge-values.js";
import { saveHierarchyTemplate } from "./commands/save-hierarchy-template.js";
import { seedDefaultRegistry } from "./commands/seed-registry.js";
import { updateDimension } from "./commands/update-dimension.js";
import { uploadAsset } from "./commands/upload-asset.js";
import { validateTuple } from "./commands/validate-tuple.js";
import { listDimensions, listHierarchyTemplates } from "./queries/list-registry.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

function loadEnv(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv(join(packageRoot, "packages/db/.env"));

const ownerUrl = process.env["DATABASE_URL"] ?? "postgresql://budget:budget@localhost:5432/budget";
const appUrl =
  process.env["APP_DATABASE_URL"] ??
  "postgresql://budget_app:replace-in-secret-manager@localhost:5432/budget";

const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const app = new PrismaClient({ datasources: { db: { url: appUrl } } });
const store = new InMemoryAssetStore();

const orgId = randomUUID();
const workspaceId = randomUUID();
const userId = randomUUID();
const seedRequestId = `epic-0.4-seed-${orgId}`;

const adminCtx: TenantContext = {
  workspaceId,
  orgId,
  userId,
  isOrgAdmin: true,
  actorType: "user",
  requestId: seedRequestId,
};

const workspaceAdminCtx: TenantContext = {
  workspaceId,
  orgId,
  userId,
  isOrgAdmin: false,
  actorType: "user",
  requestId: `epic-0.4-ws-${orgId}`,
};

const defaultKeys = [
  "client",
  "brand",
  "business_unit",
  "region",
  "country",
  "channel",
  "platform",
  "account",
  "campaign",
  "objective",
  "funnel_stage",
  "audience",
  "product_line",
  "creative_format",
  "fiscal_period",
] as const;

const defaultIcons: Record<(typeof defaultKeys)[number], string> = {
  client: "lucide:briefcase",
  brand: "lucide:tag",
  business_unit: "lucide:building",
  region: "lucide:globe",
  country: "lucide:flag",
  channel: "lucide:layers",
  platform: "lucide:plug",
  account: "lucide:user-circle",
  campaign: "lucide:megaphone",
  objective: "lucide:target",
  funnel_stage: "lucide:filter",
  audience: "lucide:users",
  product_line: "lucide:package",
  creative_format: "lucide:image",
  fiscal_period: "lucide:calendar",
};

async function expectDomain(code: DomainError["code"], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}`);
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "epic-0.4" } });
  await owner.workspace.create({
    data: {
      id: workspaceId,
      orgId,
      slug: `epic-04-${orgId.slice(0, 8)}`,
      name: "Epic 0.4",
      reportingCurrency: "USD",
    },
  });
  await seedDefaultRegistry(app, adminCtx, ["ORG_ADMIN"], store);
}, 60_000);

afterAll(async () => {
  await owner.envelopeDimension.deleteMany({ where: { envelope: { workspaceId } } });
  await owner.envelope.deleteMany({ where: { workspaceId } });
  await owner.hierarchyTemplate.deleteMany({ where: { workspaceId } });
  const dimensionIds = (await owner.dimension.findMany({ where: { orgId }, select: { id: true } })).map(
    (dimension) => dimension.id,
  );
  if (dimensionIds.length > 0) {
    await owner.valueConstraint.deleteMany({ where: { dimensionId: { in: dimensionIds } } });
  }
  await owner.dimensionValue.deleteMany({ where: { dimension: { orgId } } });
  await owner.dimension.deleteMany({ where: { orgId } });
  await owner.$executeRaw`DELETE FROM outbox WHERE payload->>'orgId' = ${orgId}`;
  await owner.workspace.deleteMany({ where: { id: workspaceId } });
  await owner.organization.deleteMany({ where: { id: orgId } });
  await app.$disconnect();
  await owner.$disconnect();
});

it("seeds the default registry, nested countries, and the default hierarchy", async () => {
  const dimensions = await withTenant(app, adminCtx, (tx) => listDimensions(tx, workspaceId));
  expect(dimensions.map((dimension) => dimension.key)).toEqual([...defaultKeys]);
  for (const dimension of dimensions) {
    expect(dimension.workspaceId).toBeNull();
    expect(dimension.icon).toBe(defaultIcons[dimension.key as (typeof defaultKeys)[number]]);
  }

  const region = dimensions.find((dimension) => dimension.key === "region");
  expect(region?.values.map((value) => value.code).sort()).toEqual(["AMER", "APAC", "EMEA", "LATAM"]);
  expect(region?.allowedParents).toEqual(["client"]);

  const country = dimensions.find((dimension) => dimension.key === "country");
  expect(country?.allowedParents).toEqual(["region"]);
  expect(country?.values.length).toBeGreaterThanOrEqual(240);
  expect(country?.values.find((value) => value.code === "BR")?.path).toBe("latam.br");
  expect(country?.values.find((value) => value.code === "US")?.path).toBe("amer.us");
  expect(country?.values.find((value) => value.code === "DE")?.path).toBe("emea.de");
  expect(country?.values.find((value) => value.code === "JP")?.path).toBe("apac.jp");
  expect(country?.values.find((value) => value.code === "MX")?.path).toBe("latam.mx");

  const platform = dimensions.find((dimension) => dimension.key === "platform");
  expect(platform?.values.map((value) => value.code).sort()).toEqual([
    "amazon",
    "dv360",
    "google_ads",
    "linkedin",
    "meta",
    "microsoft_ads",
    "other",
    "pinterest",
    "snapchat",
    "tiktok",
    "x",
  ]);

  const channel = dimensions.find((dimension) => dimension.key === "channel");
  expect(channel?.values.map((value) => value.code).sort()).toEqual([
    "affiliate",
    "other",
    "paid_search",
    "paid_social",
    "programmatic",
    "retail_media",
    "video",
  ]);

  const objective = dimensions.find((dimension) => dimension.key === "objective");
  expect(objective?.values.map((value) => value.code).sort()).toEqual([
    "awareness",
    "brand",
    "competitor",
    "consideration",
    "conversion",
    "non_brand",
    "retention",
  ]);

  expect(dimensions.find((dimension) => dimension.key === "fiscal_period")?.values).toEqual([]);

  const templates = await withTenant(app, adminCtx, (tx) => listHierarchyTemplates(tx, workspaceId));
  expect(templates).toEqual([
    {
      name: "Default",
      path: ["client", "region", "country", "platform", "objective"],
      isDefault: true,
    },
  ]);

  const seededAudits = await owner.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM audit_event
    WHERE request_id = ${seedRequestId} AND action = 'registry.dimension.created'`;
  const seededOutbox = await owner.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM outbox
    WHERE topic = 'registry.changed' AND payload->>'requestId' = ${seedRequestId} AND payload->>'kind' = 'dimension.created'`;
  expect(Number(seededAudits[0]?.n)).toBe(defaultKeys.length);
  expect(Number(seededOutbox[0]?.n)).toBe(defaultKeys.length);
});

it("creates a dimension, nested values, and another hierarchy template", async () => {
  const requestId = `epic-0.4-create-${orgId}`;
  const ctx: TenantContext = { ...workspaceAdminCtx, requestId };
  const created = await createDimension(
    app,
    ctx,
    ["WORKSPACE_ADMIN"],
    {
      key: "retailer",
      label: "Retailer",
      dataType: "ENUM",
      icon: "lucide:store",
      allowedParents: [],
      isRequiredForLeaf: false,
      workspaceId,
    },
    store,
  );
  expect(created.version).toBe(1);
  expect(created.icon).toBe("lucide:store");

  const values = await addValues(app, ctx, ["WORKSPACE_ADMIN"], created.id, {
    values: [
      { code: "grocery", label: "Grocery" },
      { code: "carrefour", label: "Carrefour", parentCode: "grocery" },
    ],
  });
  expect(values.find((value) => value.code === "grocery")?.path).toBe("grocery");
  expect(values.find((value) => value.code === "carrefour")?.path).toBe("grocery.carrefour");

  const updated = await updateDimension(
    app,
    ctx,
    ["WORKSPACE_ADMIN"],
    created.id,
    { label: "Retailers" },
    store,
  );
  expect(updated.version).toBe(2);
  expect(updated.label).toBe("Retailers");

  await saveHierarchyTemplate(app, ctx, ["WORKSPACE_ADMIN"], {
    name: "Geo",
    path: ["region", "country"],
    isDefault: false,
  });
  await expectDomain("VALIDATION", () =>
    saveHierarchyTemplate(app, ctx, ["WORKSPACE_ADMIN"], {
      name: "Bad",
      path: ["country", "region"],
      isDefault: false,
    }),
  );

  const dimensions = await withTenant(app, ctx, (tx) => listDimensions(tx, workspaceId));
  const retailer = dimensions.find((dimension) => dimension.key === "retailer");
  expect(retailer?.label).toBe("Retailers");
  expect(retailer?.workspaceId).toBe(workspaceId);
  expect(retailer?.values.map((value) => value.path).sort()).toEqual(["grocery", "grocery.carrefour"]);

  const templates = await withTenant(app, ctx, (tx) => listHierarchyTemplates(tx, workspaceId));
  expect(templates.map((template) => template.name)).toEqual(["Default", "Geo"]);

  const audits = await owner.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM audit_event
    WHERE request_id = ${requestId} AND entity_id = ${created.id}::uuid AND action = 'registry.dimension.created'`;
  const outbox = await owner.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM outbox
    WHERE topic = 'registry.changed' AND payload->>'requestId' = ${requestId} AND payload->>'kind' = 'dimension.created'`;
  expect(Number(audits[0]?.n)).toBe(1);
  expect(Number(outbox[0]?.n)).toBe(1);
});

it("rejects an envelope tuple the registry does not allow", async () => {
  const ctx: TenantContext = { ...workspaceAdminCtx, requestId: `epic-0.4-tuple-${orgId}` };
  const tier = await createDimension(
    app,
    ctx,
    ["WORKSPACE_ADMIN"],
    {
      key: "market_tier",
      label: "Market tier",
      dataType: "ENUM",
      icon: "lucide:tag",
      allowedParents: [],
      isRequiredForLeaf: true,
      workspaceId,
    },
    store,
  );
  await addValues(app, ctx, ["WORKSPACE_ADMIN"], tier.id, {
    values: [{ code: "tier_1", label: "Tier 1" }],
  });

  const objective = await withTenant(app, adminCtx, async (tx) => {
    const dimensions = await listDimensions(tx, workspaceId);
    return dimensions.find((dimension) => dimension.key === "objective");
  });
  if (objective === undefined) {
    throw new Error("objective dimension missing");
  }
  await withTenant(app, adminCtx, (tx) =>
    tx.valueConstraint.create({
      data: {
        id: randomUUID(),
        dimensionId: objective.id,
        whenDimensionKey: "channel",
        whenValueCode: "paid_social",
        allowedValueCodes: ["brand", "awareness"],
      },
    }),
  );

  await expectDomain("VALIDATION", () =>
    withTenant(app, adminCtx, (tx) => validateTuple(tx, workspaceId, { not_a_dimension: "x" })),
  );
  await expectDomain("VALIDATION", () =>
    withTenant(app, adminCtx, (tx) => validateTuple(tx, workspaceId, { country: "ZZ" })),
  );
  await expectDomain("VALIDATION", () =>
    withTenant(app, adminCtx, (tx) =>
      validateTuple(tx, workspaceId, { country: "BR", platform: "meta" }),
    ),
  );
  await expectDomain("VALIDATION", () =>
    withTenant(app, adminCtx, (tx) =>
      validateTuple(tx, workspaceId, {
        channel: "paid_social",
        objective: "competitor",
        market_tier: "tier_1",
      }),
    ),
  );

  const accepted = await withTenant(app, adminCtx, (tx) =>
    validateTuple(tx, workspaceId, {
      country: "BR",
      platform: "meta",
      channel: "paid_search",
      objective: "competitor",
      market_tier: "tier_1",
    }),
  );
  expect(accepted.ok).toBe(true);
  expect(accepted.valueIds["country"]).toEqual(expect.any(String));
  expect(accepted.valueIds["platform"]).toEqual(expect.any(String));
  expect(accepted.valueIds["market_tier"]).toEqual(expect.any(String));
});

it("accepts a bundled Lucide icon and stores a sanitized SVG asset", async () => {
  const ctx: TenantContext = { ...workspaceAdminCtx, requestId: `epic-0.4-icon-${orgId}` };
  await expectDomain("VALIDATION", () =>
    createDimension(
      app,
      ctx,
      ["WORKSPACE_ADMIN"],
      {
        key: "bad_icon",
        label: "Bad icon",
        dataType: "TEXT",
        icon: "lucide:not-a-real-icon-xyz",
        allowedParents: [],
        isRequiredForLeaf: false,
        workspaceId,
      },
      store,
    ),
  );
  await expectDomain("FORBIDDEN", () =>
    createDimension(
      app,
      ctx,
      ["PLANNER"],
      {
        key: "planner_dim",
        label: "Planner",
        dataType: "TEXT",
        icon: "lucide:tag",
        allowedParents: [],
        isRequiredForLeaf: false,
        workspaceId,
      },
      store,
    ),
  );
  await expectDomain("FORBIDDEN", () =>
    createDimension(
      app,
      { ...ctx, isOrgAdmin: false },
      ["WORKSPACE_ADMIN"],
      {
        key: "org_wide_blocked",
        label: "Org",
        dataType: "TEXT",
        icon: "lucide:tag",
        allowedParents: [],
        isRequiredForLeaf: false,
        workspaceId: null,
      },
      store,
    ),
  );

  const dirty = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)"><script>alert(1)</script><circle cx="5" cy="5" r="4"></circle></svg>`;
  const uploaded = await uploadAsset(
    app,
    ctx,
    ["WORKSPACE_ADMIN"],
    { contentType: "image/svg+xml", svg: dirty },
    store,
  );
  expect(uploaded.icon).toBe(`asset:${uploaded.gcsObject}`);
  const stored = store.get(uploaded.gcsObject);
  expect(stored).toBeDefined();
  const sanitized = new TextDecoder().decode(stored!.body);
  expect(sanitized.toLowerCase()).not.toContain("<script");
  expect(sanitized.toLowerCase()).not.toContain("onload");
  expect(sanitized.toLowerCase()).not.toContain("alert");
  expect(sanitized).toContain("<circle");

  await expectDomain("VALIDATION", () =>
    uploadAsset(app, ctx, ["WORKSPACE_ADMIN"], { contentType: "image/svg+xml", svg: "<html></html>" }, store),
  );
  await expectDomain("VALIDATION", () =>
    uploadAsset(
      app,
      ctx,
      ["WORKSPACE_ADMIN"],
      { contentType: "image/svg+xml", svg: `<svg xmlns="http://www.w3.org/2000/svg">${"x".repeat(51 * 1024)}</svg>` },
      store,
    ),
  );

  const created = await createDimension(
    app,
    ctx,
    ["WORKSPACE_ADMIN"],
    {
      key: "custom_mark",
      label: "Custom mark",
      dataType: "TEXT",
      icon: uploaded.icon,
      allowedParents: [],
      isRequiredForLeaf: false,
      workspaceId,
    },
    store,
  );
  expect(created.icon).toBe(uploaded.icon);

  const dimensions = await withTenant(app, ctx, (tx) => listDimensions(tx, workspaceId));
  expect(dimensions.some((dimension) => dimension.key === "bad_icon")).toBe(false);
  expect(dimensions.some((dimension) => dimension.key === "planner_dim")).toBe(false);
});

it("merges values, rewrites envelope dimensions, and audits each envelope", async () => {
  const requestId = `epic-0.4-merge-${orgId}`;
  const ctx: TenantContext = { ...workspaceAdminCtx, requestId };
  const created = await createDimension(
    app,
    ctx,
    ["WORKSPACE_ADMIN"],
    {
      key: "alias_src",
      label: "Alias source",
      dataType: "ENUM",
      icon: "lucide:tag",
      allowedParents: [],
      isRequiredForLeaf: false,
      workspaceId,
    },
    store,
  );
  const values = await addValues(app, ctx, ["WORKSPACE_ADMIN"], created.id, {
    values: [
      { code: "old_code", label: "Old" },
      { code: "new_code", label: "New" },
    ],
  });
  const oldValue = values.find((value) => value.code === "old_code");
  const newValue = values.find((value) => value.code === "new_code");
  expect(oldValue).toBeDefined();
  expect(newValue).toBeDefined();

  const envelopeId = randomUUID();
  await withTenant(app, ctx, async (tx) => {
    await tx.envelope.create({
      data: {
        id: envelopeId,
        workspaceId,
        name: "merge-me",
        dimensionValues: { alias_src: "old_code" },
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-12-31T00:00:00.000Z"),
        currency: "USD",
        createdBy: userId,
      },
    });
    await tx.envelopeDimension.create({
      data: { envelopeId, dimensionId: created.id, valueId: oldValue!.id },
    });
  });

  const merged = await mergeValues(app, ctx, ["WORKSPACE_ADMIN"], created.id, {
    fromCode: "old_code",
    intoCode: "new_code",
  });
  expect(merged.envelopeIds).toEqual([envelopeId]);

  const row = await withTenant(app, ctx, (tx) =>
    tx.envelopeDimension.findUnique({ where: { envelopeId_dimensionId: { envelopeId, dimensionId: created.id } } }),
  );
  expect(row?.valueId).toBe(newValue!.id);
  const envelope = await withTenant(app, ctx, (tx) => tx.envelope.findUnique({ where: { id: envelopeId } }));
  expect(envelope?.dimensionValues).toEqual({ alias_src: "new_code" });

  const source = await withTenant(app, ctx, (tx) => tx.dimensionValue.findUnique({ where: { id: oldValue!.id } }));
  const target = await withTenant(app, ctx, (tx) => tx.dimensionValue.findUnique({ where: { id: newValue!.id } }));
  expect(source?.mergedIntoId).toBe(newValue!.id);
  expect(source?.isActive).toBe(false);
  expect(target?.aliases).toContain("old_code");

  try {
    await withTenant(app, ctx, (tx) =>
      validateTuple(tx, workspaceId, { alias_src: "old_code", market_tier: "tier_1" }),
    );
    throw new Error("expected merged code to be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("VALIDATION");
    expect((error as DomainError).message).toContain("old_code");
  }

  const envelopeAudits = await owner.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM audit_event
    WHERE request_id = ${requestId} AND action = 'envelope.dimension.rewritten' AND entity_id = ${envelopeId}::uuid`;
  const registryAudits = await owner.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM audit_event
    WHERE request_id = ${requestId} AND action = 'registry.value.merged'`;
  const outbox = await owner.$queryRaw<Array<{ envelope_ids: string[] }>>`
    SELECT payload->'envelopeIds' AS envelope_ids
    FROM outbox
    WHERE topic = 'registry.changed' AND payload->>'requestId' = ${requestId} AND payload->>'kind' = 'value.merged'`;
  expect(Number(envelopeAudits[0]?.n)).toBe(1);
  expect(Number(registryAudits[0]?.n)).toBe(1);
  expect(outbox).toHaveLength(1);
  expect(outbox[0]?.envelope_ids).toEqual([envelopeId]);
});
