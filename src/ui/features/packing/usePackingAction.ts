"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PackingResultDto } from "@/modules/packing";
import { apiRequest, errorMessage, orgApi } from "@/ui/shared/apiClient";

/**
 * Runs a packing mutation: one Idempotency-Key per click (so a double click or retry is applied
 * once), shows the server's error message, and refreshes the page data. All rules live on the server.
 */
export function usePackingAction(orgSlug: string) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(path: string, options: { method?: string; body?: unknown } = {}): Promise<PackingResultDto | null> {
    setPending(true);
    setError(null);
    try {
      const result = await apiRequest<PackingResultDto>(`${orgApi(orgSlug)}/packing/${path}`, {
        method: options.method ?? "POST",
        body: options.body ?? {},
        idempotencyKey: crypto.randomUUID(),
      });
      router.refresh();
      return result;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setPending(false);
    }
  }

  return { run, pending, error, clearError: () => setError(null) };
}
