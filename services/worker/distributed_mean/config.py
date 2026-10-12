"""Settings read from environment variables (see docker-compose.yml)."""
import os

DATABASE_URL = os.environ.get("DATABASE_URL", "")
RABBITMQ_URL = os.environ.get("RABBITMQ_URL", "")
DATA_DIR = os.environ.get("DATA_DIR", "/data")  # shared folder where all .npy / .csv files live

MAX_TASK_INPUTS = 5  # a task never has more inputs than this (the "5 files per worker" rule)
HEARTBEAT_INTERVAL_MS = int(os.environ.get("HEARTBEAT_MS", "2000"))  # how often a worker says it is alive
WORKER_MEMORY_LIMIT_MB = int(os.environ.get("WORKER_MEMORY_MB", "0"))  # simulated RAM cap per worker, 0 = off (Linux only)

# Worker manager settings.
INITIAL_WORKER_COUNT = int(os.environ.get("INITIAL_WORKERS", "3"))
# Demo only: slowdown factor per worker index, cycled. "1,1,3" makes every third worker 3x slower.
WORKER_SLOWDOWN_FACTORS = [float(x) for x in os.environ.get("WORKER_SLOWDOWN", "1").split(",")]

# Queue names (must match services/api/src/infrastructure/message-broker.ts).
TASK_QUEUE = "tasks"
RESULT_QUEUE = "results"
