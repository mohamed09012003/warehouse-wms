import type { HttpClient } from "../core/types";
import { getHttpClient } from "../http/safeHttpClient";

/** Everything the worker needs from the outside world, injectable so tests control time and the network. */
export interface WorkerDeps {
  now: () => Date;
  http: HttpClient;
}

export function defaultWorkerDeps(): WorkerDeps {
  return { now: () => new Date(), http: getHttpClient() };
}
