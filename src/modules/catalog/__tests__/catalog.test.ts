import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { ctxWithRole, newTenant } from "../../../../tests/support/fixtures";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { addBarcode, createProduct, getProduct, listProducts, removeBarcode, updateProduct } from "..";

beforeEach(resetDatabase);

describe("products", () => {
  it("creates a product with a normalized, tenant-scoped SKU", async () => {
    const { ctx, org } = await newTenant();
    const p = await createProduct(ctx, { sku: " widget-01 ", name: "  Widget ", description: "A widget" });
    expect(p).toMatchObject({ sku: "WIDGET-01", name: "Widget", description: "A widget", active: true, barcodes: [] });
    const row = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.organizationId).toBe(org.organization.id);
  });

  it("rejects invalid input on the server", async () => {
    const { ctx } = await newTenant();
    for (const bad of [{ sku: "", name: "x" }, { sku: "has space", name: "x" }, { sku: "-LEADING", name: "x" }, { sku: "A".repeat(65), name: "x" }, { sku: "OK", name: "" }, { sku: "OK" }]) {
      await expect(createProduct(ctx, bad)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("SKU is unique within an organization but the same SKU may exist in another one", async () => {
    const a = await newTenant("a");
    const b = await newTenant("b");
    await createProduct(a.ctx, { sku: "SKU1", name: "A's" });
    await expect(createProduct(a.ctx, { sku: "sku1", name: "dup" })).rejects.toBeInstanceOf(ConflictError);
    await expect(createProduct(b.ctx, { sku: "SKU1", name: "B's" })).resolves.toMatchObject({ sku: "SKU1" });
  });

  it("lists, searches, edits and disables products (SKU is immutable)", async () => {
    const { ctx } = await newTenant();
    const a = await createProduct(ctx, { sku: "APPLE", name: "Green apple" });
    await createProduct(ctx, { sku: "PEAR", name: "Pear" });
    expect((await listProducts(ctx)).map((p) => p.sku)).toEqual(["APPLE", "PEAR"]);
    expect((await listProducts(ctx, { search: "gre" })).map((p) => p.sku)).toEqual(["APPLE"]);

    const edited = await updateProduct(ctx, a.id, { name: "Red apple", description: null });
    expect(edited).toMatchObject({ name: "Red apple", sku: "APPLE" });
    await expect(updateProduct(ctx, a.id, {})).rejects.toBeInstanceOf(ValidationError);

    await updateProduct(ctx, a.id, { active: false });
    expect((await listProducts(ctx)).map((p) => p.sku)).toEqual(["PEAR"]);
    expect((await listProducts(ctx, { includeInactive: true })).map((p) => p.sku)).toEqual(["APPLE", "PEAR"]);
    expect((await getProduct(ctx, a.id)).active).toBe(false);
  });
});

describe("barcodes", () => {
  it("adds and removes barcodes; no format is assumed", async () => {
    const { ctx } = await newTenant();
    const p = await createProduct(ctx, { sku: "P1", name: "P1" });
    await addBarcode(ctx, p.id, { barcode: "4006381333931" });
    const after = await addBarcode(ctx, p.id, { barcode: "internal code/7 with space" });
    expect(after.barcodes.map((b) => b.barcode)).toEqual(["4006381333931", "internal code/7 with space"]);
    const removed = await removeBarcode(ctx, p.id, after.barcodes[0].id);
    expect(removed.barcodes).toHaveLength(1);
    await expect(removeBarcode(ctx, p.id, after.barcodes[0].id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("is unique within the organization (across products), but not across organizations", async () => {
    const a = await newTenant("a");
    const b = await newTenant("b");
    const p1 = await createProduct(a.ctx, { sku: "P1", name: "P1" });
    const p2 = await createProduct(a.ctx, { sku: "P2", name: "P2" });
    await addBarcode(a.ctx, p1.id, { barcode: "123" });
    await expect(addBarcode(a.ctx, p1.id, { barcode: "123" })).rejects.toBeInstanceOf(ConflictError);
    await expect(addBarcode(a.ctx, p2.id, { barcode: "123" })).rejects.toBeInstanceOf(ConflictError);
    const pb = await createProduct(b.ctx, { sku: "P1", name: "B" });
    await expect(addBarcode(b.ctx, pb.id, { barcode: "123" })).resolves.toBeTruthy();
  });

  it("rejects empty, over-long and control-character barcodes", async () => {
    const { ctx } = await newTenant();
    const p = await createProduct(ctx, { sku: "P1", name: "P1" });
    for (const bad of ["", "   ", "x".repeat(129), "bad\u0007code"]) {
      await expect(addBarcode(ctx, p.id, { barcode: bad })).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe("tenant isolation and authorization", () => {
  it("another organization cannot see or change a product or its barcodes", async () => {
    const a = await newTenant("a");
    const b = await newTenant("b");
    const p = await createProduct(a.ctx, { sku: "SECRET", name: "A only" });
    expect(await listProducts(b.ctx)).toEqual([]);
    await expect(getProduct(b.ctx, p.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateProduct(b.ctx, p.id, { name: "hacked" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addBarcode(b.ctx, p.id, { barcode: "9" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).name).toBe("A only");
  });

  it("Member can view products but not manage them; Admin can manage", async () => {
    const { org, ctx } = await newTenant();
    const p = await createProduct(ctx, { sku: "P1", name: "P1" });
    const member = await ctxWithRole(org, "Member");
    const admin = await ctxWithRole(org, "Admin");
    await expect(listProducts(member)).resolves.toHaveLength(1);
    await expect(createProduct(member, { sku: "P2", name: "x" })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(updateProduct(member, p.id, { name: "x" })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(addBarcode(member, p.id, { barcode: "1" })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(createProduct(admin, { sku: "P2", name: "x" })).resolves.toBeTruthy();
  });

  it("enforces the sku format at the database level too", async () => {
    const { org } = await newTenant();
    await expect(prisma.product.create({ data: { organizationId: org.organization.id, sku: "lower case", name: "x" } })).rejects.toBeTruthy();
  });
});
