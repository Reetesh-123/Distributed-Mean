/**
 * Checks for id validation, malformed queue messages, and the order tasks are published in.
 * Run after `npm run build` (see combine-planner test). The database work is rolled back.
 */
const { pool } = require("../../dist/infrastructure/database");
const { isUuid } = require("../../dist/domain/ids");
const { parseResultMessage } = require("../../dist/domain/messages");
const { insertJob } = require("../../dist/repositories/job-repository");
const { insertGenerateTasks, lockPendingTasksFairly } = require("../../dist/repositories/task-repository");
const { splitIntoChunks } = require("../../dist/services/job-service");

let fails = 0;
const check = (name, ok, info = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${info}`); };

const ID = "4aafd344-3f4f-45e0-ac1e-fad7b15f1917";
const validResult = { taskId: ID, jobId: ID, workerId: "workers-0", attempt: 1, status: "DONE", outputs: [{ path: "a/b.npy", count: 1 }], durationMs: 5, error: null };
const parse = (value) => parseResultMessage(typeof value === "string" ? value : JSON.stringify(value));

(async () => {
  // --- ids ---
  check("a real uuid is accepted", isUuid(ID));
  check("36 dashes are rejected", !isUuid("-".repeat(36)));
  check("wrong length is rejected", !isUuid(ID.slice(1)));
  check("non-string is rejected", !isUuid(undefined) && !isUuid(42));

  // --- queue messages ---
  check("valid result message is accepted", parse(validResult) !== null);
  check("invalid JSON is rejected", parse("{not json") === null);
  check("non-uuid taskId is rejected", parse({ ...validResult, taskId: "abc" }) === null);
  check("unknown status is rejected", parse({ ...validResult, status: "MAYBE" }) === null);
  check("outputs that are not a list are rejected", parse({ ...validResult, outputs: "x" }) === null);
  check("output with count 0 is rejected", parse({ ...validResult, outputs: [{ path: "a", count: 0 }] }) === null);
  check("missing durationMs is rejected", parse({ ...validResult, durationMs: undefined }) === null);
  check("JSON null is rejected", parse("null") === null);

  // --- publish order ---
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bigJob = await insertJob(client, 30, 10); // 6 tasks
    await insertGenerateTasks(client, bigJob, splitIntoChunks(30, 5).map((fileIndexes) => ({ fileIndexes })));
    await client.query("UPDATE jobs SET created_at = created_at - interval '1 second' WHERE id = $1", [bigJob]); // jobs are created in separate transactions in real use
    const smallJob = await insertJob(client, 10, 10); // 2 tasks
    await insertGenerateTasks(client, smallJob, splitIntoChunks(10, 5).map((fileIndexes) => ({ fileIndexes })));

    const { rows: created } = await client.query(
      "SELECT payload->'fileIndexes'->>0 AS first, created_at FROM tasks WHERE job_id = $1 ORDER BY created_at",
      [bigJob],
    );
    check("tasks keep file order by created_at", created.map((r) => r.first).join(",") === "0,5,10,15,20,25", created.map((r) => r.first).join(","));
    const distinct = await client.query("SELECT count(DISTINCT created_at)::int AS n FROM tasks WHERE job_id = $1", [bigJob]);
    check("created_at is different for every task", distinct.rows[0].n === 6, `${distinct.rows[0].n} distinct`);

    const picked = await lockPendingTasksFairly(client, 4);
    const order = picked.map((t) => `${t.job_id === bigJob ? "big" : "small"}:${t.payload.fileIndexes[0]}`).join(" ");
    check("jobs take turns, tasks in file order", order === "big:0 small:0 big:5 small:5", order);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }

  await pool.end();
  console.log(fails ? `${fails} FAILED` : "all passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
