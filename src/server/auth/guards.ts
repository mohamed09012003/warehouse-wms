// Page-level translation of auth errors into navigation (login redirect / 404).
import "server-only";
import { notFound, redirect } from "next/navigation";
import { AuthenticationError, AuthorizationError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenancy";
import { requireTenantContext } from "./session";

/** For pages and layouts under /[orgSlug]. Not signed in -> /login. Not a member -> 404. */
export async function tenantContextOrRedirect(orgSlug: string): Promise<TenantContext> {
  try {
    return await requireTenantContext(orgSlug);
  } catch (error) {
    if (error instanceof AuthenticationError) redirect("/login");
    if (error instanceof AuthorizationError) notFound();
    throw error;
  }
}
