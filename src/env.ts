import type { PrCoordinator } from './coordinator';

export interface Env {
  APP_ID: string;
  APP_PRIVATE_KEY: string;
  WEBHOOK_SECRET?: string;
  /** `"true"` lets the coordinators start runs. Anything else only logs what they would start. */
  DISPATCH_ENABLED?: string;
  PR_COORDINATOR: DurableObjectNamespace<PrCoordinator>;
}
