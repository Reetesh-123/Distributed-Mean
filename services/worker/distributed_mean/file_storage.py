"""File storage helpers. All paths are relative to the shared data directory."""
import os

import numpy as np


def _full_path(data_dir, relative_path):
    return os.path.join(data_dir, relative_path)


def save_array_atomic(data_dir, relative_path, array):
    """Write `array` as .npy so a reader never sees a half-written file.

    The data goes to a temporary file in the same folder and is then renamed. The rename is atomic,
    so a crash mid-write (or two workers running the same task) leaves either nothing or a complete file.
    """
    path = _full_path(data_dir, relative_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = f"{path}.tmp-{os.getpid()}"
    with open(temp_path, "wb") as handle:  # a file handle stops numpy appending its own ".npy"
        np.save(handle, array)
    os.replace(temp_path, path)


def save_csv_atomic(data_dir, relative_path, array):
    """Write one value per line, in position order (line 1 = index 0)."""
    path = _full_path(data_dir, relative_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = f"{path}.tmp-{os.getpid()}"
    with open(temp_path, "w") as handle:
        np.savetxt(handle, array, fmt="%.10f")
    os.replace(temp_path, path)


def load_array(data_dir, relative_path, expected_length):
    """Memory-mapped load (does not read the whole file into RAM).

    Raises ValueError if the length is wrong: a different length would silently shift positions.
    """
    array = np.load(_full_path(data_dir, relative_path), mmap_mode="r")
    if array.shape != (expected_length,):
        raise ValueError(f"{relative_path}: expected shape ({expected_length},), got {array.shape}")
    return array
