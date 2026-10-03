// Request-level helpers used by pages, layouts, server actions and route handlers.
// These wrap Auth.js and the tenancy module; they contain no business rules.
import "server-only";
import { cache } from "react";
import { AuthenticationError } from "@/lib/errors";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy";
import { auth } from "./auth";

/** The authenticated user's id, or null. Identity only: says nothing about organizations. */
export const getSessionUserId = cache(async (): Promise<string | null> => {
  const session = await auth();
  return session?.user?.id ?? null;
});

export async function requireUserId(): Promise<string> {
  const userId = await getSessionUserId();
  if (!userId) throw new AuthenticationError();
  return userId;
}

/**
 * Verified tenant context for the organization named in the URL.
 * Throws AuthenticationError (no session) or AuthorizationError (not an active member).
 * The slug is untrusted input; membership is re-checked in the database on every request.
 */
export const requireTenantContext = cache(async (orgSlug: string): Promise<TenantContext> => {
  const userId = await requireUserId();
  return resolveTenantContext(userId, orgSlug);
});
