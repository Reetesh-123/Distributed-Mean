# Distributed Mean

Computes the per-position mean of F files, each holding C random numbers, using a pool of Python workers. A worker handles at most 5 files at a time, workers can run at different speeds, and many jobs can run together.

The idea: a task never returns averages. It returns the **sum of every position plus a count** of the files behind it. Sums can be added in any order, so partial results are combined as soon as they are ready, and the division happens once at the end.

![High-level design](docs/images/hld-diagram.png)

**Stack:** Node.js, Express and TypeScript (API and scheduler) · Python and NumPy (workers) · PostgreSQL · RabbitMQ · Docker Compose

![Dashboard](docs/dashboard.png)

## Run it

You need Docker Desktop (on Windows, with WSL2).

```bash
docker compose up --build
```

| What | Where |
|---|---|
| UI and API | http://localhost:3000 |
| RabbitMQ UI | http://localhost:15672 (guest / guest) |
| Database GUI (Adminer) | http://localhost:8080. System `PostgreSQL`, server `postgres`, user `app`, password `app`, database `jobs` |

**Stop and keep everything:** `docker compose down`

**Stop and remove all data** (jobs, activity log and the generated files), in one command:

```bash
tools/clean.sh            # Git Bash
.\tools\clean.ps1         # PowerShell
```

It runs `docker compose down -v` and then empties `./data`. The next start is empty, with the default 3 workers.

## Try it

The quickest way is the demo script. It creates a job, waits for it, downloads the result and checks it against NumPy:

```bash
tools/demo.sh              # F = 50, C = 10000
tools/demo.sh 1000 20000   # your own sizes
```

On Windows run it from Git Bash. Plain `bash` can point to a WSL distribution without Docker.

Or call the API yourself:

```bash
curl -X POST localhost:3000/jobs -H 'Content-Type: application/json' -d '{"F":50,"C":10000}'
# {"jobId":"..."}

curl localhost:3000/jobs/<jobId>                        # status and progress
curl -o result.csv localhost:3000/jobs/<jobId>/result   # once COMPLETED
curl -X DELETE localhost:3000/jobs/<jobId>              # cancel
```

To check any finished job yourself:

```bash
docker compose exec workers python tools/verify.py <jobId>
```

It recomputes the mean from the raw files with `numpy.mean` and compares.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/jobs` | Create a job. Body `{"F": 1000, "C": 5000}`, returns `202 {"jobId"}`. `400` unless 1 < F < 100,000 and 1 < C < 1,000,000. |
| `GET` | `/jobs`, `/jobs/:id` | List jobs, or one job with progress and task counts |
| `GET` | `/jobs/:id/result` | Download the result CSV. `409` until the job is completed. Supports `Range`. |
| `DELETE` | `/jobs/:id` | Cancel a job |
| `GET`, `PUT` | `/workers` | List workers, or set the worker count `{"count": 0..32}` |
| `GET` | `/stats` | Counters for workers, jobs and tasks |
| `GET` | `/events` | Activity log, up to 100 events. `?after=<id>` for newer ones, `?job=<id>` for one job. |

## Settings

Set as environment variables in `docker-compose.yml`, or on the command line.

| Variable | Default | Meaning |
|---|---|---|
| `INITIAL_WORKERS` | 3 | Workers at first start |
| `WORKER_SLOWDOWN` | `1,1,3` | Slowdown per worker index, repeated. The default makes every third worker 3× slower. |
| `BACKUP_FACTOR` | 2 | A task gets a backup copy after running this many times the median (a huge value turns it off) |
| `MAX_FAN_IN` | 5 | Most inputs per task |
| `WORKER_MEMORY_MB` | 512 | Memory cap per worker process (0 = off) |

Some experiments to try:

```bash
# one very slow worker, backup copies on or off
WORKER_SLOWDOWN=1,1,20 BACKUP_FACTOR=100000 docker compose up -d --force-recreate scheduler workers   # off
WORKER_SLOWDOWN=1,1,20 BACKUP_FACTOR=2      docker compose up -d --force-recreate scheduler workers   # on

# change the number of workers (also in the UI)
curl -X PUT localhost:3000/workers -H 'Content-Type: application/json' -d '{"count":6}'

# crash test: kill -9 a worker while a job runs. The result must still be correct.
curl -X POST localhost:3000/jobs -H 'Content-Type: application/json' -d '{"F":1500,"C":100000}'
tools/kill-worker.sh
```

## Tests

```bash
# unit tests for the maths (11 tests)
cd services/worker && python -m pytest

# integration tests against the real database (35 checks). Start the stack first.
cd services/api && npm install && npm run build
DATABASE_URL=postgres://app:app@localhost:5432/jobs RABBITMQ_URL=amqp://localhost npm run test:integration

# randomized model of the scheduler rules (920 jobs) and the scheduling comparison
python tools/planner_check.py
python tools/simulate.py
```

The integration tests write to the same database the scheduler uses, so stop the `api`, `scheduler` and `workers` containers while they run. What was tested end to end is in [`docs/test-results.md`](docs/test-results.md).

## Limits on a laptop

The design supports F < 100,000 and C < 1,000,000, but the raw data for the maximum is about 400 GB. The largest runs here were F = 4,000 with C = 300,000, and C = 999,999 with F = 40. Generated files go to `./data`. Delete its contents to free the space.

## Project layout

```
services/
  api/            TypeScript (Node 20)
    src/
      entrypoints/    api-server.ts, scheduler.ts (results and the 500 ms tick)
      http/           routes and request validation
      services/       the logic: planner, result handler, dispatcher, backup copies, ...
      repositories/   all the SQL, one file per table
      domain/         statuses, message types, row types
      infrastructure/ database and RabbitMQ
      config/         environment variables
    public/           the UI (plain HTML, CSS and JS)
    tests/integration/
  worker/         Python 3.11, package distributed_mean (worker, worker manager, maths)
db/schema.sql     tables
tools/            helper scripts, not part of the running system: demo.sh, kill-worker.sh,
                  clean.sh, clean.ps1, show_job.py, verify.py, planner_check.py, simulate.py
docs/             design and supporting documents
docker-compose.yml
```

## Documents

- [Design document](docs/01-design-document.md): requirements, API, data model, key decisions, limits and testing
- [Flows](docs/flows.md): step-by-step lists for create, combine, cancel, backup copies, dead workers and more
- [Interview Q&A](docs/interview-qa.md): likely questions and short answers
- [Test results](docs/test-results.md)
- [Requirements](docs/requirement.md) and [implementation plan](docs/implementation-plan.md)
