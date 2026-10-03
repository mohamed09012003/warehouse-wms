import { ConflictError, NotFoundError, parseInput } from "@/lib/errors";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { productRepo } from "../repo/productRepo";
import { addBarcodeSchema, createProductSchema, listProductsSchema, updateProductSchema } from "../schemas";

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
