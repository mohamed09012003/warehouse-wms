import { describe, expect, it } from "vitest";
import { canTransition } from "@/modules/orders";
import { allPickedIsPacked, orderFullyPacked, remainingToPack, startBlocker, totals } from "../domain/progress";

const line = (requestedQty: number, pickedQty: number, packedQty: number) => ({ requestedQty, pickedQty, packedQty });

describe("picked-vs-packed rules", () => {
  it("totals and the per-line remaining quantity", () => {
    expect(totals([line(10, 7, 3), line(4, 4, 4)])).toEqual({ requested: 14, picked: 11, packed: 7, remaining: 4 });
    expect(remainingToPack(line(10, 7, 3))).toBe(4);
  });

  it("a session may complete only when everything picked is packed (and something was picked)", () => {
    expect(allPickedIsPacked([line(10, 10, 10)])).toBe(true);
    expect(allPickedIsPacked([line(10, 10, 8)])).toBe(false);
    expect(allPickedIsPacked([line(10, 0, 0)])).toBe(false);
    expect(allPickedIsPacked([line(10, 7, 7), line(5, 0, 0)])).toBe(true); // second line not picked at all
  });

  it("the order is fully packed only when every REQUESTED unit is packed", () => {
    expect(orderFullyPacked([line(10, 10, 10), line(4, 4, 4)])).toBe(true);
    expect(orderFullyPacked([line(10, 7, 7)])).toBe(false); // partially picked: never fully packed
    expect(orderFullyPacked([line(10, 10, 9)])).toBe(false);
    expect(orderFullyPacked([])).toBe(false);
  });

  it("start blockers: cancelled, packed, nothing picked, nothing left to pack, wrong status", () => {
    expect(startBlocker("PICKED", [line(10, 10, 0)])).toBeNull();
    expect(startBlocker("PICKING", [line(10, 6, 0)])).toBeNull();
    expect(startBlocker("CANCELLED", [line(10, 10, 0)])).toMatch(/cancelled/);
    expect(startBlocker("PACKED", [line(10, 10, 10)])).toMatch(/already packed/);
    expect(startBlocker("PACKING", [line(10, 10, 0)])).toMatch(/in progress/);
    expect(startBlocker("PICKING", [line(10, 0, 0)])).toMatch(/Nothing has been picked/);
    expect(startBlocker("PICKING", [line(10, 6, 6)])).toMatch(/already been packed/);
    expect(startBlocker("ALLOCATED", [line(10, 0, 0)])).toMatch(/picked quantity/);
  });
});

describe("order status integration", () => {
  it("PICKED -> PACKING -> PACKED, and PACKING back to PICKED; PACKED and CANCELLED are final", () => {
    expect(canTransition("PICKED", "PACKING")).toBe(true);
    expect(canTransition("PACKING", "PACKED")).toBe(true);
    expect(canTransition("PACKING", "PICKED")).toBe(true);
    expect(canTransition("PICKING", "PACKING")).toBe(true); // last unit picked during an open session
    expect(canTransition("PICKED", "PACKED")).toBe(false); // must go through a packing session
    expect(canTransition("ALLOCATED", "PACKING")).toBe(false);
    expect(canTransition("PACKING", "CANCELLED")).toBe(false);
    expect(canTransition("PACKED", "PICKED")).toBe(false);
    expect(canTransition("CANCELLED", "PACKING")).toBe(false);
  });
});
