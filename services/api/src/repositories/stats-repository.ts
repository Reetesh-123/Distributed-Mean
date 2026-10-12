import { config } from "../config";
import { pool } from "../infrastructure/database";
import { heartbeatIsFresh } from "../infrastructure/sql-fragments";
import { getDesiredWorkers } from "./worker-repository";

type StatusCount = { status: string; n: string };

const countOf = (rows: StatusCount[], status: string): number => Number(rows.find((r) => r.status === status)?.n ?? 0);

/** Counters for the dashboard: workers, jobs and tasks by status, plus retries and backup copies. */
export async function getSystemStats() {
  const [workers, jobs, tasks, desired, extra] = await Promise.all([
    pool.query(
      `SELECT CASE WHEN ${heartbeatIsFresh()} THEN status ELSE 'DEAD' END AS status, count(*) AS n
       FROM workers GROUP BY 1`,
      [config.workerHeartbeatTimeoutMs],
    ),
    pool.query(`SELECT status, count(*) AS n FROM jobs GROUP BY status`),
    pool.query(`SELECT status, count(*) AS n FROM tasks GROUP BY status`),
    getDesiredWorkers(pool),
    pool.query(
      // A retry is any attempt beyond the first; a backup is a duplicate sent for a slow task.
      `SELECT COALESCE(sum(GREATEST(attempts - 1, 0)), 0) AS retries,
              count(*) FILTER (WHERE backup_sent) AS backups
       FROM tasks`,
    ),
  ]);

  const busyWorkers = countOf(workers.rows, "BUSY");
  const queuedTasks = countOf(tasks.rows, "QUEUED");
  return {
    workers: {
      desired,
      idle: countOf(workers.rows, "IDLE"),
      busy: busyWorkers,
      draining: countOf(workers.rows, "DRAINING"),
      dead: countOf(workers.rows, "DEAD"),
    },
    jobs: {
      waiting: countOf(jobs.rows, "PENDING"),
      running: countOf(jobs.rows, "RUNNING"),
      completed: countOf(jobs.rows, "COMPLETED"),
      failed: countOf(jobs.rows, "FAILED"),
      cancelled: countOf(jobs.rows, "CANCELLED"),
    },
    tasks: {
      pending: countOf(tasks.rows, "PENDING"),
      queued: queuedTasks,
      waitingInQueue: Math.max(0, queuedTasks - busyWorkers),
      running: busyWorkers,
      retries: Number(extra.rows[0].retries),
      backups: Number(extra.rows[0].backups),
    },
  };
}
