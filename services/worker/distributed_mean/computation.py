"""The core computation. Pure functions that only read and write files.

Every item is "sums + count": per-position SUMS of the files it covers, and how many files
that is. Items can be added in any grouping and order. Only the FINAL combine divides, once.
An item is described as {"path": ..., "count": ...}; a raw file is an item with count 1.
"""
import hashlib

import numpy as np

from . import file_storage
from .config import MAX_TASK_INPUTS


def file_seed(job_id, file_index):
    """Deterministic seed per (job, file): the same job always generates the same numbers.

    That makes results reproducible and lets verify.py recompute the true mean later.
    """
    digest = hashlib.sha256(f"{job_id}:{file_index}".encode()).digest()
    return int.from_bytes(digest[:8], "little")


def generate_files(data_dir, job_id, numbers_per_file, file_indexes):
    """GENERATE task: create up to 5 random files. Each one is an item with count 1."""
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


def combine_items(data_dir, job_id, task_id, numbers_per_file, inputs, is_final):
    """COMBINE task: add up to 5 items position by position and add their counts.

    Not final: save the running sums as a new partial item (still sums, not averages).
    Final: divide by the total count once and write result.npy / result.csv.
    Returns the list with the one output item.
    """
    # A real exception rather than `assert`, because Python can strip asserts with -O.
    if not 1 <= len(inputs) <= MAX_TASK_INPUTS:
        raise ValueError(f"a task may have 1 to {MAX_TASK_INPUTS} inputs")

    # float64 for the running total keeps precision when many values are added.
    total = np.zeros(numbers_per_file, dtype=np.float64)
    total_count = 0
    for item in inputs:  # one input in memory at a time: this is what respects the RAM limit
        total += file_storage.load_array(data_dir, item["path"], numbers_per_file)
        total_count += item["count"]

    if is_final:
        mean = total / total_count
        file_storage.save_array_atomic(data_dir, f"{job_id}/result.npy", mean)
        file_storage.save_csv_atomic(data_dir, f"{job_id}/result.csv", mean)
        # The scheduler checks that this count equals F.
        return [{"path": f"{job_id}/result.csv", "count": total_count}]

    path = f"{job_id}/partials/{task_id}.npy"
    file_storage.save_array_atomic(data_dir, path, total)
    return [{"path": path, "count": total_count}]
