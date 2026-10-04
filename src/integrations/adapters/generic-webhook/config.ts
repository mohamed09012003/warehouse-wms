import { z } from "zod";
import { OUTBOX_EVENT_TYPES } from "@/modules/outbox";

export const GENERIC_WEBHOOK_PROVIDER = "generic-webhook";
/** HMAC secret the external system uses to sign what it sends to us. */
export const INBOUND_SECRET = "inbound_signing_secret";
/** HMAC secret we use to sign what we send to the external system. */
export const OUTBOUND_SECRET = "outbound_signing_secret";

/**
 * Why a target URL is unacceptable, or null if it is fine. The URL may carry no credentials, query string
 * or fragment (tokens belong in the secrets vault, never in stored configuration). https only in production.
 */
export function targetUrlProblem(value: string, production = process.env.NODE_ENV === "production"): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Target URL is not a valid URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Target URL must use https";
  if (production && url.protocol !== "https:") return "Target URL must use https";
  if (url.username || url.password) return "Target URL must not contain credentials";
  if (url.search || url.hash) return "Target URL must not contain a query string or fragment";
  if (!url.hostname) return "Target URL needs a host name";
  return null;
}

export const genericWebhookConfigSchema = z
  .object({
    /** Where outbound events are POSTed. */
    targetUrl: z
      .string()
      .trim()
      .max(500)
      .superRefine((value, ctx) => {
        const problem = targetUrlProblem(value);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      })
      .optional(),
    /** Outbox event types delivered to the target. */
    subscribedEvents: z
      .array(z.enum(OUTBOX_EVENT_TYPES))
      .max(OUTBOX_EVENT_TYPES.length)
      .default([])
      .transform((events) => [...new Set(events)]),
    /** Per-integration retry limit (bounded 1-12; default 8). */
    maxAttempts: z.number().int().min(1).max(12).optional(),
  })
  .strict();
export type GenericWebhookConfig = z.infer<typeof genericWebhookConfigSchema>;
