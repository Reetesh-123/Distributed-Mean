# Implementation Plan

The build order, specs and acceptance criteria are in `implementation notes` (section 13, M1–M8). This file only adds what the notes don't cover: the environment check and a pointer to the relevant sections per milestone. Work one milestone at a time and tick `requirement.md` as you go.

## Status: M1–M8 complete (2026-10-10)

All milestones are built and tested. Evidence is in `test-results.md`; run instructions are in the root `README.md`.

## Environment check (2026-10-10)

Docker Desktop and WSL2 were missing at first and are now installed; the notes below are the original check.

| Tool | Found | Status |
|---|---|---|
| Python | 3.14.7 (notes say 3.11) | OK; confirm `numpy` and `psycopg[binary]` install, else `uv python install 3.12` for local tests |
| Node / npm | 24.20 / 11.19 (notes say 20) | OK locally; Docker image stays `node:20-slim` |
| git, pip, uv | present | OK |
| **Docker Desktop** | **missing** | **Blocker for M1 onward**: `winget install Docker.DockerDesktop` |
| **WSL2** | **not installed** | Needed by Docker: `wsl --install`, reboot |
| Postgres / RabbitMQ | not local | Provided by Compose |

Windows caveats: `RLIMIT_AS` (`WORKER_MEMORY_MB`) only works in the Linux worker container; `scripts/demo.sh` runs in Git Bash or WSL.

## Milestones → where to read in the notes

| Milestone | Notes sections |
|---|---|
| M1 Compose, Dockerfiles, schema, empty API | 1, 2, 3, 5 |
| M2 `compute.py` + tests (no Docker needed) | 4, 9 (compute), 14 |
| M3 `POST /jobs`, `refill()`, worker GENERATE | 6, 7, 8.3, 9 |
| M4 Scheduler, planner, final task, `verify.py` | 8.1, 8.2, 14 |
| M5 Retries, duplicates, dead workers, cancel | 8.4, 12 |
| M6 Fairness, rule 3, backups | 8.2, 8.4, 12 |
| M7 `PUT /workers`, manager, dashboard | 10, 11 |
| M8 README, `demo.sh`, screenshots | 14, 15 |

Order tweak: M2 needs no Docker, so it can be done while Docker installs. Before M4, run `bench/planner_check.py` (see the notes header) as the reference for the basket rules.
Pitfalls to re-read before each milestone: notes section 16.
