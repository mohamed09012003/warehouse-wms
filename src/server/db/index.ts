// Public surface of the database layer for services: transactions and types only.
// The raw `prisma` client is deliberately NOT exported here.
export { withTransaction } from "./transaction";
export type { Tx, DbClient } from "./transaction";
