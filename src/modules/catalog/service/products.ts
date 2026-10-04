import { ConflictError, NotFoundError, ValidationError, parseInput } from "@/lib/errors";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { withTransaction, type Tx } from "@/server/db";
import { productRepo } from "../repo/productRepo";
import { addBarcodeSchema, createProductSchema, listProductsSchema, updateProductSchema, upsertProductSchema } from "../schemas";

export interface ProductDto {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  active: boolean;
  barcodeCount: number;
}

export interface ProductDetailDto extends Omit<ProductDto, "barcodeCount"> {
  barcodes: { id: string; barcode: string }[];
}

const isUniqueViolation = (e: unknown) => (e as { code?: unknown } | null)?.code === "P2002";

export async function listProducts(ctx: TenantContext, raw: unknown = {}): Promise<ProductDto[]> {
  requirePermission(ctx, "products.view");
  const rows = await productRepo(ctx).list(parseInput(listProductsSchema, raw));
  return rows.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    active: p.active,
    barcodeCount: p._count.barcodes,
  }));
}

export async function getProduct(ctx: TenantContext, id: string): Promise<ProductDetailDto> {
  requirePermission(ctx, "products.view");
  const p = await productRepo(ctx).findById(id);
  if (!p) throw new NotFoundError("Product not found");
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    active: p.active,
    barcodes: p.barcodes.map((b) => ({ id: b.id, barcode: b.barcode })),
  };
}

export async function createProduct(ctx: TenantContext, raw: unknown): Promise<ProductDetailDto> {
  requirePermission(ctx, "products.manage");
  const input = parseInput(createProductSchema, raw);
  try {
    const p = await productRepo(ctx).create({ sku: input.sku, name: input.name, description: input.description ?? null });
    return { id: p.id, sku: p.sku, name: p.name, description: p.description, active: p.active, barcodes: [] };
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`SKU "${input.sku}" already exists`);
    throw error;
  }
}

export async function updateProduct(ctx: TenantContext, id: string, raw: unknown): Promise<ProductDetailDto> {
  requirePermission(ctx, "products.manage");
  const input = parseInput(updateProductSchema, raw);
  const { count } = await productRepo(ctx).update(id, input);
  if (count === 0) throw new NotFoundError("Product not found");
  return getProduct(ctx, id);
}

/**
 * Create or update a product by SKU, adding any missing barcodes (barcodes are never removed here).
 * Used by integrations. `opts.productId` names a product already known through an external
 * reference: its SKU must then match (SKUs are immutable). Runs in `opts.tx` when given, so the caller
 * can commit it together with other writes; otherwise in its own transaction.
 */
export async function upsertProduct(
  ctx: TenantContext,
  raw: unknown,
  opts: { tx?: Tx; productId?: string } = {},
): Promise<{ product: ProductDetailDto; created: boolean }> {
  requirePermission(ctx, "products.manage");
  const input = parseInput(upsertProductSchema, raw);

  const run = async (tx: Tx) => {
    const repo = productRepo(ctx, tx);
    let existing = opts.productId ? await repo.findById(opts.productId) : await repo.findBySku(input.sku);
    if (opts.productId && !existing) throw new NotFoundError("Product not found");
    if (existing && existing.sku !== input.sku) {
      throw new ValidationError(`SKU cannot change: the product is ${existing.sku}, the request says ${input.sku}`);
    }
    let created = false;
    if (!existing) {
      try {
        await repo.create({ sku: input.sku, name: input.name, description: input.description ?? null });
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError(`SKU "${input.sku}" was created concurrently; retry`);
        throw error;
      }
      existing = await repo.findBySku(input.sku);
      created = true;
    } else if (existing.name !== input.name || (input.description !== undefined && (input.description ?? null) !== existing.description)) {
      await repo.update(existing.id, { name: input.name, ...(input.description !== undefined ? { description: input.description ?? null } : {}) });
    }
    if (!existing) throw new NotFoundError("Product not found");

    const have = new Set(existing.barcodes.map((b) => b.barcode));
    for (const barcode of new Set(input.barcodes ?? [])) {
      if (have.has(barcode)) continue;
      const owner = await repo.findBarcodeOwner(barcode);
      if (owner && owner.productId !== existing.id) throw new ValidationError(`Barcode "${barcode}" is already assigned to another product`);
      try {
        await repo.addBarcode(existing.id, barcode);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError(`Barcode "${barcode}" was assigned concurrently; retry`);
        throw error;
      }
    }
    const p = await repo.findById(existing.id);
    if (!p) throw new NotFoundError("Product not found");
    const product: ProductDetailDto = {
      id: p.id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      active: p.active,
      barcodes: p.barcodes.map((b) => ({ id: b.id, barcode: b.barcode })),
    };
    return { product, created };
  };
  return opts.tx ? run(opts.tx) : withTransaction(run);
}

export async function addBarcode(ctx: TenantContext, productId: string, raw: unknown): Promise<ProductDetailDto> {
  requirePermission(ctx, "products.manage");
  const { barcode } = parseInput(addBarcodeSchema, raw);
  const repo = productRepo(ctx);
  if (!(await repo.findById(productId))) throw new NotFoundError("Product not found");
  try {
    await repo.addBarcode(productId, barcode);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`Barcode "${barcode}" is already assigned to a product`);
    throw error;
  }
  return getProduct(ctx, productId);
}

export async function removeBarcode(ctx: TenantContext, productId: string, barcodeId: string): Promise<ProductDetailDto> {
  requirePermission(ctx, "products.manage");
  const { count } = await productRepo(ctx).removeBarcode(productId, barcodeId);
  if (count === 0) throw new NotFoundError("Barcode not found");
  return getProduct(ctx, productId);
}

/**
 * Internal lookup for other modules (inventory). Tenant-scoped, performs no permission check:
 * callers must have checked their own permission. Ids from other organizations are simply absent.
 */
export async function lookupProducts(ctx: TenantContext, ids: string[]) {
  const rows = await productRepo(ctx).findManyByIds([...new Set(ids)]);
  return new Map(rows.map((p) => [p.id, { id: p.id, sku: p.sku, name: p.name, active: p.active }]));
}

/**
 * Internal: resolve a typed or scanned product code (SKU or barcode) to a product id.
 * Tenant-scoped; no permission check (callers check their own).
 */
export async function resolveProductCode(ctx: TenantContext, code: string) {
  const trimmed = code.trim();
  if (!trimmed) return null;
  return productRepo(ctx).findByCode(trimmed);
}
