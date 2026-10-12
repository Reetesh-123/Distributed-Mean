import { PoolClient } from "pg";
import { config } from "../config";
import { shortId } from "../domain/ids";
import { TaskResultMessage } from "../domain/messages";
import { JobRow, TaskRow } from "../domain/rows";
import { JobStatus, ResultStatus, TaskStatus, TaskType } from "../domain/statuses";
import { withTransaction } from "../infrastructure/database";
import { recordEvent } from "../repositories/event-repository";
import { insertItem } from "../repositories/item-repository";
import { addGeneratedFiles, lockJob, updateJob } from "../repositories/job-repository";
import { lockTask, updateTask } from "../repositories/task-repository";
import { planCombineTasks } from "./combine-planner";
import { getFleetSnapshot } from "./fleet-state";

/**
 * Apply one worker result in a single database transaction. The caller acks the queue message
 * only after this resolves, so a crash leads to a redelivery. Handling is idempotent: a task that
 * is already DONE is ignored, and output paths are unique (ON CONFLICT DO NOTHING).
 */
export async function applyWorkerResult(msg: TaskResultMessage): Promise<void> {
  await withTransaction(async (client) => {
    // Lock the task, then the job, so concurrent results for the same job are applied one by one.
    const task = await lockTask(client, msg.taskId);
    if (!task) return;

    if (task.status === TaskStatus.Done) {
      await recordEvent(task.job_id, `duplicate result for task ${shortId(task.id)} ignored`, client);
      return;
    }

    const job = (await lockJob(client, task.job_id))!; // the foreign key guarantees the job exists
    if (isJobOver(job) || msg.status === ResultStatus.Skipped) {
      await updateTask(client, task.id, { status: TaskStatus.Failed, error: "job not active" }); // discard the work
    } else if (msg.status === ResultStatus.Failed) {
      await retryOrFailJob(client, task, job, msg.error);
    } else {
      await applySuccessfulResult(client, task, job, msg);
    }
  });
}

const isJobOver = (job: JobRow): boolean => job.status === JobStatus.Cancelled || job.status === JobStatus.Failed;

async function applySuccessfulResult(client: PoolClient, task: TaskRow, job: JobRow, msg: TaskResultMessage): Promise<void> {
  await updateTask(client, task.id, { status: TaskStatus.Done, worker_id: msg.workerId, duration_ms: msg.durationMs });
  if (job.status === JobStatus.Pending) await updateJob(client, job.id, { status: JobStatus.Running }); // first finished task

  if (task.is_final) {
    await finishJob(client, job, msg);
  } else {
    const filesGenerated = await storeOutputs(client, task, job, msg);
    // The new items may allow new combine tasks.
    await planCombineTasks(client, { ...job, files_generated: filesGenerated }, await getFleetSnapshot(client));
  }
  await recordEvent(job.id, `${msg.workerId} finished ${task.type} task ${shortId(task.id)} (${msg.durationMs} ms)`, client);
}

/**
 * Save the task's outputs as waiting items. A GENERATE task produces raw files (count 1 each); a
 * COMBINE task produces one partial result. Returns how many files the job has generated so far.
 */
async function storeOutputs(client: PoolClient, task: TaskRow, job: JobRow, msg: TaskResultMessage): Promise<number> {
  let newItems = 0;
  for (const output of msg.outputs) {
    if (await insertItem(client, job.id, task.id, output)) newItems += 1;
  }
  if (task.type !== TaskType.Generate) return job.files_generated;
  return addGeneratedFiles(client, job.id, newItems);
}

/** The FINAL task reports how many files the result covers. It must equal F, otherwise something was missed or doubled. */
async function finishJob(client: PoolClient, job: JobRow, msg: TaskResultMessage): Promise<void> {
  const output = msg.outputs[0];
  if (output && output.count === job.f) {
    await updateJob(client, job.id, { status: JobStatus.Completed, result_path: output.path });
    await recordEvent(job.id, `job completed (F=${job.f}, C=${job.c})`, client);
  } else {
    const error = `count mismatch: got ${output?.count}, expected ${job.f}`;
    await updateJob(client, job.id, { status: JobStatus.Failed, error });
    await recordEvent(job.id, `job failed: ${error}`, client);
  }
}

/** Retry a failed task until it has used up its attempts; then fail the whole job. */
async function retryOrFailJob(client: PoolClient, task: TaskRow, job: JobRow, error: string | null): Promise<void> {
  if (task.attempts >= config.maxTaskAttempts) {
    await updateTask(client, task.id, { status: TaskStatus.Failed, error });
    await updateJob(client, job.id, { status: JobStatus.Failed, error: `task failed ${task.attempts} times: ${error}` });
    await recordEvent(job.id, `job failed: task ${shortId(task.id)} failed ${task.attempts} times (${error})`, client);
  } else {
    await updateTask(client, task.id, { status: TaskStatus.Pending, error }); // the dispatcher publishes it again
    await recordEvent(job.id, `retry task ${shortId(task.id)} (attempt ${task.attempts}): ${error}`, client);
  }
}
