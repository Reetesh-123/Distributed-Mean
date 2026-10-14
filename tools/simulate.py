"""
Benchmark: compares four ways of scheduling the distributed mean on workers with different speeds.

Model
- A task that adds k items (k <= 5) takes k * slowness time units on a worker.
- Default fleet: 8 workers -> 4 normal (1x), 2 slower (2x), 2 slowest (3x).
- Lower bound = total inputs read / total fleet speed (ignores the dependency between tree levels).

Run:  python simulate.py
"""
import heapq, itertools

def static_split(F, speeds):
    """Each worker gets F/W files up front; partials are combined after everyone finishes."""
    W = len(speeds)
    share = [F // W + (1 if i < F % W else 0) for i in range(W)]
    t = max(share[i] * speeds[i] for i in range(W))
    return basket(W, speeds, backups=False, start=t)

def fixed_rounds(F, speeds):
    """Tree built in rounds: every task in a round must finish before the next round starts."""
    W, t, items = len(speeds), 0.0, F
    while items > 1:
        groups = [5] * (items // 5) + ([items % 5] if items % 5 else [])
        free = [(t, i) for i in range(W)]
        heapq.heapify(free)
        end = t
        for k in groups:
            ft, w = heapq.heappop(free)
            end = max(end, ft + k * speeds[w])
            heapq.heappush(free, (ft + k * speeds[w], w))
        t, items = end, len(groups)
    return t

def basket(F, speeds, backups=True, start=0.0):
    """Chosen design. A free worker takes up to 5 ready items whenever >= 2 are ready.
    With backups: an otherwise idle worker copies a running task if it would finish sooner;
    the first copy to finish wins and the other is cancelled."""
    W = len(speeds)
    now, ready = start, F
    free = list(range(W))
    ids = itertools.count()
    tasks, events = {}, []                      # task id -> {k, copies{worker: end}}, heap of (end, id, worker)
    while True:
        while free and ready >= 2:
            w = free.pop(0); k = min(5, ready); ready -= k
            t = next(ids); tasks[t] = {"k": k, "copies": {w: now + k * speeds[w]}}
            heapq.heappush(events, (now + k * speeds[w], t, w))
        if backups:
            for w in sorted(free, key=lambda x: speeds[x]):
                best = None
                for t, info in tasks.items():
                    if len(info["copies"]) > 1:
                        continue
                    current_end = min(info["copies"].values())
                    my_end = now + info["k"] * speeds[w]
                    if my_end < current_end and (best is None or current_end - my_end > best[0]):
                        best = (current_end - my_end, t, my_end)
                if best:
                    _, t, my_end = best
                    free.remove(w); tasks[t]["copies"][w] = my_end
                    heapq.heappush(events, (my_end, t, w))
        if ready == 1 and not tasks:
            return now
        end, t, w = heapq.heappop(events)
        if t not in tasks or w not in tasks[t]["copies"]:
            continue                            # this copy was cancelled
        now = end
        free.extend(tasks.pop(t)["copies"].keys())
        ready += 1

if __name__ == "__main__":
    speeds = [1, 1, 1, 1, 2, 2, 3, 3]
    print(f"{'F':>6} | {'Static split':>14} | {'Fixed rounds':>14} | {'Basket':>14} | {'Basket+backup':>14}")
    for F in (20, 100, 1000, 10000):
        bound = (F + (F - 1) / 4) / sum(1 / s for s in speeds)
        res = [static_split(F, speeds), fixed_rounds(F, speeds),
               basket(F, speeds, backups=False), basket(F, speeds, backups=True)]
        print(f"{F:>6} | " + " | ".join(f"{r:6.0f} ({r/bound:4.2f}x)" for r in res))