"""Unit tests for the core computation. No database or queue needed."""
import numpy as np
import pytest

from distributed_mean import computation, file_storage

JOB = "job-1"


def put(tmp_path, rel, values):
    file_storage.save_array_atomic(str(tmp_path), rel, np.asarray(values, dtype=np.float32))
    return {"path": rel, "count": 1}


def test_assignment_example(tmp_path):
    a = put(tmp_path, "a.npy", [1, 2, 3])
    b = put(tmp_path, "b.npy", [4, 5, 6])
    out = computation.combine_items(str(tmp_path), JOB, "t1", 3, [a, b], True)
    assert out == [{"path": f"{JOB}/result.csv", "count": 2}]
    result = np.load(tmp_path / JOB / "result.npy")
    assert result.tolist() == [2.5, 3.5, 4.5]
    lines = (tmp_path / JOB / "result.csv").read_text().split()
    assert [float(x) for x in lines] == [2.5, 3.5, 4.5]


def test_generate_is_reproducible_and_shaped(tmp_path):
    out = computation.generate_files(str(tmp_path), JOB, 100, [0, 1, 2])
    assert [o["count"] for o in out] == [1, 1, 1]
    first = np.load(tmp_path / out[0]["path"]).copy()
    assert first.shape == (100,) and first.dtype == np.float32
    assert ((first >= 0) & (first < 1)).all()
    computation.generate_files(str(tmp_path), JOB, 100, [0])
    assert np.array_equal(first, np.load(tmp_path / out[0]["path"]))


@pytest.mark.parametrize("f", [2, 5, 6, 12, 37])
def test_tree_of_combines_matches_numpy(tmp_path, f):
    """Combine in groups of <=5 (uneven sizes) and compare with np.mean."""
    c, d = 50, str(tmp_path)
    items = []
    for start in range(0, f, 5):
        items += computation.generate_files(d, JOB, c, list(range(start, min(start + 5, f))))
    raw = np.stack([np.load(tmp_path / i["path"]) for i in items]).astype(np.float64)
    n = 0
    while len(items) > 5:  # uneven groups: the leftover joins the next round
        group, items = items[:5], items[5:]
        items.append(computation.combine_items(d, JOB, f"t{n}", c, group, False)[0])
        n += 1
    out = computation.combine_items(d, JOB, "final", c, items, True)
    result = np.load(tmp_path / JOB / "result.npy")
    assert out[0]["count"] == f
    assert np.abs(result - raw.mean(axis=0)).max() < 1e-9


def test_mixed_partial_and_raw_inputs_weighted_correctly(tmp_path):
    d = str(tmp_path)
    raws = computation.generate_files(d, JOB, 20, list(range(5)))
    partial = computation.combine_items(d, JOB, "p1", 20, raws, False)[0]
    assert partial["count"] == 5
    extra = computation.generate_files(d, JOB, 20, [5])[0]
    out = computation.combine_items(d, JOB, "fin", 20, [partial, extra], True)
    assert out[0]["count"] == 6
    all_raw = np.stack([np.load(tmp_path / JOB / "raw" / f"{i:05d}.npy") for i in range(6)])
    expected = all_raw.astype(np.float64).mean(axis=0)
    assert np.abs(np.load(tmp_path / JOB / "result.npy") - expected).max() < 1e-12


def test_shape_mismatch_raises(tmp_path):
    bad = put(tmp_path, "bad.npy", [1, 2])
    with pytest.raises(ValueError):
        computation.combine_items(str(tmp_path), JOB, "t", 3, [bad], False)


def test_fan_in_over_five_raises(tmp_path):
    inp = put(tmp_path, "a.npy", [1, 2, 3])
    with pytest.raises(ValueError):
        computation.combine_items(str(tmp_path), JOB, "t", 3, [inp] * 6, False)
    with pytest.raises(ValueError):
        computation.generate_files(str(tmp_path), JOB, 3, list(range(6)))


def test_empty_inputs_raise(tmp_path):
    with pytest.raises(ValueError):
        computation.combine_items(str(tmp_path), JOB, "t", 3, [], False)
