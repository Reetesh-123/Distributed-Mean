# Part 1: The core idea, sums plus a count

Files: `services/worker/distributed_mean/computation.py`, `file_storage.py`, and `services/worker/tests/test_computation.py`

This is the heart of the system. Everything else (queues, scheduler, planner) only exists to decide *who* runs this code and *when*. The code itself is about 40 lines.

## The problem

The job: F files, each with C numbers. Produce one file with C numbers, where number `i` is the mean of position `i` across all F files.

A worker may handle at most 5 files at a time, so no single worker can compute the mean directly. The work has to be split into groups, and the groups' answers combined.

## Why you can't average averages

Take 6 files and look at one position. The values are `1, 1, 1, 1, 1, 7`.

| | Value |
|---|---|
| True mean | (1+1+1+1+1+7) / 6 = **2** |
| Group A (five files) average | 1 |
| Group B (one file) average | 7 |
| Average of the two averages | (1+7) / 2 = **4**, wrong |

The group with one file got the same weight as the group with five. Because of the 5-file limit, groups are always uneven (12 files become groups of 5, 5 and 2), so this mistake would happen all the time.

## The fix: every result is "sums + count"

Instead of an average, each result carries two things:

- **sums**: a list of C numbers, the per-position **sum** of the files it covers
- **count**: how many original files it covers

| | sums (one position shown) | count |
|---|---|---|
| Group A | 5 | 5 |
| Group B | 7 | 1 |
| A + B (add both) | 12 | 6 |
| Final (divide once) | 12 / 6 = **2** | |

Adding sums and adding counts always works, in any order, in any grouping. You only divide once, at the very end.

## The code, part by part

### 1. A raw file is just an item with count 1

```python
# computation.py
def generate_files(data_dir, job_id, numbers_per_file, file_indexes):
    if not 1 <= len(file_indexes) <= MAX_TASK_INPUTS:
        raise ValueError(f"a task may generate 1 to {MAX_TASK_INPUTS} files")
    items = []
    for file_index in file_indexes:
        generator = np.random.default_rng(file_seed(job_id, file_index))
        values = generator.random(numbers_per_file, dtype=np.float32)
        path = f"{job_id}/raw/{file_index:05d}.npy"
        file_storage.save_array_atomic(data_dir, path, values)
        items.append({"path": path, "count": 1})
    return items
```

- It makes `numbers_per_file` (C) random numbers in [0, 1) per file. The `.random(c)` array **is** the file: position 0 is index 0, position 1 is index 1, and so on.
- `count: 1` marks it as one file. Because a raw file looks exactly like a partial result (a list of numbers plus a count), one kind of combine task handles both.
- The seed comes from the job id and file index, so the same job always generates the same numbers. That makes results reproducible and lets `verify.py` (run as `python tools/verify.py`) recompute the truth later.

```python
def file_seed(job_id, file_index):
    digest = hashlib.sha256(f"{job_id}:{file_index}".encode()).digest()
    return int.from_bytes(digest[:8], "little")
```

### 2. Combining: add index by index, add the counts

```python
def combine_items(data_dir, job_id, task_id, numbers_per_file, inputs, is_final):
    if not 1 <= len(inputs) <= MAX_TASK_INPUTS:
        raise ValueError(f"a task may have 1 to {MAX_TASK_INPUTS} inputs")
    total = np.zeros(numbers_per_file, dtype=np.float64)
    total_count = 0
    for item in inputs:                     # one input in memory at a time
        total += file_storage.load_array(data_dir, item["path"], numbers_per_file)
        total_count += item["count"]
```

- `total` is a running total of C zeros. `total += array` adds position 0 with position 0, position 1 with position 1, and so on. That is how "position is preserved".
- `total_count` adds up the counts. A partial result that covers 5 files contributes 5, a raw file contributes 1.
- Inputs are loaded **one at a time** and added immediately, so memory holds one input plus the total. That is how the 5-file RAM limit is respected.
- `float64` for the total keeps precision when adding thousands of values. Raw files are `float32` to stay small.
- The size check raises a real `ValueError` (not an `assert`, which Python can strip out with `-O`).

### 3. Non-final: save the partial. Final: divide once

```python
    if is_final:
        mean = total / total_count
        file_storage.save_array_atomic(data_dir, f"{job_id}/result.npy", mean)
        file_storage.save_csv_atomic(data_dir, f"{job_id}/result.csv", mean)
        return [{"path": f"{job_id}/result.csv", "count": total_count}]
    path = f"{job_id}/partials/{task_id}.npy"
    file_storage.save_array_atomic(data_dir, path, total)
    return [{"path": path, "count": total_count}]
```

- **Not final:** save `total` (still sums, not divided) and return it with its count `total_count`. This is a new item that another combine task can pick up later.
- **Final:** divide `total / total_count` exactly once, write the result as `.npy` and `.csv`, and report `count = total_count`. The scheduler then checks that the count equals F. If it doesn't, some file was missed or counted twice and the job fails instead of returning a wrong answer.

## Walking through your assignment example

Files `[1,2,3]` and `[4,5,6]`, so F=2 and C=3. Both fit in one task, so it is the final one.

```
total starts [0, 0, 0],  count = 0
add file 1   [1, 2, 3],  count = 1
add file 2   [5, 7, 9],  count = 2
divide       [5/2, 7/2, 9/2] = [2.5, 3.5, 4.5]
```

That is exactly the unit test:

```python
# tests/test_computation.py
def test_assignment_example(tmp_path):
    a = put(tmp_path, "a.npy", [1, 2, 3])
    b = put(tmp_path, "b.npy", [4, 5, 6])
    out = computation.combine_items(str(tmp_path), JOB, "t1", 3, [a, b], True)
    assert out == [{"path": f"{JOB}/result.csv", "count": 2}]
    result = np.load(tmp_path / JOB / "result.npy")
    assert result.tolist() == [2.5, 3.5, 4.5]
```

## A bigger example: 12 files, uneven groups

```
12 raw files  (each: sums = the file, count = 1)

combine files 1-5   -> partial P1  (sums, count 5)
combine files 6-10  -> partial P2  (sums, count 5)
combine P1, P2, files 11, 12 (4 inputs) -> FINAL: sum / (5+5+1+1) = sum / 12
```

Group sizes were 5, 5, 1, 1 and it doesn't matter, because counts travel with the sums. The test `test_tree_of_combines_matches_numpy` does this for F = 2, 5, 6, 12 and 37 and checks the result against `numpy.mean` within 1e-9.

## Files on disk: `file_storage.py`

```python
def save_array_atomic(data_dir, relative_path, array):
    path = _full_path(data_dir, relative_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = f"{path}.tmp-{os.getpid()}"
    with open(temp_path, "wb") as handle:   # a file handle stops numpy appending its own .npy
        np.save(handle, array)
    os.replace(temp_path, path)
```

- **Atomic write:** write to a temporary file in the same folder, then rename. `os.replace` is atomic, so a reader (or a crash) never sees a half-written file.
- **Why it matters:** a worker can crash mid-write, or two workers can run the same task (a backup copy). Either way the final path only ever holds a complete file.
- Writing through a file handle stops NumPy from appending a second `.npy` to the name.

```python
def load_array(data_dir, relative_path, expected_length):
    array = np.load(_full_path(data_dir, relative_path), mmap_mode="r")
    if array.shape != (expected_length,):
        raise ValueError(f"{relative_path}: expected shape ({expected_length},), got {array.shape}")
    return array
```

- `mmap_mode="r"` maps the file instead of reading it all into memory.
- The shape check guards the "position = index" rule. A file with the wrong length would silently shift positions, so it raises an error instead.

## What to remember

1. Never store or pass averages, only sums and a count.
2. Position = array index. Combining is `total += array`.
3. A raw file is an item with count 1, so one combine task fits everything.
4. Divide once, only in the final task. The scheduler checks the final count equals F.
5. At most 5 inputs per task, loaded one at a time.

**Next:** [Part 2](00-index.md), the life of a job from `POST /jobs` to the first tasks on the queue.
