import { CombineInput } from "./messages";
import { JobStatus, TaskStatus, TaskType } from "./statuses";

/** Database rows (snake_case columns, as in db/schema.sql). */

export interface JobRow {
  id: string;
  f: number; // number of files
  c: number; // numbers per file
  status: JobStatus;
  files_generated: number;
  result_path: string | null;
  error: string | null;
}

export interface TaskRow {
  id: string;
  job_id: string;
  type: TaskType;
  payload: { fileIndexes?: number[]; inputs?: CombineInput[] };
  is_final: boolean;
  status: TaskStatus;
  attempts: number;
}

/** A task row joined with its job's `c`, as needed to build a queue message. */
export type TaskWithJobSize = TaskRow & { c: number };

/** A waiting item (state READY) of one job, ready to be combined. */
export interface WaitingItem {
  id: string;
  path: string;
  count: number;
}
