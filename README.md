# Distributed Mean

A system that takes a large job (the per-position mean of F files of C random numbers), splits it into small tasks, spreads them over a fleet of Python workers, and combines the partial results into one output file. Workers run at different speeds, handle at most 5 files at a time, and are shared by all jobs.

Design: [`docs/01-design-document.md`](docs/01-design-document.md) · Decisions: [`docs/decision notes`](docs/decision%20notes) · Build notes: [`docs/implementation notes`](docs/implementation%20notes) · Test evidence: [`docs/test-results.md`](docs/test-results.md)

![Dashboard](docs/dashboard.png)

**Stack:** Node.js + Express + TypeScript (API and scheduler) · Python + NumPy (workers) · PostgreSQL · RabbitMQ · Docker Compose.

## Run it

Prerequisite: Docker Desktop (on Windows it needs WSL2).

```bash
docker compose up --build
```

| What | URL |
|---|---|
| UI and API | http://localhost:3000 (pages: Overview, Jobs, job detail, Workers, Activity) |
| RabbitMQ UI | http://localhost:15672 (guest / guest) |
| Database GUI (Adminer) | http://localhost:8080. Log in with System `PostgreSQL`, Server `postgres`, Username `app`, Password `app`, Database `jobs` |

## Try it

```bash
# create a job
curl -X POST localhost:3000/jobs -H 'Content-Type: application/json' -d '{"F":50,"C":10000}'
# -> {"jobId":"..."}

curl localhost:3000/jobs/<jobId>                  # status and progress
curl -o result.csv localhost:3000/jobs/<jobId>/result   # download once COMPLETED
curl -X DELETE localhost:3000/jobs/<jobId>        # cancel
curl localhost:3000/stats                         # workers, jobs, tasks
```

One-command demo (creates a job, waits, downloads the result, verifies it with numpy):

```bash
scripts/demo.sh            # F=50, C=10000
scripts/demo.sh 1000 5000  # your own sizes
```

> On Windows run it from **Git Bash**. Plain `bash` can resolve to a WSL distro that has no Docker.

Verify any completed job yourself:

```bash
docker compose exec workers python -m distributed_mean.verify <jobId>
```

It recomputes the mean from the raw files with `numpy.mean` and checks the result matches within 1e-9.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/jobs` | Body `{"F":..,"C":..}`. `400` unless 1 < F < 100,000 and 1 < C < 1,000,000. Returns `202 {jobId}`. |
| `GET` | `/jobs`, `/jobs/:id` | List jobs / one job with progress and task counts |
| `GET` | `/jobs/:id/result` | Download the result CSV (`409` if not completed) |
| `DELETE` | `/jobs/:id` | Cancel a pending or running job |
| `GET` / `PUT` | `/workers` | List workers / set the worker count `{"count": 0..32}` |
| `GET` | `/stats` | Workers idle/busy/dead, jobs waiting/running/completed, tasks queued |
| `GET` | `/events` | Activity log (`?after=<id>` for newer entries) |

## How it works

Every task returns a list of **per-position sums plus a count**, never averages (averaging averages is wrong when groups differ in size, and the 5-file limit guarantees they will). Lists are added index by index, counts are added, and the final task divides once.

1. The API stores the job and its GENERATE tasks (≤ 5 files each) and publishes the first batch.
2. Workers pull one task at a time (`prefetch = 1`), so fast workers do more.
3. The scheduler reads each result and tracks the waiting (READY) items of each job. It combines up to 5 at a time as soon as they are ready, from any level, with no waiting for rounds.
4. When everything left fits in one task and nothing else is running or being generated, the final task divides by the count. The job is `COMPLETED` only if that count equals F.
5. Duplicates are harmless (results for `DONE` tasks are ignored, output paths are unique), so crashes and backup copies are safe.

The 5-file limit holds in layers: the scheduler never builds a larger task, each worker holds one task, the worker rejects any task with more than 5 inputs, inputs are loaded one at a time, and each worker process has a 512 MB memory cap (`WORKER_MEMORY_MB`).

## Demos

```bash
# 3rd worker is 3x slower (default). Fast workers complete more tasks.
docker compose up -d
# make one worker very slow and compare backup copies on/off
WORKER_SLOWDOWN=1,1,20 BACKUP_FACTOR=100000 docker compose up -d --force-recreate scheduler workers   # off
WORKER_SLOWDOWN=1,1,20 BACKUP_FACTOR=2      docker compose up -d --force-recreate scheduler workers   # on

# change the number of workers (also available in the dashboard)
curl -X PUT localhost:3000/workers -H 'Content-Type: application/json' -d '{"count":6}'

# crash test: kill -9 one worker while a job runs; the result must still be correct
curl -X POST localhost:3000/jobs -H 'Content-Type: application/json' -d '{"F":4000,"C":300000}'
scripts/kill-worker.sh
```

| Setting | Default | Meaning |
|---|---|---|
| `INITIAL_WORKERS` | 3 | Starting number of workers |
| `WORKER_SLOWDOWN` | `1,1,3` | Slowdown factor per worker, cycled by index |
| `BACKUP_FACTOR` | 2 | A task is "slow" if it runs longer than this × the median |

## Tests

```bash
cd services/worker && python -m pytest   # unit tests for the math (11 tests)

# planner and result-handler tests against the running database (20 checks)
cd services/api && npm run build
DATABASE_URL=postgres://app:app@localhost:5432/jobs RABBITMQ_URL=amqp://localhost npm run test:integration

python bench/planner_check.py        # randomized model of the scheduler rules (920 jobs)
python bench/simulate.py             # scheduling strategy comparison
```

## Limits on a laptop

The design supports F < 100,000 and C < 1,000,000. Raw data for the maximum would be hundreds of GB, so a laptop's disk limits what you can demo: use **F ≤ 2,000 and C ≤ 100,000** (about 800 MB of raw files). Generated files stay in `./data`; delete that folder to reclaim space. The 512 MB per-worker memory cap is real (it works on Linux, so it applies inside the container).

## Project structure

```
services/
  api/                         TypeScript (Node 20)
    src/
      entrypoints/             api-server.ts (HTTP), scheduler.ts (results + periodic tick)
      http/                    Express routes, request validation
      services/                the logic: combine-planner, result-handler, task-dispatcher,
                               job-service, worker-service, worker-health, backup-copies, fleet-state
      repositories/            ALL SQL lives here, one file per table (jobs, tasks, items, workers, events) + stats
      domain/                  statuses (enums), queue message types, database row types
      infrastructure/          database (pool, transactions), message-broker (RabbitMQ)
      config/                  environment variables
    public/                    UI: index.html, styles.css, app.js (no build step)
    tests/integration/         planner and result-handler tests against PostgreSQL
  worker/                      Python 3.11
    distributed_mean/
      computation.py           generate_files, combine_items (the maths)
      file_storage.py          atomic writes, memory-mapped reads
      worker.py                one worker process (task loop, heartbeat, graceful drain)
      worker_manager.py        keeps W worker processes running
      repository.py            all SQL of the Python side
      verify.py                compares a result with numpy
      config.py                environment variables
    tests/                     unit tests
db/schema.sql                  tables: jobs, tasks, items, workers, settings, events
scripts/                       demo.sh, kill-worker.sh
bench/                         scheduling comparison and a randomized planner model
docs/                          design, decisions, requirements, test results, walkthrough
docker-compose.yml             postgres, rabbitmq, api, scheduler, workers
```

Rule of thumb for the API code: `http/` only talks HTTP, `services/` holds the decisions, `repositories/` holds read queries, `infrastructure/` talks to PostgreSQL and RabbitMQ. Services never import from `http/`.
