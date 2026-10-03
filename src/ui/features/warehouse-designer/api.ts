// Browser-side client for the internal warehouse API. Contains no business rules.
import type { LayoutDto, PalletTypeDto, RackElevationDto } from "@/modules/warehouse/types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(body?.error?.message ?? `Request failed (${res.status})`, res.status, body?.error?.code ?? "ERROR");
  }
  return body as T;
}

const base = (orgSlug: string) => `/api/internal/${encodeURIComponent(orgSlug)}`;

export const warehouseApi = {
  getLayout: (org: string, warehouseId: string) => request<LayoutDto>(`${base(org)}/warehouses/${warehouseId}/layout`),
  saveLayout: (org: string, warehouseId: string, payload: unknown) =>
    request<LayoutDto>(`${base(org)}/warehouses/${warehouseId}/layout`, { method: "PUT", body: JSON.stringify(payload) }),
  getElevation: (org: string, warehouseId: string, rackId: string) =>
    request<RackElevationDto>(`${base(org)}/warehouses/${warehouseId}/racks/${rackId}/elevation`),
  createWarehouse: (org: string, payload: unknown) =>
    request<{ id: string }>(`${base(org)}/warehouses`, { method: "POST", body: JSON.stringify(payload) }),
  createPalletType: (org: string, payload: unknown) =>
    request<PalletTypeDto>(`${base(org)}/pallet-types`, { method: "POST", body: JSON.stringify(payload) }),
};
