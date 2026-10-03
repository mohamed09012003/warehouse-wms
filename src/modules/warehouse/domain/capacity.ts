// Capacity derivation. Pure functions; nothing here assumes a particular pallet or bay size.

export interface PalletDims {
  widthMm: number;
  lengthMm: number;
  heightMm?: number | null;
  maxLoadG?: number | null;
}

/**
 * How many pallets of the given type physically fit in one bay of one level,
 * trying both orientations. `gapMm` is the clearance required between and around pallets
 * (a policy value supplied by the caller, not a property of the pallet).
 *
 * "across" runs along the bay width (rack length direction), "deep" along the rack depth.
 */
export function positionsFit(bayWidthMm: number, rackDepthMm: number, pallet: PalletDims, gapMm = 0): number {
  const fit = (span: number, size: number) => (size <= 0 ? 0 : Math.max(0, Math.floor((span + gapMm) / (size + gapMm))));
  const a = fit(bayWidthMm, pallet.widthMm) * fit(rackDepthMm, pallet.lengthMm);
  const b = fit(bayWidthMm, pallet.lengthMm) * fit(rackDepthMm, pallet.widthMm);
  return Math.max(a, b);
}
