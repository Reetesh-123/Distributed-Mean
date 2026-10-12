# Test Results

Recorded while building (2026-10-10), against the Docker Compose stack: 3 workers, slowdown `1,1,3`, 512 MB memory cap per worker. Numbers are from one laptop run and vary a little between runs.

Correctness in every end-to-end test below means `python -m distributed_mean.verify` reported a maximum difference against `numpy.mean` of 0 (limit 1e-9).

## Checklist (requirement.md section 9)

| # | Test | Result |
|---|---|---|
| 9.1 | Assignment example `[1,2,3]` + `[4,5,6]` | `[2.5, 3.5, 4.5]` exactly (`test_assignment_example`) |
| 9.2 | Random jobs match `numpy.mean` | Unit tests for F = 2, 5, 6, 12, 37 within 1e-9; end-to-end F = 2, 6, 37, 1000, 4000 all difference 0 |
| 9.3 | Final count = F | Enforced by the scheduler; a wrong count fails the job (tested: "count mismatch") |
| 9.4 | Slow-worker demo | Slowdown `1,1,3`: workers did 553, 556 and 248 tasks. Slowdown `1,1,20`, F=40, C=999,999: 4.6–6.8 s without backups, 3.6–4.2 s with backups |
| 9.5 | Crash test | `kill -9` on a worker mid-job (F=4000, C=300,000): job completed, difference 0. RabbitMQ redelivered its task, the manager restarted it. Frozen workers (no heartbeat) were marked `dead`, then recovered to `idle` |
| 9.6 | Fairness | F=10 submitted 3 s after F=3000: the small job finished in 3 s while the big one was still running (big job: 37 s) |
| 9.7 | Scaling W mid-job | 6 → 2 workers during F=1500 jobs, three times: 0 failed, 0 retried tasks. 3 → 0 → 3: jobs waited, then resumed |
| 9.8 | README | `README.md` |
| 9.9 | Demo script | `scripts/demo.sh 200 20000`: completed in 3 s, verified OK |
| 9.10 | Dashboard screenshot | `docs/dashboard.png` |
| 9.11 | Laptop limits note | README, "Limits on a laptop" |
| 9.12 | Cancel | F=3000 cancelled mid-run: status `CANCELLED`, nothing left `QUEUED`, queues empty, stats counts correct; second cancel returns 409; the next small job finished in 1 s |
| 9.13 | Two jobs at once | F=800/C=50,000 and F=600/C=80,000 together: both completed in 20 s, both verified |

## Other tests

| Test | Result |
|---|---|
| Unit tests (`pytest`) | 11 passed |
| Planner reference model (`bench/planner_check.py`) | 920 randomized jobs: correct mean, count = F, no task over 5 inputs, no deadlock |
| Planner rules against the real database | 7 scenarios passed (5-ready, final of 5, final of 3, idle-worker small task, busy-fleet wait, divide-only final, leftover blocked by in-flight) |
| `applyWorkerResult` against the real database | 13 checks passed: full F=6 lifecycle, duplicate ignored, count mismatch, retry then fail after 3 attempts, cancelled job, unknown task |
| Input validation | `F=1`, `F="abc"`, `C=1000000`, worker counts `-1`, `33`, `"x"`: all `400` |
| Scheduler restart mid-job (F=2500) | Job completed, verified |
| Task that always fails | Retried 3 times, then job `FAILED` with a clear error |
| Memory cap (512 MB) at C = 999,999 | Jobs completed, no memory errors |

## Bugs found by testing

| Bug | Fix |
|---|---|
| Workers crashed with `MemoryError` under the 512 MB cap (`RLIMIT_AS` counts virtual memory, including thread stacks and BLAS threads) | Smaller thread stacks, single BLAS thread, `MALLOC_ARENA_MAX=1` |
| Scheduler crashed on cold start: RabbitMQ passes its health check slightly before accepting connections | Connection retry for up to 30 s |
| A worker marked `DEAD` during a stall stayed `DEAD` until it handled a task | Heartbeat revives it to `IDLE` |
| Scaling down broke a task mid-write (SIGTERM interrupted NumPy's C-level write: "0 written"), causing a retry | SIGTERM is held until the task is acked, then the worker drains |
| Progress stayed at 0% during file generation (the notes' formula only counts combine tasks) | Progress = (files generated + merges done) / (2F − 1) |

## Not tested

- Dashboard buttons were not clicked in a real browser. Rendering and live updates were checked in headless Edge, and the API calls behind each button were tested directly.
- Sizes near the design limits (F = 99,999, C = 999,999 together) were not run; see the laptop limits note.
