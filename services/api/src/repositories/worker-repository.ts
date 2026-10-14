import { config } from "../config";
import { pool, Queryable } from "../infrastructure/database";
import { heartbeatIsFresh } from "../infrastructure/sql-fragments";

/**
 * All workers, with what each one is working on right now. A worker with a stale heartbeat is
 * reported as DEAD whatever its stored status is.
 * task_size = files (GENERATE) or inputs (COMBINE); task_files = files the task covers.
 */
export async function listWorkers() {
  const { rows } = await pool.query(
    `SELECT w.id,
            CASE WHEN ${heartbeatIsFresh("w.last_seen")} THEN w.status ELSE 'DEAD' END AS status,
            w.slowdown, w.tasks_done, w.current_task_id, w.current_task_started_at, w.last_seen, w.started_at,
            t.job_id AS task_job_id, t.type AS task_type, t.is_final AS task_is_final,
            COALESCE(jsonb_array_length(t.payload->'fileIndexes'), jsonb_array_length(t.payload->'inputs')) AS task_size,
            (t.payload->'fileIndexes'->>0)::int AS task_first_file,
            (t.payload->'fileIndexes'->>-1)::int AS task_last_file,
            CASE WHEN t.type = 'GENERATE' THEN jsonb_array_length(t.payload->'fileIndexes')
                 ELSE (SELECT sum((i->>'count')::int) FROM jsonb_array_elements(t.payload->'inputs') i)::int END AS task_files
     FROM workers w LEFT JOIN tasks t ON t.id = w.current_task_id
     ORDER BY w.id`,
    [config.workerHeartbeatTimeoutMs],
  );
  return rows;
}

/** Number of idle and busy workers that sent a heartbeat recently. */
export async function countLiveWorkers(db: Queryable): Promise<{ idle: number; busy: number }> {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'IDLE' AND ${heartbeatIsFresh()})::int AS idle,
            count(*) FILTER (WHERE status = 'BUSY' AND ${heartbeatIsFresh()})::int AS busy
     FROM workers`,
    [config.workerHeartbeatTimeoutMs],
  );
  return rows[0];
}

/** Mark workers with an old heartbeat as DEAD. Returns the ids of the workers that were just marked. */
export async function markStaleWorkersDead(): Promise<string[]> {
  const { rows } = await pool.query(
    `UPDATE workers SET status = 'DEAD', current_task_id = NULL, current_task_started_at = NULL
     WHERE status <> 'DEAD' AND NOT ${heartbeatIsFresh()}
     RETURNING id`,
    [config.workerHeartbeatTimeoutMs],
  );
  return rows.map((row) => row.id);
}

/** The worker count requested through PUT /workers. The worker manager reads it. */
export async function getDesiredWorkers(db: Queryable): Promise<number> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'desired_workers'`);
  return Number(rows[0]?.value ?? 0);
}

export async function setDesiredWorkers(count: number): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('desired_workers', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(count)],
  );
}
