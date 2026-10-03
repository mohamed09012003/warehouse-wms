// Location codes are GENERATED from the structured hierarchy; they are never the source of truth.
//   {rack}-L{level}-B{bay}-P{position}      e.g. R01-L01-B03-P02
// levelIndex is stored 0-based (0 = ground) and displayed 1-based (L01 = ground level).
// bayIndex and positionIndex are stored and displayed 1-based.

export interface LocationParts {
  rackCode: string;
  /** 0-based, as stored. */
  levelIndex: number;
  /** 1-based. */
  bayIndex: number;
  /** 1-based. */
  positionIndex: number;
}

/** Zero-pad to at least `width` digits; wider numbers are never truncated. */
export function padNumber(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** The number shown to people for a stored levelIndex. */
export function levelDisplayNumber(levelIndex: number): number {
  return levelIndex + 1;
}

export function formatLocationCode(parts: LocationParts, padWidth = 2): string {
  const { rackCode, levelIndex, bayIndex, positionIndex } = parts;
  return [
    rackCode,
    `L${padNumber(levelDisplayNumber(levelIndex), padWidth)}`,
    `B${padNumber(bayIndex, padWidth)}`,
    `P${padNumber(positionIndex, padWidth)}`,
  ].join("-");
}

const CODE_PATTERN = /^([A-Z0-9]{1,12})-L(\d+)-B(\d+)-P(\d+)$/;

/** Inverse of formatLocationCode. Returns null for anything that is not a valid code. */
export function parseLocationCode(code: string): LocationParts | null {
  const m = CODE_PATTERN.exec(code.trim().toUpperCase());
  if (!m) return null;
  const level = Number(m[2]);
  const bay = Number(m[3]);
  const position = Number(m[4]);
  if (level < 1 || bay < 1 || position < 1) return null;
  return { rackCode: m[1], levelIndex: level - 1, bayIndex: bay, positionIndex: position };
}
