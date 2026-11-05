import type { PrCoordinator } from './coordinator';

export interface Env {
  APP_ID: string;
  APP_PRIVATE_KEY: string;
  WEBHOOK_SECRET?: string;
  PR_COORDINATOR: DurableObjectNamespace<PrCoordinator>;
}
