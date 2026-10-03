// Public API of the catalog module.
export { listProducts, getProduct, createProduct, updateProduct, addBarcode, removeBarcode, lookupProducts } from "./service/products";
export type { ProductDto, ProductDetailDto } from "./service/products";
