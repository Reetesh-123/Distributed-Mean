#!/usr/bin/env bash
# Crash test helper: kill -9 one worker process while a job is running.
# The task it held is redelivered by RabbitMQ, the worker manager restarts the worker,
# and the final result must still be correct.
# (Workers are child processes of the worker manager, so we look for processes whose parent is PID 1.)
set -euo pipefail

docker compose exec -T workers python -c '
import os, signal
for pid in os.listdir("/proc"):
    if not pid.isdigit() or int(pid) == 1:
        continue
    try:
        ppid = int(open(f"/proc/{pid}/stat").read().split(")")[1].split()[1])
    except Exception:
        continue
    if ppid == 1:  # direct child of the worker manager (PID 1 in the container)
        print("killing worker process", pid)
        os.kill(int(pid), signal.SIGKILL)
        break
'
