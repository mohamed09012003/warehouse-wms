import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { ctxWithRole, makeProduct, newTenant } from "../../../../tests/support/fixtures";
import { AuthorizationError, ConflictError, InvalidStateError, NotFoundError, ValidationError } from "@/lib/errors";
import { updateProduct } from "@/modules/catalog";
import { createOrder, getOrder, listOrders, markOrderReady } from "..";

beforeEach(resetDatabase);

describe("creating orders", () => {
  it("creates a DRAFT order with lines; the number is normalized and quantities start unallocated", async () => {
    const { ctx } = await newTenant();
    const a = await makeProduct(ctx);
    const b = await makeProduct(ctx);
    const order = await createOrder(ctx, { orderNumber: " so-1001 ", externalRef: "SHOP-77", note: "rush", lines: [{ productId: a.id, quantity: 5 }, { productId: b.id, quantity: 2 }] });
    expect(order).toMatchObject({ orderNumber: "SO-1001", status: "DRAFT", externalRef: "SHOP-77", note: "rush", lineCount: 2, requestedTotal: 7, allocatedTotal: 0, pickedTotal: 0, allocationState: "NONE" });
    expect(order.lines.map((l) => [l.lineNo, l.sku, l.requestedQty, l.allocatedQty, l.pickedQty, l.unallocatedQty])).toEqual([
      [1, a.sku, 5, 0, 0, 5],
      [2, b.sku, 2, 0, 0, 2],
    ]);
  });

  it("can be created READY directly", async () => {
    const { ctx } = await newTenant();
    const p = await makeProduct(ctx);
    expect((await createOrder(ctx, { orderNumber: "R1", lines: [{ productId: p.id, quantity: 1 }], ready: true })).status).toBe("READY");
  });

  it("rejects invalid quantities, empty orders, duplicate products and bad numbers", async () => {
    const { ctx } = await newTenant();
    const p = await makeProduct(ctx);
    const q = await makeProduct(ctx);
    const base = { orderNumber: "X1", lines: [{ productId: p.id, quantity: 1 }] };
    for (const quantity of [0, -1, 1.5, "3", null, 100_000_001]) {
      await expect(createOrder(ctx, { ...base, lines: [{ productId: p.id, quantity }] })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(createOrder(ctx, { ...base, lines: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createOrder(ctx, { ...base, lines: [{ productId: p.id, quantity: 1 }, { productId: p.id, quantity: 2 }] })).rejects.toBeInstanceOf(ValidationError);
    for (const orderNumber of ["", "has space", "-bad", "x".repeat(41)]) {
      await expect(createOrder(ctx, { ...base, orderNumber })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(createOrder(ctx, { ...base, lines: [{ productId: "nope", quantity: 1 }] })).rejects.toBeInstanceOf(ValidationError);
    expect(q).toBeTruthy();
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects unknown and disabled products; nothing is saved", async () => {
    const { ctx } = await newTenant();
    const p = await makeProduct(ctx);
    await expect(createOrder(ctx, { orderNumber: "X1", lines: [{ productId: "00000000-0000-4000-8000-000000000000", quantity: 1 }] })).rejects.toBeInstanceOf(NotFoundError);
    await updateProduct(ctx, p.id, { active: false });
    await expect(createOrder(ctx, { orderNumber: "X1", lines: [{ productId: p.id, quantity: 1 }] })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.order.count()).toBe(0);
  });

  it("order numbers are unique per organization (not globally)", async () => {
    const a = await newTenant("a");
    const b = await newTenant("b");
    const pa = await makeProduct(a.ctx);
    const pb = await makeProduct(b.ctx);
    await createOrder(a.ctx, { orderNumber: "SO-1", lines: [{ productId: pa.id, quantity: 1 }] });
    await expect(createOrder(a.ctx, { orderNumber: "so-1", lines: [{ productId: pa.id, quantity: 1 }] })).rejects.toBeInstanceOf(ConflictError);
    await expect(createOrder(b.ctx, { orderNumber: "SO-1", lines: [{ productId: pb.id, quantity: 1 }] })).resolves.toMatchObject({ orderNumber: "SO-1" });
  });
});

describe("status transitions and reads", () => {
  it("DRAFT -> READY once; any other status cannot be marked ready", async () => {
    const { ctx } = await newTenant();
    const p = await makeProduct(ctx);
    const o = await createOrder(ctx, { orderNumber: "T1", lines: [{ productId: p.id, quantity: 1 }] });
    expect((await markOrderReady(ctx, o.id)).status).toBe("READY");
    await expect(markOrderReady(ctx, o.id)).rejects.toBeInstanceOf(InvalidStateError);
    await expect(markOrderReady(ctx, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists with filters and search; most recent first", async () => {
    const { ctx } = await newTenant();
    const p = await makeProduct(ctx);
    const a = await createOrder(ctx, { orderNumber: "AAA-1", lines: [{ productId: p.id, quantity: 1 }] });
    await createOrder(ctx, { orderNumber: "BBB-2", externalRef: "web-9", lines: [{ productId: p.id, quantity: 1 }], ready: true });
    expect((await listOrders(ctx)).map((o) => o.orderNumber)).toEqual(["BBB-2", "AAA-1"]);
    expect((await listOrders(ctx, { status: "DRAFT" })).map((o) => o.id)).toEqual([a.id]);
    expect((await listOrders(ctx, { search: "bbb" })).map((o) => o.orderNumber)).toEqual(["BBB-2"]);
    expect((await listOrders(ctx, { search: "WEB" })).map((o) => o.orderNumber)).toEqual(["BBB-2"]);
  });
});

describe("tenant isolation and permissions", () => {
  it("another organization cannot read or change an order, or use its products", async () => {
    const a = await newTenant("a");
    const b = await newTenant("b");
    const pa = await makeProduct(a.ctx);
    const o = await createOrder(a.ctx, { orderNumber: "SECRET-1", lines: [{ productId: pa.id, quantity: 3 }] });
    expect(await listOrders(b.ctx)).toEqual([]);
    await expect(getOrder(b.ctx, o.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(markOrderReady(b.ctx, o.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createOrder(b.ctx, { orderNumber: "B1", lines: [{ productId: pa.id, quantity: 1 }] })).rejects.toBeInstanceOf(NotFoundError);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("DRAFT");
  });

  it("Member can view orders but not create or change them; Admin can", async () => {
    const { org, ctx } = await newTenant();
    const p = await makeProduct(ctx);
    const o = await createOrder(ctx, { orderNumber: "P1", lines: [{ productId: p.id, quantity: 1 }] });
    const member = await ctxWithRole(org, "Member");
    const admin = await ctxWithRole(org, "Admin");
    await expect(listOrders(member)).resolves.toHaveLength(1);
    await expect(getOrder(member, o.id)).resolves.toBeTruthy();
    await expect(createOrder(member, { orderNumber: "P2", lines: [{ productId: p.id, quantity: 1 }] })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(markOrderReady(member, o.id)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(createOrder(admin, { orderNumber: "P2", lines: [{ productId: p.id, quantity: 1 }] })).resolves.toBeTruthy();
  });
});

describe("database constraints", () => {
  it("refuse picked > allocated, allocated > requested, and non-positive requests", async () => {
    const { ctx } = await newTenant();
    const p = await makeProduct(ctx);
    const o = await createOrder(ctx, { orderNumber: "C1", lines: [{ productId: p.id, quantity: 5 }] });
    const lineId = o.lines[0].id;
    await expect(prisma.orderLine.update({ where: { id: lineId }, data: { allocatedQty: 6 } })).rejects.toBeTruthy();
    await expect(prisma.orderLine.update({ where: { id: lineId }, data: { pickedQty: 1 } })).rejects.toBeTruthy(); // picked > allocated (0)
    await expect(prisma.orderLine.update({ where: { id: lineId }, data: { requestedQty: 0 } })).rejects.toBeTruthy();
    await prisma.orderLine.update({ where: { id: lineId }, data: { allocatedQty: 5, pickedQty: 5 } }); // legal
    await expect(prisma.orderLine.update({ where: { id: lineId }, data: { pickedQty: 6 } })).rejects.toBeTruthy();
  });

  it("an order line cannot reference another organization's product or order", async () => {
    const a = await newTenant("a");
    const b = await newTenant("b");
    const pa = await makeProduct(a.ctx);
    const pb = await makeProduct(b.ctx);
    const oa = await createOrder(a.ctx, { orderNumber: "D1", lines: [{ productId: pa.id, quantity: 1 }] });
    await expect(
      prisma.orderLine.create({ data: { organizationId: a.org.organization.id, orderId: oa.id, lineNo: 9, productId: pb.id, requestedQty: 1 } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.orderLine.create({ data: { organizationId: b.org.organization.id, orderId: oa.id, lineNo: 9, productId: pb.id, requestedQty: 1 } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
