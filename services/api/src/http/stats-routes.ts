import { Router } from "express";
import { isUuid } from "../domain/ids";
import { listEvents } from "../repositories/event-repository";
import { getSystemStats } from "../repositories/stats-repository";
import { asyncHandler } from "./async-handler";

export const statsRouter = Router();

statsRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    res.json(await getSystemStats());
  }),
);

/** GET /events?after=<id>&job=<jobId>: only lines newer than `after`, optionally for one job. */
statsRouter.get(
  "/events",
  asyncHandler(async (req, res) => {
    const afterId = req.query.after === undefined ? null : Number(req.query.after);
    if (afterId !== null && !Number.isInteger(afterId)) return res.status(400).json({ error: "after must be an integer" });
    const jobId = req.query.job === undefined ? null : String(req.query.job);
    if (jobId !== null && !isUuid(jobId)) return res.status(400).json({ error: "job must be a job id" });
    res.json(await listEvents(afterId, jobId));
  }),
);
