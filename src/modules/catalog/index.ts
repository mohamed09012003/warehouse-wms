// Public API of the catalog module.
export { listProducts, getProduct, createProduct, updateProduct, upsertProduct, addBarcode, removeBarcode, lookupProducts, resolveProductCode } from "./service/products";
export type { ProductDto, ProductDetailDto } from "./service/products";
