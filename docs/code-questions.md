# Code Questions: Distributed Mean

Questions an interviewer may ask while looking at the code. Each answer points to the real file and function. Lines starting with "Follow-up" are the likely next questions.

**Jump to:**
- [1. Where things live](#1-where-things-live)
- [2. Creating a job](#2-creating-a-job)
- [3. The combine planner](#3-the-combine-planner)
- [4. Applying a result](#4-applying-a-result)
- [5. Publishing tasks](#5-publishing-tasks)
- [6. The scheduler process](#6-the-scheduler-process)
- [7. The worker](#7-the-worker)
- [8. The maths and the files](#8-the-maths-and-the-files)
- [9. Database and SQL](#9-database-and-sql)
- [10. API layer](#10-api-layer)
- [11. Tests](#11-tests)
- [12. Known weak spots in the code](#12-known-weak-spots-in-the-code)
- [13. "Change this code" questions](#13-change-this-code-questions)

---

## 1. Where things live

**Q: Walk me through the code layout.**
- `services/api/src/entrypoints/`: two programs. `api-server.ts` (HTTP) and `scheduler.ts` (results and the 500 ms tick).
- `http/`: routes and input checks only.
- `services/`: the logic. `combine-planner.ts`, `result-handler.ts`, `task-dispatcher.ts`, `backup-copies.ts`, `job-service.ts`.
- `repositories/`: all the SQL, one file per table.
- `infrastructure/`: the database pool, transactions and RabbitMQ.
- `domain/`: statuses, message types, row types.
- `services/worker/distributed_mean/`: `worker_manager.py`, `worker.py`, `computation.py`, `file_storage.py`, `repository.py`.
- `tools/`: helper scripts that are not part of the running system.

**Q: Why are there two TypeScript programs from one codebase?**
- The API answers users. The scheduler makes decisions. They scale and fail differently.
- Both run the same image with a different start command. The scheduler must run as one instance.

**Q: Why separate `repositories/` from `services/`?**
- SQL stays in one place, and the logic reads like plain steps.
- A repository function does one query. A service decides which queries to run and in what order.

> **Follow-up: Where would you start reading to understand the system?**
> - `result-handler.ts`. Every result passes through it, and it calls the planner.

---

## 2. Creating a job

**Q: What happens inside `createJob`?**
- `splitIntoChunks(F, 5)` makes the file groups: 12 files give `[0..4]`, `[5..9]`, `[10, 11]`.
- One transaction inserts the job, one GENERATE task per group, and a log event.
- After the commit it calls `publishPendingTasks()` to start work.
- The route answers `202` with the job id.

**Q: Why `202` and not `200` or `201`?**
- The job is accepted but not done. The work continues in the background.

**Q: Why publish after the transaction, not inside it?**
- Workers could receive a task whose rows are not committed yet.
- If the process crashed in between, the tasks are still `PENDING` and the next tick publishes them.

**Q: How is `splitIntoChunks` written, and what are its edge cases?**
- A loop from 0 in steps of `chunkSize`. The last group is cut with `Math.min`.
- F = 1 would give one group. The API rejects it earlier, since F must be greater than 1.

**Q: Why does `insertGenerateTasks` use `clock_timestamp()`?**
- `now()` returns the same value for every row in a transaction. Tasks would have identical `created_at` and the file order would be lost.
- `clock_timestamp()` changes per row, and `WITH ORDINALITY` keeps the payload order.
- Fair publishing orders tasks by `created_at`, so this keeps file 0 before file 5.

**Q: Where are F and C validated?**
- `validateJobSize` in `http/validation.ts` checks `1 < F < 100,000` and `1 < C < 1,000,000`, and that both are integers.
- The database repeats it with `CHECK` constraints, so a bug in the API cannot store a bad job.

---

## 3. The combine planner

**Q: Explain `planCombineTasks` in one minute.**
- It looks at one job's waiting items (`READY`) and decides whether to create COMBINE tasks.
- Rule 1: while 5 or more items wait, take 5 and create a task.
- Rule 2: fewer than 5 left, all files generated, nothing unfinished, 2 or more waiting: create the **final** task.
- Rule 3: 2 or more waiting and a worker is idle and the queue is empty: create a smaller task.
- Rule 4: one item left, all done: create a final task that only divides.

**Q: How does a task become "final"?**
- In rule 1, `takesEverything` is true only if nothing else waits, no task is unfinished, and all files are generated.
- In rules 2 and 4, the planner passes `true` because it knows nothing else will arrive.

**Q: How do you stop two tasks taking the same item?**
- `createCombineTask` inserts the task and then `markItemsUsed(...)` sets those items to `USED` with `used_by = task`. Both happen in the same transaction.
- The caller holds the job row lock, so no other planner run can read the same `READY` items.

**Q: What is `workerIsIdle` and why is the queue part needed?**
- `fleet.idleWorkers > 0 && fleet.tasksWaitingInQueue === 0`.
- If tasks are waiting in the queue, the idle worker is about to get one. Making a small combine would only create extra work.

**Q: What does `countUnfinishedTasks` count?**
- Tasks of that job with status `PENDING` or `QUEUED`.
- The planner adds 1 each time it creates a task, so the number stays correct inside the loop.

**Q: Why does rule 1 use `splice`?**
- It removes the first 5 from the local list, so the loop sees what is left. Nothing else touches that list.

> **Follow-up: What if the planner runs twice for the same job?**
> - The first run marks its items `USED`. The second run does not see them. It only works with what is still `READY`.
> - This is safe because the job row lock makes the runs happen one after the other.

> **Follow-up: Can a job get stuck with items waiting?**
> - Rule 4 and the 500 ms tick prevent it. The tick re-plans every running job that has waiting items, even when no new result arrives.

---

## 4. Applying a result

**Q: Walk through `applyWorkerResult`.**
- One transaction. Lock the task, then the job.
- Task already `DONE`: log a duplicate and stop.
- Job cancelled or failed, or the worker said `SKIPPED`: mark the task `FAILED` ("job not active").
- Worker said `FAILED`: `retryOrFailJob`.
- Otherwise `applySuccessfulResult`.

**Q: What does `applySuccessfulResult` do?**
- Marks the task `DONE` with worker id and duration.
- First finished task moves the job from `PENDING` to `RUNNING`.
- Final task: `finishJob`. Otherwise `storeOutputs`, then the planner.
- Writes an activity log event.

**Q: What does `storeOutputs` return and why?**
- The number of files the job has generated so far.
- The planner needs it to know whether all files exist (`files_generated === f`).
- Only GENERATE tasks add to it. `addGeneratedFiles` adds the count of **new** items, so a duplicate insert adds 0.

**Q: How does `finishJob` decide the job is done?**
- The final task's output count must equal `job.f`. Then the status becomes `COMPLETED` and `result_path` is saved.
- Otherwise the job is `FAILED` with "count mismatch".

**Q: Why lock the task first and the job second?**
- A fixed lock order prevents deadlocks. Every code path that takes both locks uses task, then job.
- `replanJob` and `cancelJob` take only the job lock, so they cannot form a cycle.

**Q: How does a retry work in code?**
- `retryOrFailJob`: if `task.attempts >= maxTaskAttempts` (3), fail the task and the job.
- Otherwise set the task back to `PENDING` with the error. The dispatcher publishes it again.
- `attempts` is increased when a task is **published**, not when it fails.

**Q: What stops a result being applied twice?**
- The `DONE` check at the top, and `ON CONFLICT (path) DO NOTHING` on item inserts.
- Both run under the task row lock, so two copies of the same result are handled one after the other.

> **Follow-up: What if the task row doesn't exist?**
> - `lockTask` returns nothing and the function returns. The message is acked and dropped.

---

## 5. Publishing tasks

**Q: What does `publishPendingTasks` do?**
- Works out the free queue slots: `max(2, 2 × desiredWorkers) − tasksWaitingInQueue`.
- Locks that many `PENDING` tasks, fairly across jobs.
- For each, publishes to RabbitMQ and waits for the confirm, then marks it `QUEUED` and counts the attempt.

**Q: Why keep the queue short?**
- If one big job put 10,000 tasks on the queue, a small job created later would wait behind all of them.
- A short queue means the choice of the next task is made late, by the fair query.

**Q: What is `lastPublishRun` for?**
- A promise chain. A new publish run starts only after the previous one finished, within this process.
- Without it, two triggers (a result and the tick) could both see the same free slots and over-fill the queue.
- `run.catch(() => undefined)` keeps a failed run from blocking later ones.

**Q: Why publish first and mark `QUEUED` second?**
- A crash after the publish but before the update only means the task is published again later. That is harmless.
- The other order could mark a task `QUEUED` that was never sent, and it would be lost.

**Q: How does `lockPendingTasksFairly` work?**
- `ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY created_at)` gives each pending task its position inside its job.
- It sorts by that position, then by job age. So: first task of every job, then second of every job.
- `FOR UPDATE OF t SKIP LOCKED` locks the picked rows and skips rows another caller holds.

**Q: What is in the task message?**
- `buildTaskMessage` sends ids, type, `c`, attempt, `isFinal`, `isBackup`, `fileIndexes` and `inputs`. Only paths and counts, never numbers.

---

## 6. The scheduler process

**Q: How does the scheduler consume results?**
- `channel.consume(RESULT_QUEUE, ...)` with `prefetch(10)`.
- A promise chain (`previous.then(...)`) makes sure messages are handled strictly one at a time, in order.

**Q: Why is `handleResultMessage` written so it never throws?**
- One bad message must not stop the ones behind it. Errors are caught and logged.

**Q: What happens for each failure type?**
- Malformed message: `nack` with no requeue, because retrying would fail the same way.
- Apply failed (for example the database is down): `nack` with requeue, then wait 1 s so it doesn't spin.
- Success: `ack`, then try to publish tasks. If that fails, the next tick does it.

**Q: What does the tick do and why does `tickInProgress` exist?**
- Mark dead workers, take a fleet snapshot, re-plan running jobs with waiting items, send backup copies, publish pending tasks.
- `setInterval` fires every 500 ms even if the last tick is still running. The flag skips the new one, so ticks never overlap.

**Q: What happens when RabbitMQ restarts?**
- The channel `close` event schedules `keepConsuming` after 2 s, and consuming starts again.
- `getChannel` forgets the dead channel, so the next call reconnects.

**Q: Why must there be only one scheduler?**
- Several things are protected by in-process variables (`lastPublishRun`, `tickInProgress`). Row locks protect the data, but two schedulers would waste work and could over-fill the queue.
- To run two: a Postgres advisory lock for leader election, or split jobs by id.

---

## 7. The worker

**Q: Walk through one worker's life.**
- `run()` limits memory, installs the SIGTERM handler, connects to Postgres and RabbitMQ, sets `prefetch_count=1`, turns on publisher confirms, registers in `workers`, and starts the heartbeat thread.
- The loop consumes tasks with a 1 s timeout so it can notice `draining`.

**Q: What is `prefetch_count=1` for?**
- The broker gives a worker one unacknowledged task at a time. A fast worker finishes sooner and gets more tasks, so load balances itself.

**Q: What does `_process_message` do, in order?**
- Block SIGTERM and set state `BUSY`.
- `_execute` the task.
- Publish the result and wait for the confirm.
- **Then** `basic_ack`, count the task, unblock SIGTERM, set state `IDLE` (or `DRAINING`).

**Q: Why block SIGTERM during a task?**
- A signal in the middle of numpy's file write could leave a broken file.
- The signal waits until after the ack. Then the handler sets `draining` and the loop exits.

**Q: What does `_execute` check before computing?**
- If the job is cancelled, failed or missing: return `SKIPPED`.
- If the task has more than 5 inputs: return `FAILED`.
- Any exception during compute: return `FAILED` with the message. The worker never crashes on a bad task.

**Q: How is the slow worker simulated?**
- After the real work, it sleeps `(factor − 1) × time already spent`. A factor of 3 makes the task take 3 times as long in total.
- It is a demo setting only, taken from the worker index.

**Q: Why does the heartbeat run in a separate thread with its own connection?**
- A long task blocks the main thread. The heartbeat must keep going so the scheduler doesn't mark a busy worker `DEAD`.
- psycopg connections are not safe to share between threads, so it opens its own.

**Q: What is `?heartbeat=600` on the RabbitMQ URL?**
- The AMQP connection heartbeat, set to 600 s. pika's `BlockingConnection` only answers the broker's heartbeat while it is processing events, and a worker busy in a long computation is not.
- A long timeout stops the broker from closing the connection in the middle of a task.

**Q: What does `_limit_memory` do?**
- `RLIMIT_AS` caps the process's address space (default 512 MB in Compose). Going over raises `MemoryError`, which becomes a `FAILED` result.
- It works on Linux only, which is why it is guarded by `if` and imports `resource` inside.

**Q: What does the worker manager do differently from a worker?**
- It runs as PID 1 and spawns worker processes with `multiprocessing`. Every 2 s it reads `desired_workers`, starts or stops processes, and restarts crashed ones.

---

## 8. The maths and the files

**Q: Explain `combine_items`.**
- Start a float64 array of zeros and a count of 0.
- For each input (at most 5, one at a time): load it, add it to the total, add its count.
- Not final: save the total as `partials/<taskId>.npy` and return `{path, count}`.
- Final: divide by the total count, write `result.npy` and `result.csv`, return the count.

**Q: Why float64 for the total when the files are float32?**
- Adding many float32 values loses precision. float64 keeps the error tiny. The tests compare to `numpy.mean` and the difference was 0.

**Q: Why load one input at a time?**
- Memory. With C near 1,000,000, each array is about 4 MB. One at a time plus the total stays far below the cap.
- `load_array` also uses `mmap_mode="r"`, so the file is not copied fully into RAM.

**Q: Why does `load_array` check the shape?**
- If a file had a different length, adding would shift positions and give a wrong answer without any error.

**Q: How does `file_seed` work?**
- SHA-256 of `"<jobId>:<fileIndex>"`, first 8 bytes as an integer.
- The same job and file always produce the same numbers, so retries and backup copies write identical files.

**Q: What is `save_array_atomic`?**
- Write to `<path>.tmp-<pid>` in the same folder, then `os.replace` onto the final path.
- The final file is either absent or complete. The process id keeps two workers from sharing a temp file.

**Q: Why open a file handle for `np.save`?**
- If you pass a path that doesn't end in `.npy`, numpy appends `.npy` itself. A handle writes exactly where we say.

**Q: Why does the final task return the CSV path with the count?**
- The scheduler needs the count to check `count == F`, and the path to save as `result_path`.

---

## 9. Database and SQL

**Q: How does `withTransaction` work?**
- Takes a client from the pool, `BEGIN`, runs your function, `COMMIT`. On an error it does `ROLLBACK` and rethrows. `finally` releases the client.

**Q: What does `Queryable` mean?**
- A type for "anything that can run a query": the pool, or a client inside a transaction. Repository functions accept either, so the same function works inside or outside a transaction.

**Q: Is `updateById` safe from SQL injection?**
- Table and column names come only from our own code, never from a request. Values always go through `$1, $2...` parameters.
- The `table` parameter is typed as `"jobs" | "tasks"`, so TypeScript rejects anything else.

**Q: How do you lock a row?**
- `SELECT * FROM jobs WHERE id = $1 FOR UPDATE` inside a transaction (`lockJob`, `lockTask`). Others wanting the same row wait until commit or rollback.

**Q: Why `ON CONFLICT (path) DO NOTHING` and not a check first?**
- A check-then-insert has a gap where another process can insert. The unique index plus `ON CONFLICT` is one atomic step.
- `insertItem` returns whether a row was really added, which feeds `files_generated`.

**Q: Which indexes matter?**
- `tasks_pending` is a partial index on `created_at` for `status = 'PENDING'`, so the dispatcher scan stays small as `DONE` tasks pile up.
- `items_waiting (job_id, state, created_at)` serves the planner query.

**Q: How is the median computed?**
- `percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)` over the last 50 `DONE` tasks of that type. No rows gives `null`, and then no backup is sent.

---

## 10. API layer

**Q: What does `asyncHandler` do?**
- Express 4 doesn't catch rejected promises from async handlers. The wrapper calls `.catch(next)` so errors reach the error middleware.

**Q: Why `isUuid` before querying?**
- Postgres throws an error on a malformed UUID. Checking first returns a clean `404` instead of a `500`.

**Q: What does `GET /jobs/:id/result` return in each case?**
- Unknown or malformed id: `404`.
- Job not completed: `409` with the status.
- Completed: `res.download(...)` streams the CSV. Express handles `Range` requests for it.

**Q: What does cancel return?**
- `404` unknown, `409` already finished, `200 {status: "CANCELLED"}` otherwise.

**Q: Does the API ever read the numbers?**
- No. It works with job metadata and streams the finished CSV.

---

## 11. Tests

**Q: What tests exist and what do they cover?**
- Python unit tests (11): the maths in `computation.py`.
- Integration tests (35 checks) against the real database: planner rules, result handling (duplicates, retries, cancelled jobs, count mismatch), message validation, task order, fairness.
- `tools/planner_check.py`: 920 random jobs through a model of the planner.
- End-to-end runs in Docker: results compared to `numpy.mean`, plus crash and slow-worker cases.

**Q: Why integration tests that use a real database?**
- The important behaviour is in SQL and transactions: locking, `ON CONFLICT`, ordering. A mock would hide exactly those bugs.

**Q: Why is there a separate model in `tools/planner_check.py`?**
- It re-implements the rules in memory, so thousands of random orders can be tried in seconds. It checks the idea. The integration tests check the real code.

**Q: What is not tested?**
- No automated browser tests, and no run at the full 99,999 × 999,999 size (the raw data would be about 400 GB).

---

## 12. Known weak spots in the code

**Q: What would you fix first?**
- Invalid JSON in a request body returns `500` instead of `400`. The error handler in `api-server.ts` treats every error alike.

**Q: Which smaller issues do you know about?**
- The fleet snapshot is read once per tick, so it can be slightly stale by the time it is used.
- `tasksWaitingInQueue` is `queued − busy`. A backup copy adds a queued message with no row of its own, so the count can be off by one.
- `backup_sent` is not reset when a task is retried.
- A frozen worker that keeps its connection open is only redelivered after RabbitMQ's own timeout.
- Files of cancelled jobs stay on disk. There is no cleanup.
- Scheduler logs are noisy with stack traces when RabbitMQ restarts.

**Q: Is the `tasksWaitingInQueue` miscount dangerous?**
- No. It only changes how many tasks are published or whether rule 3 fires. Correctness comes from the count check and idempotent handling.

---

## 13. "Change this code" questions

**Q: Make the fan-in 10 instead of 5.**
- Set `MAX_FAN_IN` for the API (environment variable) and change `MAX_TASK_INPUTS = 5` in the worker's `config.py`. The planner, `splitIntoChunks` and the worker's input check read these, so nothing else changes.
- The two values must match, otherwise the worker rejects tasks as having too many inputs.

**Q: Add a new job status, "PAUSED".**
- Add it to `statuses.ts` and the `CHECK` in `schema.sql`.
- Decide what the dispatcher does: today it picks only `PENDING` and `RUNNING` jobs, so a paused job stops getting new tasks.

**Q: Support a different operation (a maximum, not a mean).**
- Replace the sum with `np.maximum` and drop the count and the division. Max is also order-independent, so the same planner works.
- A median would not work, because it can't be merged from partial results.

**Q: Store the files in S3 instead of a folder.**
- Only `file_storage.py` and the API's download route change. S3 has no rename, but a `PUT` of an object is already atomic, so the temp-file step goes away.

**Q: Add a priority to jobs.**
- Add a column to `jobs` and sort by it in `lockPendingTasksFairly`.
- Keep the round-robin inside each priority level so a high-priority job can't starve the others completely.

**Q: Make the tick interval or the queue depth configurable.**
- The tick is already `config.schedulerTickMs`. The queue depth constants are at the top of `task-dispatcher.ts`, so moving them into `config` is a small change.

**Q: How would you add a test for a new planner rule?**
- Add a case to `combine-planner.integration.js`: create a job and items in the database, call `planCombineTasks` in a transaction, and assert the tasks it created.
- Mirror the rule in `planner_check.py` and run the random check.
