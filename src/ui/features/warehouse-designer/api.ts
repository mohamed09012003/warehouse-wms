// Browser-side client for the internal warehouse API. Contains no business rules.
import type { LayoutDto, PalletTypeDto, RackElevationDto } from "@/modules/warehouse/types";
import { ApiError, apiRequest, orgApi } from "@/ui/shared/apiClient";

export { ApiError };

export const warehouseApi = {
  getLayout: (org: string, warehouseId: string) => apiRequest<LayoutDto>(`${orgApi(org)}/warehouses/${warehouseId}/layout`),
  saveLayout: (org: string, warehouseId: string, payload: unknown) =>
    apiRequest<LayoutDto>(`${orgApi(org)}/warehouses/${warehouseId}/layout`, { method: "PUT", body: payload }),
  getElevation: (org: string, warehouseId: string, rackId: string) =>
    apiRequest<RackElevationDto>(`${orgApi(org)}/warehouses/${warehouseId}/racks/${rackId}/elevation`),
  createWarehouse: (org: string, payload: unknown) => apiRequest<{ id: string }>(`${orgApi(org)}/warehouses`, { body: payload }),
  createPalletType: (org: string, payload: unknown) => apiRequest<PalletTypeDto>(`${orgApi(org)}/pallet-types`, { body: payload }),
};
