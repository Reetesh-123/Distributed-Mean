/**
 * Integration test for the combine planner rules against a real PostgreSQL.
 * Run after `npm run build`, with the stack up:
 *   DATABASE_URL=postgres://app:app@localhost:5432/jobs RABBITMQ_URL=amqp://localhost npm run test:integration
 * Each scenario runs in a transaction that is rolled back.
 */
const { pool } = require("../../dist/infrastructure/database");
const { planCombineTasks } = require("../../dist/services/combine-planner");

async function scenario(name, f, nReady, inFlightTasks, allGen, fleet, expect) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const j = (await c.query("INSERT INTO jobs (f,c,files_generated) VALUES ($1,10,$2) RETURNING *", [f, allGen ? f : 0])).rows[0];
    for (let i = 0; i < nReady; i++)
      await c.query("INSERT INTO items (job_id,path,count) VALUES ($1,$2,1)", [j.id, `${j.id}/${i}`]);
    for (let i = 0; i < inFlightTasks; i++)
      await c.query("INSERT INTO tasks (job_id,type,payload,status) VALUES ($1,'GENERATE','{}','QUEUED')", [j.id]);
    await planCombineTasks(c, j, fleet);
    const t = (await c.query("SELECT jsonb_array_length(payload->'inputs') AS n, is_final FROM tasks WHERE job_id=$1 AND type='COMBINE' ORDER BY created_at, id", [j.id])).rows;
    const got = t.map((r) => `${r.n}${r.is_final ? "F" : ""}`).join(",");
    const left = (await c.query("SELECT count(*)::int n FROM items WHERE job_id=$1 AND state='READY'", [j.id])).rows[0].n;
    console.log(`${got === expect.tasks && left === expect.left ? "PASS" : "FAIL"}  ${name}: tasks=[${got}] ready_left=${left} (expected [${expect.tasks}] ${expect.left})`);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

(async () => {
  const busy = { idleWorkers: 0, tasksWaitingInQueue: 0 };
  const idle = { idleWorkers: 2, tasksWaitingInQueue: 0 };
  await scenario("12 ready, others in flight -> 5,5 and wait", 40, 12, 1, false, busy, { tasks: "5,5", left: 2 });
  await scenario("5 ready, nothing else -> final of 5", 5, 5, 0, true, busy, { tasks: "5F", left: 0 });
  await scenario("3 ready, all done, nothing in flight -> final of 3", 3, 3, 0, true, busy, { tasks: "3F", left: 0 });
  await scenario("3 ready, idle worker, more coming -> small task", 40, 3, 1, false, idle, { tasks: "3", left: 0 });
  await scenario("3 ready, busy fleet, more coming -> wait", 40, 3, 1, false, busy, { tasks: "", left: 3 });
  await scenario("1 ready, all done -> divide-only final", 6, 1, 0, true, busy, { tasks: "1F", left: 0 });
  await scenario("11 ready, all done, nothing in flight -> 5, 5, then final of 1 is blocked by inFlight", 11, 11, 0, true, busy, { tasks: "5,5", left: 1 });
  await pool.end();
})();
