"""Check a finished job against numpy.

Usage (inside the worker container, which mounts ./tools):
    docker compose exec workers python tools/verify.py <jobId>
Recomputes the mean directly from the raw files and compares it with result.npy.
Exits non-zero if the largest absolute difference is above TOLERANCE.
"""
import os
import sys

import numpy as np

from distributed_mean import config, repository

TOLERANCE = 1e-9


def verify_job(job_id):
    with repository.connect() as db:
        job = repository.find_job_size(db, job_id)
    if job is None:
        sys.exit(f"job {job_id} not found")
    file_count, numbers_per_file, status = job
    if status != "COMPLETED":
        sys.exit(f"job is {status}, not COMPLETED")

    # Add the raw files one at a time (the reference answer, computed without any partial results).
    total = np.zeros(numbers_per_file, dtype=np.float64)
    for file_index in range(file_count):
        total += np.load(os.path.join(config.DATA_DIR, job_id, "raw", f"{file_index:05d}.npy"), mmap_mode="r")
    expected = total / file_count

    result = np.load(os.path.join(config.DATA_DIR, job_id, "result.npy"))
    if result.shape != (numbers_per_file,):
        sys.exit(f"result shape {result.shape}, expected ({numbers_per_file},)")
    difference = float(np.abs(result - expected).max())
    print(f"job {job_id}: F={file_count} C={numbers_per_file} max abs difference vs numpy mean = {difference:.3e}")
    if difference > TOLERANCE:
        sys.exit("FAIL: result differs from numpy mean")
    print("OK")


if __name__ == "__main__":
    verify_job(sys.argv[1])
