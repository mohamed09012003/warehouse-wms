// Public API of the identity module.
export { authenticateWithPassword } from "./service/authenticate";
export type { AuthenticatedUser } from "./service/authenticate";
export { createUser } from "./service/createUser";
export { hashPassword, verifyPassword } from "./domain/password";
export { loginSchema, createUserSchema } from "./schemas";
