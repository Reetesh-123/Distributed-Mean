/**
 * Process 2: the scheduler (run exactly one instance). It does two things:
 *   - consumes worker results one at a time and applies each in a database transaction
 *   - every tick: detects dead workers, re-plans jobs, sends backup copies, publishes pending tasks
 */
import { ConfirmChannel, ConsumeMessage } from "amqplib";
import { config } from "../config";
import { parseResultMessage } from "../domain/messages";
import { JobStatus } from "../domain/statuses";
import { withTransaction } from "../infrastructure/database";
import { getChannel, RESULT_QUEUE } from "../infrastructure/message-broker";
import { findRunningJobIdsWithWaitingItems, lockJob } from "../repositories/job-repository";
import { publishBackupCopies } from "../services/backup-copies";
import { planCombineTasks } from "../services/combine-planner";
import { FleetSnapshot, getFleetSnapshot } from "../services/fleet-state";
import { applyWorkerResult } from "../services/result-handler";
import { publishPendingTasks } from "../services/task-dispatcher";
import { markDeadWorkers } from "../services/worker-health";

const RESULT_PREFETCH = 10; // result messages the scheduler may hold unacknowledged at once
const RETRY_DELAY_MS = 1000; // pause after a failed result, to avoid a tight retry loop
const RECONNECT_DELAY_MS = 2000; // pause before the result consumer reconnects to RabbitMQ

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Handle one result message. It never throws, so one bad message cannot stop the ones after it. */
async function handleResultMessage(channel: ConfirmChannel, raw: ConsumeMessage): Promise<void> {
  const result = parseResultMessage(raw.content.toString());
  if (!result) {
    console.error("dropping a malformed result message:", raw.content.toString().slice(0, 200));
    channel.nack(raw, false, false); // retrying a bad message would fail the same way, so do not requeue
    return;
  }

  try {
    await applyWorkerResult(result);
  } catch (err) {
    console.error("applying result failed, it will be redelivered", err);
    channel.nack(raw, false, true); // requeue
    await sleep(RETRY_DELAY_MS);
    return;
  }

  channel.ack(raw); // ack only after the transaction committed: a crash means redelivery, not loss
  try {
    await publishPendingTasks(); // the result is already saved; if this fails, the next tick publishes
  } catch (err) {
    console.error("publishing tasks after a result failed", err);
  }
}

async function consumeResults(): Promise<void> {
  const channel = await getChannel();
  await channel.prefetch(RESULT_PREFETCH);

  channel.on("close", () => {
    console.error("result channel closed, reconnecting");
    setTimeout(keepConsuming, RECONNECT_DELAY_MS);
  });

  // Handle messages strictly in arrival order, one transaction at a time.
  let previous: Promise<void> = Promise.resolve();
  await channel.consume(RESULT_QUEUE, (raw) => {
    if (!raw) return;
    previous = previous
      .then(() => handleResultMessage(channel, raw))
      .catch((err) => console.error("result handler failed (for example the channel closed)", err));
  });
  console.log("scheduler consuming results");
}

/** Start consuming. If RabbitMQ is unreachable, try again later instead of leaving results unread. */
async function keepConsuming(): Promise<void> {
  try {
    await consumeResults();
  } catch (err) {
    console.error("cannot consume results, retrying", err);
    setTimeout(keepConsuming, RECONNECT_DELAY_MS);
  }
}

/** Plan combine tasks for one job, if it is still running. */
async function replanJob(jobId: string, fleet: FleetSnapshot): Promise<void> {
  await withTransaction(async (client) => {
    const job = await lockJob(client, jobId);
    if (job?.status === JobStatus.Running) await planCombineTasks(client, job, fleet);
  });
}

/** Periodic housekeeping. Re-planning lets rule 3 (use an idle worker) fire even without a new result. */
async function tick(): Promise<void> {
  await markDeadWorkers();
  const fleet = await getFleetSnapshot();

  for (const jobId of await findRunningJobIdsWithWaitingItems()) {
    await replanJob(jobId, fleet);
  }

  await publishBackupCopies(fleet);
  await publishPendingTasks();
}

async function main(): Promise<void> {
  await keepConsuming();
  let tickInProgress = false;
  setInterval(async () => {
    if (tickInProgress) return; // never overlap ticks
    tickInProgress = true;
    try {
      await tick();
    } catch (err) {
      console.error("tick failed", err);
    } finally {
      tickInProgress = false;
    }
  }, config.schedulerTickMs);
  console.log(`scheduler started (tick ${config.schedulerTickMs} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
