import { Router } from "express";
import path from "path";
import { config } from "../config";
import { isUuid } from "../domain/ids";
import { JobStatus } from "../domain/statuses";
import { findJobDetails, findJobResult, listRecentJobs } from "../repositories/job-repository";
import { cancelJob, createJob } from "../services/job-service";
import { asyncHandler } from "./async-handler";
import { validateJobSize } from "./validation";

export const jobsRouter = Router();

jobsRouter.post(
  "/jobs",
  asyncHandler(async (req, res) => {
    const { F: fileCount, C: numbersPerFile } = req.body ?? {};
    const validationError = validateJobSize(fileCount, numbersPerFile);
    if (validationError) return res.status(400).json({ error: validationError });
    const jobId = await createJob(fileCount, numbersPerFile);
    res.status(202).json({ jobId }); // accepted: the work happens in the background
  }),
);

jobsRouter.get(
  "/jobs",
  asyncHandler(async (_req, res) => {
    res.json(await listRecentJobs());
  }),
);

jobsRouter.get(
  "/jobs/:id",
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "not found" });
    const job = await findJobDetails(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    res.json(job);
  }),
);

jobsRouter.get(
  "/jobs/:id/result",
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "not found" });
    const job = await findJobResult(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    if (job.status !== JobStatus.Completed || !job.result_path) return res.status(409).json({ status: job.status });
    res.download(path.join(config.dataDir, job.result_path), `result-${req.params.id}.csv`);
  }),
);

jobsRouter.delete(
  "/jobs/:id",
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "not found" });
    const result = await cancelJob(req.params.id);
    if (result.outcome === "not_found") return res.status(404).json({ error: "not found" });
    if (result.outcome === "not_cancellable") return res.status(409).json({ status: result.status });
    res.json({ status: JobStatus.Cancelled });
  }),
);
