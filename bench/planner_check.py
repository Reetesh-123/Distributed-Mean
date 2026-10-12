# Randomized check of the basket rules in 04-implementation-notes.md section 8.2:
# random speeds and completion order; asserts correct mean, final count == F, <= 5 inputs, no deadlock.
# Run: python bench/planner_check.py
import random, heapq
import numpy as np

def run_job(F, C, W, rng):
    files = [rng.random(C) for _ in range(F)]
    truth = np.mean(files, axis=0)
    # tasks: GENERATE chunks of 5
    pending = [("GEN", list(range(i, min(i+5, F))), False) for i in range(0, F, 5)]
    ready = []                       # items: (sums, count)
    in_flight = len(pending)         # PENDING+QUEUED
    files_generated = 0
    running = []                     # heap (end, seq, task)
    free = W; t = 0.0; seq = 0; done = None; max_inputs = 0
    def plan(fleet_idle):
        nonlocal in_flight
        all_gen = files_generated == F
        while True:
            if len(ready) >= 5:
                final = len(ready) == 5 and in_flight == 0 and all_gen
                take = [ready.pop(0) for _ in range(5)]
                pending.append(("COMB", take, final)); in_flight += 1; continue
            if len(ready) >= 2 and in_flight == 0 and all_gen:
                take = ready[:]; ready.clear(); pending.append(("COMB", take, True)); in_flight += 1; break
            if len(ready) >= 2 and fleet_idle:
                take = ready[:]; ready.clear(); pending.append(("COMB", take, False)); in_flight += 1; fleet_idle = False; break
            if len(ready) == 1 and in_flight == 0 and all_gen:
                take = ready[:]; ready.clear(); pending.append(("COMB", take, True)); in_flight += 1; break
            break
    steps = 0
    while done is None:
        steps += 1
        if steps > 10_000_000: raise RuntimeError("no progress")
        # dispatch
        while free and pending:
            task = pending.pop(0); free -= 1; seq += 1
            max_inputs = max(max_inputs, len(task[1]))
            heapq.heappush(running, (t + rng.uniform(0.5, 3.0) * len(task[1]), seq, task))
        # tick: rule 3 when a worker is idle and nothing is waiting
        if free and not pending:
            before = len(pending); plan(True)
            if len(pending) > before: continue
        if not running:
            raise RuntimeError(f"deadlock: ready={len(ready)} in_flight={in_flight} gen={files_generated}")
        t, _, (kind, data, final) = heapq.heappop(running); free += 1
        in_flight -= 1
        if kind == "GEN":
            for i in data: ready.append((files[i].copy(), 1)); files_generated += 1
        else:
            s = np.zeros(C); n = 0
            for sums, cnt in data: s += sums; n += cnt
            if final:
                assert n == F, f"count {n} != F {F}"
                done = s / n; break
            ready.append((s, n))
        plan(free > 0 and not pending)
    assert max_inputs <= 5
    assert np.allclose(done, truth, atol=1e-12)
    return True

rng = random.Random(42)
np_rng = np.random.default_rng(42)
cases = 0
for F in list(range(2, 41)) + [57, 99, 100, 101, 250, 999, 1000]:
    for W in (1, 2, 3, 8):
        for _ in range(5):
            class R:
                random = staticmethod(lambda n: np_rng.random(n))
                uniform = staticmethod(rng.uniform)
            run_job(F, 4, W, R); cases += 1
print(f"{cases} randomized jobs passed: correct mean, count == F, no task > 5 inputs, no deadlock")