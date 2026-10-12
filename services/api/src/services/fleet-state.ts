import { pool, Queryable } from "../infrastructure/database";
import { countQueuedTasks } from "../repositories/task-repository";
import { countLiveWorkers, getDesiredWorkers } from "../repositories/worker-repository";

export interface FleetSnapshot {
  desiredWorkers: number; // the count requested through PUT /workers
  idleWorkers: number;
  busyWorkers: number;
  tasksWaitingInQueue: number; // in the queue and not picked up by any worker yet
}

/** Point-in-time view of the workers and the task queue. Input for publishing and planning decisions. */
export async function getFleetSnapshot(db: Queryable = pool): Promise<FleetSnapshot> {
  const { idle, busy } = await countLiveWorkers(db);
  const queuedTasks = await countQueuedTasks(db);
  return {
    desiredWorkers: await getDesiredWorkers(db),
    idleWorkers: idle,
    busyWorkers: busy,
    // "Queued" includes tasks being worked on, and each busy worker holds exactly one task.
    tasksWaitingInQueue: Math.max(0, queuedTasks - busy),
  };
}
