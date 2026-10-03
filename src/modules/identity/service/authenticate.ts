import { getDummyHash, verifyPassword } from "../domain/password";
import { loginSchema } from "../schemas";
import { findUserByEmail } from "../repo/userRepo";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Verify credentials. Returns null for ANY failure (unknown email, wrong password,
 * disabled user) so callers cannot distinguish them. Invalid input shape also yields null.
 * Authentication only proves identity; authorization to an organization is resolved
 * separately by the tenancy module.
 */
export async function authenticateWithPassword(raw: unknown): Promise<AuthenticatedUser | null> {
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { email, password } = parsed.data;

  const user = await findUserByEmail(email);
  // Always run a hash comparison to keep timing similar for unknown emails.
  const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !ok || user.disabledAt) return null;
  return { id: user.id, email: user.email, name: user.name };
}

