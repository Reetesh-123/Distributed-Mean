import { config } from "../config";
import { JobStatus } from "../domain/statuses";
import { withTransaction } from "../infrastructure/database";
import { recordEvent } from "../repositories/event-repository";
import { insertJob, lockJob, updateJob } from "../repositories/job-repository";
import { failPendingTasks, insertGenerateTasks } from "../repositories/task-repository";
import { publishPendingTasks } from "./task-dispatcher";

/**
 * Split the file indexes 0..fileCount-1 into groups of at most chunkSize.
 * Example: 12 files, 5 per group gives [0..4], [5..9], [10..11].
 */
export function splitIntoChunks(fileCount: number, chunkSize: number): number[][] {
  const chunks: number[][] = [];
  for (let first = 0; first < fileCount; first += chunkSize) {
    const last = Math.min(first + chunkSize, fileCount); // the last group may be shorter
    chunks.push(Array.from({ length: last - first }, (_, offset) => first + offset));
  }
  return chunks;
}

/** Create a job with one GENERATE task per group of up to maxTaskInputs files. Returns the new job id. */
export async function createJob(fileCount: number, numbersPerFile: number): Promise<string> {
  const payloads = splitIntoChunks(fileCount, config.maxTaskInputs).map((fileIndexes) => ({ fileIndexes }));
  const jobId = await withTransaction(async (client) => {
    const id = await insertJob(client, fileCount, numbersPerFile);
    await insertGenerateTasks(client, id, payloads);
    await recordEvent(id, `job created (F=${fileCount}, C=${numbersPerFile})`, client);
    return id;
  });
  await publishPendingTasks(); // start work right away
  return jobId;
}

export type CancelOutcome = { outcome: "cancelled" } | { outcome: "not_found" } | { outcome: "not_cancellable"; status: JobStatus };

/** Cancel a PENDING or RUNNING job. Its not-yet-published tasks are dropped; running ones are skipped by workers. */
export async function cancelJob(jobId: string): Promise<CancelOutcome> {
  const result = await withTransaction<CancelOutcome>(async (client) => {
    const job = await lockJob(client, jobId);
    if (!job) return { outcome: "not_found" };
    if (job.status !== JobStatus.Pending && job.status !== JobStatus.Running) {
      return { outcome: "not_cancellable", status: job.status };
    }
    await updateJob(client, jobId, { status: JobStatus.Cancelled });
    await failPendingTasks(client, jobId, "cancelled");
    await recordEvent(jobId, "job cancelled", client);
    return { outcome: "cancelled" };
  });
  if (result.outcome === "cancelled") await publishPendingTasks(); // queue slots freed go to other jobs
  return result;
}
