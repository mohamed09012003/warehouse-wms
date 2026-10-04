// Inbound event processing through the worker: product.upsert, order.create, order.cancel.
// Handlers translate and map; the core services keep the rules. Failures leave no partial effects.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createProduct, updateProduct } from "@/modules/catalog";
import { allocateOrder } from "@/modules/picking";
import { completePacking, startPacking } from "@/modules/packing";
import { prisma, resetDatabase } from "../../../tests/support/db";
import { assertLedgerMatchesBalances, assertPackingInvariants, assertPickingInvariants, inventorySnapshot, makeOrder, makeProduct, pickOrder, stockAt, tenantWithWarehouse, newTenant } from "../../../tests/support/fixtures";
import { envelope, FakeHttp, newIntegration, signedRequest, type TestIntegration } from "../../../tests/support/integrations";
import { disableIntegration, enableIntegration, ingestWebhook, replayInboundEvent, runOnce, updateIntegration } from "..";
import { addPackageItem, completePackage, createPackage } from "@/modules/packing";
import { inboundRepo } from "../repo/inboundRepo";
import { processInboundEvent } from "../service/inboundProcessor";
import type { WorkerDeps } from "../service/workerDeps";

beforeEach(resetDatabase);

const deps = (): WorkerDeps => ({ now: () => new Date(), http: new FakeHttp() });

async function receive(integ: TestIntegration, type: string, data: Record<string, unknown>, eventId: string = randomUUID()) {
  const res = await ingestWebhook(integ.publicId, signedRequest(integ.publicId, integ.inboundSecret, envelope(type, data, eventId)));
  expect(res.status).toBe(202);
  return eventId;
}
const stored = (externalEventId: string) => prisma.inboundEvent.findFirstOrThrow({ where: { externalEventId } });
async function run(integ: TestIntegration, type: string, data: Record<string, unknown>) {
  const id = await receive(integ, type, data);
  await runOnce(deps());
  return stored(id);
}
const outboxTypes = async () => (await prisma.outboxEvent.findMany({ orderBy: { seq: "asc" } })).map((e) => e.eventType);

describe("product.upsert", () => {
  it("creates the product, its barcodes and the external reference, and records the result", async () => {
    const t = await newTenant("pu");
    const integ = await newIntegration(t.ctx);
    const ev = await run(integ, "product.upsert", { externalId: "ext-p1", sku: "widget-1", name: "Widget", description: "A widget", barcodes: ["4006381333931", "4006381333932"] });
    expect(ev).toMatchObject({ status: "SUCCEEDED", attempts: 1, resultType: "PRODUCT", lastErrorCode: null });
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "WIDGET-1" }, include: { barcodes: true } });
    expect(ev.resultId).toBe(product.id);
    expect(product).toMatchObject({ name: "Widget", description: "A widget", organizationId: t.ctx.organizationId });
    expect(product.barcodes.map((b) => b.barcode).sort()).toEqual(["4006381333931", "4006381333932"]);
    const ref = await prisma.externalRef.findFirstOrThrow({ where: { integrationId: integ.id } });
    expect(ref).toMatchObject({ entityType: "PRODUCT", externalId: "ext-p1", productId: product.id, orderId: null });
    const lastLog = await prisma.integrationLog.findFirstOrThrow({ where: { integrationId: integ.id, status: "SUCCEEDED" } });
    expect(lastLog).toMatchObject({ direction: "INBOUND", eventType: "product.upsert", attempt: 1 });
  });

  it("updates through the mapping, keeps existing barcodes (add-only) and adds new ones", async () => {
    const t = await newTenant("pu");
    const integ = await newIntegration(t.ctx);
    await run(integ, "product.upsert", { externalId: "ext-p1", sku: "WIDGET-1", name: "Widget", barcodes: ["B-1", "B-2"] });
    const second = await run(integ, "product.upsert", { externalId: "ext-p1", sku: "WIDGET-1", name: "Widget v2", barcodes: ["B-2", "B-3"] });
    expect(second.status).toBe("SUCCEEDED");
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "WIDGET-1" }, include: { barcodes: true } });
    expect(product.name).toBe("Widget v2");
    expect(product.barcodes.map((b) => b.barcode).sort()).toEqual(["B-1", "B-2", "B-3"]); // B-1 was NOT removed
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.externalRef.count()).toBe(1);
  });

  it("maps to an existing product with the same SKU instead of duplicating it", async () => {
    const t = await newTenant("pu");
    const existing = await createProduct(t.ctx, { sku: "GADGET", name: "Old name" });
    const integ = await newIntegration(t.ctx);
    const ev = await run(integ, "product.upsert", { externalId: "g-1", sku: "gadget", name: "New name" });
    expect(ev).toMatchObject({ status: "SUCCEEDED", resultId: existing.id });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: existing.id } })).name).toBe("New name");
    expect(await prisma.product.count()).toBe(1);
  });

  it("rejects a SKU change for an already mapped product, a barcode owned by another product, and a SKU already mapped to a different external id, with no partial effects", async () => {
    const t = await newTenant("pu");
    const integ = await newIntegration(t.ctx);
    await run(integ, "product.upsert", { externalId: "ext-1", sku: "ONE", name: "One", barcodes: ["BC-ONE"] });

    const changed = await run(integ, "product.upsert", { externalId: "ext-1", sku: "ONE-RENAMED", name: "One" });
    expect(changed).toMatchObject({ status: "REJECTED", lastErrorCode: "VALIDATION_FAILED", attempts: 1 });
    expect(changed.lastErrorSummary).toMatch(/SKU cannot change/);
    expect(await prisma.product.count({ where: { sku: "ONE-RENAMED" } })).toBe(0);

    // a NEW product whose barcode belongs to ONE: the product creation must roll back with the rejection
    const clash = await run(integ, "product.upsert", { externalId: "ext-2", sku: "TWO", name: "Two", barcodes: ["BC-TWO", "BC-ONE"] });
    expect(clash).toMatchObject({ status: "REJECTED", lastErrorCode: "VALIDATION_FAILED" });
    expect(await prisma.product.count({ where: { sku: "TWO" } })).toBe(0);
    expect(await prisma.productBarcode.count({ where: { barcode: "BC-TWO" } })).toBe(0);
    expect(await prisma.externalRef.count({ where: { externalId: "ext-2" } })).toBe(0);

    const again = await run(integ, "product.upsert", { externalId: "ext-1b", sku: "ONE", name: "One again" });
    expect(again).toMatchObject({ status: "REJECTED", lastErrorCode: "PRODUCT_ALREADY_MAPPED" });
    expect(await prisma.externalRef.count()).toBe(1);
    expect((await prisma.product.findFirstOrThrow({ where: { sku: "ONE" } })).name).toBe("One"); // the rejected event changed nothing
  });

  it("rejects invalid payloads once (REJECTED, not retried) with a short safe reason", async () => {
    const t = await newTenant("pu");
    const integ = await newIntegration(t.ctx);
    const cases: Record<string, unknown>[] = [
      { externalId: "x", name: "no sku" },
      { externalId: "x", sku: "A", name: "" },
      { sku: "A", name: "no external id" },
      { externalId: "x", sku: "A", name: "n", barcodes: Array.from({ length: 51 }, (_, i) => `b${i}`) },
      { externalId: "x", sku: "A".repeat(65), name: "n" },
      { externalId: "x", sku: "has spaces", name: "n" }, // passes the loose schema, fails the catalog's SKU rules
    ];
    for (const data of cases) {
      const ev = await run(integ, "product.upsert", data);
      expect(ev.status, JSON.stringify(data)).toBe("REJECTED");
      expect(ev.attempts).toBe(1);
      expect(ev.lastErrorSummary!.length).toBeLessThanOrEqual(300);
      expect(["INVALID_PAYLOAD", "VALIDATION_FAILED"]).toContain(ev.lastErrorCode);
    }
    expect(await prisma.product.count()).toBe(0);
    // a further pass does not touch rejected events
    const summary = await runOnce(deps());
    expect(summary.inbound).toEqual({ succeeded: 0, rejected: 0, failed: 0, dead: 0, lease_lost: 0 });
  });

  it("rejects event types the provider does not support", async () => {
    const t = await newTenant("pu");
    const integ = await newIntegration(t.ctx);
    for (const type of ["inventory.adjust", "order.update", "totally.unknown"]) {
      const ev = await run(integ, type, { anything: 1 });
      expect(ev).toMatchObject({ status: "REJECTED", lastErrorCode: "UNSUPPORTED_EVENT_TYPE" });
    }
    expect(await prisma.inventoryOperation.count()).toBe(0); // inbound inventory adjustments do not exist
  });
});

describe("order.create", () => {
  async function setup() {
    const t = await tenantWithWarehouse("oc");
    const integ = await newIntegration(t.ctx);
    await run(integ, "product.upsert", { externalId: "P-1", sku: "WIDGET", name: "Widget" });
    await run(integ, "product.upsert", { externalId: "P-2", sku: "GADGET", name: "Gadget", barcodes: ["GAD-BAR"] });
    return { ...t, integ };
  }

  it("creates the order through the order service, resolving products by external reference, SKU or barcode, and records the mapping", async () => {
    const { ctx, integ } = await setup();
    const ev = await run(integ, "order.create", {
      externalId: "ext-o-1",
      note: "Rush",
      lines: [{ externalProductId: "P-1", quantity: 3 }, { sku: "gadget", quantity: 2 }],
    });
    expect(ev).toMatchObject({ status: "SUCCEEDED", resultType: "ORDER" });
    const order = await prisma.order.findFirstOrThrow({ where: { id: ev.resultId! }, include: { lines: { include: { product: true }, orderBy: { lineNo: "asc" } } } });
    expect(order).toMatchObject({ orderNumber: "EXT-O-1", externalRef: "ext-o-1", status: "READY", note: "Rush", organizationId: ctx.organizationId });
    expect(order.lines.map((l) => [l.product.sku, l.requestedQty])).toEqual([["WIDGET", 3], ["GADGET", 2]]);
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(order.createdByUserId).toBe(row.serviceUserId); // the actor is recorded
    expect(await prisma.externalRef.findFirst({ where: { integrationId: integ.id, entityType: "ORDER" } })).toMatchObject({ externalId: "ext-o-1", orderId: order.id, productId: null });

    const byBarcode = await run(integ, "order.create", { externalId: "ext-o-2", orderNumber: "SO-77", ready: false, lines: [{ sku: "GAD-BAR", quantity: 1 }] });
    expect(byBarcode.status).toBe("SUCCEEDED");
    expect(await prisma.order.findFirstOrThrow({ where: { orderNumber: "SO-77" } })).toMatchObject({ status: "DRAFT", externalRef: "ext-o-2" });
  });

  it("is idempotent per external order: a second event for the same order creates nothing and reports the same order", async () => {
    const { integ } = await setup();
    const first = await run(integ, "order.create", { externalId: "dup-o", lines: [{ sku: "WIDGET", quantity: 1 }] });
    const second = await run(integ, "order.create", { externalId: "dup-o", lines: [{ sku: "WIDGET", quantity: 99 }] });
    expect(second).toMatchObject({ status: "SUCCEEDED", resultId: first.resultId });
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.orderLine.findFirstOrThrow()).requestedQty).toBe(1);
    expect(await outboxTypes()).toEqual(["order.created"]); // one business transition, one event
  });

  it("rejects unknown products, existing order numbers, disabled products and bad lines, leaving no order, mapping or event", async () => {
    const { ctx, integ } = await setup();
    await makeOrder(ctx, [{ productId: (await prisma.product.findFirstOrThrow({ where: { sku: "WIDGET" } })).id, quantity: 1 }], { orderNumber: "TAKEN-1" });
    const outboxBefore = await prisma.outboxEvent.count();
    const widget = await prisma.product.findFirstOrThrow({ where: { sku: "WIDGET" } });
    const bad: [string, Record<string, unknown>, string][] = [
      ["unknown sku", { externalId: "b1", lines: [{ sku: "NOPE", quantity: 1 }] }, "UNKNOWN_PRODUCT"],
      ["unknown external product", { externalId: "b2", lines: [{ externalProductId: "ghost", quantity: 1 }] }, "UNKNOWN_PRODUCT"],
      ["one unknown among valid lines", { externalId: "b3", lines: [{ sku: "WIDGET", quantity: 1 }, { sku: "NOPE", quantity: 1 }] }, "UNKNOWN_PRODUCT"],
      ["order number taken", { externalId: "b4", orderNumber: "taken-1", lines: [{ sku: "WIDGET", quantity: 1 }] }, "ORDER_NUMBER_EXISTS"],
      ["duplicate product lines", { externalId: "b5", lines: [{ sku: "WIDGET", quantity: 1 }, { externalProductId: "P-1", quantity: 2 }] }, "VALIDATION_FAILED"],
      ["bad order number", { externalId: "b6", orderNumber: "has spaces!", lines: [{ sku: "WIDGET", quantity: 1 }] }, "VALIDATION_FAILED"],
      ["zero quantity", { externalId: "b7", lines: [{ sku: "WIDGET", quantity: 0 }] }, "INVALID_PAYLOAD"],
      ["fractional quantity", { externalId: "b8", lines: [{ sku: "WIDGET", quantity: 1.5 }] }, "INVALID_PAYLOAD"],
      ["no lines", { externalId: "b9", lines: [] }, "INVALID_PAYLOAD"],
      ["line without product reference", { externalId: "b10", lines: [{ quantity: 1 }] }, "INVALID_PAYLOAD"],
      ["no external id", { lines: [{ sku: "WIDGET", quantity: 1 }] }, "INVALID_PAYLOAD"],
    ];
    for (const [label, data, code] of bad) {
      const ev = await run(integ, "order.create", data);
      expect(ev, label).toMatchObject({ status: "REJECTED", lastErrorCode: code, attempts: 1 });
    }
    await updateProduct(ctx, widget.id, { active: false });
    expect(await run(integ, "order.create", { externalId: "b11", lines: [{ sku: "WIDGET", quantity: 1 }] })).toMatchObject({ status: "REJECTED", lastErrorCode: "VALIDATION_FAILED" });

    expect(await prisma.order.count()).toBe(1); // only the manually made TAKEN-1
    expect(await prisma.externalRef.count({ where: { entityType: "ORDER" } })).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(outboxBefore);
  });

  it("rolls the whole attempt back if the lease was lost: no order, no mapping, event left to its new owner", async () => {
    const { integ } = await setup();
    const id = await receive(integ, "order.create", { externalId: "lease-o", lines: [{ sku: "WIDGET", quantity: 2 }] });
    const [claimed] = await inboundRepo.claim(new Date(), 1);
    expect(claimed.externalEventId).toBe(id);
    // another worker took over (attempt counter moved on) before this one finished
    await prisma.inboundEvent.update({ where: { id: claimed.id }, data: { attempts: { increment: 1 } } });
    expect(await processInboundEvent(claimed, deps())).toBe("lease_lost");
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.externalRef.count({ where: { entityType: "ORDER" } })).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect((await stored(id)).status).toBe("PROCESSING"); // untouched: the new owner decides
  });

  it("a different tenant's product with the same SKU is invisible to this integration", async () => {
    const a = await newTenant("ta");
    const b = await newTenant("tb");
    await makeProduct(b.ctx, "ONLY-IN-B");
    const integ = await newIntegration(a.ctx);
    const ev = await run(integ, "order.create", { externalId: "x-1", lines: [{ sku: "ONLY-IN-B", quantity: 1 }] });
    expect(ev).toMatchObject({ status: "REJECTED", lastErrorCode: "UNKNOWN_PRODUCT" });
    expect(await prisma.order.count()).toBe(0);
  });

  it("the same external ids in two tenants map to different, isolated entities", async () => {
    const a = await newTenant("ta");
    const b = await newTenant("tb");
    const ia = await newIntegration(a.ctx);
    const ib = await newIntegration(b.ctx);
    for (const i of [ia, ib]) {
      await run(i, "product.upsert", { externalId: "P", sku: "SAME", name: "Same" });
      await run(i, "order.create", { externalId: "O", lines: [{ externalProductId: "P", quantity: 1 }] });
    }
    const orders = await prisma.order.findMany({ orderBy: { createdAt: "asc" } });
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map((o) => o.organizationId)).size).toBe(2);
    expect(await prisma.externalRef.count({ where: { organizationId: a.ctx.organizationId } })).toBe(2);
    expect(await prisma.externalRef.count({ where: { organizationId: b.ctx.organizationId } })).toBe(2);
  });
});

describe("order.cancel", () => {
  async function setup() {
    const t = await tenantWithWarehouse("oz", { bays: 3, levels: 1 });
    const integ = await newIntegration(t.ctx);
    const prod = await makeProduct(t.ctx, "SKU-A");
    await prisma.externalRef.create({ data: { organizationId: t.ctx.organizationId, integrationId: integ.id, entityType: "PRODUCT", externalId: "P-A", productId: prod.id } });
    await stockAt(t.ctx, prod.id, t.byCode("R01-L01-B01-P01").id, 40);
    const create = async (externalId: string, qty = 10) => {
      const ev = await run(integ, "order.create", { externalId, lines: [{ externalProductId: "P-A", quantity: qty }] });
      expect(ev.status).toBe("SUCCEEDED");
      return ev.resultId!;
    };
    return { ...t, integ, prod, create };
  }

  it("cancels an allocated order, releases its reservations through the inventory service and publishes one order.cancelled event", async () => {
    const { ctx, integ, create } = await setup();
    const orderId = await create("c-1");
    await allocateOrder(ctx, { orderId });
    expect((await prisma.inventoryBalance.findFirstOrThrow()).reserved).toBe(10);

    const ev = await run(integ, "order.cancel", { externalId: "c-1" });
    expect(ev).toMatchObject({ status: "SUCCEEDED", resultId: orderId });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("CANCELLED");
    expect((await prisma.inventoryBalance.findFirstOrThrow()).reserved).toBe(0);
    expect(await prisma.reservation.count({ where: { status: "ACTIVE" } })).toBe(0);
    expect(await outboxTypes()).toEqual(["order.created", "order.allocated", "order.cancelled"]);
    await assertLedgerMatchesBalances();
    await assertPickingInvariants();
  });

  it("is idempotent: cancelling an already cancelled order succeeds and publishes nothing more", async () => {
    const { integ, create } = await setup();
    const orderId = await create("c-2");
    await run(integ, "order.cancel", { externalId: "c-2" });
    const again = await run(integ, "order.cancel", { externalId: "c-2" });
    expect(again).toMatchObject({ status: "SUCCEEDED", resultId: orderId });
    expect((await outboxTypes()).filter((t) => t === "order.cancelled")).toHaveLength(1);
  });

  it("rejects an unknown external order", async () => {
    const { integ } = await setup();
    expect(await run(integ, "order.cancel", { externalId: "never-seen" })).toMatchObject({ status: "REJECTED", lastErrorCode: "UNKNOWN_ORDER" });
  });

  it("keeps picked stock consumed when a partially picked order is cancelled", async () => {
    const { ctx, integ, create } = await setup();
    const orderId = await create("c-3");
    await pickOrder(ctx, orderId, 4);
    const ev = await run(integ, "order.cancel", { externalId: "c-3" });
    expect(ev.status).toBe("SUCCEEDED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("CANCELLED");
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    expect([balance.onHand, balance.reserved]).toEqual([36, 0]); // 40 - 4 picked; the other 6 reserved units were released
    await assertLedgerMatchesBalances();
    await assertPickingInvariants();
  });

  it("REJECTS cancelling an order that is being packed, with INVALID_STATE and absolutely no state change", async () => {
    const { ctx, integ, create } = await setup();
    const orderId = await create("c-4");
    await pickOrder(ctx, orderId);
    const session = await startPacking(ctx, { orderId });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("PACKING");
    const before = await inventorySnapshot();
    const outbox = await prisma.outboxEvent.count();

    const ev = await run(integ, "order.cancel", { externalId: "c-4" });
    expect(ev).toMatchObject({ status: "REJECTED", lastErrorCode: "INVALID_STATE", attempts: 1 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("PACKING");
    expect((await prisma.packingSession.findUniqueOrThrow({ where: { id: session.session.id } })).status).toBe("OPEN");
    expect(await inventorySnapshot()).toBe(before);
    expect(await prisma.outboxEvent.count()).toBe(outbox);
    await assertPackingInvariants();
  });

  it("REJECTS cancelling a PACKED order and a fully PICKED order, changing nothing", async () => {
    const { ctx, integ, create } = await setup();
    const picked = await create("c-5");
    await pickOrder(ctx, picked);
    const packed = await create("c-6");
    await pickOrder(ctx, packed);
    const s = await startPacking(ctx, { orderId: packed });
    const pkg = await createPackage(ctx, { sessionId: s.session.id });
    await addPackageItem(ctx, { packageId: pkg.packageId!, productCode: "SKU-A", quantity: 10 });
    await completePackage(ctx, { packageId: pkg.packageId! });
    await completePacking(ctx, { sessionId: s.session.id });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: packed } })).status).toBe("PACKED");

    const before = await inventorySnapshot();
    for (const [ext, id, status] of [["c-5", picked, "PICKED"], ["c-6", packed, "PACKED"]] as const) {
      const ev = await run(integ, "order.cancel", { externalId: ext });
      expect(ev, ext).toMatchObject({ status: "REJECTED", lastErrorCode: "INVALID_STATE" });
      expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe(status);
    }
    expect(await inventorySnapshot()).toBe(before);
    await assertPackingInvariants();
    await assertPickingInvariants();
  });

  it("an integration without the orders grant cannot do anything: events are rejected FORBIDDEN, orders untouched", async () => {
    const { ctx, integ, create } = await setup();
    const orderId = await create("c-7");
    await updateIntegration(ctx, integ.id, { grants: [] });
    const cancel = await run(integ, "order.cancel", { externalId: "c-7" });
    expect(cancel).toMatchObject({ status: "REJECTED", lastErrorCode: "FORBIDDEN" });
    const make = await run(integ, "order.create", { externalId: "c-8", lines: [{ externalProductId: "P-A", quantity: 1 }] });
    expect(make).toMatchObject({ status: "REJECTED", lastErrorCode: "FORBIDDEN" });
    const prod = await run(integ, "product.upsert", { externalId: "P-Z", sku: "ZZZ", name: "Z" });
    expect(prod).toMatchObject({ status: "REJECTED", lastErrorCode: "FORBIDDEN" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("READY");
    expect(await prisma.product.count({ where: { sku: "ZZZ" } })).toBe(0);
  });
});

describe("processing rules", () => {
  it("does not process events of a disabled integration until it is enabled again", async () => {
    const t = await newTenant("dp");
    const integ = await newIntegration(t.ctx);
    await disableIntegration(t.ctx, integ.id);
    // the endpoint refuses new events while disabled, so queue one before disabling it
    await enableIntegration(t.ctx, integ.id);
    const id = await receive(integ, "product.upsert", { externalId: "P", sku: "DISABLED-1", name: "n" });
    await disableIntegration(t.ctx, integ.id);
    await runOnce(deps());
    expect((await stored(id)).status).toBe("RECEIVED");
    expect(await prisma.product.count()).toBe(0);
    await enableIntegration(t.ctx, integ.id);
    await runOnce(deps());
    expect((await stored(id)).status).toBe("SUCCEEDED");
  });

  it("never processes events of an archived integration", async () => {
    const t = await newTenant("ar");
    const integ = await newIntegration(t.ctx);
    const id = await receive(integ, "product.upsert", { externalId: "P", sku: "ARCH-1", name: "n" });
    await updateIntegration(t.ctx, integ.id, { archived: true });
    await runOnce(deps());
    expect((await stored(id)).status).toBe("RECEIVED");
    expect(await prisma.product.count()).toBe(0);
  });

  it("success updates health; a rejected event (bad data) does not count as a failure", async () => {
    const t = await newTenant("hl");
    const integ = await newIntegration(t.ctx);
    await run(integ, "product.upsert", { externalId: "bad" }); // rejected
    let row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(row.inboundConsecutiveFailures).toBe(0);
    expect(row.inboundLastSuccessAt).toBeNull();
    await run(integ, "product.upsert", { externalId: "P", sku: "HEALTH-1", name: "n" });
    row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(row.inboundLastSuccessAt).not.toBeNull();
    expect(row.inboundHealthStatus).toBe("HEALTHY");
  });

  it("an admin can replay a rejected event after fixing the cause", async () => {
    const t = await newTenant("rp");
    const integ = await newIntegration(t.ctx);
    const first = await run(integ, "order.create", { externalId: "later", lines: [{ sku: "LATE-SKU", quantity: 1 }] });
    expect(first).toMatchObject({ status: "REJECTED", lastErrorCode: "UNKNOWN_PRODUCT" });
    await createProduct(t.ctx, { sku: "LATE-SKU", name: "Late" });
    await replayInboundEvent(t.ctx, integ.id, first.id);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("RECEIVED");
    await runOnce(deps());
    expect(await prisma.inboundEvent.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "SUCCEEDED", attempts: 1, lastErrorCode: null });
    expect(await prisma.order.count()).toBe(1);
  });
});
