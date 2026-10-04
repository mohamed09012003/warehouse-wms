// Integration administration: CRUD, validation, permissions, tenant isolation, secrets API, service user.
import { beforeEach, describe, expect, it } from "vitest";
import { authenticateWithPassword, verifyPassword } from "@/modules/identity";
import { resolveTenantContext } from "@/modules/tenancy";
import { prisma, resetDatabase } from "../../../tests/support/db";
import { ctxWithRole, newTenant } from "../../../tests/support/fixtures";
import { canary, newIntegration } from "../../../tests/support/integrations";
import {
  createIntegration,
  deleteIntegrationSecret,
  disableIntegration,
  enableIntegration,
  getIntegration,
  listDeliveries,
  listInboundEvents,
  listIntegrationLogs,
  listIntegrations,
  replayDelivery,
  replayInboundEvent,
  setIntegrationSecret,
  testIntegration,
  updateIntegration,
} from "..";
import { resolveIntegrationContext } from "../service/context";
import { systemIntegrationRepo } from "../repo/integrationRepo";

beforeEach(resetDatabase);

const create = (ctx: Awaited<ReturnType<typeof newTenant>>["ctx"], extra: Record<string, unknown> = {}) =>
  createIntegration(ctx, { name: "ERP", provider: "generic-webhook", ...extra });

describe("creating and configuring integrations", () => {
  it("creates a DISABLED integration with an unguessable public id, default grants and no secrets set", async () => {
    const { ctx } = await newTenant("ad");
    const i = await create(ctx);
    expect(i).toMatchObject({ name: "ERP", provider: "generic-webhook", enabled: false, inboundEnabled: true, outboundEnabled: false, inbound: expect.objectContaining({ healthStatus: "HEALTHY", consecutiveFailures: 0 }), outbound: expect.objectContaining({ healthStatus: "HEALTHY", consecutiveFailures: 0 }), archivedAt: null });
    expect(i.grants.sort()).toEqual(["orders.manage", "products.manage"]);
    expect(i.webhookPath).toMatch(/^\/api\/webhooks\/[A-Za-z0-9_-]{22}$/);
    expect(i.secrets.map((s) => [s.name, s.isSet])).toEqual([["inbound_signing_secret", false], ["outbound_signing_secret", false]]);
    expect(i.readinessProblems).toContain("Set the inbound signing secret");
    const other = await create(ctx, { name: "Second" });
    expect(other.webhookPath).not.toBe(i.webhookPath);
  });

  it("keeps names unique per organization only", async () => {
    const a = await newTenant("ad");
    const b = await newTenant("bd");
    await create(a.ctx);
    await expect(create(a.ctx)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(create(b.ctx)).resolves.toMatchObject({ name: "ERP" });
  });

  it("validates provider, direction support and configuration", async () => {
    const { ctx } = await newTenant("ad");
    await expect(create(ctx, { provider: "sap-b1" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(create(ctx, { name: "" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(create(ctx, { config: { unknownSetting: 1 } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(create(ctx, { config: { targetUrl: "https://user:pw@example.com/x" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(create(ctx, { config: { targetUrl: "https://example.com/x?token=1" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(create(ctx, { config: { subscribedEvents: ["inventory.changed"] } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(create(ctx, { config: { maxAttempts: 50 } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects configuration that contains secret-looking keys, without echoing the value or storing anything", async () => {
    const { ctx } = await newTenant("ad");
    const secret = canary("cfg");
    for (const config of [{ apiKey: secret }, { password: secret }, { nested: { token: secret } }, { Authorization: secret }, { clientSecret: secret }]) {
      try {
        await create(ctx, { config });
        expect.unreachable();
      } catch (error) {
        expect((error as { code: string }).code).toBe("VALIDATION_FAILED");
        expect(JSON.stringify(error) + (error as Error).message).not.toContain(secret);
      }
    }
    const i = await create(ctx);
    await expect(updateIntegration(ctx, i.id, { config: { authToken: secret } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(JSON.stringify(await prisma.integration.findMany())).not.toContain(secret);
    expect(await prisma.integration.count()).toBe(1);
  });

  it("updates name, direction and configuration (a full replacement of config)", async () => {
    const { ctx } = await newTenant("ad");
    const i = await create(ctx);
    const u = await updateIntegration(ctx, i.id, { name: "ERP 2", outboundEnabled: true, config: { targetUrl: "https://example.com/events", subscribedEvents: ["order.packed", "order.packed"], maxAttempts: 5 } });
    expect(u).toMatchObject({ name: "ERP 2", outboundEnabled: true, config: { targetUrl: "https://example.com/events", subscribedEvents: ["order.packed"], maxAttempts: 5 } });
    const v = await updateIntegration(ctx, i.id, { config: {} });
    expect(v.config).toEqual({ subscribedEvents: [] });
    await expect(updateIntegration(ctx, i.id, {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("enabling, disabling and archiving", () => {
  it("cannot be enabled until direction, secrets and target are in place", async () => {
    const { ctx } = await newTenant("en");
    const i = await create(ctx, { inboundEnabled: false });
    await expect(enableIntegration(ctx, i.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await updateIntegration(ctx, i.id, { outboundEnabled: true, config: { targetUrl: "https://example.com/e" } });
    await expect(enableIntegration(ctx, i.id)).rejects.toThrow(/outbound signing secret/);
    await setIntegrationSecret(ctx, i.id, "outbound_signing_secret", { value: canary("o") });
    await expect(enableIntegration(ctx, i.id)).resolves.toMatchObject({ enabled: true, disabledReason: null });
    await expect(disableIntegration(ctx, i.id, { reason: "maintenance" })).resolves.toMatchObject({ enabled: false, disabledReason: "maintenance" });
  });

  it("an enabled integration must stay ready: breaking changes are refused", async () => {
    const { ctx } = await newTenant("en");
    const i = await newIntegration(ctx, { outbound: true, targetUrl: "https://example.com/e" });
    await expect(updateIntegration(ctx, i.id, { config: {} })).rejects.toThrow(/Disable the integration first/);
    await expect(deleteIntegrationSecret(ctx, i.id, "inbound_signing_secret")).rejects.toThrow(/Disable the integration/);
    await disableIntegration(ctx, i.id);
    await expect(deleteIntegrationSecret(ctx, i.id, "inbound_signing_secret")).resolves.toMatchObject({ isSet: false });
  });

  it("an archived integration is disabled, cannot be enabled, and the database agrees", async () => {
    const { ctx } = await newTenant("en");
    const i = await newIntegration(ctx);
    const archived = await updateIntegration(ctx, i.id, { archived: true });
    expect(archived).toMatchObject({ enabled: false, disabledReason: "Archived" });
    expect(archived.archivedAt).not.toBeNull();
    await expect(enableIntegration(ctx, i.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(testIntegration(ctx, i.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await listIntegrations(ctx)).map((x) => x.id)).not.toContain(i.id);
    expect((await listIntegrations(ctx, true)).map((x) => x.id)).toContain(i.id);
    await expect(prisma.$executeRaw`UPDATE "Integration" SET "enabled" = true WHERE "id" = ${i.id}::uuid`).rejects.toBeTruthy();
    // an archived integration cannot even obtain an actor context
    const archivedRow = (await systemIntegrationRepo.findById(i.id))!;
    expect(() => resolveIntegrationContext(archivedRow)).toThrow(/archived/);
    await updateIntegration(ctx, i.id, { archived: false });
    expect((await getIntegration(ctx, i.id)).archivedAt).toBeNull();
  });
});

describe("permissions", () => {
  it("Members have no integrations access; Admins view and manage; only an Owner changes grants", async () => {
    const t = await newTenant("pm");
    const member = await ctxWithRole(t.org, "Member");
    const admin = await ctxWithRole(t.org, "Admin");
    const i = await create(t.ctx);

    await expect(listIntegrations(member)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getIntegration(member, i.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createIntegration(member, { name: "X", provider: "generic-webhook" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listInboundEvents(member, i.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listIntegrationLogs(member, i.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setIntegrationSecret(member, i.id, "inbound_signing_secret", { value: canary("m") })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect((await listIntegrations(admin)).length).toBe(1);
    await expect(updateIntegration(admin, i.id, { name: "Renamed" })).resolves.toMatchObject({ name: "Renamed" });
    await expect(updateIntegration(admin, i.id, { grants: ["products.manage"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateIntegration(admin, i.id, { grants: ["products.manage", "orders.manage"] })).resolves.toBeTruthy(); // unchanged = not a change
    await expect(create(admin, { name: "Narrow", grants: ["orders.manage"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(create(admin, { name: "Default" })).resolves.toMatchObject({ grants: expect.arrayContaining(["orders.manage"]) });

    await expect(updateIntegration(t.ctx, i.id, { grants: ["orders.manage"] })).resolves.toMatchObject({ grants: ["orders.manage"] });
    await expect(create(t.ctx, { name: "Owner made", grants: [] })).resolves.toMatchObject({ grants: [] });
  });

  it("no one can grant inventory, warehouse, picking or packing rights, not even an Owner, and the database agrees", async () => {
    const { ctx } = await newTenant("gr");
    const i = await create(ctx);
    for (const bad of ["inventory.adjust", "inventory.reserve", "inventory.view", "warehouse.design", "picking.manage", "packing.manage", "org.manage", "integrations.manage", "members.manage", "*"]) {
      await expect(updateIntegration(ctx, i.id, { grants: [bad] }), bad).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(create(ctx, { name: `n-${bad}`, grants: [bad] }), bad).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await expect(prisma.$executeRaw`UPDATE "Integration" SET "grants" = ARRAY['inventory.adjust'] WHERE "id" = ${i.id}::uuid`).rejects.toBeTruthy();
    await expect(prisma.$executeRaw`UPDATE "Integration" SET "grants" = ARRAY['products.manage','picking.manage'] WHERE "id" = ${i.id}::uuid`).rejects.toBeTruthy();
    expect((await getIntegration(ctx, i.id)).grants.sort()).toEqual(["orders.manage", "products.manage"]);
  });

  it("the built-in roles carry exactly the intended integrations permissions", async () => {
    const t = await newTenant("rl");
    const roles = await prisma.role.findMany({ where: { organizationId: t.ctx.organizationId } });
    const perms = (name: string) => roles.find((r) => r.name === name)!.permissions.filter((p) => p.startsWith("integrations."));
    expect(perms("Owner").sort()).toEqual(["integrations.manage", "integrations.view"]);
    expect(perms("Admin").sort()).toEqual(["integrations.manage", "integrations.view"]);
    expect(perms("Member")).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("tenant B cannot see or touch tenant A's integrations, secrets, events, deliveries or logs", async () => {
    const a = await newTenant("ia");
    const b = await newTenant("ib");
    const ia = await newIntegration(a.ctx, { outbound: true, targetUrl: "https://example.com/e" });
    await newIntegration(b.ctx, { name: "B's own" });

    expect((await listIntegrations(b.ctx)).map((x) => x.name)).toEqual(["B's own"]);
    await expect(getIntegration(b.ctx, ia.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updateIntegration(b.ctx, ia.id, { name: "pwned" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(enableIntegration(b.ctx, ia.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(disableIntegration(b.ctx, ia.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(setIntegrationSecret(b.ctx, ia.id, "inbound_signing_secret", { value: canary("x") })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteIntegrationSecret(b.ctx, ia.id, "inbound_signing_secret")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(testIntegration(b.ctx, ia.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listInboundEvents(b.ctx, ia.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listDeliveries(b.ctx, ia.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listIntegrationLogs(b.ctx, ia.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(replayInboundEvent(b.ctx, ia.id, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(replayDelivery(b.ctx, ia.id, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A's data is untouched
    expect((await getIntegration(a.ctx, ia.id)).name).not.toBe("pwned");
    expect((await getIntegration(a.ctx, ia.id)).secrets.every((s) => s.isSet || s.name === "inbound_signing_secret")).toBe(true);
  });

  it("the database refuses cross-tenant references from every integration table", async () => {
    const a = await newTenant("fa");
    const b = await newTenant("fb");
    const ia = await newIntegration(a.ctx);
    const prodB = await prisma.product.create({ data: { organizationId: b.ctx.organizationId, sku: "B-1", name: "B product" } });
    const orderB = await prisma.order.create({ data: { organizationId: b.ctx.organizationId, orderNumber: "B-ORD" } });
    const hash = "a".repeat(64);
    const now = new Date();
    // org B pointing at A's integration
    await expect(prisma.inboundEvent.create({ data: { organizationId: b.ctx.organizationId, integrationId: ia.id, externalEventId: "e1", eventType: "order.cancel", occurredAt: now, payloadHash: hash, payload: {}, correlationId: "c" } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.externalRef.create({ data: { organizationId: b.ctx.organizationId, integrationId: ia.id, entityType: "PRODUCT", externalId: "x", productId: prodB.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.integrationLog.create({ data: { organizationId: b.ctx.organizationId, integrationId: ia.id, direction: "INBOUND", provider: "generic-webhook", correlationId: "c", status: "RECEIVED", safeSummary: "x" } })).rejects.toMatchObject({ code: "P2003" });
    // A's integration mapping B's product / order
    await expect(prisma.externalRef.create({ data: { organizationId: a.ctx.organizationId, integrationId: ia.id, entityType: "PRODUCT", externalId: "x", productId: prodB.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.externalRef.create({ data: { organizationId: a.ctx.organizationId, integrationId: ia.id, entityType: "ORDER", externalId: "x", orderId: orderB.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("ExternalRef must reference exactly one entity matching its type", async () => {
    const a = await newTenant("er");
    const i = await newIntegration(a.ctx);
    const prod = await prisma.product.create({ data: { organizationId: a.ctx.organizationId, sku: "A-1", name: "A" } });
    const order = await prisma.order.create({ data: { organizationId: a.ctx.organizationId, orderNumber: "A-ORD" } });
    const base = { organizationId: a.ctx.organizationId, integrationId: i.id };
    await expect(prisma.externalRef.create({ data: { ...base, entityType: "PRODUCT", externalId: "p", productId: null } })).rejects.toBeTruthy();
    await expect(prisma.externalRef.create({ data: { ...base, entityType: "PRODUCT", externalId: "p", productId: prod.id, orderId: order.id } })).rejects.toBeTruthy();
    await expect(prisma.externalRef.create({ data: { ...base, entityType: "ORDER", externalId: "o", productId: prod.id } })).rejects.toBeTruthy();
    await prisma.externalRef.create({ data: { ...base, entityType: "PRODUCT", externalId: "p", productId: prod.id } });
    // unique external identity and unique internal mapping per integration
    await expect(prisma.externalRef.create({ data: { ...base, entityType: "PRODUCT", externalId: "p", productId: prod.id } })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.externalRef.create({ data: { ...base, entityType: "PRODUCT", externalId: "p-other", productId: prod.id } })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("the integration actor (service user)", () => {
  it("is a dedicated, disabled, non-login user without a membership", async () => {
    const t = await newTenant("su");
    const i = await newIntegration(t.ctx);
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: i.id }, include: { serviceUser: true } });
    const user = row.serviceUser;
    expect(user.email).toMatch(/^integration-[0-9a-f-]{36}@integration\.invalid$/);
    expect(user.disabledAt).not.toBeNull();
    expect(user.name).toContain("Integration:");
    expect(await verifyPassword("", user.passwordHash)).toBe(false);
    expect(await verifyPassword("!", user.passwordHash)).toBe(false);
    expect(await authenticateWithPassword({ email: user.email, password: "anything-at-all-12345" })).toBeNull();
    expect(await prisma.membership.count({ where: { userId: user.id } })).toBe(0);
    await expect(resolveTenantContext(user.id, t.ctx.organizationSlug)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // each integration has its own actor
    const j = await newIntegration(t.ctx);
    expect((await prisma.integration.findUniqueOrThrow({ where: { id: j.id } })).serviceUserId).not.toBe(row.serviceUserId);
  });

  it("acts only inside its own organization with exactly its granted permissions", async () => {
    const t = await newTenant("cx");
    const i = await newIntegration(t.ctx);
    const row = (await systemIntegrationRepo.findById(i.id))!;
    const actor = resolveIntegrationContext(row);
    expect(actor.organizationId).toBe(t.ctx.organizationId);
    expect(actor.userId).toBe(row.serviceUserId);
    expect([...actor.permissions].sort()).toEqual(["orders.manage", "orders.view", "products.manage", "products.view"]);
    for (const forbidden of ["inventory.adjust", "inventory.reserve", "inventory.view", "warehouse.design", "warehouse.view", "picking.manage", "picking.view", "packing.manage", "packing.view", "org.manage", "integrations.manage", "members.manage", "roles.manage"]) {
      expect(actor.permissions.has(forbidden), forbidden).toBe(false);
    }
    // narrower grants narrow the actor
    await updateIntegration(t.ctx, i.id, { grants: ["orders.manage"] });
    expect([...resolveIntegrationContext((await systemIntegrationRepo.findById(i.id))!).permissions].sort()).toEqual(["orders.manage", "orders.view"]);
    await updateIntegration(t.ctx, i.id, { grants: [] });
    expect(resolveIntegrationContext((await systemIntegrationRepo.findById(i.id))!).permissions.size).toBe(0);
  });
});

describe("the secrets API is write-only", () => {
  it("returns metadata only, validates names and values, and never echoes a value", async () => {
    const { ctx } = await newTenant("sc");
    const i = await create(ctx);
    const value = canary("api");
    const meta = await setIntegrationSecret(ctx, i.id, "inbound_signing_secret", { value });
    expect(Object.keys(meta).sort()).toEqual(["hasPrevious", "isSet", "name", "rotatedAt"]);
    expect(meta).toMatchObject({ name: "inbound_signing_secret", isSet: true, hasPrevious: false });
    expect(JSON.stringify(meta)).not.toContain(value);

    expect(JSON.stringify(await getIntegration(ctx, i.id))).not.toContain(value);
    expect(JSON.stringify(await listIntegrations(ctx))).not.toContain(value);

    const rotated = await setIntegrationSecret(ctx, i.id, "inbound_signing_secret", { value: canary("api2") });
    expect(rotated.hasPrevious).toBe(true);

    const tooShort = "short-one";
    for (const bad of [{ value: tooShort }, { value: "has spaces in it here!!" }, { value: "x".repeat(600) }, {}, { value: 12345678901234567890 }]) {
      try {
        await setIntegrationSecret(ctx, i.id, "inbound_signing_secret", bad);
        expect.unreachable();
      } catch (error) {
        expect((error as { code: string }).code).toBe("VALIDATION_FAILED");
        expect(JSON.stringify(error) + (error as Error).message).not.toContain(tooShort);
      }
    }
    await expect(setIntegrationSecret(ctx, i.id, "not_a_secret", { value: canary("n") })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(setIntegrationSecret(ctx, i.id, "BAD NAME", { value: canary("n") })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("the secret never appears in any ordinary table", async () => {
    const { ctx } = await newTenant("sd");
    const i = await create(ctx);
    const value = canary("tables");
    await setIntegrationSecret(ctx, i.id, "inbound_signing_secret", { value });
    const rows = await prisma.$queryRawUnsafe<{ t: string }[]>(
      `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'IntegrationSecret')`,
    );
    for (const { t } of rows) {
      const found = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}" x WHERE row_to_json(x)::text LIKE $1`, `%${value}%`);
      expect(Number(found[0].n), `table ${t}`).toBe(0);
    }
  });
});
