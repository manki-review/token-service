import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

const HOUR = 60 * 60_000;

/** The cap on stored events per installation and hour when `INSTALLATION_EVENTS_PER_HOUR` is unset or invalid. */
export const DEFAULT_EVENTS_PER_HOUR = 500;

/** Returns `INSTALLATION_EVENTS_PER_HOUR`, or the default when it is not a positive whole number. */
export function eventsPerHour(env: Env): number {
  const value = (env.INSTALLATION_EVENTS_PER_HOUR ?? '').trim();
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : DEFAULT_EVENTS_PER_HOUR;
}

interface Counter {
  hour: number;
  count: number;
}

/**
 * Counts the deliveries of one installation that a coordinator stored, per clock hour. It is named by the installation
 * id. Only a stored delivery writes the count, so a flood above the cap or of refused replays costs reads alone.
 */
export class InstallationLimiter extends DurableObject<Env> {
  /** The stored counter, read once per hour per instance. Eviction drops it, and the next call reads it again. */
  private counter: Counter | null = null;

  /** Whether fewer than `limit` deliveries were counted this hour. Writes nothing. */
  hasRoom(limit: number): boolean {
    return this.current().count < limit;
  }

  /** Counts one delivery a coordinator stored. */
  add(): void {
    const { hour, count } = this.current();
    this.save({ hour, count: count + 1 });
  }

  private current(): Counter {
    const hour = Math.floor(Date.now() / HOUR);
    if (this.counter?.hour !== hour) {
      const stored = this.ctx.storage.kv.get<Counter>('counter');
      this.counter = stored?.hour === hour ? stored : { hour, count: 0 };
    }
    return this.counter;
  }

  private save(counter: Counter): void {
    this.counter = counter;
    this.ctx.storage.kv.put('counter', counter);
  }
}
