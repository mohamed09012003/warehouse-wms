import { describe, expect, it } from "vitest";
import { ALLOCATABLE_STATUSES, ORDER_STATUSES, allocationState, canTransition, deriveFulfilmentStatus } from "@/modules/orders";
import { planAllocation } from "../domain/allocation";

const at = (positionCode: string, available: number) => ({ positionId: `id-${positionCode}`, positionCode, warehouseId: "w", available });

describe("allocation planner", () => {
  it("takes from the first positions first and never more than is available there", () => {
    const plan = planAllocation(8, [at("R01-L01-B01-P01", 5), at("R01-L01-B02-P01", 7), at("R01-L01-B03-P01", 9)]);
    expect(plan.map((p) => [p.positionCode, p.quantity])).toEqual([
      ["R01-L01-B01-P01", 5],
      ["R01-L01-B02-P01", 3],
    ]);
  });

  it("allocates less than needed when stock is short (partial) and nothing when there is none", () => {
    expect(planAllocation(20, [at("A", 5), at("B", 7)]).reduce((n, p) => n + p.quantity, 0)).toBe(12);
    expect(planAllocation(5, [])).toEqual([]);
    expect(planAllocation(5, [at("A", 0)])).toEqual([]);
  });

  it("is deterministic: same input, same plan; exact fit stops early", () => {
    const input = [at("A", 3), at("B", 3), at("C", 3)];
    expect(planAllocation(6, input)).toEqual(planAllocation(6, input));
    expect(planAllocation(6, input).map((p) => p.positionCode)).toEqual(["A", "B"]);
  });
});

describe("order lifecycle helpers", () => {
  const line = (requestedQty: number, allocatedQty: number, pickedQty: number) => ({ requestedQty, allocatedQty, pickedQty });

  it("allocation state is FULL only when every line is fully allocated", () => {
    expect(allocationState([line(5, 0, 0)])).toBe("NONE");
    expect(allocationState([line(5, 5, 0), line(3, 1, 0)])).toBe("PARTIAL");
    expect(allocationState([line(5, 5, 0), line(3, 3, 0)])).toBe("FULL");
  });

  it("derives the fulfilment status from line quantities", () => {
    expect(deriveFulfilmentStatus([line(5, 0, 0)])).toBe("READY");
    expect(deriveFulfilmentStatus([line(5, 2, 0)])).toBe("PARTIALLY_ALLOCATED");
    expect(deriveFulfilmentStatus([line(5, 5, 0)])).toBe("ALLOCATED");
    expect(deriveFulfilmentStatus([line(5, 5, 1)])).toBe("PICKING");
    expect(deriveFulfilmentStatus([line(5, 2, 2)])).toBe("PICKING"); // partial allocation, all allocated picked: not PICKED
    expect(deriveFulfilmentStatus([line(5, 5, 5), line(2, 2, 2)])).toBe("PICKED");
  });

  it("only legal transitions are allowed; PICKED and CANCELLED are final", () => {
    expect(canTransition("DRAFT", "READY")).toBe(true);
    expect(canTransition("READY", "ALLOCATED")).toBe(true);
    expect(canTransition("DRAFT", "ALLOCATED")).toBe(false);
    expect(canTransition("READY", "PICKING")).toBe(false);
    expect(canTransition("ALLOCATED", "PICKING")).toBe(true);
    for (const to of ORDER_STATUSES) {
      expect(canTransition("PICKED", to)).toBe(false);
      expect(canTransition("CANCELLED", to)).toBe(false);
    }
    expect(ALLOCATABLE_STATUSES).toEqual(["READY", "PARTIALLY_ALLOCATED", "PICKING"]);
  });
});
