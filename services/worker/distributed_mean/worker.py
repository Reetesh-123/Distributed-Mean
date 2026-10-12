"""One worker process: take a task from the queue, compute it, report the result, repeat."""
import json
import signal
import threading
import time

import pika

from . import computation, config, repository

# Result statuses (match the API).
DONE, FAILED, SKIPPED = "DONE", "FAILED", "SKIPPED"


def _limit_memory():
    """Simulate a small machine: the OS kills allocations above the cap with MemoryError."""
    if config.WORKER_MEMORY_LIMIT_MB > 0:
        import resource  # Linux only

        limit_bytes = config.WORKER_MEMORY_LIMIT_MB * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit_bytes, limit_bytes))


def _connect_to_broker(max_attempts=30):
    """RabbitMQ can pass its health check slightly before it accepts connections, so retry."""
    for attempt in range(1, max_attempts + 1):
        try:
            return pika.BlockingConnection(pika.URLParameters(config.RABBITMQ_URL + "?heartbeat=600"))
        except pika.exceptions.AMQPConnectionError:
            if attempt == max_attempts:
                raise
            time.sleep(1)


class Worker:
    """Takes one task at a time (prefetch 1), so a faster worker naturally takes more tasks."""

    def __init__(self, index, slowdown_factor):
        self.worker_id = f"workers-{index}"
        self.slowdown_factor = slowdown_factor
        self.draining = False  # set by SIGTERM: finish the current task, then exit

    # ---- lifecycle -------------------------------------------------------------------------

    def run(self):
        threading.stack_size(512 * 1024)  # small thread stacks: the memory cap counts virtual memory
        _limit_memory()
        signal.signal(signal.SIGTERM, self._request_drain)

        self.db = repository.connect()
        self.broker = _connect_to_broker()
        self.channel = self.broker.channel()
        self.channel.queue_declare(config.TASK_QUEUE, durable=True)
        self.channel.queue_declare(config.RESULT_QUEUE, durable=True)
        self.channel.basic_qos(prefetch_count=1)  # at most one unacknowledged task at a time
        self.channel.confirm_delivery()  # publishing waits for the broker's confirm

        repository.register_worker(self.db, self.worker_id, self.slowdown_factor)
        stop_heartbeat = threading.Event()
        threading.Thread(target=self._heartbeat_loop, args=(stop_heartbeat,), daemon=True).start()
        print(f"{self.worker_id} started (slowdown {self.slowdown_factor})", flush=True)

        for method, _properties, body in self.channel.consume(config.TASK_QUEUE, inactivity_timeout=1):
            if self.draining:
                break
            if method is None:  # nothing arrived within the timeout; check `draining` again
                continue
            self._process_message(method, json.loads(body))

        stop_heartbeat.set()
        repository.delete_worker(self.db, self.worker_id)
        self.broker.close()
        self.db.close()
        print(f"{self.worker_id} stopped", flush=True)

    def _request_drain(self, *_):
        self.draining = True

    def _heartbeat_loop(self, stop):
        """Runs in a thread with its own connection. No heartbeat for ~10 s means the worker is dead."""
        with repository.connect() as connection:
            while not stop.wait(config.HEARTBEAT_INTERVAL_MS / 1000):
                repository.send_heartbeat(connection, self.worker_id)

    # ---- one task --------------------------------------------------------------------------

    def _process_message(self, method, task):
        # A SIGTERM during a write can interrupt numpy's C-level file write, so hold it until the
        # task is acknowledged. A pending SIGTERM then sets `draining` and the worker exits afterwards.
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
        repository.set_worker_state(self.db, self.worker_id, "BUSY", task["taskId"])
        started_at = time.time()

        status, outputs, error = self._execute(task, started_at)
        self._publish_result(task, status, outputs, started_at, error)

        # Ack only after the result is published and confirmed. A crash before this line makes the
        # broker redeliver the task to another worker.
        self.channel.basic_ack(method.delivery_tag)
        repository.count_task_done(self.db, self.worker_id)
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
        repository.set_worker_state(self.db, self.worker_id, "DRAINING" if self.draining else "IDLE")

    def _execute(self, task, started_at):
        """Run the task. Returns (status, output items, error message)."""
        if repository.find_job_status(self.db, task["jobId"]) in (None, "CANCELLED", "FAILED"):
            return SKIPPED, [], None  # nobody needs this work any more

        if len(task["inputs"]) > config.MAX_TASK_INPUTS or len(task["fileIndexes"]) > config.MAX_TASK_INPUTS:
            return FAILED, [], f"more than {config.MAX_TASK_INPUTS} inputs"

        try:
            outputs = self._compute(task)
        except Exception as error:  # report instead of crashing; the scheduler decides about a retry
            return FAILED, [], str(error)

        if self.slowdown_factor > 1:  # demo only: pretend to be a slower machine
            time.sleep((self.slowdown_factor - 1) * (time.time() - started_at))
        return DONE, outputs, None

    def _compute(self, task):
        if task["type"] == "GENERATE":
            return computation.generate_files(config.DATA_DIR, task["jobId"], task["c"], task["fileIndexes"])
        return computation.combine_items(
            config.DATA_DIR, task["jobId"], task["taskId"], task["c"], task["inputs"], task["isFinal"]
        )

    def _publish_result(self, task, status, outputs, started_at, error):
        message = {
            "taskId": task["taskId"],
            "jobId": task["jobId"],
            "workerId": self.worker_id,
            "attempt": task["attempt"],
            "status": status,
            "outputs": outputs,  # paths and counts only, never the numbers
            "durationMs": int((time.time() - started_at) * 1000),
            "error": error,
        }
        self.channel.basic_publish(
            "", config.RESULT_QUEUE, json.dumps(message), pika.BasicProperties(delivery_mode=2)  # 2 = persistent
        )


def run_worker(index, slowdown_factor):
    """Entry point for a worker process started by the worker manager."""
    Worker(index, slowdown_factor).run()
