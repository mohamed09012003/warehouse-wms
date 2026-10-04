"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiRequest, errorMessage, orgApi } from "@/ui/shared/apiClient";

/**
 * Runs an integrations admin call (path relative to /integrations), shows the server's error message and
 * refreshes the page data. No business rules live here; secrets are only ever sent, never received.
 */
export function useIntegrationAction(orgSlug: string) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run<T = unknown>(path: string, options: { method?: string; body?: unknown; refresh?: boolean } = {}): Promise<T | null> {
    setPending(true);
    setError(null);
    try {
      const result = await apiRequest<T>(`${orgApi(orgSlug)}/integrations${path ? `/${path}` : ""}`, {
        method: options.method ?? "POST",
        body: options.body,
      });
      if (options.refresh !== false) router.refresh();
      return result;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setPending(false);
    }
  }

  return { run, pending, error, setError };
}
