import type { PrCoordinator } from './coordinator';

export interface Env {
  APP_ID: string;
  APP_PRIVATE_KEY: string;
  WEBHOOK_SECRET?: string;
  /** `"true"` lets the coordinators start runs. Anything else only logs what they would start. */
  DISPATCH_ENABLED?: string;
  /** Comma-separated ids of the repositories whose deliveries reach a coordinator. Any other is logged and dropped. */
  WEBHOOK_REPOS?: string;
  PR_COORDINATOR: DurableObjectNamespace<PrCoordinator>;
}
