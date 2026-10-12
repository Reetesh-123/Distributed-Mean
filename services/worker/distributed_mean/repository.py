"""All SQL used by the Python side (worker processes, worker manager, verify). Tables are in db/schema.sql."""
import psycopg

from . import config


def connect():
    """Open a connection that commits every statement on its own."""
    return psycopg.connect(config.DATABASE_URL, autocommit=True)


# ---- workers ---------------------------------------------------------------------------------


def register_worker(db, worker_id, slowdown):
    """Insert (or reset) the worker's row so the dashboard and the scheduler can see it."""
    db.execute(
        """INSERT INTO workers (id, status, slowdown) VALUES (%s, 'IDLE', %s)
           ON CONFLICT (id) DO UPDATE SET status = 'IDLE', slowdown = EXCLUDED.slowdown,
             tasks_done = 0, current_task_id = NULL, last_seen = now(), started_at = now()""",
        (worker_id, slowdown),
    )


def delete_worker(db, worker_id):
    db.execute("DELETE FROM workers WHERE id = %s", (worker_id,))


def send_heartbeat(db, worker_id):
    """Record that the worker is alive. A worker marked DEAD during a stall comes back as IDLE."""
    db.execute(
        "UPDATE workers SET last_seen = now(), status = CASE WHEN status = 'DEAD' THEN 'IDLE' ELSE status END"
        " WHERE id = %s",
        (worker_id,),
    )


def set_worker_state(db, worker_id, status, task_id=None):
    """Set the status (IDLE, BUSY or DRAINING) and the task the worker holds, or None when it holds none."""
    started_at = "now()" if task_id else "NULL"
    db.execute(
        f"UPDATE workers SET status = %s, current_task_id = %s, current_task_started_at = {started_at} WHERE id = %s",
        (status, task_id, worker_id),
    )


def count_task_done(db, worker_id):
    db.execute("UPDATE workers SET tasks_done = tasks_done + 1 WHERE id = %s", (worker_id,))


# ---- jobs ------------------------------------------------------------------------------------


def find_job_status(db, job_id):
    """The job's status, or None if the job does not exist."""
    row = db.execute("SELECT status FROM jobs WHERE id = %s", (job_id,)).fetchone()
    return row[0] if row else None


def find_job_size(db, job_id):
    """(F, C, status) of the job, or None if the job does not exist."""
    return db.execute("SELECT f, c, status FROM jobs WHERE id = %s", (job_id,)).fetchone()


# ---- settings --------------------------------------------------------------------------------


def seed_desired_worker_count(db, count):
    """Set the default once. A value changed later through the API is kept."""
    db.execute(
        "INSERT INTO settings (key, value) VALUES ('desired_workers', %s) ON CONFLICT DO NOTHING",
        (str(count),),
    )


def read_desired_worker_count(db):
    return int(db.execute("SELECT value FROM settings WHERE key = 'desired_workers'").fetchone()[0])
