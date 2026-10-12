import { config } from "../config";
import { shortId } from "../domain/ids";
import { publish, TASK_QUEUE } from "../infrastructure/message-broker";
import { pool } from "../infrastructure/database";
import { recordEvent } from "../repositories/event-repository";
import { findMedianDurationMs, findRunningTasksWithoutBackup, RunningTask, updateTask } from "../repositories/task-repository";
import { FleetSnapshot } from "./fleet-state";
import { buildTaskMessage } from "./task-dispatcher";

const MIN_BACKUP_AGE_MS = 1000; // never call a task slow before it has run this long
const MEDIAN_SAMPLE_SIZE = 50; // the median covers this many recently finished tasks of the same type

/** A task is slow when it runs longer than backupFactor x the median, and at least MIN_BACKUP_AGE_MS. */
const isSlow = (elapsedMs: number, medianMs: number): boolean =>
  elapsedMs > Math.max(MIN_BACKUP_AGE_MS, config.backupFactor * medianMs);

/**
 * Backup copies for slow tasks. If a worker is idle and nothing waits in the queue, publish a
 * duplicate of a task that is much slower than usual. Whichever copy finishes first wins; the
 * other result is ignored.
 */
export async function publishBackupCopies(fleet: Pick<FleetSnapshot, "idleWorkers" | "tasksWaitingInQueue">): Promise<void> {
  if (fleet.idleWorkers <= 0 || fleet.tasksWaitingInQueue > 0) return;

  // At most one candidate per idle worker.
  const candidates = await findRunningTasksWithoutBackup(fleet.idleWorkers);
  const medianByType = new Map<string, number | null>();

  for (const task of candidates) {
    if (!medianByType.has(task.type)) {
      medianByType.set(task.type, await findMedianDurationMs(task.type, MEDIAN_SAMPLE_SIZE));
    }
    const median = medianByType.get(task.type);
    if (median != null && isSlow(task.elapsed_ms, median)) await sendBackupCopy(task);
  }
}

async function sendBackupCopy(task: RunningTask): Promise<void> {
  await publish(TASK_QUEUE, buildTaskMessage(task, task.attempts, true));
  await updateTask(pool, task.id, { backup_sent: true });
  await recordEvent(
    task.job_id,
    `backup copy of ${task.type} task ${shortId(task.id)} (running ${Math.round(task.elapsed_ms)} ms on ${task.worker_id})`,
  );
}
