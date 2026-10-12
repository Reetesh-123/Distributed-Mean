import { recordEvent } from "../repositories/event-repository";
import { markStaleWorkersDead } from "../repositories/worker-repository";

/**
 * Mark workers whose heartbeat is too old as DEAD and log each one once.
 * The task a dead worker held is redelivered by the message broker.
 */
export async function markDeadWorkers(): Promise<void> {
  const deadWorkerIds = await markStaleWorkersDead();
  for (const workerId of deadWorkerIds) {
    await recordEvent(null, `worker ${workerId} is dead (no heartbeat)`);
  }
}
