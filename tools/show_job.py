"""Print a job's raw input values next to the computed mean, so the result can be checked by eye.

Usage: python tools/show_job.py <jobId> [positions=10] [dataDir=data]
Rows are positions (0, 1, 2, ...), columns are the raw files, the last two columns are the mean
recomputed here and the mean the system produced (result.npy). Needs only numpy, no database.
"""
import os
import sys

import numpy as np


def show_job(job_id, positions=10, data_dir="data"):
    job_dir = os.path.join(data_dir, job_id)
    raw_dir = os.path.join(job_dir, "raw")
    names = sorted(os.listdir(raw_dir))
    raw = [np.load(os.path.join(raw_dir, name), mmap_mode="r") for name in names]
    shown = min(positions, len(raw[0]))

    print(f"{len(raw)} raw files, {len(raw[0])} numbers each. Showing the first {shown} positions.\n")
    print("pos | " + " ".join(f"{'file ' + str(int(n[:-4])):>9}" for n in names[:8]) + (" ..." if len(names) > 8 else "")
          + " |  mean(here) | mean(system)")
    result_path = os.path.join(job_dir, "result.npy")
    result = np.load(result_path) if os.path.exists(result_path) else None
    for pos in range(shown):
        values = [float(file[pos]) for file in raw]
        mean_here = sum(values) / len(values)
        system = f"{float(result[pos]):12.6f}" if result is not None else "   (not yet)"
        cells = " ".join(f"{v:9.6f}" for v in values[:8])
        print(f"{pos:3d} | {cells}{' ...' if len(values) > 8 else ''} | {mean_here:11.6f} | {system}")


if __name__ == "__main__":
    show_job(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 10, sys.argv[3] if len(sys.argv) > 3 else "data")
