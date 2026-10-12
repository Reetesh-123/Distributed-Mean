import { isUuid } from "./ids";
import { ResultStatus, TaskType } from "./statuses";

/** A data file on disk plus how many original files it represents. `path` is relative to DATA_DIR. */
export interface ItemRef {
  path: string;
  count: number;
}

/** A combine input as stored in tasks.payload: an item ref plus the id of its items row. */
export interface CombineInput extends ItemRef {
  itemId: string;
}

/** Message scheduler/API -> worker on the "tasks" queue. Carries paths and counts, never the numbers. */
export interface TaskMessage {
  taskId: string;
  jobId: string;
  type: TaskType;
  c: number; // numbers per file
  attempt: number; // 1 = first attempt
  isFinal: boolean;
  isBackup: boolean; // a duplicate sent because the original looks slow; the first result wins
  fileIndexes: number[]; // GENERATE only: 0-based indexes of the files to create
  inputs: CombineInput[]; // COMBINE only: the items to add together
}

/** Message worker -> scheduler on the "results" queue. */
export interface TaskResultMessage {
  taskId: string;
  jobId: string;
  workerId: string;
  attempt: number;
  status: ResultStatus;
  outputs: ItemRef[];
  durationMs: number;
  error: string | null;
}

const isItemRef = (value: any): value is ItemRef =>
  typeof value?.path === "string" && Number.isInteger(value.count) && value.count >= 1;

/**
 * Read a raw queue message. Returns null if it is not a well-formed result, so the caller can
 * drop it. A bad message would fail the same way on every retry, so it must not be requeued.
 */
export function parseResultMessage(raw: string): TaskResultMessage | null {
  let message: any;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  const isWellFormed =
    isUuid(message?.taskId) &&
    isUuid(message?.jobId) &&
    typeof message.workerId === "string" &&
    Object.values(ResultStatus).includes(message.status) &&
    Array.isArray(message.outputs) &&
    message.outputs.every(isItemRef) &&
    Number.isFinite(message.durationMs);
  return isWellFormed ? (message as TaskResultMessage) : null;
}
