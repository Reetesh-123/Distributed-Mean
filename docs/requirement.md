# Requirements Checklist

Every line of the assignment, mapped to where the solution covers it.

- **Design** = covered in the design (see `01-design-document.md` and `03-decision-notes.md`)
- **Built** = implemented and verified (tick these off while building, see `04-implementation-notes.md`)

---

## 1. Summary section of the assignment

| # | Assignment line | Our solution | Design | Built |
|---|---|---|---|---|
| 1.1 | Assign a large job across a fleet of workers | Job split into GENERATE and COMBINE tasks on a shared queue | âœ… | â¬œ |
| 1.2 | Workers' outputs aggregated into a single result returned to the user | Partial results combined until one remains; final task writes `result.csv`; `GET /jobs/:id/result` | âœ… | â¬œ |
| 1.3 | W is at the system level, not specific to a job | One shared pool of workers serves all jobs; W stored in `settings` | âœ… | â¬œ |
| 1.4 | W can be constant, or configurable (bonus) | Default W from env `INITIAL_WORKERS`; changeable via `PUT /workers` | âœ… | â¬œ |
| 1.5 | Compute the mean of every index across F files of C random numbers | Each item = list of C per-position sums + count; final task divides each position by the count | âœ… | â¬œ |
| 1.6 | 1 < F < 100k | API validates `F` in 2..99,999 â†’ otherwise `400` | âœ… | â¬œ |
| 1.7 | 1 < C < 1000k | API validates `C` in 2..999,999 â†’ otherwise `400` | âœ… | â¬œ |

## 2. Example

| # | Assignment line | Our solution | Design | Built |
|---|---|---|---|---|
| 2.1 | F=2, C=3, files [1,2,3] and [4,5,6] â†’ single output file [2.5, 3.5, 4.5] | Lists added index by index, divided by count; used as a unit test | âœ… | â¬œ |
| 2.2 | Values for F and C chosen by the user | `POST /jobs {F, C}` | âœ… | â¬œ |
| 2.3 | Any bound for the random numbers | Uniform in [0, 1), seeded per (job, file) for reproducibility | âœ… | â¬œ |
| 2.4 | Any file format | Inputs and partials as `.npy`; result as `.csv` (and `.npy`) | âœ… | â¬œ |

## 3. Components

| # | Assignment line | Our solution | Design | Built |
|---|---|---|---|---|
| 3.1 | API, DB, queue and fleet of workers | Express API, PostgreSQL, RabbitMQ, Python workers | âœ… | â¬œ |
| 3.2 | API uses Node.js, Express, TypeScript | `api/` service in TypeScript (scheduler is a second entry point in the same codebase) | âœ… | â¬œ |
| 3.3 | Workers in Python | `worker/` with NumPy, pika, psycopg | âœ… | â¬œ |
| 3.4 | Queue can be any kind | RabbitMQ (`tasks` and `results` queues) | âœ… | â¬œ |

## 4. Flow

| # | Assignment line | Our solution | Design | Built |
|---|---|---|---|---|
| 4.1 | W workers sit idle waiting for a job on the queue | Workers block on `tasks` queue with `prefetch = 1` | âœ… | â¬œ |
| 4.2 | User creates a job via an API call with C and F | `POST /jobs` | âœ… | â¬œ |
| 4.3 | The API enqueues the job | API inserts the job and its GENERATE tasks, then publishes the first batch to RabbitMQ | âœ… | â¬œ |
| 4.4 | Processing starts once at least one worker is available | Any free worker pulls the next task; works with W = 1 | âœ… | â¬œ |
| 4.5 | Each worker's result must be combined into the final averaged file | Basket of READY items; combine up to 5 at a time; final task divides | âœ… | â¬œ |

## 5. Assumptions

| # | Assignment line | Our solution | Design | Built |
|---|---|---|---|---|
| 5.1 | A worker can't process more than 5 files at a time | Every task has â‰¤ 5 inputs (partials count as files); one task per worker (`prefetch = 1`); worker rejects > 5 inputs; inputs loaded one at a time | âœ… | â¬œ |
| 5.1b | "To simulate RAM constraints on each worker" | Optional real memory cap per worker process (`WORKER_MEMORY_MB`, `RLIMIT_AS`) | âœ… | â¬œ |
| 5.2 | System must split the job when F > 5 | âŒˆF/5âŒ‰ GENERATE tasks + ~(Fâˆ’1)/4 COMBINE tasks | âœ… | â¬œ |
| 5.3 | Files stored locally or in a bucket, readable by workers | Shared folder mounted into all containers (`./data`) | âœ… | â¬œ |
| 5.4 | Workers process at different speeds | Pull model; no fixed rounds; backup copies of slow tasks | âœ… | â¬œ |
| 5.5 | Minimize idling and waiting on slower workers | Combine as soon as items are ready; small tasks; simulation shows ~1.00Ã— ideal on large jobs | âœ… | â¬œ |

## 6. Critical aspects

| # | Assignment line | Our solution | Design | Built |
|---|---|---|---|---|
| 6.1 | F > 5: one or multiple items on the queue (no strict 1:1) | Many tasks per job, created as items become ready | âœ… | â¬œ |
| 6.2 | Efficiency of the distribution algorithm | Pull + basket + backups; compared with 3 alternatives in `tools/simulate.py` | âœ… | â¬œ |
| 6.3 | How the system decides a job is finished | Final task only when all remaining items fit, nothing in flight, all files generated; then count = F check | âœ… | â¬œ |
| 6.4 | Submit multiple jobs while others are running | Shallow queue refilled round-robin across jobs | âœ… | â¬œ |

## 7. Expectations

| # | Assignment line | Our solution | Design | Built |
|---|---|---|---|---|
| 7.1 | Complete working solution desired (not primary) | Full system planned via Docker Compose | âœ… | â¬œ |
| 7.2 | Well-thought design doc covering decisions taken | `01-design-document.md` + `03-decision-notes.md` | âœ… | âœ… |
| 7.3 | Focus on how the system handles the critical aspects | Section 8 of the design doc + D1â€“D18 | âœ… | âœ… |

## 8. Bonus

| # | Assignment line | Our solution | Design | Built |
|---|---|---|---|---|
| 8.1 | W configurable via the API | `PUT /workers {count}` â†’ worker manager spawns or drains processes | âœ… | â¬œ |
| 8.2 | UI with updating logs about system state | Dashboard served by the API at `/` | âœ… | â¬œ |
| 8.3 | Number of workers free and busy | `/stats` â†’ workers idle / busy / dead | âœ… | â¬œ |
| 8.4 | How many jobs completed | `/stats` â†’ jobs by status | âœ… | â¬œ |
| 8.5 | How many jobs on the queue | `/stats` â†’ jobs waiting (PENDING) + tasks queued | âœ… | â¬œ |
| 8.6 | Any other relevant metrics | Job progress %, tasks running, retries, backups, per-worker tasks done and slowdown | âœ… | â¬œ |
| 8.7 | "Updating logs" | Activity log from `GET /events`, refreshed every second | âœ… | â¬œ |

---

## 9. Quality checklist (what makes the submission outstanding)

| # | Item | Status |
|---|---|---|
| 9.1 | Correctness test: assignment example (2.1) gives exactly [2.5, 3.5, 4.5] | â¬œ |
| 9.2 | Correctness test: random jobs match `numpy.mean` within 1e-9 | â¬œ |
| 9.3 | Every result has final count = F | â¬œ |
| 9.4 | Slow-worker demo: some workers 3Ã— slower; fast workers complete more tasks | â¬œ |
| 9.5 | Crash test: kill a worker mid-job; result still correct | â¬œ |
| 9.6 | Fairness test: big job then small job; small job finishes quickly | â¬œ |
| 9.7 | Scaling test: change W mid-job; no task is interrupted | â¬œ |
| 9.8 | README: one command to run, example `curl`, dashboard URL | â¬œ |
| 9.9 | Demo script that submits a job and verifies the result | â¬œ |
| 9.10 | Dashboard screenshot for the submission | â¬œ |
| 9.11 | Note on laptop limits (demo sizes vs. design limits) | â¬œ |
| 9.12 | Cancel test: cancel a running job; workers move on, dashboard counts stay correct | â¬œ |
| 9.13 | Concurrency test: two jobs at once both complete correctly | â¬œ |

## 10. Interview questions to be ready for

| Question | Answer in one line |
|---|---|
| Why not average the averages? | Groups differ in size (the 5-file limit guarantees it), so small groups get too much weight. |
| How is position preserved? | Every file and partial is a list of C values in position order; lists are added index by index. |
| Does a partial result count as a file? | Yes, we treat it as one, so every task has at most 5 inputs. |
| How do you know a job is done? | Final task is created only when nothing else can arrive; then count must equal F. |
| What if a worker dies? | The task was never acked, so RabbitMQ redelivers it; duplicates are ignored. |
| Isn't the scheduler a single point of failure? | All state is in PostgreSQL and results are acked after commit, so it restarts safely. |
| What if F is small but C is huge? | One worker handles it quickly; splitting by position ranges is a deferred option. |
