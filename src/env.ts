import type { PrCoordinator } from './coordinator';
import type { Reconciler } from './reconciler';

export interface Env {
  APP_ID: string;
  /** The App's client ID. When set, it is the `iss` of the App JWT in place of `APP_ID`. */
  APP_CLIENT_ID?: string;
  APP_PRIVATE_KEY: string;
  WEBHOOK_SECRET?: string;
  /** The webhook secret before the last rotation, also accepted while it is set. */
  WEBHOOK_SECRET_PREVIOUS?: string;
  /** `"true"` lets the coordinators start runs. Anything else only logs what they would start. */
  DISPATCH_ENABLED?: string;
  /** Comma-separated ids of the repositories whose deliveries reach a coordinator. Any other is logged and dropped. */
  WEBHOOK_REPOS?: string;
  PR_COORDINATOR: DurableObjectNamespace<PrCoordinator>;
  RECONCILER: DurableObjectNamespace<Reconciler>;
}

/** Returns the repository ids in `WEBHOOK_REPOS`. An unset or empty list allows none. */
export function allowedRepos(env: Env): Set<number> {
  const ids = (env.WEBHOOK_REPOS ?? '').split(',').map((id) => id.trim()).filter((id) => /^[1-9][0-9]*$/.test(id));
  return new Set(ids.map(Number));
}
