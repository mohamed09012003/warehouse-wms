// Floor-plan geometry. Millimetres, origin top-left, +x right, +y down.
// An item's (xMm, yMm) is its CENTER; rotation is clockwise degrees about the center.

export interface Box {
  xMm: number;
  yMm: number;
  widthMm: number;
  depthMm: number;
  rotationDeg: number;
}

export function normalizeDegrees(deg: number): number {
  return ((Math.round(deg) % 360) + 360) % 360;
}

/** Half extents of the axis-aligned bounding box of a rotated rectangle. */
export function rotatedHalfExtents(widthMm: number, depthMm: number, rotationDeg: number) {
  const r = (normalizeDegrees(rotationDeg) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  return { halfW: (widthMm * cos + depthMm * sin) / 2, halfH: (widthMm * sin + depthMm * cos) / 2 };
}

export function boundingBox(box: Box) {
  const { halfW, halfH } = rotatedHalfExtents(box.widthMm, box.depthMm, box.rotationDeg);
  return { minX: box.xMm - halfW, minY: box.yMm - halfH, maxX: box.xMm + halfW, maxY: box.yMm + halfH };
}

export function snapToGrid(value: number, gridMm: number): number {
  if (gridMm <= 0) return Math.round(value);
  return Math.round(value / gridMm) * gridMm;
}

/**
 * Snap an item so that the top-left corner of its (rotated) bounding box lies on the grid.
 * This keeps wall and rack edges aligned to grid lines at any rotation.
 */
export function snapCenter(box: Box, gridMm: number): { xMm: number; yMm: number } {
  const { halfW, halfH } = rotatedHalfExtents(box.widthMm, box.depthMm, box.rotationDeg);
  return {
    xMm: Math.round(snapToGrid(box.xMm - halfW, gridMm) + halfW),
    yMm: Math.round(snapToGrid(box.yMm - halfH, gridMm) + halfH),
  };
}

/** Keep the item's bounding box inside the warehouse canvas (as far as it fits). */
export function clampToCanvas(box: Box, canvasWidthMm: number, canvasLengthMm: number): { xMm: number; yMm: number } {
  const { halfW, halfH } = rotatedHalfExtents(box.widthMm, box.depthMm, box.rotationDeg);
  const clamp = (v: number, half: number, size: number) =>
    size <= half * 2 ? size / 2 : Math.min(Math.max(v, half), size - half);
  return {
    xMm: Math.round(clamp(box.xMm, halfW, canvasWidthMm)),
    yMm: Math.round(clamp(box.yMm, halfH, canvasLengthMm)),
  };
}

export function isInsideCanvas(box: Box, canvasWidthMm: number, canvasLengthMm: number): boolean {
  const b = boundingBox(box);
  const eps = 1; // tolerate rounding
  return b.minX >= -eps && b.minY >= -eps && b.maxX <= canvasWidthMm + eps && b.maxY <= canvasLengthMm + eps;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  const p = boundingBox(a);
  const q = boundingBox(b);
  return p.minX < q.maxX && p.maxX > q.minX && p.minY < q.maxY && p.maxY > q.minY;
}

/**
 * Find a spot near `box` where it does not overlap any of `others`, scanning down in steps of
 * the item's depth plus `gapMm`, then across. Falls back to the starting spot if nothing is free.
 */
export function findFreeSpot(box: Box, others: readonly Box[], canvasWidthMm: number, canvasLengthMm: number, gapMm = 1000) {
  const { halfW, halfH } = rotatedHalfExtents(box.widthMm, box.depthMm, box.rotationDeg);
  const stepY = halfH * 2 + gapMm;
  const stepX = halfW * 2 + gapMm;
  const start = clampToCanvas(box, canvasWidthMm, canvasLengthMm);
  for (let col = 0; col < 20; col++) {
    for (let row = 0; row < 50; row++) {
      const x = start.xMm + col * stepX;
      const y = start.yMm + row * stepY;
      const candidate = { ...box, xMm: x, yMm: y };
      if (!isInsideCanvas(candidate, canvasWidthMm, canvasLengthMm)) break;
      if (!others.some((o) => boxesOverlap(candidate, o))) return { xMm: Math.round(x), yMm: Math.round(y) };
    }
  }
  return start;
}
