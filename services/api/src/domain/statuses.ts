/**
 * String enums shared by the whole API. The values match the CHECK constraints in db/schema.sql
 * and the strings the Python workers read and write.
 */

export const JobStatus = {
  Pending: "PENDING", // created, no task finished yet
  Running: "RUNNING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Cancelled: "CANCELLED",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const TaskType = {
  /** Create up to 5 random files. */
  Generate: "GENERATE",
  /** Add up to 5 items (raw files or partial results) into one new item. */
  Combine: "COMBINE",
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

export const TaskStatus = {
  Pending: "PENDING", // not published to the queue yet
  Queued: "QUEUED", // published: waiting in the queue or being worked on
  Done: "DONE",
  Failed: "FAILED",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** An "item" is one data file on disk: a raw file or a partial result (sums + count). */
export const ItemState = {
  Ready: "READY", // waiting, available for a combine task
  Used: "USED", // already assigned to a combine task
} as const;
export type ItemState = (typeof ItemState)[keyof typeof ItemState];

export const WorkerStatus = {
  Idle: "IDLE",
  Busy: "BUSY",
  Draining: "DRAINING", // finishing its last task, then exiting (scale-down)
  Dead: "DEAD", // heartbeat too old
} as const;
export type WorkerStatus = (typeof WorkerStatus)[keyof typeof WorkerStatus];

/** Outcome a worker reports for one task. */
export const ResultStatus = {
  Done: "DONE",
  Failed: "FAILED",
  Skipped: "SKIPPED", // the job was cancelled or failed before the worker started
} as const;
export type ResultStatus = (typeof ResultStatus)[keyof typeof ResultStatus];
