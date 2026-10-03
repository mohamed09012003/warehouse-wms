import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuthorizationError,
  ConflictError,
  DatabaseError,
  NotFoundError,
  ValidationError,
  normalizeError,
  parseInput,
  toErrorResponse,
} from "../errors";

describe("errors", () => {
  it("parseInput returns data or throws ValidationError with issues", () => {
    const schema = z.object({ n: z.number() });
    expect(parseInput(schema, { n: 1 })).toEqual({ n: 1 });
    expect(() => parseInput(schema, { n: "x" })).toThrow(ValidationError);
  });

  it("maps Prisma error codes without leaking details", () => {
    expect(normalizeError({ code: "P2002", message: "secret sql" })).toBeInstanceOf(ConflictError);
    expect(normalizeError({ code: "P2025" })).toBeInstanceOf(NotFoundError);
    expect(normalizeError({ code: "P2021" })).toBeInstanceOf(DatabaseError);
    expect(normalizeError(new Error("boom")).status).toBe(500);
  });

  it("builds JSON responses with the right status", async () => {
    const res = toErrorResponse(new AuthorizationError());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });
});
