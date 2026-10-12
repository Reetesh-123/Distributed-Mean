/**
 * Integration test for applyWorkerResult against a real PostgreSQL: lifecycle, duplicates,
 * count mismatch, retries, cancelled jobs. Run after `npm run build` (see combine-planner test).
 */
const { pool } = require("../../dist/infrastructure/database");
const { applyWorkerResult } = require("../../dist/services/result-handler");

let fails = 0;
const check = (name, ok, info = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${info}`); };
const q = async (sql, p) => (await pool.query(sql, p)).rows;

async function newJob(f, genPayloads, attempts = 1) {
  const j = (await q("INSERT INTO jobs (f,c) VALUES ($1,10) RETURNING id", [f]))[0];
  const ids = [];
  for (const p of genPayloads)
    ids.push((await q("INSERT INTO tasks (job_id,type,payload,status,attempts) VALUES ($1,'GENERATE',$2,'QUEUED',$3) RETURNING id", [j.id, JSON.stringify(p), attempts]))[0].id);
  return { jobId: j.id, ids };
}
const msg = (jobId, taskId, status, outputs = [], error = null) =>
  ({ taskId, jobId, workerId: "workers-test", attempt: 1, status, outputs, durationMs: 5, error });
const raw = (jobId, idxs) => idxs.map((i) => ({ path: `${jobId}/raw/${String(i).padStart(5, "0")}.npy`, count: 1 }));
const job = async (id) => (await q("SELECT * FROM jobs WHERE id=$1", [id]))[0];
const combines = (id) => q("SELECT id, status, is_final, jsonb_array_length(payload->'inputs') n, payload FROM tasks WHERE job_id=$1 AND type='COMBINE' ORDER BY created_at,id", [id]);

(async () => {
  // --- full lifecycle, F=6 ---
  const { jobId, ids } = await newJob(6, [{ fileIndexes: [0, 1, 2, 3, 4] }, { fileIndexes: [5] }]);
  await applyWorkerResult(msg(jobId, ids[0], "DONE", raw(jobId, [0, 1, 2, 3, 4])));
  let j = await job(jobId);
  check("first GENERATE: RUNNING, 5 files", j.status === "RUNNING" && j.files_generated === 5, `status=${j.status} gen=${j.files_generated}`);
  let c = await combines(jobId);
  check("5 ready -> one non-final COMBINE of 5", c.length === 1 && c[0].n === 5 && !c[0].is_final, JSON.stringify(c.map(x => [x.n, x.is_final])));

  await applyWorkerResult(msg(jobId, ids[0], "DONE", raw(jobId, [0, 1, 2, 3, 4])));
  check("duplicate result ignored", (await combines(jobId)).length === 1 && (await job(jobId)).files_generated === 5);

  await applyWorkerResult(msg(jobId, ids[1], "DONE", raw(jobId, [5])));
  j = await job(jobId);
  check("second GENERATE: all 6 generated", j.files_generated === 6);
  check("combine in flight -> no extra task yet", (await combines(jobId)).length === 1);

  const partial = { path: `${jobId}/partials/x.npy`, count: 5 };
  await applyWorkerResult(msg(jobId, c[0].id, "DONE", [partial]));
  c = await combines(jobId);
  const fin = c.find((x) => x.is_final);
  check("partial + file 5 -> FINAL COMBINE of 2", c.length === 2 && fin && fin.n === 2, JSON.stringify(c.map(x => [x.n, x.is_final])));

  await applyWorkerResult(msg(jobId, fin.id, "DONE", [{ path: `${jobId}/result.csv`, count: 6 }]));
  j = await job(jobId);
  check("final count == F -> COMPLETED", j.status === "COMPLETED" && j.result_path === `${jobId}/result.csv`, `status=${j.status}`);

  // --- count mismatch ---
  const m = await newJob(2, [{ fileIndexes: [0, 1] }]);
  await applyWorkerResult(msg(m.jobId, m.ids[0], "DONE", raw(m.jobId, [0, 1])));
  const mf = (await combines(m.jobId))[0];
  check("F=2: final COMBINE of 2 created", mf && mf.is_final && mf.n === 2);
  await applyWorkerResult(msg(m.jobId, mf.id, "DONE", [{ path: `${m.jobId}/result.csv`, count: 1 }]));
  j = await job(m.jobId);
  check("wrong final count -> FAILED", j.status === "FAILED" && /count mismatch/.test(j.error), j.error);

  // --- retry then fail ---
  const r = await newJob(5, [{ fileIndexes: [0, 1, 2, 3, 4] }], 1);
  await applyWorkerResult(msg(r.jobId, r.ids[0], "FAILED", [], "boom"));
  let t = (await q("SELECT status FROM tasks WHERE id=$1", [r.ids[0]]))[0];
  check("FAILED with attempts<3 -> back to PENDING", t.status === "PENDING" && (await job(r.jobId)).status === "PENDING");
  await q("UPDATE tasks SET attempts=3, status='QUEUED' WHERE id=$1", [r.ids[0]]);
  await applyWorkerResult(msg(r.jobId, r.ids[0], "FAILED", [], "boom"));
  j = await job(r.jobId);
  check("FAILED at max attempts -> job FAILED", j.status === "FAILED", j.error);

  // --- cancelled job: late result ignored ---
  const x = await newJob(5, [{ fileIndexes: [0, 1, 2, 3, 4] }]);
  await q("UPDATE jobs SET status='CANCELLED' WHERE id=$1", [x.jobId]);
  await applyWorkerResult(msg(x.jobId, x.ids[0], "DONE", raw(x.jobId, [0, 1, 2, 3, 4])));
  t = (await q("SELECT status FROM tasks WHERE id=$1", [x.ids[0]]))[0];
  check("late result for cancelled job: task FAILED, no items", t.status === "FAILED" && (await q("SELECT 1 FROM items WHERE job_id=$1", [x.jobId])).length === 0);

  // --- unknown task ---
  await applyWorkerResult(msg(jobId, "00000000-0000-0000-0000-000000000000", "DONE", []));
  check("unknown task id does not throw", true);

  await q("DELETE FROM jobs WHERE id = ANY($1::uuid[])", [[jobId, m.jobId, r.jobId, x.jobId]]);
  await pool.end();
  console.log(fails ? `${fails} FAILED` : "all passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
