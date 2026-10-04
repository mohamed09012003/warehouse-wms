import { ingestWebhook } from "@/integrations";
import { toErrorResponse } from "@/lib/errors";

// Public inbound webhook. NOT session-authenticated: the HMAC signature (X-WMS-Signature) is the
// authentication, and the unguessable publicId in the path is the only way to select an integration.
// The request only validates and stores the event; the worker processes it.
export async function POST(request: Request, route: { params: Promise<{ publicId: string }> }): Promise<Response> {
  try {
    const { publicId } = await route.params;
    const result = await ingestWebhook(publicId, request);
    return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
