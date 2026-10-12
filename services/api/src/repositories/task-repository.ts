import { config } from "../config";
import { CombineInput } from "../domain/messages";
import { TaskRow, TaskWithJobSize } from "../domain/rows";
import { TaskStatus } from "../domain/statuses";
import { pool, Queryable } from "../infrastructure/database";
import { heartbeatIsFresh } from "../infrastructure/sql-fragments";
import { updateById } from "../infrastructure/sql-update";

/** A running task together with the worker that holds it. */
export type RunningTask = TaskWithJobSize & { worker_id: string; elapsed_ms: number };

// ---- creating tasks --------------------------------------------------------------------------

/**
 * Insert one GENERATE task per payload, in order, in a single statement.
 * clock_timestamp() (unlike now()) differs from row to row, so created_at keeps the order of the payloads.
 */
export async function insertGenerateTasks(db: Queryable, jobId: string, payloads: { fileIndexes: number[] }[]): Promise<void> {
  await db.query(
    `INSERT INTO tasks (job_id, type, payload, created_at)
     SELECT $1, 'GENERATE', payload, clock_timestamp()
     FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(payload, position)
     ORDER BY position`,
    [jobId, JSON.stringify(payloads)],
  );
}

/** Insert a COMBINE task and return its id. */
export async function insertCombineTask(db: Queryable, jobId: string, inputs: CombineInput[], isFinal: boolean): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO tasks (job_id, type, payload, is_final) VALUES ($1, 'COMBINE', $2, $3) RETURNING id`,
    [jobId, JSON.stringify({ inputs }), isFinal],
  );
  return rows[0].id;
}

// ---- finding tasks ---------------------------------------------------------------------------

/** Read the task and lock its row until the transaction ends. */
export async function lockTask(db: Queryable, taskId: string): Promise<TaskRow | undefined> {
  const { rows } = await db.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
  return rows[0];
}

/** How many tasks of the job are PENDING or QUEUED (not finished yet). */
export async function countUnfinishedTasks(db: Queryable, jobId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM tasks WHERE job_id = $1 AND status IN ('PENDING','QUEUED')`,
    [jobId],
  );
  return rows[0].n;
}

/** How many tasks are in the queue or being worked on, for jobs that are still active. */
export async function countQueuedTasks(db: Queryable): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM tasks t JOIN jobs j ON j.id = t.job_id
     WHERE t.status = 'QUEUED' AND j.status IN ('PENDING','RUNNING')`,
  );
  return rows[0].n;
}

/**
 * Pick up to `limit` PENDING tasks and lock them. The order is fair across jobs: the 1st pending
 * task of every job, then the 2nd of every job, and so on. SKIP LOCKED makes a concurrent caller
 * skip rows this one has locked instead of waiting for them.
 */
export async function lockPendingTasksFairly(db: Queryable, limit: number): Promise<TaskWithJobSize[]> {
  const { rows } = await db.query<TaskWithJobSize>(
    `WITH candidates AS (
       SELECT t.id, ROW_NUMBER() OVER (PARTITION BY t.job_id ORDER BY t.created_at, t.id) AS rank_in_job,
              j.created_at AS job_created
       FROM tasks t JOIN jobs j ON j.id = t.job_id
       WHERE t.status = 'PENDING' AND j.status IN ('PENDING','RUNNING')
     ), picked AS (
       SELECT id, rank_in_job, job_created FROM candidates ORDER BY rank_in_job, job_created, id LIMIT $1
     )
     SELECT t.*, j.c FROM picked p
     JOIN tasks t ON t.id = p.id
     JOIN jobs j ON j.id = t.job_id
     ORDER BY p.rank_in_job, p.job_created, t.id
     FOR UPDATE OF t SKIP LOCKED`,
    [limit],
  );
  return rows;
}

/** Tasks held by a busy worker that have no backup copy yet, longest running first. */
export async function findRunningTasksWithoutBackup(limit: number): Promise<RunningTask[]> {
  const { rows } = await pool.query(
    `SELECT t.*, j.c, w.id AS worker_id,
            EXTRACT(EPOCH FROM (now() - w.current_task_started_at)) * 1000 AS elapsed_ms
     FROM tasks t
     JOIN jobs j ON j.id = t.job_id
     JOIN workers w ON w.current_task_id = t.id
     WHERE t.status = 'QUEUED' AND t.backup_sent = false AND j.status = 'RUNNING'
       AND w.status = 'BUSY' AND ${heartbeatIsFresh("w.last_seen")}
     ORDER BY w.current_task_started_at
     LIMIT $2`,
    [config.workerHeartbeatTimeoutMs, limit],
  );
  return rows.map((row) => ({ ...row, elapsed_ms: Number(row.elapsed_ms) }));
}

/** Median duration of the most recently finished tasks of one type, or null if there are none yet. */
export async function findMedianDurationMs(taskType: string, sampleSize: number): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median
     FROM (SELECT duration_ms FROM tasks WHERE type = $1 AND status = 'DONE' AND duration_ms IS NOT NULL
           ORDER BY finished_at DESC LIMIT $2) recent`,
    [taskType, sampleSize],
  );
  return rows[0].median === null ? null : Number(rows[0].median);
}

// ---- changing task state ---------------------------------------------------------------------

/**
 * Columns a task update may change. queued_at and finished_at are set automatically from the new status.
 * Examples: published { status: QUEUED, attempts: 1 }, finished { status: DONE, worker_id, duration_ms },
 * back for a retry { status: PENDING, error }.
 */
type TaskChanges = {
  status?: TaskStatus;
  attempts?: number;
  worker_id?: string;
  duration_ms?: number;
  error?: string | null;
  backup_sent?: boolean;
};

export async function updateTask(db: Queryable, taskId: string, changes: TaskChanges): Promise<void> {
  const nowColumns: string[] = [];
  if (changes.status === TaskStatus.Queued) nowColumns.push("queued_at");
  if (changes.status === TaskStatus.Done || changes.status === TaskStatus.Failed) nowColumns.push("finished_at");
  await updateById(db, "tasks", taskId, changes, nowColumns);
}

/** Fail the job's tasks that were never published. Tasks already running are skipped by the workers. */
export async function failPendingTasks(db: Queryable, jobId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE tasks SET status = 'FAILED', error = $2, finished_at = now() WHERE job_id = $1 AND status = 'PENDING'`,
    [jobId, reason],
  );
}
