import { JobRow } from "../domain/rows";
import { JobStatus } from "../domain/statuses";
import { pool, Queryable } from "../infrastructure/database";
import { updateById } from "../infrastructure/sql-update";

/**
 * Progress in percent. Total work is F file generations plus F-1 merges (adding two items is
 * one merge, so a combine of n inputs does n-1 merges). Capped at 99 until the job is COMPLETED.
 */
const PROGRESS_SQL = `
  CASE WHEN j.status = 'COMPLETED' THEN 100
       ELSE LEAST(99, 100.0 * (j.files_generated + COALESCE((
         SELECT SUM(jsonb_array_length(t.payload->'inputs') - 1)
         FROM tasks t WHERE t.job_id = j.id AND t.type = 'COMBINE' AND t.status = 'DONE'), 0)) / (2 * j.f - 1))
  END AS progress`;

// ---- writes ----------------------------------------------------------------------------------

export async function insertJob(db: Queryable, fileCount: number, numbersPerFile: number): Promise<string> {
  const { rows } = await db.query("INSERT INTO jobs (f, c) VALUES ($1, $2) RETURNING id", [fileCount, numbersPerFile]);
  return rows[0].id;
}

/** Read the job and lock its row until the transaction ends. */
export async function lockJob(db: Queryable, jobId: string): Promise<JobRow | undefined> {
  const { rows } = await db.query<JobRow>("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [jobId]);
  return rows[0];
}

/** Columns a job update may change. started_at and finished_at are set automatically from the new status. */
type JobChanges = { status?: JobStatus; result_path?: string; error?: string };

export async function updateJob(db: Queryable, jobId: string, changes: JobChanges): Promise<void> {
  const nowColumns: string[] = [];
  if (changes.status === JobStatus.Running) nowColumns.push("started_at");
  if (changes.status && changes.status !== JobStatus.Running) nowColumns.push("finished_at");
  await updateById(db, "jobs", jobId, changes, nowColumns);
}

/** Add to the job's count of generated files. Returns the new total. */
export async function addGeneratedFiles(db: Queryable, jobId: string, newFiles: number): Promise<number> {
  const { rows } = await db.query(
    `UPDATE jobs SET files_generated = files_generated + $2 WHERE id = $1 RETURNING files_generated`,
    [jobId, newFiles],
  );
  return rows[0].files_generated;
}

// ---- reads -----------------------------------------------------------------------------------

/** Ids of RUNNING jobs that have at least 2 waiting items, so a combine may be possible. */
export async function findRunningJobIdsWithWaitingItems(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT j.id FROM jobs j WHERE j.status = 'RUNNING'
       AND (SELECT count(*) FROM items i WHERE i.job_id = j.id AND i.state = 'READY') >= 2`,
  );
  return rows.map((row) => row.id);
}

export async function listRecentJobs(limit = 100) {
  const { rows } = await pool.query(
    `SELECT j.id, j.f, j.c, j.status, ${PROGRESS_SQL}, j.created_at, j.started_at, j.finished_at, j.error
     FROM jobs j ORDER BY j.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/** One job with its task counts per status, or null if it does not exist. */
export async function findJobDetails(jobId: string) {
  const { rows } = await pool.query(`SELECT j.*, ${PROGRESS_SQL} FROM jobs j WHERE j.id = $1`, [jobId]);
  if (!rows.length) return null;
  const counts = await pool.query(`SELECT status, count(*)::int AS n FROM tasks WHERE job_id = $1 GROUP BY status`, [jobId]);
  const tasks = Object.fromEntries(counts.rows.map((row) => [row.status, row.n]));
  return { ...rows[0], tasks };
}

/** Status and result file path of a job, or null if it does not exist. */
export async function findJobResult(jobId: string): Promise<{ status: string; result_path: string | null } | null> {
  const { rows } = await pool.query("SELECT status, result_path FROM jobs WHERE id = $1", [jobId]);
  return rows[0] ?? null;
}
