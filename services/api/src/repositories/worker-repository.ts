import { config } from "../config";
import { pool, Queryable } from "../infrastructure/database";
import { heartbeatIsFresh } from "../infrastructure/sql-fragments";

/** All workers. A worker with a stale heartbeat is reported as DEAD whatever its stored status is. */
export async function listWorkers() {
  const { rows } = await pool.query(
    `SELECT id,
            CASE WHEN ${heartbeatIsFresh()} THEN status ELSE 'DEAD' END AS status,
            slowdown, tasks_done, current_task_id, current_task_started_at, last_seen, started_at
     FROM workers ORDER BY id`,
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
