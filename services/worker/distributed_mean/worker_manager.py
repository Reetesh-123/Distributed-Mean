"""Keeps the right number of worker processes alive. Run as: python -m distributed_mean.worker_manager

The target count is the `desired_workers` setting in the database (changed through PUT /workers).
"""
import multiprocessing
import signal
import time

from . import config, repository
from .worker import run_worker

CHECK_INTERVAL_SECONDS = 2


def _lowest_free_index(running, desired):
    """Worker ids stay stable: reuse the lowest index that is not running."""
    return next(i for i in range(desired + len(running) + 1) if i not in running)


def main():
    db = repository.connect()
    repository.seed_desired_worker_count(db, config.INITIAL_WORKER_COUNT)

    processes = {}  # worker index -> Process
    stopping = False

    def request_stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    print(f"worker manager started, {config.INITIAL_WORKER_COUNT} workers initially", flush=True)

    while not stopping:
        desired = repository.read_desired_worker_count(db)

        # Forget processes that exited or crashed; they are restarted below if still wanted.
        for index in [i for i, p in processes.items() if not p.is_alive()]:
            del processes[index]

        # Scale up.
        while len(processes) < desired:
            index = _lowest_free_index(processes, desired)
            slowdown = config.WORKER_SLOWDOWN_FACTORS[index % len(config.WORKER_SLOWDOWN_FACTORS)]
            process = multiprocessing.Process(target=run_worker, args=(index, slowdown))
            process.start()
            processes[index] = process

        # Scale down: SIGTERM makes a worker finish its current task and then exit.
        surplus = max(0, len(processes) - desired)
        for index in sorted(processes, reverse=True)[:surplus]:
            processes[index].terminate()

        time.sleep(CHECK_INTERVAL_SECONDS)

    for process in processes.values():
        process.terminate()
    for process in processes.values():
        process.join()


if __name__ == "__main__":
    main()
