export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slugs that would collide with top-level app routes. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["api", "login", "logout", "_next", "static", "admin"]);

export function isValidSlug(slug: string): boolean {
  return slug.length >= 2 && slug.length <= 48 && SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug);
}
