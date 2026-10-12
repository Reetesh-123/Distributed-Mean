# Code Walkthrough

One file per part. Each part explains one piece of the system using the real code, in the order a job flows through it. Paths are relative to `services/api/src/` (TypeScript) and `services/worker/distributed_mean/` (Python).

| Part | Topic | Main files |
|---|---|---|
| [1](01-core-idea.md) | The core idea: sums plus a count, never averages | `computation.py`, `file_storage.py` |
| 2 | The life of a job: from `POST /jobs` to the first tasks on the queue | `http/jobs-routes.ts`, `services/job-service.ts`, `services/task-dispatcher.ts`, `infrastructure/message-broker.ts` |
| 3 | The worker: pulling one task at a time, the 5-file limit, the memory cap | `worker.py`, `worker_manager.py` |
| 4 | The scheduler: processing results safely in one transaction | `entrypoints/scheduler.ts`, `services/result-handler.ts` |
| 5 | The planner: the rules on waiting items that decide when to combine | `services/combine-planner.ts` |
| 6 | Fairness: the shallow queue and round-robin across jobs | `services/task-dispatcher.ts` |
| 7 | Failures: crashes, retries, duplicates, cancel, dead workers | `services/result-handler.ts`, `services/worker-health.ts`, `services/job-service.ts` |
| 8 | Slow workers and backup copies | `services/backup-copies.ts` |
| 9 | Scaling workers and the dashboard | `http/workers-routes.ts`, `worker_manager.py`, `public/index.html` |
