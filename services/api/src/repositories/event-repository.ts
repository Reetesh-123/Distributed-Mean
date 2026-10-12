import { pool, Queryable } from "../infrastructure/database";

/** Add a line to the activity log. `jobId` is null for events that belong to no job. */
export async function recordEvent(jobId: string | null, message: string, db: Queryable = pool): Promise<void> {
  await db.query("INSERT INTO events (job_id, message) VALUES ($1, $2)", [jobId, message]);
}

/**
 * Activity log lines, oldest first.
 * Without `afterId`: the latest 100. With it: up to 100 newer ones. With `jobId`: only that job's lines.
 */
export async function listEvents(afterId: number | null, jobId: string | null = null) {
  const { rows } =
    afterId === null
      ? await pool.query(
          `SELECT * FROM (SELECT id, job_id, message, created_at FROM events
                          WHERE ($1::uuid IS NULL OR job_id = $1) ORDER BY id DESC LIMIT 100) latest ORDER BY id`,
          [jobId],
        )
      : await pool.query(
          `SELECT id, job_id, message, created_at FROM events
           WHERE id > $1 AND ($2::uuid IS NULL OR job_id = $2) ORDER BY id LIMIT 100`,
          [afterId, jobId],
        );
  return rows;
}
