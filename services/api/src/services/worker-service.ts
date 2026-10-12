import { recordEvent } from "../repositories/event-repository";
import { setDesiredWorkers } from "../repositories/worker-repository";

/** Change the number of workers. The worker manager notices the new value and starts or stops processes. */
export async function scaleWorkers(count: number): Promise<void> {
  await setDesiredWorkers(count);
  await recordEvent(null, `worker count set to ${count}`);
}
