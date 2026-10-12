import { PoolClient } from "pg";
import { config } from "../config";
import { JobRow, WaitingItem } from "../domain/rows";
import { findWaitingItems, markItemsUsed } from "../repositories/item-repository";
import { countUnfinishedTasks, insertCombineTask } from "../repositories/task-repository";
import { FleetSnapshot } from "./fleet-state";

/**
 * Decide whether to create COMBINE tasks for one job, based on its waiting items (state READY).
 * Call inside a transaction that holds the job row lock. Returns how many tasks were created.
 *
 * Rules, checked in order:
 *   1. At least MAX items are waiting: take MAX of them now (repeat while enough are left).
 *      A full task is the most efficient use of a worker.
 *   2. All files are generated and nothing else is queued or running: combine everything left, as the FINAL task.
 *   3. A worker is idle and nothing waits in the queue: combine what is there (>= 2) rather than waste the worker.
 *   4. One item left, all done: a final task that only divides (safety net so a job never gets stuck).
 * Otherwise do nothing and wait for the next result.
 */
export async function planCombineTasks(
  client: PoolClient,
  job: Pick<JobRow, "id" | "f" | "files_generated">,
  fleet: Pick<FleetSnapshot, "idleWorkers" | "tasksWaitingInQueue">,
): Promise<number> {
  const maxInputs = config.maxTaskInputs;
  const waitingItems = await findWaitingItems(client, job.id);
  let unfinishedTasks = await countUnfinishedTasks(client, job.id);
  let createdTasks = 0;

  const allFilesGenerated = job.files_generated === job.f;
  const workerIsIdle = fleet.idleWorkers > 0 && fleet.tasksWaitingInQueue === 0;

  /** Create one COMBINE task from the given items and mark them USED so no other task can take them. */
  async function createCombineTask(items: WaitingItem[], isFinal: boolean): Promise<void> {
    const inputs = items.map((item) => ({ itemId: item.id, path: item.path, count: item.count }));
    const taskId = await insertCombineTask(client, job.id, inputs, isFinal);
    await markItemsUsed(client, items.map((item) => item.id), taskId);
    unfinishedTasks += 1;
    createdTasks += 1;
  }

  // Rule 1. It is the final task only if it takes everything that exists.
  while (waitingItems.length >= maxInputs) {
    const items = waitingItems.splice(0, maxInputs);
    const takesEverything = waitingItems.length === 0 && unfinishedTasks === 0 && allFilesGenerated;
    await createCombineTask(items, takesEverything);
  }

  // Fewer than maxInputs items are left. At most one more task is created.
  const nothingElseWillArrive = unfinishedTasks === 0 && allFilesGenerated;
  if (waitingItems.length >= 2 && nothingElseWillArrive) {
    await createCombineTask(waitingItems, true); // Rule 2
  } else if (waitingItems.length >= 2 && workerIsIdle) {
    await createCombineTask(waitingItems, false); // Rule 3
  } else if (waitingItems.length === 1 && nothingElseWillArrive) {
    await createCombineTask(waitingItems, true); // Rule 4
  }
  return createdTasks;
}
