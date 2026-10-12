import { TaskMessage } from "../domain/messages";
import { TaskWithJobSize } from "../domain/rows";
import { TaskStatus } from "../domain/statuses";
import { withTransaction } from "../infrastructure/database";
import { publish, TASK_QUEUE } from "../infrastructure/message-broker";
import { lockPendingTasksFairly, updateTask } from "../repositories/task-repository";
import { getFleetSnapshot } from "./fleet-state";

// About two tasks per worker wait in the queue: enough to keep workers busy, shallow enough to stay fair.
const QUEUE_DEPTH_PER_WORKER = 2;
const MIN_QUEUE_DEPTH = 2;

/** Turn a task row (joined with its job's `c`) into the message a worker receives. */
export function buildTaskMessage(task: TaskWithJobSize, attempt: number, isBackup = false): TaskMessage {
  return {
    taskId: task.id,
    jobId: task.job_id,
    type: task.type,
    c: task.c,
    attempt,
    isFinal: task.is_final,
    isBackup,
    fileIndexes: task.payload.fileIndexes ?? [],
    inputs: task.payload.inputs ?? [],
  };
}

// The last publish run in this process. A new run starts only after it, so two overlapping
// triggers cannot both publish into the same free queue slots.
let lastPublishRun: Promise<unknown> = Promise.resolve();

/**
 * Move PENDING tasks into the queue, round-robin across jobs, keeping the queue shallow.
 * Returns how many tasks were published.
 */
export function publishPendingTasks(): Promise<number> {
  const run = lastPublishRun.then(publishIntoFreeSlots);
  lastPublishRun = run.catch(() => undefined); // a failed run must not block the next one
  return run;
}

async function publishIntoFreeSlots(): Promise<number> {
  return withTransaction(async (client) => {
    const fleet = await getFleetSnapshot(client);
    const targetQueueDepth = Math.max(MIN_QUEUE_DEPTH, QUEUE_DEPTH_PER_WORKER * fleet.desiredWorkers);
    const freeSlots = targetQueueDepth - fleet.tasksWaitingInQueue;
    if (freeSlots <= 0) return 0;

    const tasks = await lockPendingTasksFairly(client, freeSlots);
    for (const task of tasks) {
      const attempt = task.attempts + 1;
      // Publish first (and wait for the broker confirm), then mark QUEUED. A crash in between
      // only republishes the task, which is harmless because results are applied idempotently.
      await publish(TASK_QUEUE, buildTaskMessage(task, attempt));
      await updateTask(client, task.id, { status: TaskStatus.Queued, attempts: attempt });
    }
    return tasks.length;
  });
}
